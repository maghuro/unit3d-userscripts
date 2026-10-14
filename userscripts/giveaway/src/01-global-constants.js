    // SECTION 1: Global Constants and Configuration
    // ───────────────────────────────────────────────────────────
    const COMMAND_WINDOW_MS = 10000; // look back 10 seconds
    const MAX_COMMANDS_PER_WINDOW = 3; // allow 3 commands in that window
    const BASE_PENALTY_SECONDS = 30; // base lockout for exceeding (in seconds)

    // Spam filter tightening (keeps responses snappy but reduces chat spam):
    // - MIN_ACTION_GAP_MS blocks ultra-fast repeat triggers (usually bots/double-sends)
    // - REPEAT_COMMAND_COOLDOWNS_MS prevents the same command from being spammed for identical output
    // - strikes increase lockout length for repeat offenders (decays over time)
    const MIN_ACTION_GAP_MS = 900; // ignore triggers faster than this per user
    const ENTRY_FEEDBACK_COOLDOWN_MS = 8000; // throttle duplicate/out-of-range feedback per user
    const STRIKE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
    const MAX_STRIKE_MULTIPLIER = 8; // caps exponential backoff

    const REPEAT_COMMAND_COOLDOWNS_MS = Object.freeze({
        entry: 2000,
        time: 3000,
        entries: 5000,
        free: 7000,
        lucky: 7000,
        luckye: 7000,
        random: 7000,
        range: 5000,
        sponsors: 8000,
        stats: 8000,
        top: 8000,
        most: 8000,
        largest: 8000,
        scale: 5000
    });const RIG_DENY_COOLDOWN_MS = 10000; // 10s per-user cooldown for funny !rig/!unrig denial messages
    const MAX_WINNERS = 50; // central location to update max allowable number of winners
    const MAX_REMINDERS = 6; //maximum number of reminders allowed
    const PAYOUT_GIFT_GAP_MS = 150; // small spacing between sequential payout requests
    const SPONSOR_GIFT_HISTORY_POLL_MS = 10_000; // primary UNIT3D Gift History polling cadence

    // Persistent stats (saved in localStorage on this site)
    // GM store is per-script anyway; the v2 suffix retires the pre-1.2.0 copy so it can
    // never out-date the shared record and overwrite it (see migrateLegacyForkStats).
    const STATS_VERSION = 1;
    const STATS_DEFAULT_TOP_N = 3;
    const STATS_MAX_TOP_N = 10;

    // Default text to populate the custom giveaway message field
    const DEFAULT_CUSTOM_MESSAGE = "";
    const GIFT_HINT_COLOR = "#F3D34A";
    const SCALING_ACCENT_COLOR = "#7C4DFF";
    const BON_SYMBOL = "฿";

    const ENTRY_IGNORE_WINDOW_MS = 2000;



    // Sponsor announcement controls.
    // Live policy: flush immediately after each poll that discovers gifts. All gifts
    // found in that one poll are still grouped into a single sponsor announcement.
    // "digest" remains supported for experiments, but is not the production default:
    // a short giveaway could otherwise end before a small pending gift was announced.
    // - digest_ms: max wait when mode="digest"
    // - immediate_single_min / flush_min_total: early-flush thresholds in digest mode
    // - show_top_n / show_min_per_user: keep the line short; omit tiny sponsors from the name list (still counted in totals)
    const SPONSOR_ANNOUNCE = {
        mode: "immediate",
        digest_ms: 60_000,
        immediate_single_min: 500,
        flush_min_total: 250,
        max_pending_events: 50,
        show_top_n: Infinity,
        show_min_per_user: 0,
        max_visible_chars: 300,
        final_recap_max_visible_chars: 900,
        max_note_chars: 72,
        max_notes_per_sponsor: 2
    };

    const GENERAL_SETTINGS = {
        disable_random: false,
        disable_lucky: false,
        disable_free: false,
        suppress_entry_replies: false,
        silent_mode: false
    };

    const DEBUG_SETTINGS = {
        log_chat_messages: false,
        disable_chat_output: false,
        dry_run: false,
        verify_extractor: false,
        verify_sendmessage: false,
        verify_cacheChatContext: false,
        suppressApiMessages: false, // new flag to suppress API message sending
        enable_self_checks: false
    };

    const PERF = false; // Debug-only perf counters (must stay false in normal use)
    const PERF_LOG_EVERY = 50;
    const perfCounters = PERF ? Object.create(null) : null;
    function perfMeasure(section, startMs) {
        if (!PERF) return;
        const elapsed = performance.now() - startMs;
        const rec = perfCounters[section] || (perfCounters[section] = { count: 0, total: 0, max: 0 });
        rec.count += 1;
        rec.total += elapsed;
        if (elapsed > rec.max) rec.max = elapsed;
        if ((rec.count % PERF_LOG_EVERY) === 0) {
            console.debug(
                `[BON Giveaway PERF] ${section}: count=${rec.count}, avg=${(rec.total / rec.count).toFixed(2)}ms, max=${rec.max.toFixed(2)}ms`
            );
        }
    }

    const SELF_CHECK_FLAG = "BONANZA_GIVEAWAY_SELF_CHECKS";
    const SELF_CHECK_QUERY_RE = /(?:^|[?&])bg_self_checks=1(?:&|$)/i;
    const SELF_CHECKS_ENABLED = !!(
        DEBUG_SETTINGS.enable_self_checks ||
        localStorage.getItem(SELF_CHECK_FLAG) === "true" ||
        SELF_CHECK_QUERY_RE.test(String(window.location.search || ""))
    );

    const REHEARSAL_FLAG = "BONANZA_GIVEAWAY_REHEARSAL";
    const REHEARSAL_QUERY_RE = /(?:^|[?&])bg_rehearsal=1(?:&|$)/i;
    const REHEARSAL_FORCED_BY_DEBUG = DEBUG_SETTINGS.dry_run === true;
    const REHEARSAL_FORCED_BY_QUERY = REHEARSAL_QUERY_RE.test(String(window.location.search || ""));
    const REHEARSAL_MODE = !!(
        REHEARSAL_FORCED_BY_DEBUG ||
        localStorage.getItem(REHEARSAL_FLAG) === "true" ||
        REHEARSAL_FORCED_BY_QUERY
    );
    const REHEARSAL_STORAGE_SUFFIX = REHEARSAL_MODE ? "::rehearsal" : "";

    // Rehearsals use separate persistent state. The shared production stats
    // remain untouched even when the whole start/reload/end flow is exercised.
    const STATS_KEY_GM =
        `BONANZA_GIVEAWAY_STATS_v2::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;
    const STATS_KEY_LS_LEGACY_FORK =
        `BONANZA_GIVEAWAY_STATS::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;
    const STATS_KEY_LS =
        `BON_GIVEAWAY_STATS::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;

    function selfCheck(condition, message, details) {
        if (!SELF_CHECKS_ENABLED || condition) return;
        const err = new Error(`[BON Giveaway self-check] ${message}`);
        if (details && typeof details === "object") {
            try {
                console.error(err.message, details);
            } catch {
                console.error(err.message);
            }
        } else {
            console.error(err.message);
        }
        throw err;
    }

    // ── DarkPeers site constants (this fork runs on darkpeers.org only) ──
    // DarkPeers room contract verified live on 2026-09-24:
    //   1 = Main Chat (entries, commands and userscript output)
    //   2 = System (DPBot gift events / secondary verification)
    const DARKPEERS_MAIN_CHATROOM_ID = '1';
    const DARKPEERS_CHATROOM_ID = '2';

    function getMessageContentElement(messageNode) {
        if (!messageNode || messageNode.nodeType !== 1) return null;
        return messageNode.querySelector('.chatbox-message__content');
    }

    function getGiftEndpointPath(slug) {
        const raw = String(slug || "").trim();
        if (!raw) return null;
        let decoded = raw;
        try { decoded = decodeURIComponent(raw); } catch {}
        return `/users/${encodeURIComponent(decoded)}/gifts`;
    }

    function getTopNavUserLink(root = document) {
        const scope = root && typeof root.querySelector === "function" ? root : document;
        return scope.querySelector([
            'a.top-nav__username[href*="/users/"]',
            'a.top-nav__username--highresolution[href*="/users/"]',
            '.top-nav__username a[href*="/users/"]'
        ].join(", "));
    }

    function getAuthenticatedUserSlug() {
        const navLink = getTopNavUserLink();
        if (navLink) {
            try {
                const url = new URL(navLink.getAttribute("href") || navLink.href || "", location.origin);
                const parts = url.pathname.split("/").filter(Boolean);
                const idx = parts.findIndex(part => part.toLowerCase() === "users");
                if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
            } catch {}
        }

        const username = getLoggedInUsername() || giveawayData?.host || "";
        return username ? encodeURIComponent(username) : "";
    }

    // ── DarkPeers BON Pool ──────────────────────────────────────
    const BONANZA = Object.freeze({
        FUND_NAME: "BON Pool",
        POOL_PATH: "/bon-pool",
        POOL_STORE_PATH: "/bon-pool/store",
        PERCENT_OPTIONS: Object.freeze([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]),
        MAX_PERCENT: 50,
        ACCENT_COLOR: "#4FAFFF",
        GIVEAWAY_COLOR: "#4FAFFF",
        VERIFY_ATTEMPTS: 6,
        VERIFY_DELAY_MS: 2500,
        FETCH_TIMEOUT_MS: 8000
    });

    // Authoritative website -> DP -> IRC -> The Lounge contract.
    //
    // v1.3.14 deliberately does NOT use links for machine markers. A link is public
    // website content, and HTML -> IRC bridges commonly serialize a labelled link as
    // "label (URL)". Hiding only the <a> in TLCC then leaves orphaned parentheses.
    //
    // Instead, every marker is encoded as two U+2063 INVISIBLE SEPARATOR sentinels:
    //   1) a fixed bold+italic+underline prefix sentinel;
    //   2) an italic+underline sentinel whose colour identifies the marker kind.
    //
    // The type markers stay inside the canonical IRC 0..15 palette. Most kinds are
    // identified by colour alone; sponsor-message recaps intentionally reuse IRC 05
    // but add bold to the typed sentinel so they remain distinct without relying on an
    // extended colour that some bridge/client paths do not preserve reliably. They are
    // invisible on DarkPeers because U+2063 has zero visual width, while the bridge
    // preserves their formatting as IRC style spans that TLCC can select.
    const BRIDGE_SENTINEL = "\u2063";
    const BRIDGE_MARKERS = Object.freeze({
        START: "start",
        START_POOL: "start-pool",
        START_TAXES: "start-taxes",
        GIFT: "gift",
        POT: "pot",
        SPONSORS: "sponsors",
        SPONSOR_MESSAGES: "sponsor-messages",
        ENTRIES: "entries",
        STATS: "stats",
        TIME: "time",
        RESULT: "result",
        TIE: "tie",
        RIGGED: "rigged",
        UNRIGGED: "unrigged",
        NAUGHTY: "naughty",
        POOL_PAID: "pool-paid",
        TAXES_PAID: "taxes-paid"
    });
    const BRIDGE_SENTINEL_COLORS = Object.freeze({
        "start":       "#FFFFFF", // IRC 00
        "start-pool":  "#000000", // IRC 01
        "start-taxes": "#001F3F", // IRC 02
        "gift":        "#2ECC40", // IRC 03
        "pot":         "#FF4136", // IRC 04
        "sponsors":         "#85144B", // IRC 05
        "sponsor-messages": "#85144B", // IRC 05 + bold typed sentinel
        "entries":          "#B10DC9", // IRC 06
        "stats":       "#FF851B", // IRC 07
        "time":        "#FFDC00", // IRC 08
        "result":      "#01FF70", // IRC 09
        "tie":         "#39CCCC", // IRC 10
        "rigged":      "#7FDBFF", // IRC 11
        "unrigged":    "#0074D9", // IRC 12
        "naughty":     "#F012BE", // IRC 13
        "pool-paid":   "#AAAAAA", // IRC 14
        "taxes-paid":  "#DDDDDD"  // IRC 15
    });

    const BRIDGE_CONTEXT_COLORS = Object.freeze({
        pool: "#0074D9",  // IRC 12, distinguished by bold+underline (no italic)
        taxes: "#F012BE"  // IRC 13, distinguished by bold+underline (no italic)
    });

    function getActiveBridgeContext() {
        try {
            const pct = Math.max(0, Number(giveawayData?.donationPercent) || 0);
            if (!(pct > 0)) return "";
            return riggedMode ? "taxes" : "pool";
        } catch {
            return "";
        }
    }

    function bridgeMarker(kind, visible, contextOverride = null) {
        const safeKind = String(kind || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
        const markerColor = BRIDGE_SENTINEL_COLORS[safeKind];
        const safeVisible = String(visible ?? "");

        // Unknown marker kinds must fail visibly-safe: keep the human-facing emoji/text,
        // but never fall back to a public implementation URL.
        if (!markerColor) return safeVisible;

        const prefix = `[b][i][u]${BRIDGE_SENTINEL}[/u][/i][/b]`;
        const typed = safeKind === BRIDGE_MARKERS.SPONSOR_MESSAGES
            ? `[b][i][u][color=${markerColor}]${BRIDGE_SENTINEL}[/color][/u][/i][/b]`
            : `[i][u][color=${markerColor}]${BRIDGE_SENTINEL}[/color][/u][/i]`;

        // Carry the active giveaway family independently of the message type. The
        // optional override is intentionally narrow: exceptional settlement messages
        // can explicitly identify as BON Pool even if the running event was standard
        // or had Rigged Taxes enabled.
        const requestedContext = String(contextOverride || "").toLowerCase();
        const context = Object.prototype.hasOwnProperty.call(BRIDGE_CONTEXT_COLORS, requestedContext)
            ? requestedContext
            : getActiveBridgeContext();
        const contextColor = BRIDGE_CONTEXT_COLORS[context];
        const contextual = contextColor
            ? `[b][u][color=${contextColor}]${BRIDGE_SENTINEL}[/color][/u][/b]`
            : "";

        return `${safeVisible}${prefix}${typed}${contextual}`;
    }
    const LS_DONATION_PERCENT = `bonanza-giveaway-donationPercent::${location.hostname}`;
    // End-of-giveaway statements (plain text). Only the most recent few are kept.
    const LS_STATEMENTS =
        `bonanza-giveaway-statements::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;
    const STATEMENTS_KEEP = 2;

    // Mutual exclusion with the original "Blutopia BON Giveaway" script (see injectMenu)
    const ORIGINAL_SCRIPT_SELECTOR = "#giveawayFrame";
    let conflictWatchTimer = null;

    const BUTTON_CSS = `
/* Legacy v1.2.3-v1.3.13 URL markers may still exist in already-loaded scrollback.
   Keep hiding those old anchors for hosts running the userscript. v1.3.14 emits
   invisible styled sentinels instead and therefore needs no website-side hiding. */
.chatbox-message__content a[href*="#dpgw-v1-"] {
  display: none !important;
}

/* ── Toolbar button: "Neon Edge" (fx-94), sized for the chat header ── */
#chatbox_header .bonanza-btn {
  /* Theme tokens: override these to recolour the button */
  --primary: #60FDFC;         /* neon glow */
  --secondary: #0F191E;
  --surface: #E2F1F2;
  --bink: var(--surface);     /* ink / foreground (light, for the dark chat header) */
  --bsurf: var(--secondary);  /* surface / background */
  position: relative;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  vertical-align: middle;
  margin: 0 6px 0 0;
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 5px 10px;
  border: 1px solid var(--bink);
  border-radius: 6px;
  background: transparent;
  color: var(--bink);
  cursor: pointer;
  overflow: visible;
  white-space: nowrap;
  transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
#chatbox_header .bonanza-btn .btn-label {
  position: relative;
  z-index: 2;
  display: inline-block;
  transition: inherit;
}
#chatbox_header .bonanza-btn .bonanza-btn__icon {
  position: relative;
  z-index: 2;
  width: 15px;
  height: 12px;
  flex: 0 0 auto;
  transition: inherit;
}
#chatbox_header .bonanza-btn.fx-94:hover,
#chatbox_header .bonanza-btn.fx-94:focus-visible {
  border-color: var(--primary);
  color: var(--primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--primary),
              0 0 10px color-mix(in srgb, var(--primary) 70%, transparent),
              inset 0 0 8px color-mix(in srgb, var(--primary) 40%, transparent);
}
#chatbox_header .bonanza-btn.fx-94:active {
  transform: translateY(1px);
}

/* ── Conflict mode (original BON Giveaway script also installed) ──
   At rest the button looks normal; on hover it fades and shrinks; on click it
   blinks red while the original script's button glows orange and shakes. */
#chatbox_header .bonanza-btn.bonanza-btn--conflict:hover,
#chatbox_header .bonanza-btn.bonanza-btn--conflict:focus-visible {
  opacity: 0.35;
  transform: scale(0.86);
  border-color: var(--bink);
  color: var(--bink);
  box-shadow: none;
  cursor: not-allowed;
}
#chatbox_header .bonanza-btn.bonanza-btn--conflict:active { transform: scale(0.86); }
#chatbox_header .bonanza-btn.bonanza-btn--conflict.bonanza-blink-red {
  animation: bonanzaBlinkRed 0.9s steps(1, end) 0s 1;
}
@keyframes bonanzaBlinkRed {
  0%, 20%, 40%, 60% { opacity: 1; transform: scale(1); color: #fff; border-color: #ff3b3b; background: #ff3b3b; box-shadow: 0 0 0 1px #ff3b3b, 0 0 12px #ff3b3b; }
  10%, 30%, 50%     { opacity: 1; transform: scale(1); color: var(--bink); border-color: var(--bink); background: transparent; box-shadow: none; }
  100%              { opacity: 0.35; transform: scale(0.86); }
}
/* The original script's button, tagged by this script when a conflict is detected */
#chatbox_header .bonanza-orig-btn {
  display: inline-block;
  border-radius: 6px;
  transition: box-shadow 0.3s ease, color 0.3s ease;
}
#chatbox_header .bonanza-orig-btn.bonanza-orig-alert {
  color: #ff9f1c !important;
  box-shadow: 0 0 0 1px #ff9f1c, 0 0 12px #ff9f1c, inset 0 0 8px rgba(255, 159, 28, 0.45);
  animation: bonanzaShake 0.9s cubic-bezier(0.36, 0.07, 0.19, 0.97) 0s 1;
}
@keyframes bonanzaShake {
  10%, 90% { transform: translateX(-1px); }
  20%, 80% { transform: translateX(2px); }
  30%, 50%, 70% { transform: translateX(-4px); }
  40%, 60% { transform: translateX(4px); }
}
#bonanzaGiveawayConflictToast {
  position: fixed; left: 50%; top: 72px; transform: translateX(-50%);
  z-index: 10000; max-width: 460px; padding: 10px 14px; border-radius: 8px;
  background: #2a1414; color: #ffd9d9; border: 1px solid #ff3b3b;
  font-size: 13px; line-height: 1.4; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  opacity: 0; transition: opacity 0.25s ease;
}
#bonanzaGiveawayConflictToast.show { opacity: 1; }
`;

    function normalizeDonationPercent(raw) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n)) return 0;
        return BONANZA.PERCENT_OPTIONS.includes(n) ? n : 0;
    }

    function buildDonationContext(data, { compact = false } = {}) {
        const pct = normalizeDonationPercent(data?.donationPercent);
        if (pct <= 0) return "";

        if (riggedMode) {
            return compact
                ? `[b][color=#FF4F9A]${BONANZA.FUND_NAME}: ${pct}% tax[/color][/b]`
                : `[b][color=#FF4F9A]${pct}% rigging tax to the ${BONANZA.FUND_NAME}[/color][/b]`;
        }

        return compact
            ? `[b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME}: ${pct}%[/color][/b]`
            : `💙 [b][color=${BONANZA.GIVEAWAY_COLOR}]${pct}% of the final pot (including sponsor gifts) goes to the ${BONANZA.FUND_NAME}[/color][/b]; winners share the remaining ${100 - pct}%.`;
    }


    const LS_SUPPRESS = "bonanza-giveaway-suppressEntryReplies";
    const LS_SILENT = "bonanza-giveaway-silentMode";
    const LS_SHOW_GIVEAWAY_LOG = "bonanza-giveaway-showLog";
    const LS_HOST_PANEL_OPEN = "bonanza-giveaway-hostPanelOpen";
    const LS_HOST_PANEL_POS = "bonanza-giveaway-hostPanelPos";
    const LS_MINIMIZED = "bonanza-giveaway-minimized";
    const LS_PRESETS = "bonanza-giveaway-presets";
    const LS_ACTIVE_GIVEAWAY_LEGACY = `bonanza-giveaway-activeState::${location.hostname}`;
    const LS_TAB_LOCK = `bonanza-giveaway-tabLock::${location.hostname}`;
    // Per-giveaway ledger of completed gift attempts. Survives reload + visible to other tabs,
    // so even if endGiveaway runs in two tabs the second one won't re-pay.
    const LS_PAID_GIFTS =
        `bonanza-giveaway-paidGifts::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;
    const LS_POOL_CONTRIBUTIONS =
        `bonanza-giveaway-poolContributions::${location.hostname}${REHEARSAL_STORAGE_SUFFIX}`;
    // Cap retained giveaway-id entries in the ledger so it can't grow unbounded over time.
    const PAID_GIFTS_MAX_GIVEAWAYS = 50;
    const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const TAB_LOCK_HEARTBEAT_MS = 5000;   // update lock every 5s
    const TAB_LOCK_STALE_MS = 15000;      // lock is stale if no heartbeat for 15s
    const TAB_WEB_LOCK_NAME = `bonanza-giveaway-owner::${location.hostname}`;
    const EXPIRED_SNAPSHOT_SETTLEMENT_GRACE_MS = 60 * 60 * 1000; // 1h after scheduled end
    let tabLockHeartbeatTimer = null;
    let tabWebLockRelease = null;
    let tabWebLockAcquirePromise = null;
    let giveawayMutationQuarantined = false;
    let hostAddBonInFlight = false;

    function readStoredBooleanSetting(key, fallback = false, persistFallback = false) {
        const raw = localStorage.getItem(key);
        if (raw === "true") return true;
        if (raw === "false") return false;
        if (persistFallback) {
            localStorage.setItem(key, String(!!fallback));
        }
        return !!fallback;
    }

    // Initialize silent mode as early as possible (no page refresh needed).
    GENERAL_SETTINGS.silent_mode = readStoredBooleanSetting(LS_SILENT, false, true);
    GENERAL_SETTINGS.show_giveaway_log = readStoredBooleanSetting(LS_SHOW_GIVEAWAY_LOG, false, true);

    const chatroomId = DARKPEERS_CHATROOM_ID;
    const chatboxId = "chatbox__messages-create";

    const COMMAND_PANEL_SECTIONS = Object.freeze({
        giveaway: "General Commands",
        stats: "Stats Commands",
        entry: "Entry Commands",
        help: "Help",
        rigging: "Rigging Commands",
        pot: "BON Commands"
    });
    const HOST_PANEL_NAUGHTY_SECTION_TITLE = "Naughty List";
    const HOST_PANEL_END_COMMAND_DENYLIST = Object.freeze(["end", "endgiveaway", "giveawayend", "stop", "stopgiveaway"]);
    const HOST_PANEL_INTERNAL_COMMAND_DENYLIST = Object.freeze(["commands"]);
    const HOST_PANEL_SECTION_ORDER = Object.freeze(["giveaway", "stats", "pot", "entry", "rigging", "help"]);
    const HOST_PANEL_COMMAND_SECTION_BY_KEY = Object.freeze({
        reminder: "giveaway",
        entries: "giveaway",
        time: "giveaway",
        addtime: "giveaway",
        removetime: "giveaway",
        winners: "giveaway",
        maxwinners: "giveaway",
        scale: "giveaway",
        stats: "stats",
        top: "stats",
        most: "stats",
        largest: "stats",
        unlucky: "stats",
        sponsors: "stats",
        help: "help",
        gift: "help",
        bon: "pot",
        addbon: "pot",
        rig: "rigging",
        unrig: "rigging",
        naughty: "naughty"
    });
    const HOST_PANEL_COMMAND_ORDER_BY_SECTION = Object.freeze({
        giveaway: Object.freeze(["reminder", "entries", "time", "addtime", "removetime", "winners", "maxwinners", "scale"]),
        stats: Object.freeze(["stats", "top", "most", "largest", "unlucky", "sponsors"]),
        help: Object.freeze(["help", "gift"]),
        pot: Object.freeze(["bon", "addbon"]),
        rigging: Object.freeze(["rig", "unrig"])
    });

    // only run the cooldown/spam‑detection logic on available commands
    const baseCommands = ["time", "entries", "help", "commands", "bon", "range", "gift","random", "number", "free", "lucky", "luckye", "rig", "unrig", "stats", "top", "most", "sponsors", "unlucky", "largest", "scale"];
    const hostCommands = ["addtime", "removetime", "reminder", "addbon", "end", "winners", "maxwinners", "naughty"];
    const validCommands = new Set([
        ...baseCommands,
        ...hostCommands
    ]);
    const HOST_PANEL_COMMAND_METADATA = Object.freeze({
        time: { label: "Time", section: "giveaway", description: "Show remaining giveaway time.", usage: "!time", requiresGiveaway: true },
        entries: { label: "Entries", section: "info", description: "List current entries.", usage: "!entries", requiresGiveaway: true },
        help: { label: "Help", section: "info", description: "Show available commands in chat.", usage: "!help", requiresGiveaway: false },
        commands: { label: "Commands", section: "info", description: "Alias for !help.", usage: "!commands", requiresGiveaway: false },
        stats: { label: "Stats", section: "info", description: "Show saved stats for a user.", usage: "!stats [username]", requiresGiveaway: false,
                args: [{ name: "username", label: "User", type: "username", required: false, placeholder: "optional username" }] },
        top: { label: "Top", section: "info", description: "Top winners leaderboard.", usage: "!top [N]", requiresGiveaway: false,
              args: [{ name: "count", label: "N", type: "int", required: false, min: 1, max: STATS_MAX_TOP_N, placeholder: String(STATS_DEFAULT_TOP_N) }] },
        most: { label: "Most", section: "info", description: "Most BON won leaderboard.", usage: "!most [N]", requiresGiveaway: false,
               args: [{ name: "count", label: "N", type: "int", required: false, min: 1, max: STATS_MAX_TOP_N, placeholder: String(STATS_DEFAULT_TOP_N) }] },
        sponsors: { label: "Sponsors", section: "pot", description: "Show top sponsors.", usage: "!sponsors [N]", requiresGiveaway: false,
                   args: [{ name: "count", label: "N", type: "int", required: false, min: 1, max: STATS_MAX_TOP_N, placeholder: String(STATS_DEFAULT_TOP_N) }] },
        unlucky: { label: "Unlucky", section: "info", description: "Show most losses leaderboard.", usage: "!unlucky [N]", requiresGiveaway: false,
                  args: [{ name: "count", label: "N", type: "int", required: false, min: 1, max: STATS_MAX_TOP_N, placeholder: String(STATS_DEFAULT_TOP_N) }] },
        largest: { label: "Largest", section: "info", description: "Show largest giveaways.", usage: "!largest [N]", requiresGiveaway: false,
                  args: [{ name: "count", label: "N", type: "int", required: false, min: 1, max: STATS_MAX_TOP_N, placeholder: String(STATS_DEFAULT_TOP_N) }] },
        gift: { label: "Gift", section: "pot", description: "Show giveaway gift status.", usage: "!gift", requiresGiveaway: true },
        bon: { label: "BON", section: "pot", description: "Show current pot amount.", usage: "!bon", requiresGiveaway: true },
        range: { label: "Range", section: "entry", description: "Show valid entry range.", usage: "!range", requiresGiveaway: true },
        lucky: { label: "Lucky", section: "entry", description: "Show lucky number.", usage: "!lucky", requiresGiveaway: true },
        luckye: { label: "Lucky Enter", section: "entry", description: "Enter using lucky number.", usage: "!luckye", requiresGiveaway: true },
        rig: { label: "Rig", section: "entry", description: "Fun rig toggle command.", usage: "!rig", requiresGiveaway: true },
        unrig: { label: "Unrig", section: "entry", description: "Fun rig toggle command.", usage: "!unrig", requiresGiveaway: true },
        random: { label: "Random", section: "entry", description: "Enter with a random number.", usage: "!random", requiresGiveaway: true },
        number: { label: "Number", section: "entry", description: "Show your current entry.", usage: "!number", requiresGiveaway: true },
        free: { label: "Free", section: "entry", description: "Show available entry numbers.", usage: "!free", requiresGiveaway: true },
        addbon: { label: "Add BON", section: "pot", description: "Add BON to the pot.", usage: "!addbon <amount>", requiresGiveaway: true, hostOnly: true,
                 args: [{ name: "amount", label: "BON", type: "int", required: true, min: 1, placeholder: "amount" }] },
        reminder: { label: "Reminder", section: "giveaway", description: "Send reminder now.", usage: "!reminder", requiresGiveaway: true, hostOnly: true },
        winners: { label: "Winners", section: "giveaway", description: "Set winner count.", usage: `!winners 1-${MAX_WINNERS}`, requiresGiveaway: true, hostOnly: true,
                  args: [{ name: "count", label: "Count", type: "int", required: true, min: 1, max: MAX_WINNERS, placeholder: "winners" }] },
        maxwinners: { label: "Max Winners", section: "giveaway", description: "Set max scaled winners.", usage: `!maxwinners 1-${MAX_WINNERS}`, requiresGiveaway: true, hostOnly: true,
                     args: [{ name: "count", label: "Max", type: "int", required: true, min: 1, max: MAX_WINNERS, placeholder: "max" }] },
        scale: { label: "Scale", section: "info", description: "Show scaling progress.", usage: "!scale", requiresGiveaway: true },
        addtime: { label: "Add Time", section: "giveaway", description: "Add giveaway minutes.", usage: "!addtime <minutes>", requiresGiveaway: true, hostOnly: true,
                  args: [{ name: "minutes", label: "Min", type: "int", required: true, min: 1, placeholder: "minutes" }] },
        removetime: { label: "Remove Time", section: "giveaway", description: "Remove giveaway minutes.", usage: "!removetime <minutes>", requiresGiveaway: true, hostOnly: true,
                     args: [{ name: "minutes", label: "Min", type: "int", required: true, min: 1, placeholder: "minutes" }] },
        naughty: { label: "Naughty", section: "giveaway", description: "Manage naughty list.", usage: "!naughty (add|remove|list) [username]", requiresGiveaway: true, hostOnly: true,
                  args: [
                      { name: "action", label: "Action", type: "select", required: true, placeholder: "action", options: [{ label: "Add", value: "add" }, { label: "Remove", value: "remove" }, { label: "List", value: "list" }], validate: (v) => /^(add|remove|list)$/i.test(String(v || "").trim()), hint: "Use add, remove, or list." },
                      { name: "username", label: "User", type: "username", required: false, placeholder: "username", requiredWhen: (all) => /^(add|remove)$/i.test(String(all.action || "").trim()), hint: "Username is required for add/remove." }
                  ] },
        end: { label: "End", section: "giveaway", description: "End the active giveaway.", usage: "!end [host]", requiresGiveaway: true, hostOnly: true,
              args: [{ name: "host", label: "Host", type: "username", required: false, placeholder: "optional host" }] },
    });

    // Declared early so UI init paths can safely reference this object before command handlers are populated.
    const COMMAND_HANDLERS = Object.create(null);

    // ───────────────────────────────────────────────────────────
