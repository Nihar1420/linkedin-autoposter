// Grok, through xAI's Responses API. Docs: https://docs.x.ai
import { extractText } from "unpdf";
import { ANALYSIS_PROMPT, ANALYSIS_SCHEMA, WRITING_PROMPT, buildPrompt, splitSources } from "./prompts.js";

const TIMEOUT_MS = 5 * 60 * 1000;

function readText(data) {
  const parts = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const block of item.content ?? []) {
      if (block.type === "output_text") parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

function readSources(data) {
  const urls = new Set(data.citations ?? []);
  for (const item of data.output ?? []) {
    for (const block of item.content ?? []) {
      for (const note of block.annotations ?? []) {
        if (note.type === "url_citation" && note.url) urls.add(note.url);
      }
    }
  }
  return [...urls].map((url) => ({ url, title: new URL(url).hostname.replace(/^www\./, "") }));
}

async function pdfToText(base64) {
  let text;
  try {
    ({ text } = await extractText(new Uint8Array(Buffer.from(base64, "base64")), { mergePages: true }));
  } catch {
    throw new Error("Couldn't read that PDF. Paste your profile text instead.");
  }
  if (text.trim().length < 50) {
    throw new Error("That PDF has no readable text. Paste your profile text instead.");
  }
  return text;
}

export function createGrok({ apiKey, model, baseUrl }) {
  async function send(body) {
    let res;
    try {
      res = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, store: false, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("Couldn't reach Grok. Check your connection and try again.");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = String(data.error?.message ?? data.error ?? "");
      if (res.status === 401 || /api key/i.test(detail)) {
        throw new Error("Grok rejected the API key. Check XAI_API_KEY in your .env file.");
      }
      if (res.status === 429) throw new Error("Grok is rate limited right now. Try again in a minute.");
      throw new Error(`Grok returned an error (${res.status}): ${detail}`);
    }
    if (data.status === "incomplete") throw new Error("The response was cut off before it finished. Try again.");
    return data;
  }

  return {
    /** Writes a post. Returns { text, sources }. */
    async write(input) {
      const body = {
        input: [
          { role: "system", content: WRITING_PROMPT },
          { role: "user", content: buildPrompt(input) },
        ],
        // A post can't contain [[1]](url) markers, so sources are collected separately.
        include: ["no_inline_citations"],
      };
      if (input.pillar?.type === "news") body.tools = [{ type: "web_search" }];

      const data = await send(body);
      const { text } = splitSources(readText(data));
      if (!text) throw new Error("Grok returned an empty draft. Try again.");
      return { text, sources: readSources(data) };
    },

    /** Reviews a profile from a base64 PDF or pasted text. */
    async analyze({ pdf, text }) {
      const profile = pdf ? await pdfToText(pdf) : text;
      const data = await send({
        input: [
          { role: "system", content: ANALYSIS_PROMPT },
          { role: "user", content: `Review this LinkedIn profile.\n\nThe profile:\n\n${profile}` },
        ],
        text: { format: { type: "json_schema", name: "profile_review", schema: ANALYSIS_SCHEMA, strict: true } },
      });
      try {
        return JSON.parse(readText(data));
      } catch {
        throw new Error("Grok's analysis came back incomplete. Try again.");
      }
    },
  };
}
