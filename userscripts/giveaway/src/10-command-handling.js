    // SECTION 10: Command Handling
    // ───────────────────────────────────────────────────────────
    function handleGiveawayCommands(author, messageContent, fancyName, giveawayData) {
        // Fast-exit when it’s not a command
        if (!messageContent.startsWith("!")) return;

        // Parse command + args first
        const args = messageContent.slice(1).trim().split(/\s+/);
        const command = (args.shift() || "").toLowerCase();

        // Early-ignore window for *entry* commands right after giveaway starts.
        // This ensures auto-join scripts are dropped before naughty/cooldown logic.
        const isEntryCommand =
              command === "random" || command === "luckye"; // add more here later if you introduce other entry commands

        if (isEntryCommand && isWithinEntryIgnoreWindow()) {
            return;
        }

        if (isNaughtyBlocked(author, fancyName, giveawayData)) return;

        if (!validCommands.has(command)) return; // Unsupported

        const entriesClosed =
            isGiveawaySettling(giveawayData) ||
            getGiveawayRemainingMs(giveawayData) <= 0;
        if (entriesClosed) {
            const settlementSafeCommands = new Set([
                "time", "entries", "bon", "number", "gift", "range", "scale",
                "stats", "top", "most", "sponsors", "unlucky", "largest",
                "help", "commands"
            ]);
            const readOnlyTime = command !== "time" || args.length === 0;
            if (!settlementSafeCommands.has(command) || !readOnlyTime) return;
        }

        if (applyCooldown(author, { command, fancyName })) return; // Spammer – ignored

        executeCommand({
            name: command,
            args,
            author,
            fancyName,
            giveawayData,
            source: "chat",
            reply: (msg) => sendCommandResponse(author, msg)
        });
    }

    function executeCommand({ name, args = [], author = "", fancyName = "", giveawayData: dataOverride, reply, source = "chat" } = {}) {
        const data = dataOverride || giveawayData || null;
        const resolvedAuthor = author || getLoggedInUsername() || (data ? data.host : "") || "";
        const resolvedFancyName = fancyName || "";
        const replyFn = typeof reply === "function"
        ? reply
        : (msg) => sendCommandResponse(resolvedAuthor, msg);

        const handler = COMMAND_HANDLERS[name];
        if (!handler) return;

        const maybePromise = handler({
            author: resolvedAuthor,
            fancyName: resolvedFancyName,
            args,
            giveawayData: data,
            reply: replyFn,
            say: (msg) => sendMessage(msg),
            pm: (to, msg) => sendPrivateMessage(to, msg),
            source,
            safeAuthor: sanitizeNick(resolvedAuthor),
            safeHost: sanitizeNick(data ? data.host : "")
        });

        if (maybePromise && typeof maybePromise.then === "function") {
            return maybePromise.catch(err => {
                console.error("Giveaway command handler error:", err);
                throw err;
            });
        }
        return maybePromise;
    }



    /**
     * Throttle per-user feedback messages (duplicate entry / out-of-range / spam lockout notices)
     * to avoid the script spamming chat with repeated error responses.
     *
     * @param {string} author
     * @param {string} bucket - feedback category key, e.g. "entry-repeat", "entry-range", "spam-lockout"
     * @param {number} cooldownMs - override cooldown in ms (default ENTRY_FEEDBACK_COOLDOWN_MS)
     * @returns {boolean} true if feedback may be sent now
     */
    function canSendUserFeedback(author, bucket, cooldownMs = ENTRY_FEEDBACK_COOLDOWN_MS) {
        const now = Date.now();
        const authorKey = String(author || "").toLowerCase();
        if (!authorKey) return true;

        const b = String(bucket || "default");
        const key = `${authorKey}::${b}`;
        const last = userFeedbackCooldown.get(key) || 0;

        if (now - last < cooldownMs) return false;

        userFeedbackCooldown.set(key, now);
        return true;
    }

    /** Rate‑limit users – returns `true` when the caller must be ignored. */
    function applyCooldown(author, opts = {}) {
        const now = Date.now();
        const rawAuthor = String(author || "");
        const authorKey = rawAuthor.toLowerCase();
        if (!authorKey) return false;

        // The giveaway host and recognized DarkPeers staff may need several recovery
        // commands in quick succession. Never put either into the escalating spam
        // lockout. Keep only the ultra-fast double-send guard so accidental duplicate
        // submits are ignored.
        const activeHostKey = normalizeUserKey(giveawayData?.host);
        const fancyName = (opts && typeof opts === "object") ? opts.fancyName : "";
        const command = (opts && typeof opts === "object" && opts.command != null)
            ? String(opts.command).trim().toLowerCase()
            : "";
        const staffEmergencyCommands = new Set([
            "rig", "unrig", "time", "addtime", "removetime", "naughty", "end"
        ]);
        const isEmergencyOperator =
            (activeHostKey && authorKey === activeHostKey) ||
            (isAdmin(fancyName) && staffEmergencyCommands.has(command));
        if (isEmergencyOperator) {
            const lastAny = userLastActionAt.get(authorKey) || 0;
            const tooFast = (now - lastAny) < MIN_ACTION_GAP_MS;
            userLastActionAt.set(authorKey, now);
            return tooFast;
        }

        const lockoutExpires = userCooldown.get(authorKey) || 0;
        if (now < lockoutExpires) return true;

        // Track this trigger in the rolling window (we count triggers even if we suppress output)
        const log = (userCommandLog.get(authorKey) || []).filter(ts => now - ts < COMMAND_WINDOW_MS);
        log.push(now);
        userCommandLog.set(authorKey, log);
        selfCheck(log.length >= 1, "command log should contain at least the current trigger", {
            author: rawAuthor,
            logLength: log.length
        });

        // Block ultra-fast repeats (bots / accidental double-send)
        const lastAny = userLastActionAt.get(authorKey) || 0;
        const tooFast = (now - lastAny) < MIN_ACTION_GAP_MS;
        userLastActionAt.set(authorKey, now);

        // Per-command cooldown (prevents identical output spam)
        let repeatBlocked = false;

        if (command) {
            const cd = Number(REPEAT_COMMAND_COOLDOWNS_MS[command]) || 0;
            if (cd > 0) {
                const k = `${authorKey}::${command}`;
                const lastCmd = userLastCommandAt.get(k) || 0;
                repeatBlocked = (now - lastCmd) < cd;
                userLastCommandAt.set(k, now);
            }
        }

        // Hard limit in the rolling window → lockout (with escalating penalties for repeat offenders)
        if (log.length > MAX_COMMANDS_PER_WINDOW) {
            const excess = log.length - MAX_COMMANDS_PER_WINDOW;

            const prev = userSpamStrikes.get(authorKey) || { count: 0, lastAt: 0 };
            if (now - (prev.lastAt || 0) < STRIKE_WINDOW_MS) {
                prev.count = (prev.count || 0) + 1;
            } else {
                prev.count = 1;
            }
            prev.lastAt = now;
            userSpamStrikes.set(authorKey, prev);

            const multiplier = Math.min(MAX_STRIKE_MULTIPLIER, Math.pow(2, Math.max(0, (prev.count || 1) - 1)));
            const penaltySec = Math.max(1, Math.round(BASE_PENALTY_SECONDS * excess * multiplier));

            userCooldown.set(authorKey, now + penaltySec * 1000);
            userCommandLog.delete(authorKey);

            if (canSendUserFeedback(rawAuthor, "spam-lockout", 60_000)) {
                sendCommandResponse(rawAuthor, `[color=red][b]Spamming detected! ${sanitizeNick(rawAuthor)} locked out for ${penaltySec} seconds.[/b][/color]`);
            }
            return true;
        }

        // If we didn't lock them out, we may still suppress output for too-fast / repeat cases
        return tooFast || repeatBlocked;
    }

    const _adminCache = new Map(); // fancyName HTML → boolean (cleared per giveaway in stopGiveaway)
    const DARKPEERS_STAFF_ROLE_NAMES = new Set([
        "leader", "administrator", "admin", "moderator", "mod", "developer", "operator"
    ]);

    function isAdmin(fancyName) {
        if (!fancyName) return false;
        const cached = _adminCache.get(fancyName);
        if (cached !== undefined) return cached;

        let result = false;
        try {
            const div = document.createElement('div');
            div.innerHTML = fancyName;
            const a = div.querySelector('a.user-tag__link');
            if (a) {
                const title = String(a.getAttribute('title') || "")
                    .trim()
                    .toLowerCase()
                    .replace(/\s+/g, " ");
                result = DARKPEERS_STAFF_ROLE_NAMES.has(title);
            }
        } catch {
            result = false;
        }
        _adminCache.set(fancyName, result);
        return result;
    }

    function isNonHostStaffAction(author, fancyName, host) {
        const authorKey = normalizeUserKey(author);
        const hostKey = normalizeUserKey(host);
        return !!(authorKey && hostKey && authorKey !== hostKey && isAdmin(fancyName));
    }

    function makeStaffAttributedReply(ctx) {
        const reply = ctx && typeof ctx.reply === "function" ? ctx.reply : sendMessage;
        if (!ctx || !isNonHostStaffAction(ctx.author, ctx.fancyName, ctx.giveawayData?.host)) {
            return reply;
        }

        const prefix =
            `👮 [b][color=#5DE2E7]Staff action by ${sanitizeNick(ctx.author)}:[/color][/b] `;

        // Staff intervention is operationally significant and must stay public
        // even when the host enabled Silent Mode. Rehearsal Mode still suppresses
        // sendMessage itself, so testing cannot leak messages into live chat.
        return (message) => sendMessage(prefix + message);
    }

    /** Factory for leaderboard commands. Eliminates boilerplate across top/most/sponsors/unlucky. */
    function makeLeaderboardCommand({ emoji, label, emptyMsg, sort, filter, format }) {
        return function leaderboardHandler(ctx) {
            const { reply } = ctx;
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const rows = getLeaderboardRows(sort, n, filter);
            if (!rows.length) {
                reply(emptyMsg);
                return;
            }
            const out = rows.map((u, i) => format(u, i, ctx));
            reply(`[b]${bridgeMarker(BRIDGE_MARKERS.STATS, "📊")} ${emoji} ${label}: ${out.join(" | ")}[/b]`);
        };
    }

    Object.assign(COMMAND_HANDLERS, {
        /* Public commands */
        time(ctx) {
            const { args, author, fancyName, giveawayData, reply } = ctx;

            const addMinutes = hostAdjustTime(+1);
            const removeMinutes = hostAdjustTime(-1);

            // no args → derive from the absolute deadline, never from the cached
            // timeLeft field (which can be stale if a timer is throttled/stopped).
            if (args.length === 0) {
                const remainingMs = syncGiveawayTimeLeft(giveawayData);
                const settling = isGiveawaySettling(giveawayData);
                if (settling || remainingMs <= 0) {
                    reply(
                        `${bridgeMarker(BRIDGE_MARKERS.TIME, "⏳")} [b][color=#FFDE59]Entries are closed.[/color][/b] Settlement is in progress.`
                    );

                    // A background-tab timer may be throttled. A status request
                    // after the absolute deadline must actively kick settlement
                    // instead of merely reporting that it should already be running.
                    if (!settling && remainingMs <= 0) {
                        setTimeout(() => {
                            if (
                                giveawayData &&
                                !giveawayData.__ending &&
                                getGiveawayRemainingMs(giveawayData) <= 0
                            ) {
                                endGiveaway();
                            }
                        }, 0);
                    }
                } else {
                    reply(
                        `Time left: [b][color=#1DDC5D]${parseTime(remainingMs)}[/color][/b] ${bridgeMarker(BRIDGE_MARKERS.TIME, "⏳")}`
                    );
                }
                return;
            }

            const action = (args[0] || "").toLowerCase(); // "add" / "remove"
            const minutes = parseFloat(args[1]);
            const isPriv = normalizeUserKey(author) === normalizeUserKey(giveawayData.host) || isAdmin(fancyName);

            if (!isPriv) return; // silently ignore non-host/non-admin

            const actionReply = makeStaffAttributedReply(ctx);

            if (action !== "add" && action !== "remove") {
                actionReply("[color=red]Usage:[/color] !time add|remove <minutes>");
                return;
            }

            if (isNaN(minutes) || minutes <= 0) {
                actionReply("[color=red]Usage:[/color] !time add|remove <minutes>");
                return;
            }

            // Pass only the minutes to the shared adjuster
            const ctxWithArg = { ...ctx, args: [String(minutes)] };

            if (action === "add") {
                addMinutes(ctxWithArg);
            } else {
                removeMinutes(ctxWithArg);
            }
        },

        entries({ giveawayData , reply}) {
            const taken = numberEntries.size;
            const total = giveawayData.totalEntries;
            const free = total - taken;

            if (taken === 0) {
                reply(`[b]No entries yet! ${total} numbers available.[/b]`);
                return;
            }

            // Sort by entry number (ascending)
            const list = Array.from(numberEntries.entries())
            .sort(([, numA], [, numB]) => numA - numB)
            .map(([user, num]) =>
                 `[color=#d85e27][b]${sanitizeNick(user)}[/b][/color]: [b]${num}[/b]`
                );

            reply(
                `${bridgeMarker(BRIDGE_MARKERS.ENTRIES, "📋")} Entries – ${taken}/${total} ` +
                `[b]([color=#1DDC5D]${free} free[/color][/b]): ${list.join(", ")}`
            );
        },

        help: showHelp,
        commands: showHelp,

        stats(ctx) {
            const { reply } = ctx;
            const target = (ctx.args[0] || ctx.author || "").trim();
            const stats = getStatsCached();
            const key = normUserKey(target);
            const rec = key && stats.users ? stats.users[key] : null;

            if (!rec) {
                reply(`[b]No saved stats yet for ${safeNameForChat(target)}.[/b]`);
                return;
            }

            const enteredAll = rec.entered || 0;
            const wins = rec.wins || 0;
            const losses = rec.losses || 0;

            // Winrate should be based on completed giveaways only.
            let enteredForWr = enteredAll;
            if (ctx.giveawayData && liveEnteredThisGiveaway.has(key)) {
                enteredForWr = Math.max(0, enteredAll - 1);
            }
            const wr = enteredForWr ? ((wins / enteredForWr) * 100).toFixed(1) : "0.0";

            // If the giveaway host calls !stats (for themselves), also show how much they've given away (host pot only; excludes sponsors).
            const isHostCaller = !!(ctx.giveawayData && normUserKey(ctx.author) === normUserKey(ctx.giveawayData.host));
            const isSelfQuery = !ctx.args[0] || normUserKey(target) === normUserKey(ctx.author);

            const parts = [
                `Entered [color=#ffc00a]${fmtBON(enteredAll)}[/color]`,
                `Wins [color=#1DDC5D]${fmtBON(wins)}[/color]`,
                `Losses [color=#CE2E30]${fmtBON(losses)}[/color]`,
                `WR [color=#1DDC5D]${wr}%[/color]`
            ];

            if (rec.totalWon) parts.push(`Won [color=#ffc00a]${fmtBONCurrency(rec.totalWon)} BON[/color]`);
            if (rec.biggestWin) parts.push(`Best [color=#ffc00a]${fmtBONCurrency(rec.biggestWin)} BON[/color]`);
            if (rec.sponsoredTotal) parts.push(`Sponsored [color=#00abff]${fmtBONCurrency(rec.sponsoredTotal)} BON[/color]`);
            if (rec.hosted) parts.push(`Hosted ${fmtBON(rec.hosted)}`);

            if (isHostCaller && isSelfQuery) {
                parts.push(`Given [color=#ffc00a]${fmtBONCurrency(rec.hostedTotal || 0)} BON[/color]`);
                parts.push(`Sponsors received [color=#00abff]${fmtBONCurrency(rec.sponsorReceivedTotal || 0)} BON[/color]`);
                const thisSponsor = sumSponsorContribs(ctx.giveawayData?.sponsorContribs, ctx.giveawayData?.host);
                if (thisSponsor > 0) {
                    parts.push(`Current sponsors [color=#00abff]${fmtBONCurrency(thisSponsor)} BON[/color]`);
                }
            }

            reply(`[b]${bridgeMarker(BRIDGE_MARKERS.STATS, "📊")} Stats: [color=#d85e27]${safeNameForChat(rec.name || target)}[/color] - ${parts.join(" • ")}[/b]`);
        },

        // Leaderboards: table-driven to reduce repetition
        top:      makeLeaderboardCommand({
            emoji: "🏆", label: "Top winners", emptyMsg: "[b]No winner stats saved yet.[/b]",
            sort:   (a, b) => (b.wins - a.wins) || (b.totalWon - a.totalWon) || (b.entered - a.entered),
            filter: u => (u.wins || 0) > 0,
            format: (u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#1DDC5D]${fmtBON(u.wins)}W[/color] • ` +
                `[color=#ffc00a]${fmtBONCurrency(u.totalWon)} BON[/color]`
        }),

        most:     makeLeaderboardCommand({
            emoji: "💰", label: "Most BON won", emptyMsg: "[b]No winner stats saved yet.[/b]",
            sort:   (a, b) => (b.totalWon - a.totalWon) || (b.wins - a.wins) || (b.entered - a.entered),
            filter: u => (u.totalWon || 0) > 0,
            format: (u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#ffc00a]${fmtBONCurrency(u.totalWon)} BON[/color] • ` +
                `[color=#1DDC5D]${fmtBON(u.wins)}W[/color]`
        }),

        sponsors: makeLeaderboardCommand({
            emoji: "💸", label: "Top all-time sponsors", emptyMsg: "[b]No sponsor stats saved yet.[/b]",
            sort:   (a, b) => (b.sponsoredTotal - a.sponsoredTotal) || (b.sponsorCount - a.sponsorCount),
            filter: u => (u.sponsoredTotal || 0) > 0,
            format: (u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#ffc00a]${fmtBONCurrency(u.sponsoredTotal)} BON[/color] • ` +
                `[color=#1DDC5D]${fmtBON(u.sponsorCount)}x[/color]`
        }),

        unlucky:  makeLeaderboardCommand({
            emoji: "😵", label: "Unlucky", emptyMsg: "[b]No unlucky stats saved yet.[/b]",
            sort:   (a, b) => (b.losses - a.losses) || (b.entered - a.entered) || (a.wins - b.wins),
            filter: u => (u.losses || 0) > 0,
            format: (u, i, ctx) => {
                const key = normUserKey(u.name);
                let entered = u.entered || 0;
                const wins = u.wins || 0;
                const losses = u.losses || 0;

                // Winrate should be based on completed giveaways only.
                if (ctx.giveawayData && key && liveEnteredThisGiveaway.has(key)) {
                    entered = Math.max(0, entered - 1);
                }

                const wr = entered ? ((wins / entered) * 100).toFixed(1) : "0.0";

                return `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                    `[color=#CE2E30]${fmtBON(losses)} L[/color] ` +
                    `/ [color=#ffc00a]${fmtBON(entered)} entered[/color] ` +
                    `• [color=#1DDC5D]WR ${wr}%[/color]`;
            }
        }),


        largest(ctx) {
            const { reply } = ctx;
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const stats = getStatsForRead();
            const all = Array.isArray(stats.giveaways) ? stats.giveaways.slice() : [];

            if (!all.length) {
                reply("[b]No giveaway history saved yet.[/b]");
                return;
            }

            const getAmt = (g) => (typeof g === "number" ? g : (g && typeof g === "object" ? Number(g.amount) : 0)) || 0;
            const getEndedAt = (g) => (g && typeof g === "object" ? Number(g.endedAt) : 0) || 0;
            const getEndedDate = (g) => (g && typeof g === "object" && g.endedDate) ? String(g.endedDate) : "";
            const fmtEndedDate = (g) => {
                const d = getEndedDate(g);
                if (d) return d;
                const t = getEndedAt(g);
                if (t) {
                    try { return new Date(t).toLocaleDateString("en-CA"); } catch (e) { /* ignore */ }
                }
                return "unknown date";
            };


            const top = all
            .filter(g => getAmt(g) > 0)
            .sort((a, b) => (getAmt(b) - getAmt(a)) || (getEndedAt(b) - getEndedAt(a)))
            .slice(0, n);

            if (!top.length) {
                reply("[b]No giveaway history saved yet.[/b]");
                return;
            }

            const out = top.map((g, i) => {
                const amt = fmtBONCurrency(getAmt(g));
                const d = fmtEndedDate(g);
                return `${i + 1}) [color=#ffc00a]${amt} BON[/color] [color=#9aa0a6](${d})[/color]`;
            });

            reply(`[b]📈 Largest giveaways: ${out.join(" | ")}[/b]`);

        },

        gift({ giveawayData, reply }) {
            const giftHost = getGiftSyntaxHostName();
            reply(`${bridgeMarker(BRIDGE_MARKERS.GIFT, "✨")} To send a gift type: /gift ${giftHost} amount message`);
        },

        bon({ giveawayData , reply}) {
            const rigTag = rigNote("(pot size [b]carefully curated[/b] by our rigging department)");
            const donationContext = buildDonationContext(giveawayData);
            reply(
                `Giveaway Amount: [b][color=#FFB700]${fmtBONCurrency(giveawayData.amount)} BON[/color][/b]` +
                (donationContext ? ` | ${donationContext}` : "") +
                rigTag
            );
        },

        range({ giveawayData , reply}) {
            const rigTag = rigNote("(this range has been [b]pre-approved[/b] for maximum riggability)");
            reply(
                `Numbers between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color] inclusive are valid.` +
                rigTag
            );
        },

        lucky({ safeAuthor, giveawayData , reply}) {
            // Safety: no active giveaway
            if (!giveawayData) {
                reply("There is no active giveaway right now.");
                return;
            }

            if (GENERAL_SETTINGS.disable_lucky) {
                reply(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], ` +
                    `[color=#999999]!lucky[/color] has been disabled for this giveaway.`
                );
                return;
            }

            const luckyNum = getLuckyNumber(giveawayData);
            if (luckyNum === null || luckyNum === undefined) {
                reply("All numbers are taken. No free numbers left!");
                return;
            }
            const rigHint = rigNote("(approved by the Official Rigging Committee™) ✅");

            reply(
                `The current giveaway lucky number is: ` +
                `[b][color=#1DDC5D]${luckyNum}[/color][/b].` +
                rigHint
            );
        },

        luckye(ctx) {
            const { author, safeAuthor, fancyName, giveawayData, reply } = ctx;

            // Safety: no active giveaway
            if (!giveawayData) {
                reply("There is no active giveaway right now.");
                return;
            }

            if (GENERAL_SETTINGS.disable_lucky) {
                reply(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], ` +
                    `[color=#999999]!lucky[/color] has been disabled for this giveaway.`
                );
                return;
            }

            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                reply(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]you[/color] already entered with number ` +
                    `[color=#DC3D1D][b]${userNumber}[/b][/color]!`
                );
                return;
            }

            const luckyNum = getLuckyNumber(giveawayData);
            if (luckyNum === null || luckyNum === undefined) {
                reply("All numbers are taken. No free numbers left!");
                return;
            }

            addNewEntry(author, fancyName, luckyNum);

            const timeLeftStr = parseTime(getGiveawayRemainingMs(giveawayData));
            const rigHint = rigNote("(approved by the Official Rigging Committee™) ✅");

            reply(
                `[color=#d85e27]${safeAuthor}[/color] used [color=#999999]!luckye[/color] and entered with ` +
                `lucky number [color=#1DDC5D][b]${luckyNum}[/b][/color]! ` +
                `Time remaining: [b][color=#1DDC5D]${timeLeftStr}[/color][/b].` +
                rigHint
            );
        },


        rig(ctx) {
            const { author, safeAuthor, fancyName, giveawayData: ctxGiveawayData, reply } = ctx;
            if (!ctxGiveawayData) return;
            if (!isHostOrAdmin(author, fancyName, ctxGiveawayData.host)) {
                maybeSendRigDeny(author, safeAuthor, "rig");
                return;
            }
            const actionReply = makeStaffAttributedReply(ctx);

            // Only treat as "active giveaway" if the real global giveawayData is set
            const hasActiveGiveaway = !!giveawayData;

            if (!riggedMode) {
                riggedMode = true;
                if (rigBadge) {
                    rigBadge.hidden = false;
                    rigBadge.classList.add('rigged-pulse');
                }
                if (bonanzaGiveawayFrame) {
                    bonanzaGiveawayFrame.classList.add('rigged');
                }

                updateRigToggleUI();

                // Only announce in chat if a giveaway is actually running
                if (hasActiveGiveaway) {
                    actionReply(
                        `${bridgeMarker(BRIDGE_MARKERS.RIGGED, "😈")} [color=#FF4F9A][b]RIGGED MODE ENGAGED![/b][/color] ` +
                        `[i][color=#FF9AE6]Visual flair only. The math is still fair... probably.[/color][/i]`
                    );
                }
            } else {
                if (hasActiveGiveaway) {
                    actionReply(
                        `[color=#FF4F9A][b]RIGGED MODE is already active![/b][/color]`
                    );
                }
            }
        },

        unrig(ctx) {
            const { author, safeAuthor, fancyName, giveawayData: ctxGiveawayData, reply } = ctx;
            if (!ctxGiveawayData) return;
            if (!isHostOrAdmin(author, fancyName, ctxGiveawayData.host)) {
                maybeSendRigDeny(author, safeAuthor, "unrig");
                return;
            }
            const actionReply = makeStaffAttributedReply(ctx);

            const hasActiveGiveaway = !!giveawayData;

            if (riggedMode) {
                riggedMode = false;
                if (rigBadge) {
                    rigBadge.hidden = true;
                    rigBadge.classList.remove('rigged-pulse');
                }
                if (bonanzaGiveawayFrame) {
                    bonanzaGiveawayFrame.classList.remove('rigged');
                }

                updateRigToggleUI();

                if (hasActiveGiveaway) {
                    actionReply(
                        `${bridgeMarker(BRIDGE_MARKERS.UNRIGGED, "😒")} [color=#32cd53][b]Rigged mode disabled.[/b][/color] ` +
                        `[i][color=#A0E7AF]Back to boring, fully transparent fairness.[/color][/i]`
                    );
                }
            } else {
                if (hasActiveGiveaway) {
                    actionReply(
                        `[color=#32cd53][b]Rigged mode isn&#39;t enabled.[/b][/color]`
                    );
                }
            }
        },

        random(ctx) {
            const { author, safeAuthor, fancyName, giveawayData, reply } = ctx;

            if (GENERAL_SETTINGS.disable_random) {
                reply(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#999999]!random[/color] has been disabled for this giveaway.`);
                return;
            }
            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                reply(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]you[/color] already entered with number [color=#DC3D1D][b]${userNumber}[/b][/color]!`);
                return;
            }

            const randomNum = pickRandomFreeNumber(giveawayData);
            if (randomNum === null) {
                reply("All numbers are taken. No free numbers left!");
                return;
            }

            addNewEntry(author, fancyName, randomNum);
            const timeLeftStr = parseTime(getGiveawayRemainingMs(giveawayData));
            const rigHint = rigNote("(chosen by our [b]totally unbiased[/b] chaos engine)");
            reply(
                `[color=#d85e27]${safeAuthor}[/color] has entered with the number ` +
                `[color=#DC3D1D][b]${randomNum}[/b][/color]! Time remaining: ` +
                `[b][color=#1DDC5D]${timeLeftStr}[/color][/b].` +
                rigHint
            );
        },

        number({ author, safeAuthor , reply}) {
            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                reply(`[color=#d85e27]${safeAuthor}[/color] your number is [color=#DC3D1D][b]${userNumber}[/b][/color]`);
            } else {
                reply(`[color=#d85e27]${safeAuthor}[/color] you are not currently in the giveaway.`);
            }
        },

        free({ safeAuthor, giveawayData , reply}) {
            if (GENERAL_SETTINGS.disable_free) {
                reply(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], !free disabled`);
                return;
            }

            const sample = getFreeNumberSample(giveawayData, 5);

            if (!sample.length) {
                reply("There are no free numbers left!");
                return;
            }

            const rigHint = rigNote("(these are some [b]suspiciously good[/b] numbers, trust me...) 😏");
            reply(`Free numbers: ${sample.join(", ")}.` + rigHint);
        },


        /* Privileged commands. Each handler applies its own host/staff policy. */
        addbon: hostAddBon,

        reminder(ctx) {
            if (normalizeUserKey(ctx.author) === normalizeUserKey(ctx.giveawayData.host)) {
                // An explicit host !reminder is a manual override: send it now
                // instead of applying the automatic recent-reminder suppression.
                sendReminder({ force: true });
            }
        },

        winners(ctx) {
            const { author, args, giveawayData, reply } = ctx;
            if (normalizeUserKey(author) !== normalizeUserKey(giveawayData.host)) return;
            const newCount = parseInt(ctx.args[0], 10);
            if (isNaN(newCount) || newCount < 1 || newCount > MAX_WINNERS) {
                reply(`[color=red]Usage:[/color] !winners 1‑${MAX_WINNERS}`);
                return;
            }

            const minimumPot = minimumPotForWeightedWinners(newCount);
            if (Math.floor(Number(giveawayData.amount) || 0) < minimumPot) {
                reply(
                    `[color=red]Cannot set ${fmtBON(newCount)} winners with the current ${fmtBONCurrency(giveawayData.amount)} BON pot. ` +
                    `Weighted payouts require at least ${fmtBONCurrency(minimumPot)} BON.[/color]`
                );
                return;
            }

            // Snapshot previous effective so we can announce the change in chat
            // (host-driven adjustment, symmetric to the scaling-increase announcement).
            const prevEffective = Math.max(
                1,
                Math.floor(Number(giveawayData.effectiveWinnersNum || giveawayData.baseWinnersAtStart || giveawayData.winnersNum) || 1)
            );

            giveawayData.winnersNum = newCount;
            giveawayData.baseWinnersAtStart = newCount;
            giveawayData.effectiveWinnersNum = newCount;
            winnersInput.value = newCount;

            // Host's explicit !winners overrides scaling: drop the cap to N as well,
            // so effective resets to exactly N. Scaling can resume from this new base
            // if more sponsor BON arrives, up to N until the host raises the cap via !maxwinners.
            let capWasReset = false;
            if (giveawayData.scaleWinnersWithSponsors) {
                const prevCap = Math.floor(Number(giveawayData.hostMaxScaledWinners) || newCount);
                giveawayData.hostMaxScaledWinners = newCount;
                capWasReset = prevCap !== newCount;
                if (maxScaledWinnersInput) {
                    maxScaledWinnersInput.min = String(newCount);
                    maxScaledWinnersInput.value = String(newCount);
                }
                // Recompute is a no-op for effective (base === cap === N) but keeps
                // derived state consistent (e.g. syncs the winners display).
                recomputeEffectiveWinners(giveawayData);
            }

            // Update the announcement baseline so future scaling-increase messages
            // count from N, not from the pre-override effective value.
            giveawayData.lastAnnouncedWinners = newCount;
            initializeScaledWinnersAnnouncementState(giveawayData);

            // Public chat announcement when the effective winner count actually changed.
            // Symmetric to the "Winners increased" message scaling sends on its own.
            if (newCount !== prevEffective) {
                const direction = newCount > prevEffective ? "increased" : "decreased";
                const delta = Math.abs(newCount - prevEffective);
                const sign = newCount > prevEffective ? "+" : "−";
                const announcement =
                    `[b][color=${SCALING_ACCENT_COLOR}]Host adjustment:[/color][/b] ` +
                    `[b]Winners ${direction}[/b]: [b][color=#5DE2E7]${prevEffective} → ${newCount} (${sign}${delta})[/color][/b].`;
                sendMessage(announcement);
                flashWinnersUI();
                logEvent("Host adjusted winners", `${prevEffective} -> ${newCount} (${sign}${delta})`);
            }

            const capNote = capWasReset
                ? ` [i][color=#9aa0a6]Scaling cap also reset to ${newCount}. Use !maxwinners to raise.[/color][/i]`
                : "";
            reply(`Number of winners set to [color=#1DDC5D][b]${newCount}[/b][/color].${capNote}`);
            snapshotGiveaway();
        },

        maxwinners(ctx) {
            const { author, args, giveawayData, reply } = ctx;
            if (normalizeUserKey(author) !== normalizeUserKey(giveawayData.host)) return;
            if (!giveawayData.scaleWinnersWithSponsors) {
                reply(`[color=red]Scaling is not enabled for this giveaway.[/color]`);
                return;
            }
            const newMax = parseInt(args[0], 10);
            const baseWinners = Math.max(1, Math.floor(Number(giveawayData.baseWinnersAtStart || giveawayData.winnersNum) || 1));
            if (isNaN(newMax) || newMax < baseWinners || newMax > MAX_WINNERS) {
                reply(`[color=red]Usage:[/color] !maxwinners ${baseWinners}‑${MAX_WINNERS}`);
                return;
            }
            giveawayData.hostMaxScaledWinners = newMax;
            if (maxScaledWinnersInput) maxScaledWinnersInput.value = String(newMax);
            const effective = recomputeEffectiveWinners(giveawayData);
            initializeScaledWinnersAnnouncementState(giveawayData);
            reply(
                `Max scaled winners set to [color=#1DDC5D][b]${newMax}[/b][/color]. ` +
                `Current effective winners: [b][color=#5DE2E7]${effective}[/color][/b].`
            );
            snapshotGiveaway();
        },

        scale(ctx) {
            const { giveawayData, reply } = ctx;
            if (!giveawayData) {
                reply("There is no active giveaway right now.");
                return;
            }
            if (!giveawayData.scaleWinnersWithSponsors) {
                reply("Winner scaling is not enabled for this giveaway.");
                return;
            }

            const state = getScalingProgressState(giveawayData);
            if (!state) {
                reply("Winner scaling is not available for this giveaway.");
                return;
            }

            const extraWinners = state.effectiveWinners - state.baseWinners;
            let msg = `[b][color=${SCALING_ACCENT_COLOR}]Scaling Status:[/color][/b] ` +
                `Winners: [b][color=#5DE2E7]${state.effectiveWinners}[/color][/b] ` +
                `(base ${state.baseWinners}` +
                (extraWinners > 0 ? ` + ${extraWinners} from scaling` : ``) +
                `, max ${state.cap}). ` +
                `Extra-winner threshold: [b]${fmtBONCurrency(state.threshold)} BON[/b] ` +
                `(${state.isCustomThreshold ? "custom" : "auto"}). ` +
                `Scaling contributions: [b][color=#ffc00a]${fmtBONCurrency(state.totalContrib)} BON[/color][/b]. `;

            if (state.effectiveWinners >= state.cap) {
                msg += `[b]Max winners reached[/b].`;
            } else {
                msg +=
                    `Progress to winner #${state.nextWinner}: ` +
                    `[b]${fmtBONCurrency(state.progress)} / ${fmtBONCurrency(state.threshold)} BON[/b]. ` +
                    `Still needed: [b][color=#FFDE59]${fmtBONCurrency(state.remaining)} BON[/color][/b].`;
            }

            reply(msg);
        },

        addtime: hostAdjustTime(+1),
        removetime: hostAdjustTime(-1),

        naughty(ctx) {
            const { author, fancyName, args, giveawayData } = ctx;
            if (!isHostOrAdmin(author, fancyName, giveawayData.host)) return;
            const actionReply = makeStaffAttributedReply(ctx);

            const sub = (args.shift() || "").toLowerCase();
            const target = (args.shift() || "");

            const key = normalizeUserKey(target); // canonical key we store/match on

            switch (sub) {
                case "add": {
                    if (!key) { actionReply("[color=red]Usage:[/color] !naughty add username"); return; }

                    if (key === normalizeUserKey(giveawayData.host)) {
                        actionReply(
                            `[color=red][b]The host can't be added to the naughty list![/b][/color]`
                        );
                        return;
                    }
                    naughtySet.add(key); // save in LS
                    saveNaughty();

                    // remove any existing entry (try exact, then case-insensitive fallback)
                    let removed = false;
                    let removedUser = null;

                    // exact-case fast path (if the host typed the exact casing)
                    if (target && numberEntries.has(target)) {
                        removedUser = target;
                    } else {
                        for (const user of numberEntries.keys()) {
                            if (normalizeUserKey(user) === key) {
                                removedUser = user;
                                break;
                            }
                        }
                    }

                    if (removedUser) {
                        const prevNum = numberEntries.get(removedUser);
                        numberEntries.delete(removedUser);
                        fancyNames.delete(removedUser);
                        if (prevNum !== undefined) numberTakenBy.delete(prevNum);
                        removed = true;
                    }

                    if (removed) { updateEntries(); snapshotGiveaway(); }

                    actionReply(`${bridgeMarker(BRIDGE_MARKERS.NAUGHTY, "👮")} [color=#FFDE59]${fmtUserList([target])} added to the naughty list and removed from the giveaway.[/color]`);
                    break;
                }


                case "remove":
                    if (!key) { actionReply("[color=red]Usage:[/color] !naughty remove username"); return; }
                    naughtySet.delete(key); saveNaughty();
                    actionReply(`🥳 [color=#7DDA58]${fmtUserList([target])} removed from the naughty list![/color]`);
                    break;

                case "list":
                    actionReply(naughtySet.size
                          ? `[color=#FFDE59]Naughty list: [b]${fmtUserList([...naughtySet])}[/b][/color]`
                          : "Naughty list is empty.");
                    break;

                default:
                    actionReply("[color=red]Usage:[/color] !naughty (add|remove|list) username");
            }
        },


        end(ctx) {
            const { author, fancyName, args, giveawayData, reply } = ctx;
            // If host, always allow
            if (normalizeUserKey(author) === normalizeUserKey(giveawayData.host)) {
                logEvent("Giveaway stop requested", `Requested by host ${sanitizeNick(author)} via !end.`);
                endGiveaway();
                return;
            }
            // If staff (not host), require the target host explicitly.
            if (isAdmin(fancyName)) {
                const actionReply = makeStaffAttributedReply(ctx);
                if (!args.length || normalizeUserKey(args[0]) !== normalizeUserKey(giveawayData.host)) {
                    actionReply(`[color=red]Specify the giveaway host to end it. Example: !end ${sanitizeNick(giveawayData.host)}[/color]`);
                    return;
                }
                actionReply(
                    `Ending the giveaway hosted by [b][color=#d85e27]${sanitizeNick(giveawayData.host)}[/color][/b].`
                );
                logEvent("Giveaway stop requested", `Requested by staff ${sanitizeNick(author)} via !end ${sanitizeNick(giveawayData.host)}.`);
                endGiveaway();
            }
        }
    });

    function isHostOrAdmin(author, fancyName, host) {
        return normalizeUserKey(author) === normalizeUserKey(host) || isAdmin(fancyName);
    }

    function showHelp(ctx) {
        const reply = (ctx && typeof ctx.reply === "function") ? ctx.reply : sendMessage;

        const COMMANDS = [
            // Toggleable commands (reflect Settings toggles)
            { name: "random", setting: "disable_random" },
            { name: "lucky", setting: "disable_lucky" },
            { name: "luckye", setting: "disable_lucky" },
            { name: "free", setting: "disable_free" },

            // Always-available commands
            { name: "time", setting: null },
            { name: "entries", setting: null },
            { name: "number", setting: null },
            { name: "bon", setting: null },
            { name: "range", setting: null },
            { name: "scale", setting: null },
            { name: "stats", setting: null },
            { name: "top", setting: null },
            { name: "most", setting: null },
            { name: "sponsors", setting: null },
            { name: "unlucky", setting: null },
            { name: "largest", setting: null },
            { name: "help", setting: null },
            { name: "commands", setting: null },
        ];

        function fmt(cmd, isDisabled) {
            if (isDisabled) {
                // Use strikethrough and gray
                return `![color=#888888][s][b]${cmd}[/b][/s][/color]`;
            }
            // Enabled formatting
            return `![color=#E50E68][b]${cmd}[/b][/color]`;
        }

        const helpText = "Commands are " + COMMANDS.map(({ name, setting }) =>
                                                        fmt(name, setting && GENERAL_SETTINGS[setting])
                                                       ).join(" - ") + ".";
        reply(helpText);
    }


    async function hostAddBon(ctx) {
        const { author, args, giveawayData, reply } = ctx;
        if (normalizeUserKey(author) !== normalizeUserKey(giveawayData.host)) return;

        if (giveawayData?.__sponsorAccountingVerified === false) {
            reply(
                "[b][color=#FFDE59]Sponsor accounting is not verified yet. " +
                "Entries and time controls remain active, but BON pot changes are paused until Gift History reconciliation succeeds.[/color][/b]"
            );
            return;
        }

        if (hostAddBonInFlight) {
            reply("[b][color=#FFDE59]A host BON top-up is already being verified. Please wait a moment.[/color][/b]");
            return;
        }

        const raw = args[0];
        const clean = String(raw ?? "").replace(/[^0-9]/g, "");
        const amount = parseInt(clean, 10);

        if (!Number.isFinite(amount) || amount <= 0) {
            reply("[b][color=red]Invalid usage.[/color] Example: !addbon 100[/b]");
            return;
        }

        // The host's virtual BON is deliberately frozen against sponsor gifts.
        // Reject impossible top-ups locally before spending another DarkPeers request.
        const virtualBon = getHostVirtualBon(giveawayData);
        if (Number.isFinite(virtualBon) && amount > virtualBon) {
            reply(
                `[b][color=red]You only have ${fmtBONCurrency(virtualBon)} virtual BON available to add from your own balance.[/color][/b]`
            );
            return;
        }

        // Serialize the balance check and mutation as one host transaction.
        hostAddBonInFlight = true;
        try {
            const currentBon = await getVerifiedHostBalance({ requireServer: true, maxAgeMs: 0 });
            if (!canMutateActiveGiveaway()) {
                logEvent(
                    "Host BON top-up aborted",
                    "The page lost exclusive giveaway ownership while the balance check was in flight."
                );
                return;
            }
            const currentPot = Math.max(0, Math.floor(Number(giveawayData.amount) || 0));
            const newTotal = currentPot + amount;
    
            if (!Number.isFinite(currentBon) || currentBon == null || currentBon < 0) {
                reply(
                    `[b][color=red]Unable to verify your current BON balance right now. ` +
                    `Please try !addbon again shortly.[/color][/b]`
                );
                return;
            }
    
            if (currentBon < newTotal) {
                reply(
                    `[b][color=red]You only have ${fmtBONCurrency(currentBon)} BON right now, so you can't increase the pot to ${fmtBONCurrency(newTotal)} BON. ` +
                    `Wait for more BON (or sponsor gifts) and try again.[/color][/b]`
                );
                return;
            }
    
            const prevEffectiveWinners = Math.max(
                1,
                Math.floor(Number(giveawayData.effectiveWinnersNum || giveawayData.baseWinnersAtStart || giveawayData.winnersNum) || 1)
            );

            giveawayData.amount = newTotal;

            // ✅ host-only tracking (excludes sponsors)
            giveawayData.hostAdded = (giveawayData.hostAdded || 0) + amount;
            updateHostPanelUI();
    
            const newEffectiveWinners = recomputeEffectiveWinners(giveawayData);
            const winnersDelta = Math.max(0, newEffectiveWinners - prevEffectiveWinners);
            if (winnersDelta > 0) {
                giveawayData.lastAnnouncedWinners = Math.max(
                    newEffectiveWinners,
                    Math.floor(Number(giveawayData.lastAnnouncedWinners || giveawayData.baseWinnersAtStart || 1) || 1)
                );
                flashWinnersUI();
            }
    
            const addedPart = `Host added [color=#DC3D1D][b]${fmtBONCurrency(amount)} BON[/b][/color].`;
            const totalPart = `Total pot: [b][color=#ffc00a]${fmtBONCurrency(Number(cleanPotString(giveawayData.amount)))} BON[/color][/b].`;
            const donationPart = buildDonationContext(giveawayData, { compact: true });
    
            let scalingPart = "";
            if (giveawayData.scaleWinnersWithSponsors) {
                if (winnersDelta > 0) {
                    scalingPart = `[b][color=${SCALING_ACCENT_COLOR}]Scaling:[/color][/b] [b]Winners increased[/b]: [b][color=#5DE2E7]${prevEffectiveWinners} → ${newEffectiveWinners} (+${winnersDelta})[/color][/b].`;
                } else {
                    scalingPart = getSponsorshipNextWinnerLine(giveawayData, { plain: true });
                }
            }
    
            snapshotGiveaway({ force: true });

            const announced = await sendMessage(
                `${bridgeMarker(BRIDGE_MARKERS.POT, "💰")} ` +
                [addedPart, totalPart, donationPart, scalingPart].filter(Boolean).join(" "),
                { requireExclusiveGiveawayOwnership: true }
            );

            if (announced === false) {
                logEvent(
                    "Host BON top-up announcement deferred",
                    `Recorded ${fmtBONCurrency(amount)} BON locally (pot=${fmtBONCurrency(newTotal)} BON), but the chat announcement could not be sent safely.`
                );
            } else {
                logEvent(
                    "Host BON top-up recorded",
                    `Host added ${fmtBONCurrency(amount)} BON | pot=${fmtBONCurrency(newTotal)} BON | verified wallet=${fmtBONCurrency(currentBon)} BON | virtual remaining=${fmtBONCurrency(getHostVirtualBon(giveawayData) ?? 0)} BON`
                );
            }
        } finally {
            hostAddBonInFlight = false;
        }
    }

    function rebuildSchedule() {
        const totalMin = (giveawayData.endTs - Date.now()) / 60000;
        // Use the UI value for number of reminders (clamp if needed)
        let reminderNum = Math.min(Number(remNumInput.value), getReminderLimits(totalMin)[0]);
        if (isNaN(reminderNum) || reminderNum < 0) reminderNum = 0;
        giveawayData.reminderSchedule = getReminderSchedule(totalMin, reminderNum);
        giveawayData.reminderNum = reminderNum;
        // Frequency fields (legacy helpers)
        giveawayData.reminderFreqSec = (reminderNum > 0) ? totalMin * 60 / (reminderNum + 1) : 0;
        giveawayData.nextReminderSec = giveawayData.reminderFreqSec;
        remNumInput.value = reminderNum;
    }

    function hostAdjustTime(sign) {
        // sign = +1 for !addtime / !time add, -1 for !removetime / !time remove
        return (ctx) => {
            const { author, fancyName, args, giveawayData } = ctx;
            if (!isHostOrAdmin(author, fancyName, giveawayData.host)) return;
            const actionReply = makeStaffAttributedReply(ctx);

            const mins = parseFloat(args[0]);
            if (isNaN(mins) || mins <= 0) {
                actionReply(
                    "[color=red]Usage:[/color] !time add|remove <minutes> or !addtime|!removetime <minutes>"
                );
                return;
            }

            const deltaMs = sign * mins * 60_000;
            giveawayData.endTs += deltaMs; // move the deadline

            rebuildSchedule(); // rebuild reminder schedule

            giveawayData.timeLeft = Math.max(
                Math.ceil((giveawayData.endTs - Date.now()) / 1000),
                0
            );
            countdownHeader.textContent = parseTime(giveawayData.endTs - Date.now());

            const verb = sign > 0 ? "Added" : "Removed";
            const prep = sign > 0 ? "to" : "from";

            actionReply(
                `${verb} [color=#DC3D1D][b]${mins}[/b][/color] minute${mins === 1 ? "" : "s"} ${prep} the giveaway. ` +
                `New time left: [b][color=#1DDC5D]${parseTime(
                    giveawayData.endTs - Date.now()
                )}[/color][/b].`
            );
            snapshotGiveaway();
        };
    }

    // ───────────────────────────────────────────────────────────
