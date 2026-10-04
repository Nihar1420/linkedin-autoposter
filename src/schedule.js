// Works out posting times. "Tuesdays at 9:00" means 9:00 where you live, so all
// of this is done in your time zone, including across daylight saving changes.

function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== "literal") out[type] = Number(value);
  }
  return out;
}

function offsetMs(utcMs, timeZone) {
  const p = partsIn(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to a UTC timestamp in milliseconds. */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - offsetMs(naive, timeZone);
  return naive - offsetMs(first, timeZone);
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the next free posting slot.
 * days: weekdays, 0 = Sunday. time: "HH:MM". taken: ISO times already booked.
 * Returns an ISO string, or null if no weekdays are selected.
 */
export function nextSlot({ days, time, timezone }, taken = [], from = Date.now()) {
  if (!days?.length) return null;
  const timeZone = timezone || "UTC";
  const [hour, minute] = time.split(":").map(Number);
  const takenMinutes = new Set(taken.map((t) => Math.floor(Date.parse(t) / 60000)));
  const today = partsIn(new Date(from), timeZone);

  // Ten years of days: enough for any realistic queue.
  for (let i = 0; i < 3660; i++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!days.includes(d.getUTCDay())) continue;
    const utc = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, timeZone);
    if (utc <= from || takenMinutes.has(Math.floor(utc / 60000))) continue;
    return new Date(utc).toISOString();
  }
  return null;
}

export const isValidTime = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
