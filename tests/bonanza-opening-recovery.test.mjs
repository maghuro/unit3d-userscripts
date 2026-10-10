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
  assert.match(safety, /openingCheckpoint\?\.status === "pending"/);
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
    giftAt(2001, "after"),
    giftAt(2500, "later")
  ], 2000.5, 4500);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].historyKey, "after");
  assert.equal(result.accepted[1].historyKey, "later");
});

test("fallback Gift History interpretations exclude overlapping opening buckets", async () => {
  const tracker = sponsorHistoryFilterHarness({ calibrated: false });
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(2000, "before"),
    giftAt(2001, "after")
  ], 2000.5, 4500);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].historyKey, "after");
});

test("even without a closing timestamp, an overlapping pre-opening gift is not sponsored", async () => {
  const tracker = sponsorHistoryFilterHarness();
  tracker.data.endTs = null;
  const result = await tracker.filterHistoryRowsByWindow([
    giftAt(1999, "old"),
    giftAt(2001, "new")
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
