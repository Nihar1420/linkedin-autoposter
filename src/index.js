import { resolve } from "node:path";
import { createAi } from "./ai.js";
import { createBudget } from "./budget.js";
import { createGrok } from "./grok.js";
import { startDailyDrafts } from "./daily.js";
import { createLinkedIn } from "./linkedin.js";
import { startPublisher } from "./publisher.js";
import { createApp } from "./server.js";
import { openStore } from "./db.js";

const env = process.env;
const port = Number(env.PORT ?? 3000);
const appUrl = (env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
// Needed once, to create the first login. APP_PASSWORD is the older name for it.
const setupCode = env.SETUP_CODE || env.APP_PASSWORD || null;
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appUrl);

// Without a setup code, a stranger who found the address first could create the owner login.
if (!isLocal && !setupCode) {
  console.error("SETUP_CODE must be set when the app isn't running on localhost.");
  process.exit(1);
}

const dryRun = env.LINKEDIN_DRY_RUN !== "false";
// Grok is used when its key is set. Otherwise the app uses Claude.
const useGrok = Boolean(env.XAI_API_KEY);
const model = useGrok ? env.GROK_MODEL || "grok-4.7" : env.CLAUDE_MODEL || "claude-sonnet-5-5";
const store = openStore(resolve(env.DATA_DIR ?? "./data"));
// Claude spending is capped per month. Set MONTHLY_BUDGET_USD=0 to turn the cap off.
const budget = useGrok ? null : createBudget({ store, limit: Number(env.MONTHLY_BUDGET_USD ?? 3) });
const ai = useGrok
  ? createGrok({ apiKey: env.XAI_API_KEY, model, baseUrl: env.XAI_BASE_URL || "https://api.x.ai/v1" })
  : createAi({ model, budget });
const linkedin = createLinkedIn({
  clientId: env.LINKEDIN_CLIENT_ID,
  clientSecret: env.LINKEDIN_CLIENT_SECRET,
  redirectUri: `${appUrl}/auth/linkedin/callback`,
  apiVersion: env.LINKEDIN_API_VERSION || "202610",
  apiBase: env.LINKEDIN_API_BASE || "https://api.linkedin.com",
  authBase: env.LINKEDIN_AUTH_BASE || "https://www.linkedin.com",
});

const app = createApp({ store, ai, linkedin, dryRun, setupCode, model, appUrl, budget });
startPublisher({ store, linkedin, dryRun });
startDailyDrafts({ store, ai });

// On localhost, only this computer can reach the app.
const host = isLocal ? "127.0.0.1" : "0.0.0.0";
app.listen(port, host, () => {
  console.log(`LinkedIn Autoposter is running at ${appUrl}, using ${model}`);
  if (dryRun) console.log("Dry run is on: nothing will be sent to LinkedIn.");
});
