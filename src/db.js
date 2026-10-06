import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SETTINGS = {
  // New accounts post automatically on weekdays, so connecting and uploading a
  // profile is all anyone has to do.
  days: [1, 2, 3, 4, 5],
  time: "11:00",
  timezone: null, // Filled in from your browser on first visit.
  voice: "",
  learning: "",
  autoApprove: false,
  dailyDrafts: true,
  autoPostDaily: true,
  draftTime: "10:00",
  pillars: [],
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    personUrn: row.person_urn,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings) },
    analysis: row.analysis ? JSON.parse(row.analysis) : null,
    dailyDate: row.daily_date,
    dailyIndex: row.daily_index,
    dailyError: row.daily_error,
  };
}

/** Brings a database from the single-account version up to date, keeping its data. */
function migrate(db) {
  const columns = db.prepare("PRAGMA table_info(posts)").all().map((c) => c.name);
  if (!columns.includes("account_id")) {
    db.exec(`
      ALTER TABLE posts ADD COLUMN account_id INTEGER;
      ALTER TABLE posts ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE posts ADD COLUMN pillar_type TEXT;
      ALTER TABLE posts ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
    `);
  }

  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  if (!accountColumns.includes("user_id")) db.exec("ALTER TABLE accounts ADD COLUMN user_id INTEGER");

  const { count } = db.prepare("SELECT COUNT(*) AS count FROM accounts").get();
  if (count > 0) return;

  const readKv = (key) => {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : null;
  };
  const linkedin = readKv("linkedin");
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO accounts (name, person_urn, access_token, expires_at, settings, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      linkedin?.name ?? "My account",
      linkedin?.personUrn ?? null,
      linkedin?.accessToken ?? null,
      linkedin?.expiresAt ?? null,
      JSON.stringify(readKv("settings") ?? {}),
      new Date().toISOString(),
    );
  db.prepare("UPDATE posts SET account_id = ? WHERE account_id IS NULL").run(lastInsertRowid);
  db.exec("DELETE FROM kv");
}

export function openStore(dataDir) {
  let db;
  if (dataDir === ":memory:") {
    db = new DatabaseSync(":memory:");
  } else {
    mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(join(dataDir, "app.db"));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TEXT,
      published_at TEXT,
      linkedin_urn TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      person_urn TEXT UNIQUE,
      access_token TEXT,
      expires_at TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      analysis TEXT,
      daily_date TEXT,
      daily_index INTEGER NOT NULL DEFAULT 0,
      daily_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spending (month TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER,
      expires_at TEXT NOT NULL
    );
  `);
  db.exec("BEGIN");
  try {
    migrate(db);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const insertAccount = (name, userId) =>
    Number(
      db
        .prepare("INSERT INTO accounts (name, user_id, created_at) VALUES (?, ?, ?)")
        .run(name, userId, new Date().toISOString()).lastInsertRowid,
    );
  const now = () => new Date().toISOString();
  const toUser = (row) => row && { id: row.id, username: row.username, isAdmin: Boolean(row.is_admin) };

  const getAccount = (id) => hydrate(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id));

  return {
    /** All accounts, or only the ones that belong to one login. */
    listAccounts: (userId) =>
      (userId === undefined
        ? db.prepare("SELECT * FROM accounts ORDER BY id").all()
        : db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY id").all(userId)
      ).map(hydrate),
    getAccount,

    spent: (month) => db.prepare("SELECT usd FROM spending WHERE month = ?").get(month)?.usd ?? 0,
    addSpend: (month, usd) =>
      db
        .prepare("INSERT INTO spending (month, usd) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd")
        .run(month, usd),

    countUsers: () => db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    listUsers: () => db.prepare("SELECT * FROM users ORDER BY id").all().map(toUser),
    getUser: (id) => toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    findLogin: (username) => {
      const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      return row && { ...toUser(row), passwordHash: row.password_hash };
    },
    /**
     * Adds a login with an empty account of its own. The first login also takes
     * over any accounts made before logins existed, so nothing is lost.
     */
    createUser({ username, passwordHash, isAdmin = false }) {
      db.exec("BEGIN");
      try {
        const id = Number(
          db
            .prepare("INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)")
            .run(username, passwordHash, isAdmin ? 1 : 0, now()).lastInsertRowid,
        );
        const { count } = db.prepare("SELECT COUNT(*) AS count FROM users").get();
        if (count === 1) db.prepare("UPDATE accounts SET user_id = ? WHERE user_id IS NULL").run(id);
        const owned = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE user_id = ?").get(id).count;
        if (!owned) insertAccount(username, id);
        db.exec("COMMIT");
        return id;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    setPassword(id, passwordHash) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    },
    /** Removes a login with all of its accounts and posts. */
    deleteUser(id) {
      db.prepare("DELETE FROM posts WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)").run(id);
      db.prepare("DELETE FROM accounts WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM invites WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
    },

    createSession: (tokenHash, userId, expiresAt) =>
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt),
    sessionUser: (tokenHash) =>
      toUser(
        db
          .prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?")
          .get(tokenHash, now()),
      ),
    deleteSession: (tokenHash) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash),

    /** An invite for a new person, or with userId, a link to set an existing person's password. */
    createInvite: (tokenHash, userId, expiresAt) =>
      db.prepare("INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt),
    findInvite(tokenHash) {
      const row = db.prepare("SELECT * FROM invites WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now());
      return row && { userId: row.user_id };
    },
    /** Uses up an invite. Returns false if it was already used, so a link works only once. */
    useInvite: (tokenHash) => db.prepare("DELETE FROM invites WHERE token_hash = ?").run(tokenHash).changes === 1,

    /**
     * Saves a LinkedIn connection for a login. The same person reconnecting
     * updates their account, and a new person gets their own, so one profile's
     * connection can never replace another's. A LinkedIn profile already
     * connected under someone else's login is refused. Returns the account ID.
     */
    saveConnection({ accessToken, expiresAt, personUrn, name, userId }) {
      const owner = db.prepare("SELECT id, user_id FROM accounts WHERE person_urn = ?").get(personUrn);
      if (owner && owner.user_id !== userId) {
        throw new Error("This LinkedIn profile is already connected by someone else in this app.");
      }
      const existing =
        owner ??
        db.prepare("SELECT id FROM accounts WHERE person_urn IS NULL AND user_id = ? ORDER BY id LIMIT 1").get(userId);
      const id = existing?.id ?? insertAccount(name, userId);
      db.prepare("UPDATE accounts SET name = ?, person_urn = ?, access_token = ?, expires_at = ? WHERE id = ?").run(
        name,
        personUrn,
        accessToken,
        expiresAt,
        id,
      );
      return Number(id);
    },
    disconnect: (id) => db.prepare("UPDATE accounts SET access_token = NULL, expires_at = NULL WHERE id = ?").run(id),
    deleteAccount(id) {
      db.prepare("DELETE FROM posts WHERE account_id = ?").run(id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    },

    saveSettings: (id, settings) =>
      db.prepare("UPDATE accounts SET settings = ? WHERE id = ?").run(JSON.stringify(settings), id),
    saveAnalysis: (id, analysis) =>
      db.prepare("UPDATE accounts SET analysis = ? WHERE id = ?").run(JSON.stringify(analysis), id),
    rename: (id, name) => db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id),

    markDailyRun: (id, date) =>
      db.prepare("UPDATE accounts SET daily_date = ?, daily_error = NULL WHERE id = ?").run(date, id),
    setDailyError: (id, error) => db.prepare("UPDATE accounts SET daily_error = ? WHERE id = ?").run(error, id),
    advancePillar: (id) => db.prepare("UPDATE accounts SET daily_index = daily_index + 1 WHERE id = ?").run(id),
    /** Daily posts still waiting: drafts for review, and ones scheduled but not yet published. */
    waitingDailyDrafts: (accountId) =>
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM posts WHERE account_id = ? AND origin = 'daily' AND status IN ('draft', 'scheduled')",
        )
        .get(accountId).count,

    listPosts: (accountId) =>
      db
        .prepare("SELECT * FROM posts WHERE account_id = ? ORDER BY created_at DESC, id DESC")
        .all(accountId)
        .map((post) => ({ ...post, sources: JSON.parse(post.sources) })),
    getPost(id) {
      const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
      return post ? { ...post, sources: JSON.parse(post.sources) } : undefined;
    },
    recentOpenings: (accountId, limit = 10) =>
      db
        .prepare("SELECT body FROM posts WHERE account_id = ? ORDER BY id DESC LIMIT ?")
        .all(accountId, limit)
        .map((row) => row.body.split("\n")[0]),

    createPost({ accountId, topic, notes = "", body, origin = "manual", pillarType = null, sources = [] }) {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO posts (account_id, topic, notes, body, origin, pillar_type, sources, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(accountId, topic, notes, body, origin, pillarType, JSON.stringify(sources), new Date().toISOString());
      return Number(lastInsertRowid);
    },
    updateBody: (id, body) => db.prepare("UPDATE posts SET body = ? WHERE id = ?").run(body, id),
    updateDraft: (id, body, sources) =>
      db.prepare("UPDATE posts SET body = ?, sources = ? WHERE id = ?").run(body, JSON.stringify(sources), id),
    schedule: (id, at) =>
      db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL WHERE id = ?").run(at, id),
    unschedule: (id) => db.prepare("UPDATE posts SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(id),
    deletePost: (id) => db.prepare("DELETE FROM posts WHERE id = ?").run(id),

    takenSlots: (accountId) =>
      db
        .prepare("SELECT scheduled_at FROM posts WHERE status = 'scheduled' AND account_id = ?")
        .all(accountId)
        .map((r) => r.scheduled_at),
    duePostIds: (nowIso) =>
      db
        .prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at")
        .all(nowIso)
        .map((r) => r.id),

    /** Atomically takes a post for publishing, so it can never go out twice. */
    claimForPublishing(id, fromStatuses) {
      const marks = fromStatuses.map(() => "?").join(", ");
      const { changes } = db
        .prepare(`UPDATE posts SET status = 'publishing', error = NULL WHERE id = ? AND status IN (${marks})`)
        .run(id, ...fromStatuses);
      return changes === 1;
    },
    markPublished: (id, urn) =>
      db
        .prepare("UPDATE posts SET status = 'published', linkedin_urn = ?, published_at = ? WHERE id = ?")
        .run(urn, new Date().toISOString(), id),
    markFailed: (id, error) => db.prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?").run(error, id),
  };
}
