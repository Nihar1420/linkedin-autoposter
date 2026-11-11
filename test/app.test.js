import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db.js";
import { createLinkedIn, escapeForLinkedIn } from "../src/linkedin.js";
import { runDailyDrafts } from "../src/daily.js";
import { publishDuePosts } from "../src/publisher.js";
import { createApp } from "../src/server.js";
import { hashToken } from "../src/auth.js";

// A stand-in for LinkedIn's servers that records what it receives.
const received = [];
let failNextPost = 0;
const fakeLinkedIn = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.url === "/oauth/v2/accessToken") {
      received.push({ url: req.url, form: new URLSearchParams(raw) });
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ access_token: "tok", expires_in: 5184000 }));
    }
    if (req.url === "/v2/userinfo") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ sub: "abc123", name: "Test Person" }));
    }
    if (req.url === "/rest/posts") {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      if (failNextPost) {
        const status = failNextPost;
        failNextPost = 0;
        res.statusCode = status;
        return res.end("nope");
      }
      res.statusCode = 201;
      res.setHeader("x-restli-id", "urn:li:share:999");
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
});

let server;
let base;
let liBase;
let store;
let linkedin;
let aiCalls;
let userId;
const COOKIE = "sid=tester-token";
const authFetch = (url, options = {}) => fetch(url, { ...options, headers: { cookie: COOKIE, ...options.headers } });
let analyzeCalls;
const ANALYSIS = {
  name: "Test Person",
  summary: "Forward Deployed Engineer at Acme.",
  positioning: "The FDE who ships",
  audience: "FDEs",
  score: 62,
  verdict: "Solid.",
  sections: [{ name: "Headline", score: 50, finding: "Vague." }],
  fixes: [{ title: "Sharpen headline", why: "Search.", suggestedText: "FDE at Acme" }],
  pillars: [
    { name: "The ideal FDE", description: "", type: "expertise" },
    { name: "New for FDEs", description: "", type: "news" },
    { name: "What I'm learning", description: "", type: "learning" },
  ],
};
let aiError;

async function startApp(options = {}) {
  store = openStore(":memory:");
  aiCalls = [];
  analyzeCalls = [];
  aiError = null;
  const ai = {
    write: async (input) => {
      aiCalls.push(input);
      if (aiError) throw new Error(aiError);
      return { text: `Draft about ${input.topic ?? input.pillar.name}`, sources: [] };
    },
    analyze: async (input) => {
      analyzeCalls.push(input);
      return ANALYSIS;
    },
  };
  linkedin = createLinkedIn({
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://localhost/auth/linkedin/callback",
    apiVersion: "202610",
    apiBase: liBase,
    authBase: liBase,
  });
  userId = store.createUser({ username: "tester", passwordHash: "unused", isAdmin: true });
  store.createSession(hashToken("tester-token"), userId, new Date(Date.now() + 86400000).toISOString());
  const app = createApp({ store, ai, linkedin, dryRun: false, model: "test", appUrl: "https://app.example", ...options });
  await new Promise((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
}

const post = async (path, body = {}, headers = {}) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: COOKIE, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

const connect = () =>
  store.saveConnection({
    accessToken: "tok",
    personUrn: "urn:li:person:abc123",
    name: "Test Person",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    userId,
  });

before(async () => {
  await new Promise((resolve) => fakeLinkedIn.listen(0, "127.0.0.1", resolve));
  liBase = `http://127.0.0.1:${fakeLinkedIn.address().port}`;
});
after(() => fakeLinkedIn.close());
beforeEach(async () => {
  received.length = 0;
  failNextPost = 0;
  server?.close();
  await startApp();
});
after(() => server?.close());

test("escapes LinkedIn's reserved characters but keeps hashtags", () => {
  assert.equal(escapeForLinkedIn("Hi (there) @you a_b *c* #tag"), "Hi \\(there\\) \\@you a\\_b \\*c\\* #tag");
  assert.equal(escapeForLinkedIn("back\\slash [x] {y} <z> ~ |"), "back\\\\slash \\[x\\] \\{y\\} \\<z\\> \\~ \\|");
});

test("topic becomes a draft and nothing is published without approval", async () => {
  const { status, data } = await post("/api/accounts/1/posts", { topic: "Testing", notes: "Some notes" });
  assert.equal(status, 201);
  assert.equal(data.posts[0].status, "draft");
  assert.equal(data.posts[0].body, "Draft about Testing");
  assert.equal(aiCalls[0].notes, "Some notes");

  connect();
  await publishDuePosts({ store, linkedin, dryRun: false });
  assert.equal(received.length, 0);
});

test("a due post is sent to LinkedIn once, in the documented format", async () => {
  connect();
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const id = data.posts[0].id;
  store.updateBody(id, "Hello (world) #tag");
  store.schedule(id, new Date(Date.now() - 1000).toISOString());

  const deps = { store, linkedin, dryRun: false };
  await Promise.all([publishDuePosts(deps), publishDuePosts(deps)]);
  await publishDuePosts(deps);

  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.headers.authorization, "Bearer tok");
  assert.equal(sent.headers["linkedin-version"], "202610");
  assert.equal(sent.headers["x-restli-protocol-version"], "2.0.0");
  assert.equal(sent.body.author, "urn:li:person:abc123");
  assert.equal(sent.body.commentary, "Hello \\(world\\) #tag");
  assert.equal(sent.body.visibility, "PUBLIC");
  assert.equal(sent.body.lifecycleState, "PUBLISHED");

  const saved = store.getPost(id);
  assert.equal(saved.status, "published");
  assert.equal(saved.linkedin_urn, "urn:li:share:999");
});

test("posts that aren't due yet stay scheduled", async () => {
  connect();
  const { data } = await post("/api/accounts/1/posts", { topic: "Later" });
  const id = data.posts[0].id;
  await post(`/api/posts/${id}/schedule`);
  await publishDuePosts({ store, linkedin, dryRun: false });
  assert.equal(received.length, 0);
  assert.equal(store.getPost(id).status, "scheduled");
});

test("dry run never contacts LinkedIn", async () => {
  server.close();
  await startApp({ dryRun: true });
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const result = await post(`/api/posts/${data.posts[0].id}/publish`);
  assert.equal(result.data.posts[0].status, "published");
  assert.match(result.data.posts[0].linkedin_urn, /^dry-run:/);
  assert.equal(received.length, 0);
});

test("a failed post is kept with its reason and isn't retried automatically", async () => {
  connect();
  failNextPost = 500;
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const id = data.posts[0].id;
  store.schedule(id, new Date(Date.now() - 1000).toISOString());

  const deps = { store, linkedin, dryRun: false };
  await publishDuePosts(deps);
  await publishDuePosts(deps);
  assert.equal(received.length, 1);
  assert.equal(store.getPost(id).status, "failed");
  assert.match(store.getPost(id).error, /500/);

  const retry = await post(`/api/posts/${id}/publish`);
  assert.equal(retry.data.posts[0].status, "published");
});

test("an expired connection fails with a clear message before calling LinkedIn", async () => {
  store.saveConnection({ accessToken: "t", personUrn: "u", name: "n", expiresAt: "2020-01-01T00:00:00Z", userId });
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const result = await post(`/api/posts/${data.posts[0].id}/publish`);
  assert.equal(result.data.posts[0].status, "failed");
  assert.match(result.data.posts[0].error, /expired/);
  assert.equal(received.length, 0);
});

test("post without review schedules the draft in the next open slot", async () => {
  await post("/api/accounts/1/settings", { days: [1], time: "09:00", timezone: "UTC", autoApprove: true });
  const first = await post("/api/accounts/1/posts", { topic: "One" });
  const second = await post("/api/accounts/1/posts", { topic: "Two" });
  const [two, one] = second.data.posts;
  assert.equal(first.data.posts[0].status, "scheduled");
  assert.equal(two.status, "scheduled");
  assert.notEqual(one.scheduled_at, two.scheduled_at);
});

test("rejects posts over LinkedIn's limit and already-published posts", async () => {
  connect();
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const id = data.posts[0].id;
  await post(`/api/posts/${id}/update`, { body: "x".repeat(3001) });
  const tooLong = await post(`/api/posts/${id}/publish`);
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error, /3001/);

  await post(`/api/posts/${id}/update`, { body: "ok" });
  await post(`/api/posts/${id}/publish`);
  const again = await post(`/api/posts/${id}/publish`);
  assert.equal(again.status, 409);
  assert.equal(received.length, 1);
});

test("a Claude error is shown to the user and creates no post", async () => {
  aiError = "ANTHROPIC_API_KEY isn't set yet.";
  const { status, data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  assert.equal(status, 500);
  assert.equal(data.error, "ANTHROPIC_API_KEY isn't set yet.");
  assert.equal(store.listPosts(1).length, 0);
});

test("rewrite passes the previous draft and feedback to Claude", async () => {
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  await post(`/api/posts/${data.posts[0].id}/regenerate`, { feedback: "Shorter" });
  assert.equal(aiCalls[1].previous, "Draft about Testing");
  assert.equal(aiCalls[1].feedback, "Shorter");
});

test("LinkedIn sign-in rejects a forged state and accepts the real one", async () => {
  const forged = await authFetch(`${base}/auth/linkedin/callback?code=x&state=forged`);
  assert.equal(forged.status, 400);
  assert.equal(store.getAccount(1).accessToken, null);

  const start = await authFetch(`${base}/auth/linkedin`, { redirect: "manual" });
  const authUrl = new URL(start.headers.get("location"));
  assert.equal(authUrl.searchParams.get("scope"), "openid profile w_member_social");

  const state = authUrl.searchParams.get("state");
  const done = await authFetch(`${base}/auth/linkedin/callback?code=good&state=${state}`, { redirect: "manual" });
  assert.equal(done.status, 302);
  assert.equal(received[0].form.get("code"), "good");
  const account = store.getAccount(1);
  assert.equal(account.personUrn, "urn:li:person:abc123");
  assert.equal(account.name, "Test Person");
  assert.ok(Date.parse(account.expiresAt) > Date.now() + 59 * 86400000);
});

test("every API route and LinkedIn sign-in needs a login", async () => {
  for (const path of ["/api/state", "/api/people"]) assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(`${base}/auth/linkedin`, { redirect: "manual" })).status, 401);
  const forged = { cookie: "sid=made-up" };
  assert.equal((await fetch(`${base}/api/state`, { headers: forged })).status, 401);
  assert.equal((await authFetch(`${base}/api/state`)).status, 200);
});

test("POST requests that aren't JSON are refused", async () => {
  const { data } = await post("/api/accounts/1/posts", { topic: "Testing" });
  const res = await authFetch(`${base}/api/posts/${data.posts[0].id}/publish`, { method: "POST" });
  assert.equal(res.status, 415);
  assert.equal(store.getPost(data.posts[0].id).status, "draft");
});

test("a profile check saves the analysis, themes and name", async () => {
  const { status, data } = await post("/api/accounts/1/analyze", { pdf: "JVBERi0xLjQK" });
  assert.equal(status, 200);
  assert.equal(data.analysis.score, 62);
  assert.equal(data.settings.pillars.length, 3);
  assert.equal(data.account.name, "Test Person");
  assert.equal(analyzeCalls[0].pdf, "JVBERi0xLjQK");
});

test("a profile check rejects files that aren't PDFs and text that's too short", async () => {
  assert.equal((await post("/api/accounts/1/analyze", { pdf: "aGVsbG8=" })).status, 400);
  assert.equal((await post("/api/accounts/1/analyze", { text: "short" })).status, 400);
  assert.equal(analyzeCalls.length, 0);
});

test("a large PDF is accepted", async () => {
  const pdf = "JVBERi0" + "A".repeat(5 * 1024 * 1024);
  assert.equal((await post("/api/accounts/1/analyze", { pdf })).status, 200);
});

test("a re-check keeps themes you edited", async () => {
  await post("/api/accounts/1/settings", {
    timezone: "UTC",
    pillars: [{ name: "Mine", description: "", type: "expertise" }],
  });
  const { data } = await post("/api/accounts/1/analyze", { pdf: "JVBERi0xLjQK" });
  assert.deepEqual(data.settings.pillars.map((p) => p.name), ["Mine"]);
});

test("typed topics are written using the profile", async () => {
  await post("/api/accounts/1/analyze", { pdf: "JVBERi0xLjQK" });
  await post("/api/accounts/1/posts", { topic: "Testing" });
  assert.equal(aiCalls[0].profile.positioning, "The FDE who ships");
});

async function setUpDaily(extra = {}) {
  await post("/api/accounts/1/analyze", { pdf: "JVBERi0xLjQK" });
  await post("/api/accounts/1/settings", { timezone: "UTC", draftTime: "08:00", autoPostDaily: false, ...extra });
}
const at = (iso) => new Date(iso);

test("daily drafts run once a day after the draft time and wait for approval", async () => {
  await setUpDaily({ learning: "Agent evals" });
  const deps = { store, ai: { write: async (i) => ({ text: i.pillar.name, sources: [] }) } };

  await runDailyDrafts(deps, at("2026-11-06T07:59:00Z"));
  assert.equal(store.listPosts(1).length, 0);

  await Promise.all([runDailyDrafts(deps, at("2026-11-06T08:00:00Z")), runDailyDrafts(deps, at("2026-11-06T08:00:30Z"))]);
  await runDailyDrafts(deps, at("2026-11-06T20:00:00Z"));
  const posts = store.listPosts(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, "draft");
  assert.equal(posts[0].origin, "daily");

  await runDailyDrafts(deps, at("2026-11-07T08:00:00Z"));
  assert.equal(store.listPosts(1).length, 2);
});

test("with auto-post on, each daily draft is scheduled for the next posting time", async () => {
  await setUpDaily({ days: [0, 1, 2, 3, 4, 5, 6], time: "09:00", autoPostDaily: true });
  const sources = [{ url: "https://example.com", title: "Example" }];
  const deps = { store, ai: { write: async (i) => ({ text: `About ${i.pillar.name}`, sources }) } };
  await runDailyDrafts(deps, at("2026-11-06T08:00:00Z"));
  const [first] = store.listPosts(1);
  assert.equal(first.status, "scheduled");
  assert.equal(first.scheduled_at, "2026-11-06T09:00:00.000Z");

  await runDailyDrafts(deps, at("2026-11-07T08:00:00Z"));
  assert.equal(store.listPosts(1)[0].scheduled_at, "2026-11-07T09:00:00.000Z");
});

test("a working day with auto-post: drafted at 10:00, on LinkedIn at 11:00, with nobody clicking", async () => {
  connect();
  await setUpDaily({ days: [1, 2, 3, 4, 5], time: "11:00", draftTime: "10:00", timezone: "Asia/Calcutta", autoPostDaily: true });
  const sources = [{ url: "https://example.com", title: "Example" }];
  const deps = { store, ai: { write: async (i) => ({ text: `About ${i.pillar.name}`, sources }) } };
  const publish = (iso) => publishDuePosts({ store, linkedin, dryRun: false }, at(iso));

  // Monday 9 November 2026. India is 5:30 ahead of UTC, so 10:00 there is 04:30 UTC.
  await runDailyDrafts(deps, at("2026-11-09T04:29:00Z"));
  assert.equal(store.listPosts(1).length, 0, "nothing before the draft time");
  await runDailyDrafts(deps, at("2026-11-09T04:30:00Z"));
  const [draft] = store.listPosts(1);
  assert.equal(draft.status, "scheduled");
  assert.equal(draft.scheduled_at, "2026-11-09T05:30:00.000Z");

  await publish("2026-11-09T05:29:00Z");
  assert.equal(received.length, 0, "not before the posting time");
  await publish("2026-11-09T05:30:00Z");
  await publish("2026-11-09T05:31:00Z");
  assert.equal(received.length, 1, "posted exactly once");
  assert.equal(store.getPost(draft.id).status, "published");
  assert.equal(store.getPost(draft.id).linkedin_urn, "urn:li:share:999");
});

test("if the Mac was asleep at posting time, the post goes out as soon as the app runs again", async () => {
  connect();
  await setUpDaily({ days: [1, 2, 3, 4, 5], time: "11:00", draftTime: "10:00", timezone: "Asia/Calcutta", autoPostDaily: true });
  const sources = [{ url: "https://example.com", title: "Example" }];
  const deps = { store, ai: { write: async () => ({ text: "x", sources }) } };
  await runDailyDrafts(deps, at("2026-11-09T04:30:00Z"));
  await publishDuePosts({ store, linkedin, dryRun: false }, at("2026-11-09T09:00:00Z"));
  assert.equal(received.length, 1);
});

test("a draft written after the day's posting time waits for the next working day, never a weekend", async () => {
  connect();
  await setUpDaily({ days: [1, 2, 3, 4, 5], time: "11:00", draftTime: "10:00", timezone: "Asia/Calcutta", autoPostDaily: true });
  const sources = [{ url: "https://example.com", title: "Example" }];
  const deps = { store, ai: { write: async () => ({ text: "x", sources }) } };
  // Friday 13 November, Mac turned on at 14:00 India time.
  await runDailyDrafts(deps, at("2026-11-13T08:30:00Z"));
  assert.equal(store.listPosts(1)[0].scheduled_at, "2026-11-16T05:30:00.000Z", "Monday 11:00");
});

test("auto-post posts a researched draft even when it has nothing to cite", async () => {
  await setUpDaily({ days: [5], autoPostDaily: true });
  store.advancePillar(1); // The next theme is the researched one.
  const deps = { store, ai: { write: async () => ({ text: "A general post", sources: [] }) } };
  await runDailyDrafts(deps, at("2026-11-06T08:00:00Z"));
  assert.equal(store.listPosts(1)[0].status, "scheduled");
  assert.equal(store.getAccount(1).dailyError, null);
});

test("new accounts post automatically on weekdays at 11:00", () => {
  const { settings } = store.getAccount(1);
  assert.deepEqual(settings.days, [1, 2, 3, 4, 5]);
  assert.equal(settings.time, "11:00");
  assert.equal(settings.draftTime, "10:00");
  assert.equal(settings.autoPostDaily, true);
});

test("auto-post stops writing while three daily posts are queued", async () => {
  await setUpDaily({ days: [1], autoPostDaily: true });
  let writes = 0;
  const sources = [{ url: "https://example.com", title: "Example" }];
  const deps = { store, ai: { write: async () => (writes++, { text: "x", sources }) } };
  for (const day of ["06", "07", "08", "09", "10"]) await runDailyDrafts(deps, at(`2026-11-${day}T09:00:00Z`));
  assert.equal(writes, 3);
  assert.ok(store.listPosts(1).every((p) => p.status === "scheduled"));
});

test("daily drafts take turns through the themes", async () => {
  await setUpDaily({ learning: "Agent evals" });
  const deps = { store, ai: { write: async (i) => ({ text: i.pillar.name, sources: [] }) } };
  for (const day of ["06", "07", "08"]) await runDailyDrafts(deps, at(`2026-11-${day}T09:00:00Z`));
  const topics = store.listPosts(1).map((p) => p.topic).reverse();
  assert.deepEqual(topics, ["The ideal FDE", "New for FDEs", "What I'm learning"]);
});

test("a learning post is skipped until there's something real to say", async () => {
  await setUpDaily({ learning: "   " });
  const seen = [];
  const deps = { store, ai: { write: async (i) => (seen.push(i.pillar.type), { text: "x", sources: [] }) } };
  for (const day of ["06", "07", "08"]) await runDailyDrafts(deps, at(`2026-11-${day}T09:00:00Z`));
  assert.ok(!seen.includes("learning"));
});

test("daily drafts stop while three are waiting, so unread drafts don't cost money", async () => {
  await setUpDaily();
  let writes = 0;
  const deps = { store, ai: { write: async () => (writes++, { text: "x", sources: [] }) } };
  for (const day of ["06", "07", "08", "09", "10"]) await runDailyDrafts(deps, at(`2026-11-${day}T09:00:00Z`));
  assert.equal(writes, 3);
});

test("daily drafts are skipped when switched off or before a profile check", async () => {
  let writes = 0;
  const deps = { store, ai: { write: async () => (writes++, { text: "x", sources: [] }) } };
  await post("/api/accounts/1/settings", { timezone: "UTC" });
  await runDailyDrafts(deps, at("2026-11-06T09:00:00Z"));
  await setUpDaily({ dailyDrafts: false });
  await runDailyDrafts(deps, at("2026-11-07T09:00:00Z"));
  assert.equal(writes, 0);
});

test("a failed daily draft shows its error and isn't retried until tomorrow", async () => {
  await setUpDaily();
  let tries = 0;
  const deps = { store, ai: { write: async () => { tries++; throw new Error("Claude is down"); } } };
  await runDailyDrafts(deps, at("2026-11-06T09:00:00Z"));
  await runDailyDrafts(deps, at("2026-11-06T09:01:00Z"));
  assert.equal(tries, 1);
  assert.equal(store.getAccount(1).dailyError, "Today's draft couldn't be written: Claude is down");
  const good = { store, ai: { write: async () => ({ text: "x", sources: [] }) } };
  await runDailyDrafts(good, at("2026-11-07T09:00:00Z"));
  assert.equal(store.getAccount(1).dailyError, null);
});

test("sources are kept on the draft and replaced on rewrite", async () => {
  await setUpDaily();
  const url = "https://example.com/a";
  const deps = { store, ai: { write: async () => ({ text: "x", sources: [{ url, title: "A" }] }) } };
  await runDailyDrafts(deps, at("2026-11-06T09:00:00Z"));
  const [saved] = store.listPosts(1);
  assert.deepEqual(saved.sources, [{ url, title: "A" }]);
  const { data } = await post(`/api/posts/${saved.id}/regenerate`, {});
  assert.deepEqual(data.posts[0].sources, []);
});

test("each account has its own posts, slots, settings and connection", async () => {
  const one = connect();
  const two = store.saveConnection({
    accessToken: "tok2",
    personUrn: "urn:li:person:two",
    name: "Second Person",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    userId,
  });
  assert.notEqual(one, two);
  await post(`/api/accounts/${two}/settings`, { timezone: "UTC", voice: "Second voice" });
  await post(`/api/accounts/${one}/settings`, { timezone: "UTC" });
  const a = await post(`/api/accounts/${one}/posts`, { topic: "A" });
  const b = await post(`/api/accounts/${two}/posts`, { topic: "B" });
  assert.deepEqual(a.data.posts.map((p) => p.topic), ["A"]);
  assert.deepEqual(b.data.posts.map((p) => p.topic), ["B"]);
  assert.equal(aiCalls[1].voice, "Second voice");

  const scheduledA = await post(`/api/posts/${a.data.posts[0].id}/schedule`);
  const scheduledB = await post(`/api/posts/${b.data.posts[0].id}/schedule`);
  assert.equal(scheduledA.data.posts[0].scheduled_at, scheduledB.data.posts[0].scheduled_at);

  await post(`/api/posts/${b.data.posts[0].id}/publish`);
  assert.equal(received.at(-1).headers.authorization, "Bearer tok2");
  assert.equal(received.at(-1).body.author, "urn:li:person:two");
});

test("reconnecting updates that person's account without creating another", async () => {
  const first = connect();
  const again = store.saveConnection({
    accessToken: "fresh",
    personUrn: "urn:li:person:abc123",
    name: "Test Person",
    expiresAt: "2030-01-01T00:00:00Z",
    userId,
  });
  assert.equal(first, again);
  assert.equal(store.listAccounts().length, 1);
  assert.equal(store.getAccount(first).accessToken, "fresh");
});

test("removing an account deletes its posts, but the last account stays", async () => {
  const one = connect();
  const two = store.saveConnection({ accessToken: "t", personUrn: "p2", name: "Two", expiresAt: "2030-01-01T00:00:00Z", userId });
  await post(`/api/accounts/${two}/posts`, { topic: "B" });
  await authFetch(`${base}/api/accounts/${two}`, { method: "DELETE" });
  assert.equal(store.listAccounts().length, 1);
  assert.equal(store.listPosts(two).length, 0);
  const last = await authFetch(`${base}/api/accounts/${one}`, { method: "DELETE" });
  assert.equal(last.status, 400);
});

test("a database from the first version keeps its posts, settings and connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoposter-"));
  const old = new DatabaseSync(join(dir, "app.db"));
  old.exec(`
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', scheduled_at TEXT, published_at TEXT,
      linkedin_urn TEXT, error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO posts (topic, body, status, created_at) VALUES ('Old', 'Old body', 'scheduled', '2026-11-01');
  `);
  old.prepare("INSERT INTO kv VALUES (?, ?)").run("settings", JSON.stringify({ time: "10:30", timezone: "Asia/Kolkata" }));
  old.prepare("INSERT INTO kv VALUES (?, ?)").run(
    "linkedin",
    JSON.stringify({ accessToken: "old", personUrn: "urn:li:person:old", name: "Old Name", expiresAt: "2030-01-01" }),
  );
  old.close();

  for (let i = 0; i < 2; i++) {
    const migrated = openStore(dir);
    const [account] = migrated.listAccounts();
    assert.equal(migrated.listAccounts().length, 1);
    assert.equal(account.name, "Old Name");
    assert.equal(account.accessToken, "old");
    assert.equal(account.settings.time, "10:30");
    assert.equal(account.settings.dailyDrafts, true);
    const [oldPost] = migrated.listPosts(account.id);
    assert.equal(oldPost.body, "Old body");
    assert.deepEqual(oldPost.sources, []);
  }
  rmSync(dir, { recursive: true, force: true });
});
