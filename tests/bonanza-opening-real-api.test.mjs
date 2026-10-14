import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const lifecycle = readFileSync(
  new URL("../userscripts/giveaway/src/06-lifecycle.js", import.meta.url), "utf8"
);
const first = lifecycle.indexOf("    async function verifyPendingGiveawayOpening(");
const last = lifecycle.indexOf("\n    async function startGiveaway()", first);
assert.ok(first !== -1 && last > first);
const source = lifecycle.slice(first, last);
const startMs = Date.parse("2026-10-14T20:25:29.220Z");
const endMs = Date.parse("2026-10-14T20:25:29.403Z");
const openingProof = "\u2063\u200B\u2063\u200B" +
  "\u200B\u2063".repeat(64) + "\u200B\u2063\u200B\u2063";
const preparedMessage = "🎁[b][i][u]\u2063[/u][/i][/b] 💙 [b][color=#4FAFFF]BON POOL CONTRIBUTION G\u200bIVEAWAY[/color][/b]\nI am hosting a giveaway for [b]101 042 BON[/b]" + openingProof;
const renderedMessage = '<img class="joypixels" alt="&#x1f381;"/> <b><i><u>\u2063</u></i></b> <img class="joypixels" alt="&#x1f499;"/> <b><span style="color: #4FAFFF">BON POOL CONTRIBUTION G\u200bIVEAWAY</span></b><br>I am hosting a giveaway for <b>101 042 BON</b>' + openingProof;

const real = (id = 629180, override = {}) => ({
  id, user: { id: 10, username: "maghuro" },
  message: renderedMessage,
  created_at: "2026-10-14T20:25:29+00:00",
  ...override
});

async function verify(records, opts = {}) {
  const checkpoint = {
    status: opts.status || "pending", host: "maghuro",
    startedAt: startMs, sendCompletedAt: endMs,
    windowEndAt: startMs + 10000, afterMessageId: 629175,
    preparedMessage, openingProof, sendAcknowledged: opts.ack !== false,
    ...(opts.checkpoint || {})
  };
  const ctx = vm.createContext({
    URL, location: { origin: "https://darkpeers.org" },
    OT_USER_ID: 10, DARKPEERS_MAIN_CHATROOM_ID: 1,
    OPENING_POST_MAX_PUBLICATION_WINDOW_MS: 10000,
    ownsTabLock: () => true,
    optionalFiniteNumber: v => v == null ? null : Number(v),
    unit3dTimestampResolutionMs: str => /\.\d+/.test(String(str)) ? 1 : 1000,
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ data: records }) }),
    setTimeout: fn => fn(), console: { warn() {} }
  });
  vm.runInContext(source, ctx);
  return ctx.verifyPendingGiveawayOpening(checkpoint);
}

test("real DarkPeers HTML, JoyPixels alt and whole-second timestamp confirm acknowledged POST", async () => {
  const r = await verify([real()]);
  assert.equal(r.messageId, 629180);
  assert.equal(r.sponsorStartTs, Date.parse("2026-10-14T20:25:30Z"));
});

test("durable unique proof recovers a posted opening even after lost HTTP acknowledgement", async () => {
  assert.equal((await verify([real()], { ack: false })).messageId, 629180);
});

test("old checkpoints without an opening proof still cannot match partial server-second buckets", async () => {
  assert.equal(await verify([real()], { checkpoint: { openingProof: null } }), null);
});

test("mismatched or copied opening proof fails despite matching text", async () => {
  const differentMarker = "\u2063\u200B\u2063\u200B" +
    "\u2063\u200B".repeat(64) + "\u200B\u2063\u200B\u2063";
  assert.equal(await verify([real(629180, {
    message: renderedMessage.replace(openingProof, differentMarker)
  })]), null);
});

test("the opening path generates a fresh 128-bit proof before checkpoint and POST", () => {
  const marker = lifecycle.indexOf("const openingProof = REHEARSAL_MODE ? null : createOpeningProofMarker()");
  const saved = lifecycle.indexOf("openingProof,", marker);
  const posted = lifecycle.indexOf("const introSent = await sendMessage(", marker);
  assert.ok(marker > 0 && saved > marker && posted > saved);
});

test("earlier identical chat announcement cannot confirm a later attempt", async () => {
  assert.equal(await verify([real(629177, {
    created_at: "2026-10-14T20:25:23+00:00"
  })]), null);
});

test("duplicate same-second announcements remain unverified despite HTTP 200", async () => {
  assert.equal(await verify([real(), real(629181)]), null);
});

test("author ID, before-send cursor and actual content are mandatory", async () => {
  assert.equal(await verify([
    real(629170),
    real(629181, { user: { id: 11, username: "other" } }),
    real(629182, { message: renderedMessage.replace("101 042", "101 043") })
  ]), null);
});

test("conflicting numeric user ID defeats matching username", async () => {
  assert.equal(await verify([real(629180, { user_id: 99 })]), null);
});

test("no numeric or username author evidence cannot confirm an opening", async () => {
  assert.equal(await verify([real(629180, { user: undefined })]), null);
});

test("authenticated username fallback supports missing numeric user IDs", async () => {
  assert.equal((await verify([
    real(629180, { user: { username: "maghuro" } })
  ])).messageId, 629180);
});

test("confirmed checkpoints are pinned to the saved message ID", async () => {
  assert.equal(await verify([real()], {
    status: "confirmed", checkpoint: { messageId: 629181 }
  }), null);
});

test("publication after HTTP completion cannot confirm", async () => {
  assert.equal(await verify([real(629182, {
    created_at: "2026-10-14T20:25:30+00:00"
  })]), null);
});

test("opening acknowledgement is durably saved before reconciliation", () => {
  const post = lifecycle.indexOf("const introSent = await sendMessage(");
  const ack = lifecycle.indexOf(
    "giveawayData.openingCheckpoint.sendAcknowledged = introSent === true;", post
  );
  const persist = lifecycle.indexOf(
    "snapshotGiveaway({ force: true, verifyWrite: true })", ack
  );
  const verified = lifecycle.indexOf("await verifyPendingGiveawayOpening(", ack);
  assert.ok(post > 0 && ack > post && persist > ack && verified > persist);
});
