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
    preparedMessage
  };
  const runtime = vm.createContext({
    URL,
    location: { origin: "https://darkpeers.org" },
    OT_USER_ID: 17,
    DARKPEERS_MAIN_CHATROOM_ID: 1,
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

test("verified sponsorship starts AFTER the publication timestamp bucket", async () => {
  const h = createHarness({ records: [goodMessage({ created_at: sameSecond })] });
  const result = await h.run();
  assert.ok(result);
  assert.equal(result.sponsorStartTs, START + 500);
  assert.ok(result.sponsorStartTs >= START);
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
