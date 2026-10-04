import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSlot, zonedTimeToUtc } from "../src/schedule.js";

const iso = (ms) => new Date(ms).toISOString();

test("converts local time to UTC, including half-hour zones and daylight saving", () => {
  assert.equal(iso(zonedTimeToUtc(2026, 11, 10, 9, 0, "Asia/Kolkata")), "2026-11-10T03:30:00.000Z");
  assert.equal(iso(zonedTimeToUtc(2026, 1, 15, 9, 0, "America/New_York")), "2026-01-15T14:00:00.000Z");
  assert.equal(iso(zonedTimeToUtc(2026, 7, 15, 9, 0, "America/New_York")), "2026-07-15T13:00:00.000Z");
});

test("picks the next matching weekday in the user's time zone", () => {
  // Friday Nov 6 2026, 12:00 UTC. Next Tue/Thu is Tue Nov 10.
  const from = Date.parse("2026-11-06T12:00:00Z");
  const slot = nextSlot({ days: [2, 4], time: "09:00", timezone: "Asia/Kolkata" }, [], from);
  assert.equal(slot, "2026-11-10T03:30:00.000Z");
});

test("uses today if the time hasn't passed, and skips it if it has", () => {
  const settings = { days: [2], time: "09:00", timezone: "UTC" };
  assert.equal(nextSlot(settings, [], Date.parse("2026-11-10T08:00:00Z")), "2026-11-10T09:00:00.000Z");
  assert.equal(nextSlot(settings, [], Date.parse("2026-11-10T09:30:00Z")), "2026-11-17T09:00:00.000Z");
});

test("skips slots that are already taken", () => {
  const settings = { days: [2, 4], time: "09:00", timezone: "UTC" };
  const from = Date.parse("2026-11-06T12:00:00Z");
  const slot = nextSlot(settings, ["2026-11-10T09:00:00.000Z", "2026-11-12T09:00:00.000Z"], from);
  assert.equal(slot, "2026-11-17T09:00:00.000Z");
});

test("the local weekday wins when it differs from the UTC weekday", () => {
  // Sunday 20:00 UTC is already Monday in Tokyo.
  const from = Date.parse("2026-11-08T20:00:00Z");
  const slot = nextSlot({ days: [1], time: "09:00", timezone: "Asia/Tokyo" }, [], from);
  assert.equal(slot, "2026-11-09T00:00:00.000Z");
});

test("returns null when no days are selected", () => {
  assert.equal(nextSlot({ days: [], time: "09:00", timezone: "UTC" }), null);
});
