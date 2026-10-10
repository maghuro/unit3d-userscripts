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
  extractNamedFunction(initialization, "loadGiveawaySnapshot")
].join("\n");

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

function recoveryHarness({
  ageMinutes,
  advertisedMinutes = 90,
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
      settlement,
      closingIntent,
      closingNoticeSent
    }
  };
  const context = vm.createContext({
    Date: { now: () => NOW },
    MAX_GIVEAWAY_MINUTES: 45,
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
