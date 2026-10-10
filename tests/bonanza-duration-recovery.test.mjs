import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const initialization = read("userscripts/giveaway/src/05-initialization.js");
const utilities = read("userscripts/giveaway/src/12-utilities.js");

function extractNamedFunction(source, name) {
  const start = source.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const end = source.indexOf("\n    }\n", start);
  assert.notEqual(end, -1, `Missing end of ${name}`);
  return source.slice(start, end + "\n    }\n".length);
}

// Run the real recovery predicate, not a reimplementation of the logic.
const functions = [
  extractNamedFunction(utilities, "getGiveawayMaxEndTs"),
  extractNamedFunction(utilities, "getReminderLimits"),
  extractNamedFunction(utilities, "getReminderSchedule"),
  extractNamedFunction(utilities, "nextReminderMs"),
  extractNamedFunction(initialization, "loadGiveawaySnapshot")
].join("\n");

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

function recoveryHarness({
  ageMinutes,
  advertisedMinutes = 90,
  reminderCount = 1,
  settlement = null,
  closingIntent = false,
  closingNoticeSent = false
}) {
  const openedAt = NOW - ageMinutes * MINUTE;
  const originalEnd = openedAt + advertisedMinutes * MINUTE;
  const clears = [];
  const warnings = [];
  const snap = {
    startTime: openedAt, // Legacy snapshots predate giveawayData.openedAt.
    giveawayData: {
      host: "maghuro",
      rehearsalMode: false,
      endTs: originalEnd,
      reminderNum: reminderCount,
      reminderSchedule: [Math.round(advertisedMinutes / (reminderCount + 1) * MINUTE)],
      reminderFreqSec: advertisedMinutes * 60 / (reminderCount + 1),
      nextReminderSec: advertisedMinutes * 60 / (reminderCount + 1),
      totalSeconds: advertisedMinutes * 60,
      settlement,
      closingIntent,
      closingNoticeSent
    }
  };
  const context = vm.createContext({
    Date: { now: () => NOW },
    MAX_GIVEAWAY_MINUTES: 45,
    MAX_REMINDERS: 6,
    EXPIRED_SNAPSHOT_SETTLEMENT_GRACE_MS: 60 * MINUTE,
    REHEARSAL_MODE: false,
    normalizeUserKey: (value) => String(value || "").toLowerCase(),
    getLoggedInUsername: () => "maghuro",
    readActiveGiveawayRawForHost: () => ({ raw: JSON.stringify(snap) }),
    clearGiveawaySnapshot: () => { clears.push(true); },
    console: { warn: (message) => warnings.push(message) }
  });
  vm.runInContext(functions, context);
  return {
    restore: () => context.loadGiveawaySnapshot(),
    nextReminderMs: (schedule, msLeft) => context.nextReminderMs(schedule, msLeft),
    clears, warnings, originalEnd, cappedEnd: openedAt + 45 * MINUTE
  };
}

test("stale legacy giveaway is not resurrected when capped deadline exceeds recovery grace", () => {
  // Under the old 90-minute deadline this ended 20 minutes ago and was
  // recoverable; its compliant 45-minute deadline was already 65 minutes ago.
  const h = recoveryHarness({ ageMinutes: 110 });
  assert.equal(h.restore(), null);
  assert.equal(h.clears.length, 1);
  assert.ok(h.warnings.some(w => w.includes("Discarding stale expired")));
});

test("long-abandoned giveaway cannot settle unexpectedly after a code upgrade", () => {
  const h = recoveryHarness({ ageMinutes: 3 * 24 * 60, advertisedMinutes: 120 });
  assert.equal(h.restore(), null);
  assert.equal(h.clears.length, 1);
});

test("recoverable legacy snapshot is capped and recognized as already expired", () => {
  const h = recoveryHarness({ ageMinutes: 50 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.cappedEnd);
  assert.equal(result.__expiredAtLoad, true);
  assert.equal(h.clears.length, 0);
});

test("a still-active legacy snapshot retains only its allowed remaining time", () => {
  const h = recoveryHarness({ ageMinutes: 30 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.cappedEnd);
  assert.equal(result.__expiredAtLoad, false);
  assert.equal(h.clears.length, 0);
});

test("the ordinary expiry grace boundary still applies to the capped deadline", () => {
  const withinGrace = recoveryHarness({ ageMinutes: 105 });
  assert.ok(withinGrace.restore());
  assert.equal(withinGrace.clears.length, 0);

  const afterGrace = recoveryHarness({ ageMinutes: 105 + 1 / MINUTE });
  assert.equal(afterGrace.restore(), null);
  assert.equal(afterGrace.clears.length, 1);
});

test("committed settlement remains recoverable without rewriting its deadline", () => {
  const h = recoveryHarness({ ageMinutes: 150, settlement: { committed: true } });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.originalEnd);
  assert.equal(result.__expiredAtLoad, true);
  assert.equal(h.clears.length, 0);
});

test("latched in-progress settlement is retained after the normal grace", () => {
  const h = recoveryHarness({ ageMinutes: 150, closingIntent: true });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.cappedEnd);
  assert.equal(result.__expiredAtLoad, true);
  assert.equal(h.clears.length, 0);
});

test("capped active legacy giveaway rebuilds a single reminder at the new midpoint", () => {
  const h = recoveryHarness({ ageMinutes: 5, advertisedMinutes: 90, reminderCount: 1 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.cappedEnd);
  assert.deepEqual(Array.from(result.giveawayData.reminderSchedule), [22.5 * MINUTE]);
  assert.equal(result.giveawayData.reminderNum, 1);
  assert.equal(result.giveawayData.totalSeconds, 45 * 60);
  assert.equal(result.giveawayData.reminderFreqSec, 22.5 * 60);
  assert.equal(result.giveawayData.nextReminderSec, 22.5 * 60);
  assert.equal(h.nextReminderMs(result.giveawayData.reminderSchedule, 40 * MINUTE), 17.5 * MINUTE);
});

test("capped restore drops already-passed reminder thresholds instead of replaying them", () => {
  const h = recoveryHarness({ ageMinutes: 30, advertisedMinutes: 90, reminderCount: 1 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.__expiredAtLoad, false);
  assert.equal(h.nextReminderMs(result.giveawayData.reminderSchedule, 15 * MINUTE), null);
  assert.equal(result.giveawayData.reminderSchedule.length, 0);
});

test("capped restore preserves multiple reminder count and recalculates the actual offsets", () => {
  const h = recoveryHarness({ ageMinutes: 5, advertisedMinutes: 90, reminderCount: 3 });
  const result = h.restore();
  assert.ok(result);
  assert.deepEqual(Array.from(result.giveawayData.reminderSchedule), [
    Math.round(33.75 * MINUTE),
    Math.round(22.5 * MINUTE),
    Math.round(11.25 * MINUTE)
  ]);
  assert.equal(result.giveawayData.reminderNum, 3);
  assert.equal(result.giveawayData.reminderFreqSec, 11.25 * 60);
});

test("capped restore clamps a legacy excessive reminder count to the safe configured maximum", () => {
  const h = recoveryHarness({ ageMinutes: 5, reminderCount: 99 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.reminderNum, 6);
  assert.equal(result.giveawayData.reminderSchedule.length, 6);
});

test("already compliant snapshots are not rescheduled on restore", () => {
  const h = recoveryHarness({ ageMinutes: 5, advertisedMinutes: 30, reminderCount: 1 });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.originalEnd);
  assert.deepEqual(Array.from(result.giveawayData.reminderSchedule), [15 * MINUTE]);
  assert.equal(result.giveawayData.totalSeconds, 30 * 60);
});

test("committed settlement retains original reminders and deadline intact", () => {
  const h = recoveryHarness({
    ageMinutes: 150, advertisedMinutes: 90,
    reminderCount: 1, settlement: { committed: true }
  });
  const result = h.restore();
  assert.ok(result);
  assert.equal(result.giveawayData.endTs, h.originalEnd);
  assert.deepEqual(Array.from(result.giveawayData.reminderSchedule), [45 * MINUTE]);
});
