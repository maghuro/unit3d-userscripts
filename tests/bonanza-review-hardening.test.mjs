import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourcePath = new URL(
  "../userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js",
  import.meta.url
);
const source = readFileSync(sourcePath, "utf8");

test("review hardening invariants stay present", () => {
  assert.match(source, /^\/\/ @version\s+1\.5\.13$/m);
  assert.doesNotMatch(source, /pollChatFallback/);
  assert.doesNotMatch(source, /onlyguardians/i);
  assert.match(source, /async function getLatestMainChatReplayBoundary\(\)/);
  assert.match(source, /chatReplayIgnoreBeforeTs = replayBoundary\.ts - resolutionMs/);
  assert.match(source, /chatReplayCommandIgnoreBeforeTs = replayBoundary\.ts/);
  assert.match(source, /const REHEARSAL_MODE = !!\(/);
  assert.match(source, /Rehearsal gift suppressed/);
  assert.match(source, /Rehearsal BON Pool contribution suppressed/);
  assert.equal(
    (source.match(/getLatestChatMessageId\(DARKPEERS_MAIN_CHATROOM_ID\)/g) || []).length,
    4
  );
  assert.equal(
    (source.match(/getLatestChatMessageId\(DARKPEERS_CHATROOM_ID\)/g) || []).length,
    2
  );
});

test("BON gift notification cleanup is scoped and non-blocking", () => {
  assert.match(source, /async function markGiveawayBonNotificationsRead\(\{ hostName, startTs, endTs \} = \{\}\)/);
  assert.match(source, /giftNotificationOverlapsWindow\(notification, start, end\)/);
  assert.match(source, /const ts = Number\.isFinite\(utcTs\) \? utcTs : localTs/);
  assert.match(source, /return \(ts \+ resolutionMs\) >= start && ts <= end/);
  assert.doesNotMatch(source, /ts <= \(end \+ resolutionMs\)/);
  assert.match(source, /input\[name="_method"\][\s\S]*?PATCH/);
  assert.match(source, /actionUrl\.pathname\.startsWith\(notificationsPath \+ "\/"\)/);
  assert.doesNotMatch(source, /notifications\/mass-update/);

  const completion = source.indexOf('giveawayData.settlement.phase = "complete"');
  const stop = source.indexOf("const stopped = stopGiveaway()", completion);
  const cleanup = source.indexOf("void markGiveawayBonNotificationsRead(notificationCleanupContext)", stop);
  assert.ok(completion >= 0 && stop > completion && cleanup > stop);
  assert.doesNotMatch(
    source.slice(stop, cleanup + 100),
    /await\s+markGiveawayBonNotificationsRead/
  );
});

test("public update metadata is split from the install payload", () => {
  const header = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)?.[0] || "";

  assert.match(header, /^\/\/ @namespace\s+https:\/\/darkpeers\.org\/users\/maghuro$/m);
  assert.match(header, /^\/\/ @homepageURL\s+https:\/\/darkpeers\.org\/users\/maghuro$/m);
  assert.match(
    header,
    /^\/\/ @updateURL\s+https:\/\/gist\.githubusercontent\.com\/maghuro\/da2dbfec94951990cbc54e75a9aee318\/raw\/DarkPeers_BONanza_Giveaway\.meta\.js$/m
  );
  assert.match(
    header,
    /^\/\/ @downloadURL\s+https:\/\/gist\.githubusercontent\.com\/maghuro\/da2dbfec94951990cbc54e75a9aee318\/raw\/DarkPeers_BONanza_Giveaway\.user\.js$/m
  );
  assert.doesNotMatch(header, /github\.com\/maghuro\/unit3d-userscripts/);
  assert.match(source, /v1\.5\.10 intentionally changes @namespace/);
});

test("Gist workflow generates and verifies a minimal .meta.js manifest", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish-bonanza-gist.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /GIST_META_FILE: DarkPeers_BONanza_Giveaway\.meta\.js/);
  assert.match(workflow, /META_FILE: \/tmp\/DarkPeers_BONanza_Giveaway\.meta\.js/);
  assert.match(
    workflow,
    /metadata_keys = \([\s\S]*?"@name"[\s\S]*?"@namespace"[\s\S]*?"@version"[\s\S]*?"@updateURL"[\s\S]*?"@downloadURL"[\s\S]*?\)/
  );
  assert.match(workflow, /Gist update response does not contain/);
  assert.match(workflow, /Published Gist content for \{gist_file\} does not match the generated content/);
});

test("Gist workflow verifies the public raw update URLs after publish", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish-bonanza-gist.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /Verify public raw Gist files/);
  assert.match(workflow, /gist\.githubusercontent\.com\/maghuro\/\$\{GIST_ID\}\/raw/);
  assert.match(workflow, /Cache-Control: no-cache/);
  assert.match(workflow, /Pragma: no-cache/);
  assert.match(workflow, /cmp --silent/);
  assert.match(workflow, /Public raw Gist content does not match/);
});

test("winner-count commands are host-only", () => {
  const winners = source.match(/winners\(ctx\) \{[\s\S]*?\n\s*\},\n\n\s*maxwinners\(ctx\)/)?.[0] || "";
  const maxWinners = source.match(/maxwinners\(ctx\) \{[\s\S]*?\n\s*\},\n\n\s*scale\(ctx\)/)?.[0] || "";

  assert.match(winners, /normalizeUserKey\(author\) !== normalizeUserKey\(giveawayData\.host\)/);
  assert.doesNotMatch(winners, /isHostOrAdmin/);

  assert.match(maxWinners, /normalizeUserKey\(author\) !== normalizeUserKey\(giveawayData\.host\)/);
  assert.doesNotMatch(maxWinners, /isHostOrAdmin/);
});

test("host virtual BON stays isolated from sponsor gifts", () => {
  assert.match(source, /hostWalletAtStart: null/);
  assert.match(source, /hostWalletAtStart: giveawayData\.hostWalletAtStart/);
  assert.match(source, /function getHostVirtualBon\(data = giveawayData\)/);
  assert.match(source, /Math\.floor\(walletAtStart\) - hostCommitted/);
  assert.match(source, /My Virtual BON/);
  assert.match(source, /sponsor gifts do not affect this balance/);
  assert.match(source, /const virtualBon = getHostVirtualBon\(giveawayData\)/);
  assert.match(source, /amount > virtualBon/);
  assert.match(source, /giveawayData\.hostAdded = \(giveawayData\.hostAdded \|\| 0\) \+ amount/);
  assert.match(source, /updateHostPanelUI\(\)/);
});

test("staff emergency controls remain available", () => {
  const required = [
    /rig\(ctx\)[\s\S]*?isHostOrAdmin/,
    /unrig\(ctx\)[\s\S]*?isHostOrAdmin/,
    /const isPriv = normalizeUserKey\(author\) === normalizeUserKey\(giveawayData\.host\) \|\| isAdmin\(fancyName\)/,
    /naughty\(ctx\)[\s\S]*?isHostOrAdmin/,
    /end\(ctx\)[\s\S]*?isAdmin\(fancyName\)/
  ];

  for (const pattern of required) assert.match(source, pattern);
});

test("staff emergency actions are publicly attributed and cooldown-exempt", () => {
  assert.match(source, /function makeStaffAttributedReply\(ctx\)/);
  assert.match(source, /Staff action by \$\{sanitizeNick\(ctx\.author\)\}/);
  assert.match(source, /return \(message\) => sendMessage\(prefix \+ message\)/);
  assert.match(source, /const actionReply = makeStaffAttributedReply\(ctx\)/);
  assert.match(source, /Requested by staff \$\{sanitizeNick\(author\)\} via !end/);
  assert.match(source, /staffEmergencyCommands = new Set\(\[[\s\S]*?"end"[\s\S]*?\]\)/);
  assert.match(source, /isAdmin\(fancyName\) && staffEmergencyCommands\.has\(command\)/);
});

test("staff time validation uses the attributed public reply path", () => {
  const timeHandler = source.match(/time\(ctx\) \{[\s\S]*?\n\s*\},\n\n\s*entries/)?.[0] || "";
  assert.match(timeHandler, /const actionReply = makeStaffAttributedReply\(ctx\)/);
  assert.match(timeHandler, /actionReply\("\[color=red\]Usage:\[\/color\] !time add\|remove <minutes>"\)/);
});

test("public winner names use anti-ping sanitization", () => {
  assert.doesNotMatch(source, /\[color=#DC3D1D\]\$\{w\.author\}\[\/color\]/);
  assert.match(source, /\[color=#DC3D1D\]\$\{sanitizeNick\(w\.author\)\}\[\/color\]/);
});

test("degraded restore keeps a settlement gate", () => {
  assert.match(source, /__sponsorAccountingVerified === false/);
  assert.match(source, /scheduleSponsorAccountingRecovery/);
  assert.match(source, /ACCOUNTING NOT VERIFIED/);
  assert.match(source, /repairStats: false/);
});

test("restore starts sponsor accounting fail-closed before commands resume", () => {
  const restoreStart = source.indexOf("async function restoreGiveawayFromSnapshot");
  const failClosed = source.indexOf("giveawayData.__sponsorAccountingVerified = false", restoreStart);
  const beginCapture = source.indexOf("beginChatReplayBoundaryCapture()", restoreStart);
  const reconciliation = source.indexOf("reconcileCanonicalSponsorAccounting", restoreStart);

  assert.ok(restoreStart >= 0);
  assert.ok(failClosed > restoreStart);
  assert.ok(beginCapture > failClosed);
  assert.ok(reconciliation > beginCapture);
});

test("restore observes chat while the replay boundary request is in flight", () => {
  const restoreStart = source.indexOf("async function restoreGiveawayFromSnapshot");
  const beginCapture = source.indexOf("beginChatReplayBoundaryCapture()", restoreStart);
  const addObserver = source.indexOf("addObserver(giveawayData)", beginCapture);
  const fetchBoundary = source.indexOf("await getLatestMainChatReplayBoundary()", addObserver);
  const finishCapture = source.indexOf("finishChatReplayBoundaryCapture()", fetchBoundary);

  assert.ok(beginCapture > restoreStart);
  assert.ok(addObserver > beginCapture);
  assert.ok(fetchBoundary > addObserver);
  assert.ok(finishCapture > fetchBoundary);
  assert.match(source, /if \(chatReplayBoundaryPending\)[\s\S]*?chatReplayPendingNodes\.push\(messageNode\)/);
});

test("historical commands use a strict replay cutoff while entries keep tolerance", () => {
  assert.match(source, /const replayCutoff = isCommand[\s\S]*?chatReplayCommandIgnoreBeforeTs[\s\S]*?: chatReplayIgnoreBeforeTs/);
  assert.match(source, /chatReplayCommandIgnoreBeforeTs = replayBoundary\.ts/);
  assert.match(source, /chatReplayIgnoreBeforeTs = replayBoundary\.ts - resolutionMs/);
});

test("failed replay-boundary lookup preserves entries received during the wait", () => {
  const restoreStart = source.indexOf("async function restoreGiveawayFromSnapshot");
  const captureStart = source.indexOf("const localReplayCaptureStartedAt = Date.now()", restoreStart);
  const fetchBoundary = source.indexOf("await getLatestMainChatReplayBoundary()", captureStart);
  const fallbackEntry = source.indexOf("chatReplayIgnoreBeforeTs = localReplayCaptureStartedAt - 2000", fetchBoundary);
  const fallbackCommand = source.indexOf("chatReplayCommandIgnoreBeforeTs = Date.now()", fallbackEntry);

  assert.ok(captureStart > restoreStart);
  assert.ok(fetchBoundary > captureStart);
  assert.ok(fallbackEntry > fetchBoundary);
  assert.ok(fallbackCommand > fallbackEntry);
});


test("rehearsal guards precede every money/chat POST path", () => {
  const poolStart = source.indexOf("async function contributeBonPool");
  const poolDryRun = source.indexOf("if (REHEARSAL_MODE)", poolStart);
  const poolPost = source.indexOf('method: "POST"', poolStart);
  assert.ok(poolStart >= 0 && poolDryRun > poolStart && poolPost > poolDryRun);

  const giftStart = source.indexOf("async function giftBon");
  const giftDryRun = source.indexOf("if (REHEARSAL_MODE)", giftStart);
  const giftPost = source.indexOf('method: "POST"', giftStart);
  assert.ok(giftStart >= 0 && giftDryRun > giftStart && giftPost > giftDryRun);

  const sendStart = source.indexOf("async function sendMessage");
  const sendRehearsalRoute = source.indexOf("if (REHEARSAL_MODE && !allowRehearsalPrivateOutput)", sendStart);
  const sendApiCall = source.indexOf("trySendViaApi(messageStr)", sendStart);
  assert.ok(sendStart >= 0 && sendRehearsalRoute > sendStart && sendApiCall > sendRehearsalRoute);

  assert.equal((source.match(/trySendViaApi\(/g) || []).length, 2);
});

test("rehearsal routes userscript output privately to the host", () => {
  assert.match(source, /function formatRehearsalPrivateOutput\(messageStr\)/);
  assert.match(source, /async function sendPrivateMessage\(username, messageStr, options = \{\}\)/);
  assert.match(source, /const allowRehearsalPrivateOutput =[\s\S]*?options\?\.rehearsalPrivateOutput === true/);
  assert.match(source, /const rehearsalHost = String\(giveawayData\?\.host \|\| getLoggedInUsername\(\) \|\| ""\)\.trim\(\)/);
  assert.match(source, /return sendPrivateMessage\(rehearsalHost, rehearsalBody, \{[\s\S]*?rehearsalPrivateOutput: true,[\s\S]*?requireExclusiveGiveawayOwnership[\s\S]*?\}\)/);
  assert.match(source, /return sendMessage\(`\/msg \$\{to\} \$\{body\}`, options\)/);
  assert.doesNotMatch(source, /logEvent\("Rehearsal chat suppressed"/);
});

test("staff detection uses exact role-title allow-list matching", () => {
  assert.match(source, /DARKPEERS_STAFF_ROLE_NAMES\.has\(title\)/);
  assert.doesNotMatch(source, /roleTokens\.some/);
  assert.doesNotMatch(source, /includes\(['"]onlyguardians['"]\)/i);
});


test("rehearsal debug mode is exposed as a safe reload toggle", () => {
  assert.match(source, /id="rehearsalModeToggle"/);
  assert.match(source, /Rehearsal \/ Debug mode/);
  assert.match(source, /localStorage\.setItem\(REHEARSAL_FLAG, String\(requested\)\)/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /cannot be changed while a giveaway is active or recoverable/);
});

test("rehearsal toggle handles forced overrides honestly", () => {
  assert.match(source, /const REHEARSAL_FORCED_BY_DEBUG = DEBUG_SETTINGS\.dry_run === true/);
  assert.match(source, /const REHEARSAL_FORCED_BY_QUERY = REHEARSAL_QUERY_RE\.test/);
  assert.match(source, /rehearsalModeToggle\.disabled = REHEARSAL_FORCED_BY_DEBUG/);
  assert.match(source, /if \(!requested && REHEARSAL_FORCED_BY_QUERY\)/);
  assert.match(source, /key\.toLowerCase\(\) === "bg_rehearsal"/);
  assert.match(source, /cleanUrl\.searchParams\.delete\(key\)/);
  assert.match(source, /window\.history\.replaceState\(window\.history\.state, "", cleanUrl\.toString\(\)\)/);
});


test("rehearsal statements keep simulated transfers distinct from live confirmations", () => {
  assert.match(source, /rehearsalMode: REHEARSAL_MODE/);
  assert.match(source, /"dry-run": "simulated \(no BON sent\)"/);
  assert.match(source, /isRehearsalStatementRecord\(targetStatement\)/);
  assert.match(source, /REHEARSAL \/ SIMULATION \(no BON-moving requests sent\)/);
  assert.match(source, /const rehearsalPool = poolResult\.dryRun === true/);
  assert.match(source, /simulated only \(no BON Pool contribution sent\)/);
  assert.match(source, /REHEARSAL:[\s\S]*?No BON was sent\./);
  assert.match(source, /noEntryPoolResult\.dryRun/);
  assert.match(source, /simulated only \(zero entrants; no BON Pool contribution sent\)/);
  assert.match(source, /const finalPoolStatus = donationActive[\s\S]*?poolResult\.dryRun[\s\S]*?simulated only \(no BON Pool contribution sent\)/);
  assert.match(source, /currentStatement\.donationStatus = finalPoolStatus/);
  assert.match(source, /currentStatement\.verification = poolResult\.dryRun[\s\S]*?rehearsal simulation complete; no BON-moving requests sent/);
});

test("legacy rehearsal statements inherit rehearsal context and lose false live confirmations", () => {
  assert.match(source, /function normalizeStatementRecord\(record\)/);
  assert.match(source, /const hasExplicitMode = typeof normalized\.rehearsalMode === "boolean"/);
  assert.match(source, /if \(!hasExplicitMode\) \{[\s\S]*?normalized\.rehearsalMode = REHEARSAL_MODE/);
  assert.match(source, /legacy rehearsal; no BON Pool contribution sent/);
  assert.match(source, /normalized\.verification === "nothing to verify"/);
  assert.match(source, /normalized\.verification === "all gifts confirmed in DarkPeers"/);
  assert.match(source, /return Array\.isArray\(arr\) \? arr\.map\(normalizeStatementRecord\) : \[\]/);
  assert.match(source, /function isRehearsalStatementRecord\(record\)/);
  assert.match(source, /typeof record\.rehearsalMode === "boolean"[\s\S]*?\? record\.rehearsalMode[\s\S]*?: REHEARSAL_MODE/);
});

test("rehearsal persistent state is isolated from live giveaway state", () => {
  assert.match(source, /const REHEARSAL_STORAGE_SUFFIX = REHEARSAL_MODE \? "::rehearsal" : ""/);
  assert.match(source, /BONANZA_GIVEAWAY_STATS_v2::\$\{location\.hostname\}\$\{REHEARSAL_STORAGE_SUFFIX\}/);
  assert.match(source, /bonanza-giveaway-statements::\$\{location\.hostname\}\$\{REHEARSAL_STORAGE_SUFFIX\}/);
  assert.match(source, /LS_ACTIVE_GIVEAWAY_LEGACY\}\$\{REHEARSAL_STORAGE_SUFFIX\}::/);
  assert.match(source, /savedRehearsalMode !== REHEARSAL_MODE/);
  assert.match(source, /rehearsalMode: REHEARSAL_MODE/);

  // Ownership stays shared deliberately so a live giveaway and rehearsal cannot
  // operate concurrently in separate tabs.
  assert.match(source, /const LS_TAB_LOCK = `bonanza-giveaway-tabLock::\$\{location\.hostname\}`/);
  assert.match(source, /const TAB_WEB_LOCK_NAME = `bonanza-giveaway-owner::\$\{location\.hostname\}`/);
});
