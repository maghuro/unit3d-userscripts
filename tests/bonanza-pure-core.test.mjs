import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

function readSource(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function extractBraceBlock(source, needle) {
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `Missing source block: ${needle}`);

  const brace = source.indexOf("{", start);
  assert.notEqual(brace, -1, `Missing opening brace: ${needle}`);

  let depth = 0;
  let single = false;
  let double = false;
  let template = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (single) {
      if (ch === "\\") escaped = true;
      else if (ch === "'") single = false;
      continue;
    }

    if (double) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') double = false;
      continue;
    }

    if (template) {
      if (ch === "\\") escaped = true;
      else if (ch === "`") template = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      single = true;
      continue;
    }

    if (ch === '"') {
      double = true;
      continue;
    }

    if (ch === "`") {
      template = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`Unterminated source block: ${needle}`);
}

function makeContext(extra = {}) {
  return vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    URL,
    decodeURIComponent,
    encodeURIComponent,
    ...extra
  });
}

const utilitiesSource = readSource("userscripts/giveaway/src/12-utilities.js");
const constantsSource = readSource("userscripts/giveaway/src/01-global-constants.js");
const sponsorSource = readSource("userscripts/giveaway/src/09-sponsorship-polling.js");
const payoutSource = readSource("userscripts/giveaway/src/11-winner-selection-payouts.js");

function loadChatNumberFormatter() {
  const context = makeContext();
  const formatter = extractBraceBlock(utilitiesSource, "function formatChatNumbersWithSpaces");

  vm.runInContext(
    `${formatter}\nglobalThis.formatChatNumbersWithSpaces = formatChatNumbersWithSpaces;`,
    context
  );

  return context.formatChatNumbersWithSpaces;
}

test("chat number formatter preserves comma-separated giveaway suggestions with digit-bearing usernames", () => {
  const format = loadChatNumberFormatter();
  const message =
    "🚫 Sorry d\u200Bemonkadar, but S\u200Bch2021 already entered with number " +
    "[color=#DC3D1D][b]61[/b][/color]! Here are some free numbers you can try: " +
    "[b][color=#1DDC5D]28, 36, 52, 83, 89[/color][/b].";

  assert.equal(format(message), message);
});

test("chat number formatter never mistakes comma-space list syntax for thousands grouping", () => {
  const format = loadChatNumberFormatter();

  assert.equal(
    format("Free numbers: 28, 365, 52, 83, 89."),
    "Free numbers: 28, 365, 52, 83, 89."
  );
});

test("chat number formatter still normalizes genuine thousands-grouped amounts", () => {
  const format = loadChatNumberFormatter();

  assert.equal(
    format("Amounts: 1000 | 1000000 | 1,000,000 | 1 000 000 | 1'000'000 | 1’000’000"),
    "Amounts: 1 000 | 1 000 000 | 1 000 000 | 1 000 000 | 1 000 000 | 1 000 000"
  );
});

function loadFinancialFunctions() {
  const context = makeContext({
    BONANZA: {
      PERCENT_OPTIONS: Object.freeze([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50])
    },
    selfCheck(condition, message, details) {
      if (!condition) {
        const error = new Error(message);
        error.details = details;
        throw error;
      }
    }
  });

  const normalize = extractBraceBlock(constantsSource, "function normalizeDonationPercent");
  const split = extractBraceBlock(utilitiesSource, "function computeDonationSplit");

  vm.runInContext(
    `${normalize}\n${split}\nglobalThis.normalizeDonationPercent = normalizeDonationPercent; globalThis.computeDonationSplit = computeDonationSplit;`,
    context
  );

  return context;
}

function normalizeUserKey(name) {
  return String(name || "").trim().replace(/^@+/, "").toLowerCase();
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timestampResolution(value) {
  const raw = String(value || "").trim();
  const timestamp = raw.match(
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!timestamp) return 1;
  if (!timestamp[1]) return 1000;
  const fractionalDigits = Math.min(timestamp[1].length, 3);
  return Math.max(1, 1000 / (10 ** fractionalDigits));
}

function extractSponsorTrackerClass() {
  return extractBraceBlock(sponsorSource, "class SponsorTracker");
}

function loadSponsorCore(extra = {}) {
  const context = makeContext({
    normalizeUserKey,
    optionalFiniteNumber,
    unit3dTimestampResolutionMs: timestampResolution,
    DEBUG_SETTINGS: { log_chat_messages: false },
    logEvent() {},
    sanitizeNick(value) { return String(value || ""); },
    fmtBONCurrency(value) { return String(value); },
    snapshotGiveaway() { return true; },
    recomputeEffectiveWinners() {},
    sumSponsorContribs() { return 0; },
    getStatsCached() { return { users: {} }; },
    getOrCreateUserStats() { return null; },
    saveGiveawayStats() {},
    liveSponsorTotalThisGiveaway: new Map(),
    liveSponsorSeenThisGiveaway: new Set(),
    _statsCache: null,
    _statsDirty: false,
    _statsFlushTimer: null,
    clearTimeout() {},
    ...extra
  });

  const baseKey = extractBraceBlock(sponsorSource, "function giftHistoryBaseKey");
  const indexRows = extractBraceBlock(sponsorSource, "function indexGiftHistoryRows");
  const klass = extractSponsorTrackerClass();

  vm.runInContext(
    `${baseKey}\n${indexRows}\n${klass}\nglobalThis.giftHistoryBaseKey = giftHistoryBaseKey; globalThis.indexGiftHistoryRows = indexGiftHistoryRows; globalThis.SponsorTracker = SponsorTracker;`,
    context
  );

  return context;
}

test("computeDonationSplit reproduces the audited 2026-09-24 settlement", () => {
  const { computeDonationSplit } = loadFinancialFunctions();
  const result = computeDonationSplit([569560, 379705, 189852], 10);

  assert.equal(result.percent, 10);
  assert.deepEqual(Array.from(result.donations), [56956, 37970, 18985]);
  assert.deepEqual(Array.from(result.net), [512604, 341735, 170867]);
  assert.equal(result.total, 113911);
  assert.equal(result.net.reduce((sum, value) => sum + value, 0) + result.total, 1139117);
});

test("computeDonationSplit keeps every positive winner payout at least 1 BON", () => {
  const { computeDonationSplit } = loadFinancialFunctions();
  const result = computeDonationSplit([1, 2, 3], 50);

  assert.equal(result.total, 3);
  assert.deepEqual(Array.from(result.net), [1, 1, 1]);
  assert.ok(result.net.every((value) => value >= 1));
});

test("computeDonationSplit rejects unsupported percentages through production normalization", () => {
  const { computeDonationSplit } = loadFinancialFunctions();
  const result = computeDonationSplit([100, 200], 12);

  assert.equal(result.percent, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(Array.from(result.net), [100, 200]);
});

test("gift history identity keys normalize usernames and distinguish occurrences", () => {
  const { giftHistoryBaseKey, indexGiftHistoryRows } = loadSponsorCore();
  const row = {
    sender: "@RAINMAN",
    recipient: "Maghuro ",
    amount: 500000,
    rawTimestamp: "2026-09-24 17:18:45",
    message: "Happy Birthday Trzy"
  };

  const same = {
    ...row,
    sender: "rainman",
    recipient: "@maghuro"
  };

  assert.equal(giftHistoryBaseKey(row), giftHistoryBaseKey(same));

  const indexed = Array.from(indexGiftHistoryRows([row, same]));
  assert.ok(indexed[0].historyKey.endsWith("\u001f1"));
  assert.ok(indexed[1].historyKey.endsWith("\u001f2"));
  assert.notEqual(indexed[0].historyKey, indexed[1].historyKey);
});

test("SponsorTracker infers the dense Gift History clock-offset cluster", () => {
  const { SponsorTracker } = loadSponsorCore();
  const tracker = new SponsorTracker({
    chatroomId: "2",
    giveawayStartTime: new Date(0),
    giveawayData: { host: "maghuro", sponsors: [], endTs: 9999999999999 }
  });

  const hour = 60 * 60 * 1000;
  const events = [
    { gifter: "A", recipient: "maghuro", rawAmount: 100, createdAtTs: 1_000_000 },
    { gifter: "B", recipient: "maghuro", rawAmount: 200, createdAtTs: 2_000_000 },
    { gifter: "C", recipient: "maghuro", rawAmount: 300, createdAtTs: 3_000_000 }
  ];
  const rows = [
    { sender: "A", recipient: "maghuro", amount: 100, createdAtAltTs: 1_000_000 + hour },
    { sender: "B", recipient: "maghuro", amount: 200, createdAtAltTs: 2_000_000 + hour + 10_000 },
    { sender: "C", recipient: "maghuro", amount: 300, createdAtAltTs: 3_000_000 - 5 * hour }
  ];

  const inferred = tracker.inferGiftHistoryClockOffset(events, rows);
  assert.equal(inferred, hour + 5_000);
  assert.equal(tracker.giftHistoryClockOffsetMs, hour + 5_000);
});

test("SponsorTracker keeps a persisted offset instead of trusting one conflicting sample", () => {
  const { SponsorTracker } = loadSponsorCore();
  const hour = 60 * 60 * 1000;
  const tracker = new SponsorTracker({
    chatroomId: "2",
    giveawayStartTime: new Date(0),
    giveawayData: { host: "maghuro", sponsors: [], endTs: 9999999999999 },
    giftHistoryClockOffsetMs: hour
  });

  const inferred = tracker.inferGiftHistoryClockOffset(
    [{ gifter: "A", recipient: "maghuro", rawAmount: 100, createdAtTs: 1_000_000 }],
    [{ sender: "A", recipient: "maghuro", amount: 100, createdAtAltTs: 1_000_000 + 2 * hour }]
  );

  assert.equal(inferred, hour);
  assert.equal(tracker.giftHistoryClockOffsetMs, hour);
});

test("SponsorTracker filters Gift History rows to the verified giveaway window", async () => {
  const { SponsorTracker } = loadSponsorCore();
  const tracker = new SponsorTracker({
    chatroomId: "2",
    giveawayStartTime: new Date(10_000),
    giveawayData: { host: "maghuro", sponsors: [], endTs: 20_000 },
    giftHistoryClockOffsetMs: 0,
    maxAcceptedCreatedAtTs: 20_000
  });

  tracker.fetchRecentChatGiftEvents = async () => [];

  const rows = [
    { sender: "old", recipient: "maghuro", amount: 1, createdAtTs: 8_000, createdAtAltTs: 8_000, timestampResolutionMs: 1, rawTimestamp: "x", historyKey: "old" },
    { sender: "inside", recipient: "maghuro", amount: 2, createdAtTs: 15_000, createdAtAltTs: 15_000, timestampResolutionMs: 1, rawTimestamp: "x", historyKey: "inside" },
    { sender: "late", recipient: "maghuro", amount: 3, createdAtTs: 21_000, createdAtAltTs: 21_000, timestampResolutionMs: 1, rawTimestamp: "x", historyKey: "late" }
  ];

  const result = await tracker.filterHistoryRowsByWindow(rows, 10_000, 20_000, rows);

  assert.deepEqual(
    Array.from(result.accepted, (item) => item.sender),
    ["inside"]
  );
  assert.equal(result.retryableKeys.size, 0);
});

function makeCell(text, { user = null, timestamp = null } = {}) {
  return {
    textContent: text,
    querySelector(selector) {
      if (selector.includes('/users/') && user) {
        return {
          href: `https://darkpeers.org/users/${encodeURIComponent(user)}`,
          getAttribute() {
            return `/users/${encodeURIComponent(user)}`;
          }
        };
      }

      if (selector === "time" && timestamp) {
        return {
          getAttribute(name) {
            return name === "datetime" ? timestamp : null;
          }
        };
      }

      return null;
    }
  };
}

test("parseGiftHistoryPage keeps decimal BON correct and normalizes No note", () => {
  const rows = [
    {
      querySelectorAll(selector) {
        assert.equal(selector, "td");
        return [
          makeCell("RAINMAN", { user: "RAINMAN" }),
          makeCell("maghuro", { user: "maghuro" }),
          makeCell("170867.00 BON"),
          makeCell(" No note "),
          makeCell("", { timestamp: "2026-09-24 20:01:10" })
        ];
      }
    }
  ];

  const context = makeContext({
    location: { origin: "https://darkpeers.org" },
    giftDOMParser: {
      parseFromString() {
        return {
          querySelectorAll(selector) {
            assert.equal(selector, "table.data-table tbody tr");
            return rows;
          }
        };
      }
    }
  });

  for (const needle of [
    "function giftHistoryUsernameFromCell",
    "function parseUnit3dTimestamp",
    "function parseUnit3dTimestampUtcFallback",
    "function unit3dTimestampResolutionMs",
    "function parseGiftHistoryPage"
  ]) {
    vm.runInContext(extractBraceBlock(sponsorSource, needle), context);
  }

  vm.runInContext("globalThis.__parse = parseGiftHistoryPage;", context);
  const parsed = Array.from(context.__parse("<fixture />"));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sender, "RAINMAN");
  assert.equal(parsed[0].recipient, "maghuro");
  assert.equal(parsed[0].amount, 170867);
  assert.equal(parsed[0].message, "");
  assert.equal(parsed[0].rawTimestamp, "2026-09-24 20:01:10");
  assert.equal(parsed[0].timestampResolutionMs, 1000);
});

test("the committed settlement planner reproduces the audited winners and totals", () => {
  const financial = loadFinancialFunctions();
  const context = makeContext({
    normalizeDonationPercent: financial.normalizeDonationPercent,
    computeDonationSplit: financial.computeDonationSplit,
    giveawayData: {
      amount: 1139117,
      host: "maghuro",
      hostAdded: 10112,
      initialPotVerifiedAtStart: 10111,
      sponsorContribs: {
        RAINMAN: 500000,
        Jeditwo: 381994,
        TheRazgriz: 100000,
        samisd: 77522,
        demonkadar: 69420,
        Chungus: 69
      },
      sponsors: ["RAINMAN", "Jeditwo", "TheRazgriz", "samisd", "demonkadar", "Chungus"],
      sponsorGiftMessages: [],
      donationPercent: 10,
      scaleWinnersWithSponsors: false,
      baseWinnersAtStart: 3,
      winnersNum: 3,
      winningNumber: 42
    },
    numberEntries: new Map([
      ["weedsmoke", 42],
      ["samisd", 41],
      ["Crow", 40],
      ["maghuro", 11],
      ["mrkmrtns", 111]
    ]),
    riggedMode: false,
    sumSponsorContribs(data, host) {
      const hostKey = normalizeUserKey(host);
      return Object.entries(data || {}).reduce(
        (sum, [name, amount]) =>
          normalizeUserKey(name) === hostKey ? sum : sum + Math.max(0, Math.floor(Number(amount) || 0)),
        0
      );
    },
    getNonHostSponsorContributions() { return []; },
    recomputeEffectiveWinners(data) {
      return Math.max(1, Math.floor(Number(data.winnersNum) || 1));
    }
  });

  const block = extractBraceBlock(payoutSource, "const buildSettlementFinancialPlan =");
  vm.runInContext(
    `${block}; globalThis.__buildSettlementFinancialPlan = buildSettlementFinancialPlan;`,
    context
  );

  const plan = context.__buildSettlementFinancialPlan();

  assert.equal(plan.mode, "winners");
  assert.equal(plan.potTotal, 1139117);
  assert.equal(plan.sponsoredTotal, 1129005);
  assert.equal(plan.hostFundedTotal, 10112);
  assert.deepEqual(Array.from(plan.winners, (winner) => winner.author), ["weedsmoke", "samisd", "Crow"]);
  assert.deepEqual(Array.from(plan.gross), [569560, 379705, 189852]);
  assert.deepEqual(Array.from(plan.donations), [56956, 37970, 18985]);
  assert.deepEqual(Array.from(plan.net), [512604, 341735, 170867]);
  assert.equal(plan.split.total, 113911);
});
