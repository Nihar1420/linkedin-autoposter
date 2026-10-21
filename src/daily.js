import { MAX_POST_LENGTH } from "./prompts.js";
import { nextSlot } from "./schedule.js";

export const MAX_WAITING_DRAFTS = 3;

/** The date and time right now on the wall clock in `timeZone`. */
export function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Themes that can be written now. A learning post needs something real to be about. */
export function usablePillars({ pillars, learning }) {
  return pillars.filter((pillar) => pillar.type !== "learning" || learning.trim());
}

/** Writes a draft from the account's next content theme, taking turns between themes. */
export async function draftNextPost({ store, ai }, accountId, origin = "daily") {
  const account = store.getAccount(accountId);
  const { settings, analysis } = account;
  const pillars = usablePillars(settings);
  if (!pillars.length) throw new Error("Add a content theme first.");

  const pillar = pillars[account.dailyIndex % pillars.length];
  const { text, sources } = await ai.write({
    pillar,
    profile: analysis,
    voice: settings.voice,
    learning: settings.learning,
    recentOpenings: store.recentOpenings(accountId),
  });
  store.advancePillar(accountId);
  return store.createPost({
    accountId,
    topic: pillar.name,
    body: text,
    origin,
    pillarType: pillar.type,
    sources,
  });
}

/**
 * Writes today's draft for each account that's due. Each account is marked as
 * done before the work starts, so a failure can't cause repeated paid retries;
 * the error is shown in the app instead. Drafts wait for your approval unless
 * "Post daily drafts automatically" is on, in which case each one is scheduled
 * for the next posting time.
 */
export async function runDailyDrafts(deps, now = new Date()) {
  const { store } = deps;
  for (const account of store.listAccounts()) {
    const { settings, analysis } = account;
    if (!settings.dailyDrafts || !analysis || !settings.timezone) continue;

    const { date, time } = localNow(settings.timezone, now);
    if (time < settings.draftTime || account.dailyDate === date) continue;

    store.markDailyRun(account.id, date);
    if (store.waitingDailyDrafts(account.id) >= MAX_WAITING_DRAFTS) continue;

    try {
      const id = await draftNextPost(deps, account.id);
      if (settings.autoPostDaily) autoSchedule(store, account.id, id, now);
    } catch (err) {
      store.setDailyError(account.id, `Today's draft couldn't be written: ${err.message}`);
      console.error(`Daily draft failed for ${account.name}: ${err.message}`);
    }
  }
}

/**
 * Schedules a new daily draft without review. A researched post with nothing to
 * cite is still posted: the writing instructions keep it general in that case.
 */
function autoSchedule(store, accountId, postId, now) {
  const post = store.getPost(postId);
  const { settings } = store.getAccount(accountId);
  if (post.body.length > MAX_POST_LENGTH) {
    store.setDailyError(accountId, "Today's draft is over LinkedIn's length limit, so it wasn't posted automatically.");
    return;
  }
  const slot = nextSlot(settings, store.takenSlots(accountId), now.getTime());
  if (!slot) {
    store.setDailyError(accountId, "Pick at least one posting day so daily drafts can be posted automatically.");
    return;
  }
  store.schedule(postId, slot);
}

export function startDailyDrafts(deps) {
  const run = () => runDailyDrafts(deps).catch((err) => console.error("Daily draft error:", err));
  run();
  return setInterval(run, 60_000);
}
