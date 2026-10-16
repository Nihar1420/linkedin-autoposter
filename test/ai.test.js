import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createAi } from "../src/ai.js";

let reply;
let baseUrl;
let failWith = null;
let lastRequest = null;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    lastRequest = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    res.setHeader("Content-Type", "application/json");
    if (failWith) {
      res.statusCode = failWith;
      const message = failWith === 402 ? "Your credit balance is too low to access the Anthropic API." : "down";
      if (failWith === 402) res.statusCode = 400;
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
    }
    res.end(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }, content: reply,
    }));
  });
});

const searchResult = {
  type: "web_search_tool_result",
  content: [
    { type: "web_search_result", url: "https://real.example/a", title: "Real page" },
    { type: "web_search_result", url: "https://real.example/unused", title: "Unused" },
  ],
};
const news = { pillar: { name: "News", description: "", type: "news" } };

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test";
});
after(() => server.close());

test("keeps only sources that appeared in the search results, and removes the list from the post", async () => {
  reply = [
    { type: "text", text: "Let me look." },
    { type: "server_tool_use", name: "web_search" },
    searchResult,
    { type: "server_tool_use", name: "code_execution" },
    { type: "code_execution_tool_result", content: { type: "code_execution_result" } },
    { type: "text", text: "A real " },
    { type: "text", text: "post.\n\n#tag\n\nSOURCES:\nhttps://real.example/a\nhttps://real.example/a\nhttps://invented.example/b" },
  ];
  const result = await createAi({ model: "claude-opus-5-5", baseUrl }).write(news);
  assert.equal(result.text, "A real post.\n\n#tag");
  assert.deepEqual(result.sources, [{ url: "https://real.example/a", title: "Real page" }]);
});

test("a post with no sources list is returned unchanged", async () => {
  reply = [{ type: "text", text: "Just a post." }];
  assert.deepEqual(await createAi({ model: "claude-opus-5-5", baseUrl }).write({ topic: "T" }), {
    text: "Just a post.",
    sources: [],
  });
});

test("an outage on Claude's side gives a plain message", async () => {
  failWith = 503;
  await assert.rejects(createAi({ model: "claude-opus-5-5", maxRetries: 0, baseUrl }).write({ topic: "T" }), /temporarily unavailable/);
  failWith = 400;
  await assert.rejects(createAi({ model: "claude-opus-5-5", maxRetries: 0, baseUrl }).write({ topic: "T" }), /error \(400\)/);
  failWith = 402; // Stands for a 400 "credit balance too low" reply.
  await assert.rejects(createAi({ model: "claude-opus-5-5", maxRetries: 0, baseUrl }).write({ topic: "T" }), /out of credits/);
  failWith = null;
});

test("ANTHROPIC_BASE_URL in the shell can't redirect requests", async () => {
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  reply = [{ type: "text", text: "Direct." }];
  const result = await createAi({ model: "claude-opus-5-5", maxRetries: 0, baseUrl }).write({ topic: "T" });
  assert.equal(result.text, "Direct.");
  delete process.env.ANTHROPIC_BASE_URL;
});

test("Sonnet 5.5 requests use its supported options: effort, web search and refusal fallback", async () => {
  reply = [{ type: "text", text: "A post." }];
  const ai = createAi({ model: "claude-sonnet-5-5", maxRetries: 0, baseUrl });

  await ai.write({ topic: "T" });
  assert.equal(lastRequest.body.model, "claude-sonnet-5-5");
  assert.deepEqual(lastRequest.body.output_config, { effort: "medium" });
  assert.equal(lastRequest.body.fallbacks, "default");
  assert.match(lastRequest.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(lastRequest.body.tools, undefined, "a typed topic doesn't search the web");
  assert.equal(lastRequest.body.thinking, undefined, "Sonnet 5.5 rejects disabled thinking, so none is sent");

  await ai.write(news);
  assert.deepEqual(lastRequest.body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }]);
});

test("Haiku uses the web search version it supports and no fallback", async () => {
  reply = [{ type: "text", text: "A post." }];
  await createAi({ model: "claude-haiku-5-5", maxRetries: 0, baseUrl }).write(news);
  assert.equal(lastRequest.body.tools[0].type, "web_search_20250305");
  assert.equal(lastRequest.body.fallbacks, undefined);
});

test("each reply's cost is recorded, and nothing is sent once the budget is used up", async () => {
  reply = [{ type: "text", text: "A post." }];
  const recorded = [];
  let full = false;
  const budget = {
    check: () => { if (full) throw new Error("This month's AI budget is used up."); },
    record: (usage, model) => recorded.push({ usage, model }),
  };
  const ai = createAi({ model: "claude-sonnet-5-5", maxRetries: 0, baseUrl, budget });
  await ai.write({ topic: "T" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].model, "claude-sonnet-5-5");

  full = true;
  lastRequest = null;
  await assert.rejects(ai.write({ topic: "T" }), /budget is used up/);
  assert.equal(lastRequest, null, "Claude wasn't called");
});
