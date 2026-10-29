import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { MAX_POST_LENGTH } from "./prompts.js";
import { draftNextPost } from "./daily.js";
import { publishPost } from "./publisher.js";
import { isValidTime, isValidTimeZone, nextSlot } from "./schedule.js";
import {
  INVITE_DAYS,
  MIN_PASSWORD,
  SESSION_DAYS,
  checkPassword,
  cleanUsername,
  createRateLimit,
  daysFromNow,
  hashPassword,
  hashToken,
  newToken,
  readCookie,
} from "./auth.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const EDITABLE = ["draft", "scheduled", "failed"];
const COOKIE = "sid";
const OAUTH_MINUTES = 10;

class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function checkBody(body) {
  if (typeof body !== "string" || !body.trim()) throw new UserError("The post is empty.");
  if (body.length > MAX_POST_LENGTH) {
    throw new UserError(`The post is ${body.length} characters. LinkedIn's limit is ${MAX_POST_LENGTH}.`);
  }
}

function sameSecret(given, expected) {
  const digest = (value) => createHash("sha256").update(String(value ?? "")).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function checkNewPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new UserError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  }
}

function checkUsername(value) {
  const username = cleanUsername(value);
  if (!username) throw new UserError("Use 3 to 32 letters, numbers, dots, dashes or underscores for the username.");
  return username;
}

/**
 * setupCode protects creating the very first login on a public address, so a
 * stranger can't claim the app before you do. appUrl is used for invite links.
 */
export function createApp({ store, ai, linkedin, dryRun, setupCode = null, model, appUrl = "", budget = null }) {
  const app = express();
  const deps = { store, linkedin, dryRun };
  const secureCookie = appUrl.startsWith("https://");
  const allowTry = createRateLimit();
  // LinkedIn sign-ins in progress: random state -> who started it.
  const oauthStates = new Map();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Hosts such as Railway put a proxy in front of the app.
  app.use("/api/accounts/:id/analyze", express.json({ limit: "15mb" }));
  app.use(express.json({ limit: "1mb" }));
  // Browsers won't send JSON from another site, so this blocks forged requests.
  app.post(/.*/, (req, res, next) => (req.is("json") ? next() : res.status(415).json({ error: "JSON required." })));

  app.use((req, res, next) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    req.user = token ? store.sessionUser(hashToken(token)) : null;
    next();
  });

  function signIn(res, userId) {
    const token = newToken();
    store.createSession(hashToken(token), userId, daysFromNow(SESSION_DAYS));
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      maxAge: SESSION_DAYS * 86400000,
      path: "/",
    });
  }

  function limitTries(req) {
    if (!allowTry(req.ip)) throw new UserError("Too many tries. Wait 15 minutes and try again.", 429);
  }

  const loadPost = (id, user) => {
    const post = store.getPost(Number(id));
    if (!post || store.getAccount(post.account_id)?.userId !== user.id) {
      throw new UserError("That post no longer exists.", 404);
    }
    return post;
  };
  const loadAccount = (id, user) => {
    const account = store.getAccount(Number(id));
    if (!account || account.userId !== user.id) throw new UserError("That account no longer exists.", 404);
    return account;
  };
  const requireStatus = (post, allowed) => {
    if (!allowed.includes(post.status)) throw new UserError(`This post is already ${post.status}.`, 409);
  };
  const nextFreeSlot = (account) => nextSlot(account.settings, store.takenSlots(account.id));

  function state(user, accountId) {
    const accounts = store.listAccounts(user.id);
    const account = accounts.find((a) => a.id === Number(accountId)) ?? accounts[0];
    return {
      user: { username: user.username, isAdmin: user.isAdmin },
      accounts: accounts.map(({ id, name, accessToken }) => ({ id, name, connected: Boolean(accessToken) })),
      account: {
        id: account.id,
        name: account.name,
        connected: Boolean(account.accessToken),
        expiresAt: account.expiresAt,
        dailyError: account.dailyError,
      },
      posts: store.listPosts(account.id),
      settings: account.settings,
      analysis: account.analysis,
      nextSlot: nextFreeSlot(account),
      dryRun,
      model,
      budget: budget?.status() ?? null,
      maxLength: MAX_POST_LENGTH,
      linkedinConfigured: linkedin.isConfigured(),
    };
  }

  // Signing in. These routes work without a login.

  app.get("/api/session", (req, res) => {
    const needsSetup = store.countUsers() === 0;
    res.json({
      user: req.user && { username: req.user.username, isAdmin: req.user.isAdmin },
      needsSetup,
      setupCodeRequired: needsSetup && Boolean(setupCode),
    });
  });

  app.post("/api/setup", async (req, res) => {
    limitTries(req);
    if (store.countUsers() > 0) throw new UserError("This app is already set up. Sign in instead.", 409);
    if (setupCode && !sameSecret(req.body.setupCode, setupCode)) throw new UserError("That setup code isn't right.", 403);
    const username = checkUsername(req.body.username);
    checkNewPassword(req.body.password);
    const id = store.createUser({ username, passwordHash: await hashPassword(req.body.password), isAdmin: true });
    signIn(res, id);
    res.status(201).json({ ok: true });
  });

  app.post("/api/login", async (req, res) => {
    limitTries(req);
    const login = store.findLogin(cleanUsername(req.body.username) ?? "");
    const ok = login && (await checkPassword(String(req.body.password ?? ""), login.passwordHash));
    if (!ok) throw new UserError("That username and password don't match.", 401);
    signIn(res, login.id);
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token) store.deleteSession(hashToken(token));
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/invites/:token", (req, res) => {
    const invite = store.findInvite(hashToken(req.params.token));
    if (!invite) throw new UserError("This link has expired or was already used. Ask for a new one.", 404);
    res.json({ username: invite.userId ? store.getUser(invite.userId)?.username : null });
  });

  app.post("/api/invites/:token", async (req, res) => {
    limitTries(req);
    const tokenHash = hashToken(req.params.token);
    const invite = store.findInvite(tokenHash);
    if (!invite) throw new UserError("This link has expired or was already used. Ask for a new one.", 404);
    checkNewPassword(req.body.password);
    const passwordHash = await hashPassword(req.body.password);

    let userId = invite.userId;
    if (!userId) {
      const username = checkUsername(req.body.username);
      if (store.findLogin(username)) throw new UserError("That username is taken. Pick another.", 409);
      if (!store.useInvite(tokenHash)) throw new UserError("This link was already used.", 409);
      userId = store.createUser({ username, passwordHash });
    } else {
      if (!store.useInvite(tokenHash)) throw new UserError("This link was already used.", 409);
      store.setPassword(userId, passwordHash);
    }
    signIn(res, userId);
    res.status(201).json({ ok: true });
  });

  // Everything below needs a login.
  app.use(["/api", "/auth/linkedin"], (req, res, next) => {
    if (!req.user) throw new UserError("Sign in first.", 401);
    next();
  });

  // Managing people. Only the person who set up the app can do this.
  const requireAdmin = (req) => {
    if (!req.user.isAdmin) throw new UserError("Only the app's owner can manage people.", 403);
  };
  const people = () => store.listUsers().map(({ id, username, isAdmin }) => ({ id, username, isAdmin }));
  const inviteLink = (userId) => {
    const token = newToken();
    store.createInvite(hashToken(token), userId, daysFromNow(INVITE_DAYS));
    return `${appUrl}/?invite=${token}`;
  };

  app.get("/api/people", (req, res) => {
    requireAdmin(req);
    res.json({ people: people() });
  });

  app.post("/api/people/invite", (req, res) => {
    requireAdmin(req);
    res.status(201).json({ link: inviteLink(null), people: people() });
  });

  app.post("/api/people/:id/reset", (req, res) => {
    requireAdmin(req);
    const user = store.getUser(Number(req.params.id));
    if (!user) throw new UserError("That person no longer exists.", 404);
    res.status(201).json({ link: inviteLink(user.id), people: people() });
  });

  app.delete("/api/people/:id", (req, res) => {
    requireAdmin(req);
    const user = store.getUser(Number(req.params.id));
    if (!user) throw new UserError("That person no longer exists.", 404);
    if (user.id === req.user.id) throw new UserError("You can't remove yourself.");
    store.deleteUser(user.id);
    res.json({ people: people() });
  });

  app.get("/api/state", (req, res) => res.json(state(req.user, req.query.account)));

  app.post("/api/accounts/:id/analyze", async (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    const { pdf, text } = req.body;
    if (pdf !== undefined) {
      if (typeof pdf !== "string" || !pdf.startsWith("JVBERi0")) throw new UserError("That file isn't a PDF.");
    } else if (typeof text !== "string" || text.trim().length < 50) {
      throw new UserError("Upload your profile PDF or paste your profile text.");
    }

    const analysis = await ai.analyze(pdf ? { pdf } : { text });
    store.saveAnalysis(account.id, { ...analysis, analyzedAt: new Date().toISOString() });
    if (!account.personUrn && analysis.name) store.rename(account.id, analysis.name);
    // Themes you've already edited are yours, so a re-check doesn't replace them.
    // Settings are read again because the analysis can take a minute.
    const { settings } = store.getAccount(account.id);
    if (!settings.pillars.length) store.saveSettings(account.id, { ...settings, pillars: analysis.pillars });
    res.json(state(req.user, account.id));
  });

  app.post("/api/accounts/:id/draft-next", async (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    if (!account.analysis) throw new UserError("Run the profile check first.");
    await draftNextPost({ store, ai }, account.id, "manual");
    res.status(201).json(state(req.user, account.id));
  });

  app.delete("/api/accounts/:id", (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    if (store.listAccounts(req.user.id).length === 1) throw new UserError("You can't remove your only account.");
    store.deleteAccount(account.id);
    res.json(state(req.user));
  });

  app.post("/api/accounts/:id/disconnect", (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    store.disconnect(account.id);
    res.json(state(req.user, account.id));
  });

  app.post("/api/accounts/:id/posts", async (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    const topic = String(req.body.topic ?? "").trim();
    const notes = String(req.body.notes ?? "").trim();
    if (!topic) throw new UserError("Enter a topic first.");

    const { settings, analysis } = account;
    const { text, sources } = await ai.write({
      topic,
      notes,
      voice: settings.voice,
      profile: analysis,
      recentOpenings: store.recentOpenings(account.id),
    });
    const id = store.createPost({ accountId: account.id, topic, notes, body: text, sources });

    if (settings.autoApprove && text.length <= MAX_POST_LENGTH) {
      const slot = nextFreeSlot(account);
      if (slot) store.schedule(id, slot);
    }
    res.status(201).json(state(req.user, account.id));
  });

  app.post("/api/posts/:id/update", (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, EDITABLE);
    if (typeof req.body.body !== "string") throw new UserError("The post is empty.");
    store.updateBody(post.id, req.body.body);
    res.json(state(req.user, post.account_id));
  });

  app.post("/api/posts/:id/regenerate", async (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, ["draft", "failed"]);
    const { settings, analysis } = loadAccount(post.account_id, req.user);
    const { text, sources } = await ai.write({
      topic: post.topic,
      notes: post.notes,
      voice: settings.voice,
      profile: analysis,
      learning: settings.learning,
      pillar: post.pillar_type ? { name: post.topic, type: post.pillar_type } : null,
      previous: post.body,
      feedback: String(req.body.feedback ?? "").trim(),
    });
    store.updateDraft(post.id, text, sources);
    res.json(state(req.user, post.account_id));
  });

  app.post("/api/posts/:id/schedule", (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, EDITABLE);
    checkBody(post.body);

    let at = nextFreeSlot(loadAccount(post.account_id, req.user));
    if (req.body.at) {
      const time = Date.parse(req.body.at);
      if (Number.isNaN(time)) throw new UserError("That date isn't valid.");
      if (time <= Date.now()) throw new UserError("Pick a time in the future.");
      at = new Date(time).toISOString();
    }
    if (!at) throw new UserError("Pick at least one posting day in Schedule settings.");
    store.schedule(post.id, at);
    res.json(state(req.user, post.account_id));
  });

  app.post("/api/posts/:id/unschedule", (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, ["scheduled", "failed"]);
    store.unschedule(post.id);
    res.json(state(req.user, post.account_id));
  });

  app.post("/api/posts/:id/publish", async (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, EDITABLE);
    checkBody(post.body);
    await publishPost(deps, post.id, EDITABLE);
    res.json(state(req.user, post.account_id));
  });

  app.delete("/api/posts/:id", (req, res) => {
    const post = loadPost(req.params.id, req.user);
    requireStatus(post, [...EDITABLE, "published"]);
    store.deletePost(post.id);
    res.json(state(req.user, post.account_id));
  });

  app.post("/api/accounts/:id/settings", (req, res) => {
    const account = loadAccount(req.params.id, req.user);
    const next = { ...account.settings };
    const { days, time, draftTime, timezone, voice, learning, autoApprove, dailyDrafts, autoPostDaily, pillars } = req.body;

    if (days !== undefined) {
      if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        throw new UserError("Those posting days aren't valid.");
      }
      next.days = days;
    }
    for (const [key, value] of [["time", time], ["draftTime", draftTime]]) {
      if (value === undefined) continue;
      if (!isValidTime(value)) throw new UserError("That time isn't valid.");
      next[key] = value;
    }
    if (timezone !== undefined) {
      if (!isValidTimeZone(timezone)) throw new UserError(`"${timezone}" isn't a time zone I recognize.`);
      next.timezone = timezone;
    }
    if (pillars !== undefined) {
      const valid =
        Array.isArray(pillars) &&
        pillars.every((p) => p?.name?.trim() && ["expertise", "news", "learning"].includes(p.type));
      if (!valid) throw new UserError("Every content theme needs a name.");
      next.pillars = pillars.map(({ name, description, type }) => ({
        name: name.trim(),
        description: String(description ?? "").trim(),
        type,
      }));
    }
    if (voice !== undefined) next.voice = String(voice);
    if (learning !== undefined) next.learning = String(learning);
    if (autoApprove !== undefined) next.autoApprove = Boolean(autoApprove);
    if (dailyDrafts !== undefined) next.dailyDrafts = Boolean(dailyDrafts);
    if (autoPostDaily !== undefined) next.autoPostDaily = Boolean(autoPostDaily);

    store.saveSettings(account.id, next);
    res.json(state(req.user, account.id));
  });

  app.get("/auth/linkedin", (req, res) => {
    if (!linkedin.isConfigured()) throw new UserError("Add your LinkedIn app credentials to .env first.");
    const oauthState = randomBytes(24).toString("hex");
    const now = Date.now();
    for (const [key, entry] of oauthStates) if (entry.expires < now) oauthStates.delete(key);
    oauthStates.set(oauthState, { userId: req.user.id, expires: now + OAUTH_MINUTES * 60000 });
    res.redirect(linkedin.authorizeUrl(oauthState));
  });

  app.get("/auth/linkedin/callback", async (req, res) => {
    const { code, state: returnedState, error, error_description: description } = req.query;
    const started = oauthStates.get(String(returnedState));
    oauthStates.delete(String(returnedState));
    if (!started || started.expires < Date.now() || started.userId !== req.user.id) {
      throw new UserError("That sign-in link expired. Try connecting again.");
    }
    if (error) throw new UserError(`LinkedIn sign-in didn't complete: ${description ?? error}`);
    const connection = await linkedin.exchangeCode(String(code));
    let id;
    try {
      id = store.saveConnection({ ...connection, userId: req.user.id });
    } catch (err) {
      throw new UserError(err.message, 409);
    }
    res.redirect(`/?account=${id}`);
  });

  app.use(express.static(publicDir));

  // Express 5 sends errors from async routes here too.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? 500;
    if (status >= 500 && !(err instanceof UserError)) console.error(err);
    if (req.path.startsWith("/api/")) return res.status(status).json({ error: err.message });
    res.status(status).type("text").send(err.message);
  });

  return app;
}
