import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = p => readFileSync(new URL(p, root), "utf8");
const lifecycle = read("userscripts/giveaway/src/06-lifecycle.js");
const initialization = read("userscripts/giveaway/src/05-initialization.js");
const utilities = read("userscripts/giveaway/src/12-utilities.js");
const commands = read("userscripts/giveaway/src/10-command-handling.js");
const sponsorship = read("userscripts/giveaway/src/09-sponsorship-polling.js");

function extract(source, signature) {
  const start = source.indexOf("    " + signature);
  assert.notEqual(start, -1, "Missing " + signature);
  const delimiter = "\n    }\n";
  const end = source.indexOf(delimiter, start);
  assert.notEqual(end, -1, "Unclosed " + signature);
  return source.slice(start, end + delimiter.length);
}

const verifyOpening = extract(lifecycle, "async function verifyPendingGiveawayOpening(");
const openingSend = extract(utilities, "async function sendMessage(");
const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 10, 11, 0, 0, 500);
const sameSecond = new Date(START - 500).toISOString().replace(".000Z", "Z");
const nextSecond = new Date(START + 500).toISOString().replace(".000Z", "Z");
const preparedMessage = "🎁 I am hosting a giveaway for 100 BON";

function createHarness({ records = [], responses = null, owned = () => true } = {}) {
  const calls = [];
  const checks = {
    status: "pending",
    startedAt: START,
    afterMessageId: 100,
    windowEndAt: START + 10_000,
    preparedMessage
  };
  const runtime = vm.createContext({
    URL,
    location: { origin: "https://darkpeers.org" },
    OT_USER_ID: 17,
    DARKPEERS_MAIN_CHATROOM_ID: 1,
    OPENING_POST_MAX_PUBLICATION_WINDOW_MS: 10_000,
    ownsTabLock: owned,
    optionalFiniteNumber: value => value == null ? null : Number(value),
    unit3dTimestampResolutionMs: raw => String(raw).includes(".") ? 1 : 1000,
    fetchWithTimeout: async url => {
      calls.push(String(url));
      const result = responses ? responses.shift() : records;
      if (result instanceof Error) throw result;
      return {
        ok: true,
        json: async () => ({ data: result })
      };
    },
    setTimeout: fn => fn(),
    console: { warn() {} }
  });
  vm.runInContext(verifyOpening, runtime);
  return { run: () => runtime.verifyPendingGiveawayOpening(checks), calls, checks };
}

const goodMessage = (overrides = {}) => ({
  id: 101,
  user_id: 17,
  message: preparedMessage,
  created_at: nextSecond,
  ...overrides
});

test("opening reconciliation requires authenticated author, exact announcement and cursor", async () => {
  const h = createHarness({ records: [
    goodMessage({ id: 100 }),
    goodMessage({ user_id: 18 }),
    goodMessage({ message: "another giveaway" }),
    goodMessage()
  ] });
  const result = await h.run();
  assert.ok(result);
  assert.equal(result.messageId, 101);
  assert.equal(result.sponsorStartTs, START + 1500);
  assert.match(h.calls[0], /after_id=100/);
});

test("a timestamp bucket overlapping the pre-send boundary stays unresolved", async () => {
  // Same-second history can represent a message posted before this attempt.
  const h = createHarness({ records: [goodMessage({ created_at: sameSecond })] });
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 3);
});

test("verified sponsorship starts strictly AFTER a fully proven publication bucket", async () => {
  const h = createHarness({ records: [goodMessage()] });
  const result = await h.run();
  assert.ok(result);
  assert.equal(result.sponsorStartTs, START + 1500);
  assert.ok(result.sponsorStartTs > START);
});

test("a later identical host message cannot confirm an old opening", async () => {
  // Cursor and identity alone are insufficient: the same announcement can
  // be posted later by the host while the original send was never published.
  const later = new Date(START + 15_000).toISOString();
  const h = createHarness({ records: [goodMessage({ created_at: later, id: 102 })] });
  assert.equal(await h.run(), null);
});

test("opening publication buckets crossing the upper send window are rejected", async () => {
  const upperBucket = new Date(START + 9_500).toISOString()
    .replace(".000Z", "Z");
  const h = createHarness({ records: [
    goodMessage({ created_at: upperBucket })
  ] });
  // 11:00:10.000 .. 11:00:11.000 overlaps 11:00:10.500 bound.
  assert.equal(await h.run(), null);
});

test("a timestamp bucket fully inside the persisted opening window is accepted", async () => {
  const h = createHarness({ records: [
    goodMessage({ created_at: new Date(START + 9900).toISOString() })
  ] });
  const result = await h.run();
  assert.ok(result);
  assert.equal(result.sponsorStartTs, START + 9901);
});

test("response completion narrows the publication window for confirmed and failed sends", async () => {
  const accepted = createHarness({ records: [goodMessage()] });
  accepted.checks.sendCompletedAt = START + 1700;
  assert.ok(await accepted.run());

  const rejected = createHarness({ records: [goodMessage()] });
  rejected.checks.sendCompletedAt = START + 1200;
  assert.equal(await rejected.run(), null);
});

test("an invalid persisted upper boundary never widens recovery into later history", async () => {
  const h = createHarness({ records: [goodMessage()] });
  h.checks.windowEndAt = START - 1;
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 0);
});

test("ambiguous opening does not accept someone else's message or mismatched text", async () => {
  const h = createHarness({ records: [
    goodMessage({ user_id: 20 }),
    goodMessage({ message: "old intro" })
  ] });
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 3);
});

test("a missing announcement is not treated as definitive non-publication", async () => {
  const h = createHarness({ records: [] });
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 3);
});

test("failed authoritative chat reads preserve ambiguous opening", async () => {
  const h = createHarness({ responses: [
    new Error("timeout"), new Error("timeout"), new Error("timeout")
  ] });
  assert.equal(await h.run(), null);
  assert.equal(h.calls.length, 3);
});

test("ownership loss during reconciliation aborts without verification", async () => {
  let count = 0;
  const h = createHarness({
    records: [goodMessage()],
    owned: () => ++count === 1
  });
  assert.equal(await h.run(), null);
});

test("reconciliation refuses matching messages entirely before the send boundary", async () => {
  const timestamp = new Date(START - 2500).toISOString().replace(".000Z", "Z");
  const h = createHarness({ records: [goodMessage({ created_at: timestamp })] });
  assert.equal(await h.run(), null);
});

test("ambiguous opening API timeouts do not trigger chatbox fallback duplicates", async () => {
  let fallback = 0;
  const runtime = vm.createContext({
    REHEARSAL_MODE: false,
    DEBUG_SETTINGS: {
      disable_chat_output: false,
      suppressApiMessages: false,
      log_chat_messages: false,
      verify_sendmessage: false
    },
    OT_USER_ID: 17,
    OT_CHATROOM_ID: 1,
    OT_CSRF_TOKEN: "token",
    prepareOutgoingMessage: text => text,
    trySendViaApi: async () => { throw new Error("POST timed out"); },
    sendViaChatbox: () => { fallback++; return true; },
    console: { warn() {} }
  });
  vm.runInContext(openingSend, runtime);
  assert.equal(await runtime.sendMessage("opening", {
    prepared: true, noFallbackOnApiException: true
  }), false);
  assert.equal(fallback, 0);
  assert.equal(await runtime.sendMessage("ordinary", { prepared: true }), true);
  assert.equal(fallback, 1);
});

test("recovery checkpoint and independent sponsor boundary survive snapshots", () => {
  assert.match(initialization, /openingCheckpoint: giveawayData\.openingCheckpoint/);
  assert.match(initialization, /sponsorStartTs: giveawayData\.sponsorStartTs/);
  assert.match(initialization, /verifyPendingGiveawayOpening\(/);
  const start = initialization.indexOf('if (snap.giveawayData?.openingCheckpoint?.status === "pending")');
  const restore = initialization.indexOf("// 1) Restore giveaway data", start);
  assert.ok(start >= 0 && restore > start);
  const guard = initialization.slice(start, restore);
  assert.match(guard, /if \(!verified\)/);
  assert.match(guard, /releaseTabLock\(\)/);
  assert.match(guard, /EXPIRED_SNAPSHOT_SETTLEMENT_GRACE_MS/);
  assert.match(guard, /localStorage\.setItem\(storageKey, verifiedRaw\)/);
  assert.match(guard, /read-back mismatch/);
  assert.doesNotMatch(guard, /endGiveaway\(/);
  assert.match(initialization, /giveawayStartTime: new Date\(\s*giveawayData\.sponsorStartTs \?\?/);
});

test("winners and host top-ups route command announcements privately under Silent Mode", () => {
  const winnerHandler = commands.slice(
    commands.indexOf("        winners(ctx) {"),
    commands.indexOf("        maxwinners(ctx) {")
  );
  assert.match(winnerHandler, /reply\(announcement\)/);
  assert.doesNotMatch(winnerHandler, /sendMessage\(announcement\)/);

  const topUp = commands.slice(
    commands.indexOf("    async function hostAddBon("),
    commands.indexOf("    function rebuildSchedule()")
  );
  assert.match(topUp, /sendCommandResponse\(author, potAnnouncement, \{/);
  assert.doesNotMatch(topUp, /await sendMessage\(\s*`\$\{bridgeMarker/);
  assert.match(utilities, /async function sendCommandResponse\(username, messageStr, options = \{\}\)/);
  assert.match(utilities, /return sendPrivateMessage\(username, messageStr, options\)/);
});

test("recoverable uncertain opening blocks a second start from overwriting its snapshot", () => {
  const start = lifecycle.indexOf("async function startGiveaway()");
  const startLock = lifecycle.indexOf("await acquireTabLock()", start);
  const safety = lifecycle.slice(start, startLock);
  assert.match(safety, /readActiveGiveawayRawForHost\(getLoggedInUsername\(\)/);
  assert.match(safety, /!proof \|\| proof\.status !== "confirmed"/);
  assert.match(safety, /GIVEAWAY START BLOCKED/);
});

test("manual !reminder uses the public broadcast path, regardless of Silent Mode", () => {
  assert.match(commands, /sendReminder\(\{ force: true \}\)/);
  assert.doesNotMatch(commands, /commandAuthor: ctx\.author/);
  const reminder = extract(utilities, "function sendReminder(");
  assert.match(reminder, /return sendMessage\(msg\)/);
  assert.doesNotMatch(reminder, /sendCommandResponse\(/);
});

function reminderHarness({ silent = false, rehearsal = false } = {}) {
  const publicMessages = [];
  const privateMessages = [];
  const ctx = vm.createContext({
    giveawayData: {
      host: "maghuro", amount: 100, startNum: 1, endNum: 20,
      customMessage: "Good luck!", donationPercent: 0, totalEntries: 20
    },
    REHEARSAL_MODE: rehearsal,
    GENERAL_SETTINGS: { silent_mode: silent },
    DEBUG_SETTINGS: {
      disable_chat_output: false, suppressApiMessages: false,
      log_chat_messages: false, verify_sendmessage: false
    },
    OT_USER_ID: 17, OT_CHATROOM_ID: 1, OT_CSRF_TOKEN: "token",
    reminderRetryTimeout: null,
    isGiveawaySettling: () => false,
    getGiveawayRemainingMs: () => 10 * MINUTE,
    shouldSendReminder: () => true,
    silentNote: () => "",
    rigNote: () => "",
    normalizeDonationPercent: () => 0,
    riggedMode: false,
    BRIDGE_MARKERS: { START: "start" },
    bridgeMarker: () => "🎁",
    fmtBONCurrency: amount => String(amount),
    cleanPotString: amount => amount,
    buildWinnersAnnouncementLine: () => "1 winner",
    parseTime: () => "10:00",
    getGiftSyntaxHostName: () => "maghuro",
    buildDonationContext: () => "",
    GIFT_HINT_COLOR: "#abcdef",
    getLoggedInUsername: () => "maghuro",
    prepareOutgoingMessage: text => text,
    trySendViaApi: async text => { publicMessages.push(text); return true; },
    sendPrivateMessage: async (user, text) => {
      privateMessages.push({ user, text });
      return true;
    },
    formatRehearsalPrivateOutput: text => "[REHEARSAL] " + text,
    sanitizeNick: x => x,
    logEvent() {}
  });
  vm.runInContext([
    extract(utilities, "async function sendMessage("),
    extract(utilities, "function sendReminder(")
  ].join("\n"), ctx);
  return { send: options => ctx.sendReminder(options), publicMessages, privateMessages };
}

test("!reminder broadcasts the actual reminder to Main Chat with Silent Mode enabled", async () => {
  const h = reminderHarness({ silent: true });
  assert.equal(await h.send({ force: true }), true);
  assert.equal(h.publicMessages.length, 1);
  assert.match(h.publicMessages[0], /Ongoing giveaway for/);
  assert.match(h.publicMessages[0], /Time left:/);
  assert.equal(h.privateMessages.length, 0);
});

test("manual and scheduled reminders share the public chat route in normal mode", async () => {
  const h = reminderHarness();
  assert.equal(await h.send({ force: true }), true);
  assert.equal(await h.send(), true);
  assert.equal(h.publicMessages.length, 2);
  assert.equal(h.privateMessages.length, 0);
});

test("Rehearsal Mode keeps manually requested reminders private to the host", async () => {
  const h = reminderHarness({ silent: true, rehearsal: true });
  assert.equal(await h.send({ force: true }), true);
  assert.equal(h.publicMessages.length, 0);
  assert.equal(h.privateMessages.length, 1);
  assert.equal(h.privateMessages[0].user, "maghuro");
  assert.match(h.privateMessages[0].text, /\[REHEARSAL\]/);
  assert.match(h.privateMessages[0].text, /Ongoing giveaway for/);
});

test("missing pre-send Main Chat cursor blocks live opening instead of matching an older post", async () => {
  for (const cursor of [null, 0, -1]) {
    const h = createHarness({ records: [goodMessage()] });
    h.checks.afterMessageId = cursor;
    assert.equal(await h.run(), null, "Bad cursor " + cursor + " must fail closed");
    assert.equal(h.calls.length, 0, "No ambiguous authoritative match without a pre-send cursor");
  }
  const start = lifecycle.indexOf("const afterMessageId = REHEARSAL_MODE");
  const post = lifecycle.indexOf("const introSent = await sendMessage(", start);
  const guard = lifecycle.slice(start, post);
  assert.match(guard, /!Number\.isSafeInteger\(afterMessageId\)/);
  assert.match(guard, /afterMessageId <= 0/);
  assert.match(guard, /resetGiveaway\(\)/);
  assert.ok(guard.indexOf("resetGiveaway()") < guard.indexOf("openingCheckpoint = {"));
});

test("chat reconciliation does not accept missing IDs or records preceding the cursor", async () => {
  const h = createHarness({ records: [
    goodMessage({ id: null }),
    goodMessage({ id: 100 })
  ] });
  assert.equal(await h.run(), null);
});

test("a confirmed opening enables sponsor accounting only after canonical reconciliation", () => {
  const anchor = lifecycle.indexOf("giveawayData.sponsorStartTs = verifiedOpening.sponsorStartTs");
  const code = lifecycle.slice(anchor, lifecycle.indexOf("chatReplayIgnoreBeforeTs = null;", anchor));
  const reconcile = code.indexOf("await tracker.reconcileCanonicalSponsorAccounting(");
  const verifyPersist = code.indexOf("snapshotGiveaway({ force: true, verifyWrite: true })", reconcile);
  const confirmed = code.indexOf("setSponsorAccountingVerificationState(", verifyPersist);
  const deferred = code.indexOf("scheduleSponsorAccountingRecovery(tracker)");
  assert.ok(reconcile >= 0, "Must reconcile canonical Gift History after verified opening");
  assert.ok(verifyPersist > reconcile, "Must persist canonical reconciliation");
  assert.ok(confirmed > verifyPersist, "Cannot enable accounting before persistence");
  assert.ok(deferred > confirmed, "On failure recovery remains retryable");
  assert.match(code, /if \(giveawayData\.__sponsorAccountingVerified === true\)/);
  assert.match(code, /scheduleSponsorAccountingRecovery\(tracker\)/);
});

test("the bounded send window is persisted before POST and completion before verification", () => {
  const beginning = lifecycle.indexOf("const openingSendStartedAt = Date.now();");
  const storeHardEnd = lifecycle.indexOf(
    "windowEndAt: openingSendStartedAt + OPENING_POST_MAX_PUBLICATION_WINDOW_MS", beginning
  );
  const firstPersistence = lifecycle.indexOf(
    "snapshotGiveaway({ force: true, verifyWrite: true })", storeHardEnd
  );
  const posted = lifecycle.indexOf("const introSent = await sendMessage(", firstPersistence);
  const finished = lifecycle.indexOf(
    "giveawayData.openingCheckpoint.sendCompletedAt = Date.now();", posted
  );
  const persistedCompletion = lifecycle.indexOf(
    "snapshotGiveaway({ force: true, verifyWrite: true })", finished
  );
  const verified = lifecycle.indexOf("await verifyPendingGiveawayOpening(", posted);
  assert.ok(beginning >= 0 && storeHardEnd > beginning);
  assert.ok(firstPersistence > storeHardEnd && posted > firstPersistence);
  assert.ok(finished > posted && persistedCompletion > finished && verified > persistedCompletion);
  assert.match(lifecycle, /timestamp < startedAt/);
  assert.match(lifecycle, /\(timestamp \+ resolutionMs\) > windowEnd/);
});

function sponsorHistoryFilterHarness({ calibrated = true } = {}) {
  const start = sponsorship.indexOf("        async filterHistoryRowsByWindow(");
  const end = sponsorship.indexOf("\n        async processGiftHistoryRows(", start);
  assert.ok(start >= 0 && end > start, "SponsorTracker filter extraction failed");
  const method = sponsorship.slice(start, end);
  const ctx = vm.createContext({
    optionalFiniteNumber: val => val === undefined || val === null ? null : Number(val),
    DEBUG_SETTINGS: { log_chat_messages: false },
    unit3dTimestampResolutionMs: () => 1000,
    normalizeUserKey: x => String(x || "").toLowerCase(),
    logEvent() {},
    sanitizeNick: x => x,
    fmtBONCurrency: x => x
  });
  vm.runInContext(`class HistoryFilterTest { ${method} }
    this.HistoryFilterTest = HistoryFilterTest;`, ctx);
  const tracker = new ctx.HistoryFilterTest();
  tracker.data = { endTs: 5000 };
  tracker.maxAcceptedCreatedAtTs = null;
  tracker.giftHistoryClockOffsetMs = calibrated ? 0 : null;
  tracker.giftHistorySeenKeys = new Set();
  tracker.ensureGiftHistoryClockOffset = async () => calibrated ? 0 : null;
  tracker.fetchRecentChatGiftEvents = async () => [];
  return tracker;
}
function giftAt(time, key) {
  return {
    historyKey: key,
    sender: "sponsor", recipient: "host", amount: 100,
    createdAtTs: time, createdAtAltTs: time,
    rawTimestamp: "2026-10-10 11:00:02",
    timestampResolutionMs: 1000
  };
}

test("calibrated Gift History excludes a coarse gift overlapping the sponsor-opening boundary", async () => {
  const tracker = sponsorHistoryFilterHarness({ calibrated: true });
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(2000, "before"),
    giftAt(3101, "after"),
    giftAt(3500, "later")
  ], 2000.5, 4500);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].historyKey, "after");
  assert.equal(result.accepted[1].historyKey, "later");
});

test("uncalibrated Gift History defers ALL gifts rather than guessing a timezone", async () => {
  const tracker = sponsorHistoryFilterHarness({ calibrated: false });
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(2000, "before"),
    giftAt(3101, "apparently-after")
  ], 2000.5, 4500);
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(Array.from(result.retryableKeys).sort(), ["apparently-after", "before"]);
});

test("uncalibrated interpretations remain unverified even with no closing cutoff", async () => {
  const tracker = sponsorHistoryFilterHarness({ calibrated: false });
  tracker.data.endTs = null;
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(3101, "unresolved")
  ], 2000.5, null);
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(Array.from(result.retryableKeys), ["unresolved"]);
});

test("even without a closing timestamp, an overlapping pre-opening gift is not sponsored", async () => {
  const tracker = sponsorHistoryFilterHarness();
  tracker.data.endTs = null;
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(1999, "old"),
    giftAt(3101, "new")
  ], 2000.5, null);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].historyKey, "new");
});

test("non-OK opening POST never retries the same announcement via chatbox", async () => {
  let publicApiCalls = 0;
  let fallbackCalls = 0;
  const sandbox = vm.createContext({
    REHEARSAL_MODE: false,
    DEBUG_SETTINGS: {
      disable_chat_output: false, suppressApiMessages: false,
      verify_sendmessage: false, log_chat_messages: false
    },
    OT_USER_ID: 17, OT_CHATROOM_ID: 1, OT_CSRF_TOKEN: "csrf",
    prepareOutgoingMessage: x => x,
    fetchWithTimeout: async () => {
      publicApiCalls++;
      return { ok: false, status: 500, text: async () => '{"error":"server error"}' };
    },
    sendViaChatbox: () => { fallbackCalls++; return true; },
    console: { error() {}, warn() {} }
  });
  vm.runInContext([
    extract(utilities, "async function trySendViaApi("),
    openingSend
  ].join("\n"), sandbox);
  assert.equal(await sandbox.sendMessage("opening", {
    prepared: true, noFallbackOnApiException: true
  }), false);
  assert.equal(publicApiCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(await sandbox.sendMessage("ordinary", { prepared: true }), true);
  assert.equal(publicApiCalls, 2);
  assert.equal(fallbackCalls, 1);
});

test("opening never falls back when the API is disabled or returns false before posting", async () => {
  for (const suppressed of [true, false]) {
    let fallbackCalls = 0;
    const sandbox = vm.createContext({
      REHEARSAL_MODE: false,
      DEBUG_SETTINGS: {
        disable_chat_output: false, suppressApiMessages: suppressed,
        verify_sendmessage: false, log_chat_messages: false
      },
      OT_USER_ID: 17, OT_CHATROOM_ID: 1, OT_CSRF_TOKEN: "csrf",
      prepareOutgoingMessage: x => x,
      trySendViaApi: async () => false,
      sendViaChatbox: () => { fallbackCalls++; return true; },
      console: { warn() {} }
    });
    vm.runInContext(openingSend, sandbox);
    assert.equal(await sandbox.sendMessage("opening", {
      prepared: true, noFallbackOnApiException: true
    }), false);
    assert.equal(fallbackCalls, 0);
  }
});

test("calibration fractional bias cannot turn a pre-opening gift into a sponsor", async () => {
  const tracker = sponsorHistoryFilterHarness({ calibrated: true });
  // A calibration anchor at .750s produces offset -750ms for a coarse
  // Gift History .000s bucket. Without uncertainty the gift falsely moves
  // 750ms later and falls beyond the 3000.5ms opening boundary.
  tracker.giftHistoryClockOffsetMs = -750;
  tracker.giftHistoryClockOffsetUncertaintyMs = 1000;
  tracker.data.endTs = 10000;
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(2500, "before"),
    giftAt(4250, "after")
  ], 3000.5, 10000);
  assert.deepEqual(Array.from(result.accepted, x => x.historyKey), ["after"]);
});

test("the inferred calibration error is propagated and conserved", () => {
  const start = sponsorship.indexOf("        inferGiftHistoryClockOffset(");
  const end = sponsorship.indexOf("\n        matchGiftEventsToRows(", start);
  assert.ok(start >= 0 && end > start);
  const method = sponsorship.slice(start, end);
  const context = vm.createContext({
    optionalFiniteNumber: x => x == null ? null : Number(x),
    normalizeUserKey: x => String(x || "").toLowerCase(),
    unit3dTimestampResolutionMs: () => 1000
  });
  vm.runInContext(
    `class CalibrationTest { ${method} } this.CalibrationTest = CalibrationTest;`,
    context
  );
  const tracker = new context.CalibrationTest();
  tracker.giftHistoryClockOffsetMs = null;
  const offset = tracker.inferGiftHistoryClockOffset(
    [{ gifter: "sponsor", recipient: "host", rawAmount: 100, createdAtTs: 2750 }],
    [{ sender: "sponsor", recipient: "host", amount: 100, createdAtAltTs: 2000,
       rawTimestamp: "2026-10-10 11:00:02", timestampResolutionMs: 1000 }]
  );
  assert.equal(offset, -750);
  assert.ok(tracker.giftHistoryClockOffsetUncertaintyMs >= 1000);
});

test("clock-offset uncertainty survives sponsor snapshot and restore", () => {
  const load = initialization;
  const sponsorshipTrackerStart = sponsorship.slice(
    sponsorship.indexOf("    class SponsorTracker {"),
    sponsorship.indexOf("        /* ---- poll for any chat messages since last cursor ---- */")
  );
  assert.match(sponsorshipTrackerStart, /giftHistoryClockOffsetUncertaintyMs = null/);
  assert.match(load, /giftHistoryClockOffsetUncertaintyMs:\s*optionalFiniteNumber\(window\.__activeTracker\.giftHistoryClockOffsetUncertaintyMs\)/);
  assert.match(load, /giftHistoryClockOffsetUncertaintyMs: savedTracker/);
});

test("starting a new giveaway repeats recovery snapshot check inside the acquired lock", () => {
  const start = lifecycle.indexOf("async function startGiveaway()");
  const beforeLock = lifecycle.indexOf("const prior = readActiveGiveawayRawForHost(", start);
  const locked = lifecycle.indexOf("if (!await acquireTabLock())", start);
  const afterLock = lifecycle.indexOf("const savedAfterLock = readActiveGiveawayRawForHost(", locked);
  const firstMutation = lifecycle.indexOf("if (sponsorsInterval)", afterLock);
  const guard = lifecycle.slice(afterLock, firstMutation);
  assert.ok(start >= 0 && beforeLock > start && locked > beforeLock);
  assert.ok(afterLock > locked && firstMutation > afterLock);
  assert.match(guard, /if \(!savedAfterLock\.readOk \|\| savedAfterLock\.hasStoredState \|\| !savedAfterLock\.storageKey\)/);
  assert.match(guard, /releaseTabLock\(\)/);
  assert.match(guard, /return;/);
});

test("authoritatively confirmed opening must reverify identical original message ID", async () => {
  const valid = createHarness({ records: [goodMessage()] });
  valid.checks.status = "confirmed";
  valid.checks.messageId = 101;
  const result = await valid.run();
  assert.ok(result);
  assert.equal(result.messageId, 101);

  const altered = createHarness({ records: [goodMessage({ id: 102 })] });
  altered.checks.status = "confirmed";
  altered.checks.messageId = 101;
  assert.equal(await altered.run(), null);

  const missing = createHarness({ records: [goodMessage()] });
  missing.checks.status = "confirmed";
  assert.equal(await missing.run(), null);
});

test("confirmed restore verifies Main Chat before reloading entries or settlement", () => {
  const begin = initialization.indexOf("async function restoreGiveawayFromSnapshot(");
  const afterLock = initialization.indexOf("if (!await acquireTabLock())", begin);
  const check = initialization.indexOf("restoredCheckpoint?.status === \"confirmed\"", afterLock);
  const verify = initialization.indexOf("await verifyPendingGiveawayOpening(restoredCheckpoint)", check);
  const restoreEntries = initialization.indexOf("// 1) Restore giveaway data", verify);
  assert.ok(begin >= 0 && afterLock > begin && check > afterLock);
  assert.ok(verify > check && restoreEntries > verify);
  const guard = initialization.slice(check, restoreEntries);
  assert.match(guard, /verified\.messageId !== optionalFiniteNumber\(restoredCheckpoint\.messageId\)/);
  assert.match(guard, /verified\.sponsorStartTs !== savedSponsorStart/);
  assert.match(guard, /releaseTabLock\(\)/);
  assert.match(guard, /return false;/);
});

test("unverified history keys remain retryable across polling and block canonical payout", () => {
  assert.match(sponsorship, /if \(min !== null && offset === null\)/);
  assert.match(sponsorship, /retryableKeys: new Set\(/);
  assert.match(sponsorship, /if \(!item\.historyKey \|\| retryableBoundaryKeys\.has\(item\.historyKey\)\) continue/);
  assert.match(sponsorship, /if \(filtered\.retryableKeys\.size\)/);
  assert.match(sponsorship, /Gift History reconciliation found timestamp-boundary rows/);
});

function recoveryReadHarness({ namespaced = null, legacy = null, throwsOn = "" } = {}) {
  const storage = new Map();
  if (namespaced !== null) storage.set("recovery::maghuro", namespaced);
  if (legacy !== null) storage.set("recovery", legacy);
  const events = [];
  const ctx = vm.createContext({
    REHEARSAL_MODE: false,
    LS_ACTIVE_GIVEAWAY_LEGACY: "recovery",
    REHEARSAL_STORAGE_SUFFIX: "",
    normalizeUserKey: s => String(s || "").toLowerCase(),
    getLoggedInUsername: () => "maghuro",
    getActiveGiveawayStorageKey: () => "recovery::maghuro",
    localStorage: {
      getItem: key => {
        if (throwsOn === "read") throw Error("read denied");
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem: (key, value) => {
        if (throwsOn === "write") throw Error("write denied");
        storage.set(key, value);
        events.push("write:" + key);
      },
      removeItem: key => {
        if (throwsOn === "remove") throw Error("remove denied");
        storage.delete(key);
      }
    },
    console: { warn() {} }
  });
  vm.runInContext([
    extract(initialization, "function readActiveGiveawayRawForHost(")
  ].join("\n"), ctx);
  return { read: (...args) => ctx.readActiveGiveawayRawForHost(...args), events };
}

test("recovery storage access failures never masquerade as empty storage", () => {
  const denied = recoveryReadHarness({ throwsOn: "read" }).read("maghuro", { migrateLegacy: true });
  assert.equal(denied.readOk, false);
  assert.equal(denied.raw, null);

  const malformed = recoveryReadHarness({ legacy: "{bad json" }).read("maghuro", { migrateLegacy: true });
  assert.equal(malformed.readOk, false);
  assert.equal(malformed.raw, null);

  const failedWrite = recoveryReadHarness({
    legacy: JSON.stringify({ giveawayData: { host: "maghuro" } }),
    throwsOn: "write"
  }).read("maghuro", { migrateLegacy: true });
  assert.equal(failedWrite.readOk, false);
});

test("only positively established empty recovery storage allows start prechecks", () => {
  const absent = recoveryReadHarness().read("maghuro", { migrateLegacy: true });
  assert.equal(absent.readOk, true);
  assert.equal(absent.raw, null);
  const existing = recoveryReadHarness({
    namespaced: JSON.stringify({ giveawayData: { host: "maghuro" } })
  }).read("maghuro", { migrateLegacy: true });
  assert.equal(existing.readOk, true);
  assert.ok(existing.raw);
  const start = lifecycle.slice(
    lifecycle.indexOf("async function startGiveaway()"),
    lifecycle.indexOf("if (sponsorsInterval)")
  );
  assert.match(start, /if \(!prior\.readOk \|\| !prior\.storageKey\)/);
  assert.match(start, /if \(!savedAfterLock\.readOk \|\| savedAfterLock\.hasStoredState/);
});

test("preflight state cannot be snapshotted by pagehide or beforeunload", () => {
  const persistentWrites = [];
  const sandbox = vm.createContext({
    giveawayData: { host: "maghuro", openedAt: null, endTs: 123456 },
    canMutateActiveGiveaway: () => true,
    window: {},
    localStorage: { setItem: (...args) => persistentWrites.push(args) }
  });
  vm.runInContext(extract(initialization, "function snapshotGiveaway("), sandbox);
  assert.equal(sandbox.snapshotGiveaway({ force: true, verifyWrite: true }), false);
  assert.equal(sandbox.snapshotGiveaway(), false);
  assert.equal(persistentWrites.length, 0);
  const start = lifecycle.slice(
    lifecycle.indexOf("async function startGiveaway()"),
    lifecycle.indexOf("async function resetGiveaway(")
  );
  assert.match(start, /if \(!ownsTabLock\(\)\) return;/);
  const hide = initialization.slice(
    initialization.indexOf("function handleGiveawayPageHide("),
    initialization.indexOf("function handleGiveawayPageShow(")
  );
  assert.match(hide, /snapshotGiveaway\(\)/);
  assert.match(initialization, /if \(!giveawayData \|\|[\s\S]*?!proof \|\|/);
});

test("empty but present recovery key is occupied and blocks a new opening", () => {
  const empty = recoveryReadHarness({ namespaced: "" }).read("maghuro", { migrateLegacy: true });
  assert.equal(empty.readOk, true);
  assert.equal(empty.hasStoredState, true);
  assert.equal(empty.raw, "");
  const trulyEmpty = recoveryReadHarness().read("maghuro", { migrateLegacy: true });
  assert.equal(trulyEmpty.readOk, true);
  assert.equal(trulyEmpty.hasStoredState, false);
  const start = lifecycle.slice(
    lifecycle.indexOf("async function startGiveaway()"),
    lifecycle.indexOf("if (sponsorsInterval)")
  );
  assert.match(start, /if \(prior\.hasStoredState\)/);
  assert.match(start, /if \(!savedAfterLock\.readOk \|\| savedAfterLock\.hasStoredState/);
});

test("empty legacy key is occupied, unreadable and never treated as vacant", () => {
  const empty = recoveryReadHarness({ legacy: "" }).read("maghuro", { migrateLegacy: false });
  assert.equal(empty.readOk, false, "Corrupt present legacy key cannot permit a new start");
  assert.equal(empty.raw, null);
  const afterLock = recoveryReadHarness({ legacy: "" }).read("maghuro", { migrateLegacy: true });
  assert.equal(afterLock.readOk, false);
  assert.equal(afterLock.raw, null);
});

test("initial legacy discovery is strictly read-only; migration waits for lock", () => {
  const raw = JSON.stringify({ giveawayData: { host: "maghuro" } });
  const h = recoveryReadHarness({ legacy: raw });
  const before = h.read("maghuro", { migrateLegacy: false });
  assert.equal(before.readOk, true);
  assert.equal(before.hasStoredState, true);
  assert.equal(before.raw, raw);
  assert.deepEqual(h.events, []);
  const after = h.read("maghuro", { migrateLegacy: true });
  assert.equal(after.readOk, true);
  assert.equal(after.migratedLegacy, true);
  assert.deepEqual(h.events, ["write:recovery::maghuro"]);
  const loadStart = initialization.indexOf("function loadGiveawaySnapshot()");
  const loadEnd = initialization.indexOf("function clearSponsorAccountingRecoveryTimer()", loadStart);
  const loader = initialization.slice(loadStart, loadEnd);
  assert.match(loader, /migrateLegacy: false/);
  assert.doesNotMatch(loader, /migrateLegacy: true/);
});

test("restore discards pre-lock object and freshly validates durable state under exclusive ownership", () => {
  const start = initialization.indexOf("async function restoreGiveawayFromSnapshot(");
  const acquire = initialization.indexOf("if (!await acquireTabLock())", start);
  const read = initialization.indexOf("const lockedRead = readActiveGiveawayRawForHost(", acquire);
  const validateRead = initialization.indexOf("!lockedRead.readOk", read);
  const fresh = initialization.indexOf("const lockedSnapshot = loadGiveawaySnapshot()", read);
  const freshness = initialization.indexOf("snap = lockedSnapshot;", fresh);
  const verified = initialization.indexOf("const restoredCheckpoint = snap.giveawayData?.openingCheckpoint", freshness);
  const hydrate = initialization.indexOf("// 1) Restore giveaway data", verified);
  assert.ok(start >= 0 && acquire > start && read > acquire);
  assert.ok(validateRead > read && fresh > validateRead && freshness > fresh);
  assert.ok(verified > freshness && hydrate > verified);
  const guard = initialization.slice(read, freshness);
  assert.match(guard, /migrateLegacy: true/);
  assert.match(guard, /!lockedRead.hasStoredState/);
  assert.match(guard, /!ownsTabLock\(\)/);
  assert.match(guard, /releaseTabLock\(\)/);
  assert.match(guard, /lockedSnapshot.__legacyOpeningUnverified === true/);
});

test("fresh restore rejects deleted or corrupted recovery even when caller holds old snapshot", () => {
  const begin = initialization.indexOf("const lockedRead = readActiveGiveawayRawForHost(");
  const end = initialization.indexOf("snap = lockedSnapshot;", begin);
  const body = initialization.slice(begin, end);
  assert.match(body, /!lockedRead.readOk/);
  assert.match(body, /!lockedRead.hasStoredState/);
  assert.match(body, /!lockedRead.raw/);
  assert.match(body, /!lockedSnapshot/);
  assert.match(body, /normalizeUserKey\(lockedSnapshot.giveawayData.host\)/);
  assert.match(body, /lockedSnapshot.giveawayData.rehearsalMode === true/);
});

test("valid but hostless legacy records remain occupied and block new starts", () => {
  const examples = [
    "{}", '{"giveawayData":{}}', '{"giveawayData":{"host":""}}',
    '{"giveawayData":{"host":null}}', "null", '"unexpected"'
  ];
  for (const raw of examples) {
    for (const migrateLegacy of [false, true]) {
      const h = recoveryReadHarness({ legacy: raw });
      const state = h.read("maghuro", { migrateLegacy });
      assert.equal(state.readOk, false, `Unidentified record must fail closed: ${raw}`);
      assert.equal(state.hasStoredState, true);
      assert.equal(state.raw, raw);
      assert.equal(state.migratedLegacy, false);
      assert.deepEqual(h.events, [], "Unidentified state must not be migrated");
    }
  }
  const foreignRaw = JSON.stringify({ giveawayData: { host: "different-host" } });
  for (const migrateLegacy of [false, true]) {
    const h = recoveryReadHarness({ legacy: foreignRaw });
    const state = h.read("maghuro", { migrateLegacy });
    assert.equal(state.readOk, true);
    assert.equal(state.hasStoredState, false);
    assert.equal(state.raw, null);
    assert.deepEqual(h.events, []);
  }
});

test("restore rejects stale recovery flags only after refreshing under exclusive lock", () => {
  const start = initialization.indexOf("async function restoreGiveawayFromSnapshot(");
  const lock = initialization.indexOf("if (!await acquireTabLock())", start);
  const read = initialization.indexOf("const lockedRead = readActiveGiveawayRawForHost(", lock);
  const fresh = initialization.indexOf("const lockedSnapshot = loadGiveawaySnapshot()", read);
  const replace = initialization.indexOf("snap = lockedSnapshot;", fresh);
  const verify = initialization.indexOf("const restoredCheckpoint = snap.giveawayData?.openingCheckpoint", replace);
  assert.ok(start >= 0 && lock > start && read > lock && fresh > read);
  assert.ok(replace > fresh && verify > replace);
  const prelock = initialization.slice(start, lock);
  assert.doesNotMatch(prelock,
    /__expiredBeyondGrace|__legacyOpeningUnverified|openingCheckpoint|restoreExpectedHost|snap\.giveawayData/);
  const lockedGuard = initialization.slice(fresh, replace);
  assert.match(lockedGuard, /lockedSnapshot.__expiredBeyondGrace === true/);
  assert.match(lockedGuard, /lockedSnapshot.__legacyOpeningUnverified === true/);
  assert.match(lockedGuard, /normalizeUserKey\(lockedSnapshot.giveawayData.host\)/);
  assert.match(lockedGuard, /lockedSnapshot.giveawayData.rehearsalMode === true/);
  assert.match(lockedGuard, /releaseTabLock\(\)/);
  assert.match(lockedGuard, /return false;/);
});
