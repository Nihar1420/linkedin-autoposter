import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { openStore } from "../src/db.js";
import { createApp } from "../src/server.js";

let server;
let base;
let store;
const linkedin = { isConfigured: () => true, authorizeUrl: (state) => `https://linkedin.example/auth?state=${state}` };
const ai = { write: async () => ({ text: "Draft", sources: [] }), analyze: async () => ({}) };

async function startApp(options = {}) {
  store = openStore(":memory:");
  const app = createApp({ store, ai, linkedin, dryRun: true, model: "test", appUrl: "https://app.example", ...options });
  await new Promise((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => startApp());
afterEach(() => server.close());

/** A browser with its own cookie. */
function browser() {
  let cookie = "";
  const send = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return {
    get: (path) => send("GET", path),
    post: (path, body = {}) => send("POST", path, body),
    delete: (path) => send("DELETE", path),
    cookie: () => cookie,
  };
}

async function owner() {
  const me = browser();
  await me.post("/api/setup", { username: "Nihar", password: "owner-pass-1" });
  return me;
}

async function invited(me, username) {
  const { data } = await me.post("/api/people/invite");
  const token = new URL(data.link).searchParams.get("invite");
  const them = browser();
  const res = await them.post(`/api/invites/${token}`, { username, password: "their-pass-1" });
  return { them, token, res };
}

test("the first person creates the owner login and takes over existing accounts", async () => {
  const anon = browser();
  assert.deepEqual((await anon.get("/api/session")).data, { user: null, needsSetup: true, setupCodeRequired: false });
  const me = await owner();
  const { data } = await me.get("/api/state");
  assert.deepEqual(data.user, { username: "nihar", isAdmin: true });
  assert.equal(data.account.id, 1);
  assert.equal((await browser().post("/api/setup", { username: "late", password: "whatever-1" })).status, 409);
});

test("on a public address, setting up needs the setup code", async () => {
  server.close();
  await startApp({ setupCode: "open-sesame" });
  const anon = browser();
  assert.equal((await anon.get("/api/session")).data.setupCodeRequired, true);
  assert.equal((await anon.post("/api/setup", { username: "nihar", password: "owner-pass-1" })).status, 403);
  assert.equal(
    (await anon.post("/api/setup", { username: "nihar", password: "owner-pass-1", setupCode: "open-sesame" })).status,
    201,
  );
});

test("signing in and out", async () => {
  await owner();
  const me = browser();
  assert.equal((await me.post("/api/login", { username: "nihar", password: "wrong-pass" })).status, 401);
  assert.equal((await me.post("/api/login", { username: "NIHAR", password: "owner-pass-1" })).status, 200);
  assert.equal((await me.get("/api/state")).status, 200);
  await me.post("/api/logout");
  assert.equal((await me.get("/api/state")).status, 401);
});

test("passwords must be long enough and usernames simple", async () => {
  const anon = browser();
  assert.equal((await anon.post("/api/setup", { username: "nihar", password: "short" })).status, 400);
  assert.equal((await anon.post("/api/setup", { username: "a b", password: "long-enough-1" })).status, 400);
});

test("an invite link adds a person with their own empty account, and works only once", async () => {
  const me = await owner();
  const { them, token, res } = await invited(me, "Priya");
  assert.equal(res.status, 201);
  const { data } = await them.get("/api/state");
  assert.deepEqual(data.user, { username: "priya", isAdmin: false });
  assert.notEqual(data.account.id, 1);
  assert.equal(data.posts.length, 0);

  const again = await browser().post(`/api/invites/${token}`, { username: "someone", password: "their-pass-1" });
  assert.equal(again.status, 404);
  assert.equal(store.listUsers().length, 2);
});

test("people can't see or change each other's accounts and posts", async () => {
  const me = await owner();
  const { data: mine } = await me.post("/api/accounts/1/posts", { topic: "Mine" });
  const postId = mine.posts[0].id;
  const { them } = await invited(me, "priya");

  assert.equal((await them.get("/api/state?account=1")).data.account.id === 1, false);
  assert.equal((await them.post("/api/accounts/1/settings", { voice: "hacked" })).status, 404);
  assert.equal((await them.post(`/api/posts/${postId}/update`, { body: "hacked" })).status, 404);
  assert.equal((await them.post(`/api/posts/${postId}/publish`)).status, 404);
  assert.equal((await them.delete(`/api/posts/${postId}`)).status, 404);
  assert.equal(store.getPost(postId).body, "Draft");
});

test("only the owner manages people", async () => {
  const me = await owner();
  const { them } = await invited(me, "priya");
  assert.equal((await them.get("/api/people")).status, 403);
  assert.equal((await them.post("/api/people/invite")).status, 403);

  const priya = store.listUsers().find((u) => u.username === "priya");
  const reset = await me.post(`/api/people/${priya.id}/reset`);
  const token = new URL(reset.data.link).searchParams.get("invite");
  assert.equal((await browser().get(`/api/invites/${token}`)).data.username, "priya");
  await browser().post(`/api/invites/${token}`, { password: "brand-new-pass" });
  assert.equal((await them.get("/api/state")).status, 401, "a reset signs the person out everywhere");
  assert.equal((await browser().post("/api/login", { username: "priya", password: "brand-new-pass" })).status, 200);

  const removed = await me.delete(`/api/people/${priya.id}`);
  assert.deepEqual(removed.data.people.map((p) => p.username), ["nihar"]);
  assert.equal(store.listAccounts().length, 1);
  assert.equal((await me.delete(`/api/people/${store.listUsers()[0].id}`)).status, 400);
});

test("a LinkedIn profile can only be connected under one login", async () => {
  const me = await owner();
  await invited(me, "priya");
  const [nihar, priya] = store.listUsers();
  const profile = { accessToken: "t", personUrn: "urn:li:person:x", name: "N", expiresAt: "2030-01-01T00:00:00Z" };
  store.saveConnection({ ...profile, userId: nihar.id });
  assert.throws(() => store.saveConnection({ ...profile, userId: priya.id }), /someone else/);
});

test("LinkedIn sign-in must finish in the same login that started it", async () => {
  const me = await owner();
  const { them } = await invited(me, "priya");
  const start = await fetch(`${base}/auth/linkedin`, { redirect: "manual", headers: { cookie: me.cookie() } });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const res = await fetch(`${base}/auth/linkedin/callback?code=x&state=${state}`, {
    redirect: "manual",
    headers: { cookie: them.cookie() },
  });
  assert.equal(res.status, 400);
});
