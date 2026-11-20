import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_PROMPT, ANALYSIS_SCHEMA, WRITING_PROMPT, buildPrompt, splitSources } from "./prompts.js";

const MAX_CONTINUATIONS = 5;
const MAX_SEARCHES = 2; // Each search costs a cent, and its results add input tokens.
const MAX_RETRIES = 5; // Rides out brief outages. The SDK waits longer between each try.

// Models that accept the server-side fallback option used below.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/** Failures worth trying again later: the connection dropped, Claude was busy or down. */
function isRetryable(err) {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError) return err.status >= 500;
  return /terminated|fetch failed|socket|ECONNRESET|ETIMEDOUT|network/i.test(err.message ?? "");
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the API key. Check ANTHROPIC_API_KEY in your settings.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limited right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check your connection and try again.";
  if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) {
    return "Your Claude account is out of credits. Add credits at platform.claude.com, then try again.";
  }
  if (err instanceof Anthropic.APIError && err.status >= 500) {
    return "Claude is temporarily unavailable. Nothing was lost, so try again in a minute.";
  }
  if (err instanceof Anthropic.APIError) return `Claude returned an error (${err.status}): ${err.message}`;
  if (/api.?key|authentication method/i.test(err.message)) return "ANTHROPIC_API_KEY isn't set yet.";
  if (isRetryable(err)) return "The connection to Claude dropped, usually because the computer went to sleep.";
  return err.message;
}

function checkFinished(response) {
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request. Try rewording it.");
  if (response.stop_reason === "max_tokens") throw new Error("The response was cut off before it finished. Try again.");
  if (response.stop_reason === "pause_turn") throw new Error("The web research took too long. Try again.");
}

/**
 * Pulls out the final text and its sources. Text before the last tool result is
 * only Claude's working notes. A source is kept only if that URL really appeared
 * in the search results, so an invented link can't reach you.
 */
function readPost(content) {
  const lastTool = content.findLastIndex((block) => block.type.endsWith("_tool_result"));
  const blocks = content.slice(lastTool + 1).filter((block) => block.type === "text");
  const { text, urls } = splitSources(blocks.map((block) => block.text).join(""));
  if (!text) throw new Error("Claude returned an empty draft. Try again.");

  const found = new Map();
  for (const block of content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) found.set(result.url, result.title || result.url);
  }
  const sources = [...new Set(urls)]
    .filter((url) => found.has(url))
    .map((url) => ({ url, title: found.get(url) }));
  return { text, sources };
}

// Set explicitly so a shell setting such as ANTHROPIC_BASE_URL can't quietly send
// your API key and profile to some other server.
export const CLAUDE_API = "https://api.anthropic.com";

export function createAi({ model, maxRetries = MAX_RETRIES, baseUrl = CLAUDE_API, budget = null }) {
  let client;

  async function send(request) {
    client ??= new Anthropic({ maxRetries, baseURL: baseUrl });
    const full = { model, max_tokens: 16000, ...request };
    if (FALLBACK_MODELS.has(model)) {
      full.betas = ["server-side-fallback-2026-07-01"];
      full.fallbacks = "default";
    }
    budget?.check();
    let response;
    try {
      response = await client.beta.messages.create(full);
    } catch (err) {
      const friendly = new Error(friendlyError(err));
      friendly.retryable = isRetryable(err);
      throw friendly;
    }
    budget?.record(response.usage, model);
    return response;
  }

  return {
    /** Writes a post. Returns { text, sources }. */
    async write(input) {
      const messages = [{ role: "user", content: buildPrompt(input) }];
      const request = { output_config: { effort: "medium" }, system: WRITING_PROMPT, messages };
      if (input.pillar?.type === "news") {
        const type = model.includes("haiku") ? "web_search_20250305" : "web_search_20260209";
        request.tools = [{ type, name: "web_search", max_uses: MAX_SEARCHES }];
      }

      let response = await send(request);
      // Long searches pause partway. Sending the partial answer back resumes them.
      for (let i = 0; i < MAX_CONTINUATIONS && response.stop_reason === "pause_turn"; i++) {
        messages.push({ role: "assistant", content: response.content });
        response = await send(request);
        messages.pop();
      }
      checkFinished(response);
      return readPost(response.content);
    },

    /** Reviews a profile from a base64 PDF or pasted text. */
    async analyze({ pdf, text }) {
      const content = [{ type: "text", text: "Review this LinkedIn profile." }];
      if (pdf) {
        content.unshift({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } });
      } else {
        content.push({ type: "text", text: `The profile:\n\n${text}` });
      }

      const response = await send({
        output_config: { effort: "high", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
        system: ANALYSIS_PROMPT,
        messages: [{ role: "user", content }],
      });
      checkFinished(response);

      const json = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      try {
        return JSON.parse(json);
      } catch {
        throw new Error("Claude's analysis came back incomplete. Try again.");
      }
    },
  };
}
