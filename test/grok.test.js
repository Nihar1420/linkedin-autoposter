import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createGrok } from "../src/grok.js";

let seen;
let reply;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.statusCode = reply.status ?? 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply.body));
  });
});

const message = (text, annotations = []) => ({
  status: "completed",
  output: [
    { type: "web_search_call" },
    { type: "message", content: [{ type: "output_text", text, annotations }] },
  ],
});

// A small real PDF containing one line of text.
function samplePdf(line) {
  const stream = `BT /F1 12 Tf 40 700 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

let grok;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  grok = createGrok({ apiKey: "k", model: "grok-4.7", baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
});
after(() => server.close());
beforeEach(() => (seen = null));

test("writes a post through the Responses API, without web search for a typed topic", async () => {
  reply = { body: message("A post.") };
  const result = await grok.write({ topic: "Testing" });
  assert.deepEqual(result, { text: "A post.", sources: [] });
  assert.equal(seen.url, "/v1/responses");
  assert.equal(seen.auth, "Bearer k");
  assert.equal(seen.body.model, "grok-4.7");
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.tools, undefined);
  assert.match(seen.body.input[1].content, /Topic: Testing/);
});

test("news posts search the web and collect their sources", async () => {
  reply = {
    body: {
      ...message("News.", [{ type: "url_citation", url: "https://www.b.example/x" }]),
      citations: ["https://a.example/1", "https://www.b.example/x"],
    },
  };
  const { sources } = await grok.write({ pillar: { name: "New", description: "", type: "news" } });
  assert.deepEqual(seen.body.tools, [{ type: "web_search" }]);
  assert.deepEqual(seen.body.include, ["no_inline_citations"]);
  assert.deepEqual(sources, [
    { url: "https://a.example/1", title: "a.example" },
    { url: "https://www.b.example/x", title: "b.example" },
  ]);
});

test("reads the text out of a real PDF and requests the structured review", async () => {
  reply = { body: message('{"score": 70}') };
  const pdf = samplePdf("Forward Deployed Engineer at Acme building AI systems for enterprise customers");
  assert.deepEqual(await grok.analyze({ pdf }), { score: 70 });
  assert.match(seen.body.input[1].content, /Forward Deployed Engineer at Acme/);
  assert.equal(seen.body.text.format.type, "json_schema");
  assert.equal(seen.body.text.format.schema.properties.score.type, "integer");
});

test("a PDF with no readable text asks you to paste instead, and sends nothing", async () => {
  await assert.rejects(grok.analyze({ pdf: samplePdf("x") }), /no readable text/);
  await assert.rejects(grok.analyze({ pdf: "JVBERi0xLjQK" }), /Paste your profile/);
  assert.equal(seen, null);
});

test("a rejected key, rate limit and cut-off response give clear messages", async () => {
  reply = { status: 400, body: { code: "invalid-argument", error: "Incorrect API key provided." } };
  await assert.rejects(grok.write({ topic: "T" }), /rejected the API key/);
  reply = { status: 429, body: {} };
  await assert.rejects(grok.write({ topic: "T" }), /rate limited/);
  reply = { body: { status: "incomplete", output: [] } };
  await assert.rejects(grok.write({ topic: "T" }), /cut off/);
  reply = { body: message("{broken") };
  await assert.rejects(grok.analyze({ text: "x" }), /incomplete/);
});
