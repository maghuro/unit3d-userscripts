import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const prefix = "userscripts/giveaway/src/";
const utilities = read(prefix + "12-utilities.js");
const commands = read(prefix + "10-command-handling.js");
const lifecycle = read(prefix + "06-lifecycle.js");
const initialization = read(prefix + "05-initialization.js");
const ui = read(prefix + "04-ui-template.js");

function namedFunction(source, name) {
  const start = source.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const closing = source.indexOf("\n    }\n", start);
  assert.notEqual(closing, -1, `Missing closing brace for ${name}`);
  return source.slice(start, closing + "\n    }\n".length);
}

const limitFunctions = [
  namedFunction(utilities, "parseGiveawayMinutes"),
  namedFunction(utilities, "getGiveawayMaxEndTs"),
  namedFunction(commands, "hostAdjustTime")
].join("\n");

function makeHarness(startedAt, initialEndTs) {
  const replies = [];
  let schedules = 0;
  let snapshots = 0;
  const countdownHeader = { textContent: "" };
  const runtime = vm.createContext({
    MAX_GIVEAWAY_MINUTES: 45,
    isHostOrAdmin: (author, _fancyName, host) => author === host,
    makeStaffAttributedReply: ({ reply }) => reply,
    rebuildSchedule: () => { schedules++; },
    snapshotGiveaway: () => { snapshots++; },
    parseTime: (ms) => String(ms),
    countdownHeader
  });
  vm.runInContext(limitFunctions, runtime);

  const giveawayData = { host: "maghuro", openedAt: startedAt, endTs: initialEndTs };
  const adjust = (sign, minutes, author = "maghuro") => {
    runtime.hostAdjustTime(sign)({
      author, fancyName: "", args: [String(minutes)], giveawayData,
      reply: (message) => replies.push(message)
    });
  };
  return {
    runtime, giveawayData, replies, adjust,
    get schedules() { return schedules; },
    get snapshots() { return snapshots; },
    countdownHeader
  };
}

test("only whole durations from 1 through 45 minutes are accepted", () => {
  const { runtime } = makeHarness(1_000_000, 2_000_000);
  for (const value of ["1", "12", "45"]) {
    assert.equal(runtime.parseGiveawayMinutes(value), Number(value));
  }
  for (const value of ["", "0", "46", "99", "-1", "45.5", "1e2", "30abc", "Infinity", "999999999999999999999"]) {
    assert.equal(runtime.parseGiveawayMinutes(value), null, value);
  }
  assert.equal(runtime.getGiveawayMaxEndTs(1_000_000), 1_000_000 + 45 * 60_000);
  assert.equal(runtime.getGiveawayMaxEndTs(null), null);
  assert.equal(runtime.getGiveawayMaxEndTs("not-a-timestamp"), null);
});

test("an extension may reach 45 minutes exactly but never cross the opening-based deadline", () => {
  const startedAt = Date.now() - 10 * 60_000;
  const h = makeHarness(startedAt, startedAt + 40 * 60_000);
  h.adjust(1, 5);
  assert.equal(h.giveawayData.endTs, startedAt + 45 * 60_000);
  assert.equal(h.snapshots, 1);
  assert.equal(h.schedules, 1);

  h.adjust(1, 0.01);
  assert.equal(h.giveawayData.endTs, startedAt + 45 * 60_000);
  assert.equal(h.snapshots, 1);
  assert.equal(h.schedules, 1);
  assert.match(h.replies.at(-1), /maximum of 45 minutes/);
});

test("the cap concerns total duration, not remaining time", () => {
  const startedAt = Date.now() - 30 * 60_000;
  const h = makeHarness(startedAt, startedAt + 40 * 60_000);
  h.adjust(1, 10); // Only ten minutes are left, but the total would become 50.
  assert.equal(h.giveawayData.endTs, startedAt + 40 * 60_000);
  assert.equal(h.snapshots, 0);
  h.adjust(-1, 1);
  assert.equal(h.giveawayData.endTs, startedAt + 39 * 60_000);
  assert.equal(h.snapshots, 1);
});

test("time adjustment fails closed without a trustworthy public-opening timestamp", () => {
  const h = makeHarness(null, Date.now() + 10 * 60_000);
  const original = h.giveawayData.endTs;
  h.adjust(1, 1);
  assert.equal(h.giveawayData.endTs, original);
  assert.equal(h.snapshots, 0);
  assert.match(h.replies.at(-1), /opening time is unavailable/);
  h.adjust(1, 1, "another-user");
  assert.equal(h.replies.length, 1); // Non-hosts cannot change the deadline.
});

test("UI, start path, both time commands, and recovered snapshots share the hard cap", () => {
  assert.match(ui, /id="timerNum"[\s\S]*?max="45"/);
  assert.match(initialization, /Math\.min\(n, MAX_GIVEAWAY_MINUTES\)/);
  assert.match(initialization, /Math\.min\(minutes, MAX_GIVEAWAY_MINUTES\)/);
  assert.match(lifecycle, /const totalTimeMin = parseGiveawayMinutes\(timerInput\?\.value\)/);
  assert.ok(
    lifecycle.indexOf("const totalTimeMin = parseGiveawayMinutes") <
    lifecycle.indexOf("await acquireTabLock()")
  );
  assert.match(lifecycle, /giveawayData\.openedAt = giveawayStartTime\.getTime\(\)/);
  assert.match(commands, /const addMinutes = hostAdjustTime\(\+1\)/);
  assert.match(commands, /const removeMinutes = hostAdjustTime\(-1\)/);
  assert.match(commands, /const maxEndTs = getGiveawayMaxEndTs\(giveawayData\.openedAt\)/);
  assert.match(initialization, /openedAt: giveawayData\.openedAt/);
  assert.match(initialization, /const correctedDeadline = !committedSettlement && maxEndTs !== null && endTs > maxEndTs/);
  assert.match(initialization, /snap\.giveawayData\.endTs = maxEndTs/);
});
