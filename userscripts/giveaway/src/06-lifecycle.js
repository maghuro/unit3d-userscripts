    // SECTION 6: Giveaway Lifecycle
    // ───────────────────────────────────────────────────────────

    // The opening POST has a 7s HTTP timeout. Allow limited transport overhead
    // for recovering an ambiguous result, but NEVER accept an announcement
    // sent minutes/hours later as this giveaway's opening.
    const OPENING_POST_MAX_PUBLICATION_WINDOW_MS = 10000;

    // Unique live-opening proof encoded as non-rendering Unicode code points
    // already observed surviving DarkPeers chat HTML and bridge markers.
    function createOpeningProofMarker() {
        if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return null;
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        const bits = Array.from(bytes, b =>
            Array.from({ length: 8 }, (_, i) =>
                (b & (1 << (7 - i))) ? "\u200B" : "\u2063"
            ).join("")
        ).join("");
        return "\u2063\u200B\u2063\u200B" + bits + "\u200B\u2063\u200B\u2063";
    }

    // Reconcile an opening announcement against authoritative Main Chat history.
    // An HTTP timeout is NOT evidence the server rejected the POST. Never
    // release a pending opening snapshot merely because sendMessage returned
    // false; an announced giveaway may already exist publicly.
    // UNIT3D returns HTML (with JoyPixels images) for BBCode chat announcements.
    // Its second-resolution timestamps cannot fit inside a millisecond POST.
    async function verifyPendingGiveawayOpening(checkpoint) {
        if (!checkpoint ||
            (checkpoint.status !== "pending" && checkpoint.status !== "confirmed") ||
            !checkpoint.preparedMessage || !Number.isFinite(Number(checkpoint.startedAt))) {
            return null;
        }
        const afterId = optionalFiniteNumber(checkpoint.afterMessageId);
        if (!Number.isSafeInteger(afterId) || afterId <= 0) return null;
        const startedAt = Number(checkpoint.startedAt);
        const persistedHardEnd = optionalFiniteNumber(checkpoint.windowEndAt);
        const completedAt = optionalFiniteNumber(checkpoint.sendCompletedAt);
        const absoluteHardEnd = startedAt + OPENING_POST_MAX_PUBLICATION_WINDOW_MS;
        const windowEnd = Math.min(
            absoluteHardEnd,
            persistedHardEnd === null ? absoluteHardEnd : persistedHardEnd,
            completedAt === null ? absoluteHardEnd : completedAt
        );
        if (!Number.isFinite(startedAt) || !Number.isFinite(windowEnd) ||
            windowEnd <= startedAt) return null;
        const senderId = Math.floor(Number(OT_USER_ID));
        if (!Number.isSafeInteger(senderId) || senderId <= 0) return null;
        const decodeEntities = value => String(value).replace(
            /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
            (entity, token) => {
                const t = token.toLowerCase();
                if (t[0] === "#") {
                    const isHex = t[1] === "x";
                    const n = Number.parseInt(t.slice(isHex ? 2 : 1), isHex ? 16 : 10);
                    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff &&
                        !(n >= 0xd800 && n <= 0xdfff)
                        ? String.fromCodePoint(n) : entity;
                }
                return ({amp: "&", lt: "<", gt: ">", quot: '"',
                    apos: "'", nbsp: " "})[t] || entity;
            }
        );
        const canonical = (value, rendered) => {
            let content = String(value ?? "");
            if (rendered) {
                content = content.replace(/<img\b[^>]*>/gi, tag => {
                    const alt = tag.match(/\balt\s*=\s*(["'])([\s\S]*?)\1/i);
                    return alt ? alt[2] : "\uFFFD";
                }).replace(/<br\s*\/?>/gi, "\n")
                    .replace(/<\/(?:p|div)>/gi, "\n")
                    .replace(/<[^>]*>/g, "");
            } else {
                content = content.replace(
                    /\[(?:\/)?(?:b|i|u|s|color(?:=[^\]]*)?|size(?:=[^\]]*)?|url(?:=[^\]]*)?)\]/gi,
                    ""
                );
            }
            return decodeEntities(content).replace(/[\s\u00a0]+/g, "");
        };
        const proof = checkpoint.openingProof;
        const hasUniqueProof = typeof proof === "string" &&
            /^\u2063\u200B\u2063\u200B[\u2063\u200B]{128}\u200B\u2063\u200B\u2063$/.test(proof) &&
            checkpoint.preparedMessage.endsWith(proof);
        const expected = canonical(checkpoint.preparedMessage, false);
        if (!expected) return null;
        const expectedHost = String(checkpoint.host ||
            (typeof getLoggedInUsername === "function" ? getLoggedInUsername() : "")
        ).trim().replace(/^@/, "").toLowerCase();

        for (let attempt = 0; attempt < 3; attempt++) {
            if (!ownsTabLock()) return null;
            try {
                const url = new URL("/api/chat/messages/" + DARKPEERS_MAIN_CHATROOM_ID, location.origin);
                url.searchParams.set("after_id", String(afterId));
                const response = await fetchWithTimeout(
                    url, { credentials: "include", cache: "no-store" }, 5000
                );
                if (!ownsTabLock()) return null;
                if (!response?.ok) throw new Error("Opening verification chat read failed");
                const payload = await response.json();
                if (!ownsTabLock()) return null;
                if (!Array.isArray(payload?.data)) throw new Error("Malformed Main Chat messages");
                const matches = [];
                // Track every matching announcement after the pre-send cursor,
                // including posts OUTSIDE the permitted timestamp interval.
                // Otherwise an out-of-window duplicate could be silently
                // discarded, leaving a misleading single valid candidate.
                const matchingAnnouncementIds = new Set();
                for (const message of payload.data) {
                    const id = optionalFiniteNumber(message?.id);
                    if (!Number.isSafeInteger(id) || id <= afterId) continue;
                    if (checkpoint.status === "confirmed" &&
                        id !== optionalFiniteNumber(checkpoint.messageId)) continue;
                    const knownAuthorIds = [
                        message?.user_id, message?.user?.id,
                        message?.sender?.id, message?.author?.id
                    ].filter(v => v != null && v !== "").map(Number)
                        .filter(v => Number.isSafeInteger(v) && v > 0);
                    if (knownAuthorIds.length) {
                        if (knownAuthorIds.some(authorId => authorId !== senderId)) continue;
                    } else {
                        const serverName = String(
                            message?.user?.username ?? message?.user?.name ??
                            message?.author?.username ?? message?.username ?? ""
                        ).trim().replace(/^@/, "").toLowerCase();
                        if (!expectedHost || serverName !== expectedHost) continue;
                    }
                    if (canonical(message?.message, true) !== expected) continue;
                    matchingAnnouncementIds.add(id);
                    const rawTs = String(message?.created_at || "");
                    const timestamp = Date.parse(rawTs);
                    const resolutionMs = unit3dTimestampResolutionMs(rawTs);
                    if (!Number.isFinite(timestamp) ||
                        !Number.isFinite(resolutionMs) || resolutionMs <= 0) continue;
                    const whollyInside =
                        !(timestamp < startedAt || (timestamp + resolutionMs) > windowEnd);
                    const overlapsAttempt =
                        timestamp < windowEnd && timestamp + resolutionMs > startedAt;
                    // A positive HTTP status alone does not identify a returned
                    // same-second announcement. Require a unique random marker
                    // persisted before POST. Legacy openings remain fail-closed.
                    if (!whollyInside &&
                        !(hasUniqueProof && overlapsAttempt &&
                            canonical(message?.message, true).endsWith(proof))) continue;
                    matches.push({
                        messageId: id,
                        sponsorStartTs: Math.max(startedAt, timestamp + resolutionMs)
                    });
                }
                // Reconcile only when there is ONE candidate across the
                // entire returned Main Chat history, not just one within the
                // timestamp window. This cannot establish uniqueness for an
                // announcement already evicted by the fixed 100-message limit.
                if (matchingAnnouncementIds.size > 1) return null;
                if (matches.length === 1) return matches[0];
                if (matches.length > 1) return null;

                // UNIT3D's GET /api/chat/messages/{room} returns only the last
                // configured chat.message_limit messages (currently 100) and
                // does not implement pagination or the after_id query parameter.
                // A previously CONFIRMED opening with a durable random proof
                // becomes older than that window during busy chats. When a
                // complete healthy latest-page has advanced beyond its saved
                // message ID, retain that earlier confirmation. Never apply
                // this shortcut to a pending, legacy or still-in-range opening.
                const confirmedId = optionalFiniteNumber(checkpoint.messageId);
                const pageIds = payload.data.map(message =>
                    optionalFiniteNumber(message?.id)
                );
                if (checkpoint.status === "confirmed" && hasUniqueProof &&
                    Number.isSafeInteger(confirmedId) && confirmedId > afterId &&
                    pageIds.length >= 100 && pageIds.every(id =>
                        Number.isSafeInteger(id) && id > 0
                    ) && Math.min(...pageIds) > confirmedId) {
                    return { messageId: confirmedId, historyEvicted: true };
                }
            } catch (error) {
                console.warn("[BON Giveaway] Opening reconciliation deferred:", error);
            }
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700));
        }
        return null;
    }

    async function startGiveaway() {
        clearWinnersStatusUI();

        const maxScaledValid = validateMaxScaledWinnersInput({ forceMessage: true });
        if (scaleWinnersToggleInput && scaleWinnersToggleInput.checked && !maxScaledValid) {
            if (maxScaledWinnersInput) maxScaledWinnersInput.focus();
            return;
        }

        // Validate in code, not just through the HTML max attribute: DevTools,
        // presets or scripted property changes cannot start a longer giveaway.
        const totalTimeMin = parseGiveawayMinutes(timerInput?.value);
        if (totalTimeMin === null) {
            window.alert(`DarkPeers giveaways must last between 1 and ${MAX_GIVEAWAY_MINUTES} whole minutes.`);
            timerInput?.focus();
            return;
        }

        if (!giveawayForm.checkValidity()) {
            giveawayForm.reportValidity();
            return;
        }

        // DarkPeers renders richer BBCode (quote/code/img etc.) to HTML whose
        // text cannot be compared 1:1 to the original markup. Reject those
        // custom inputs BEFORE a LIVE public POST, never after announcing it.
        const customStartText = String(customMessageInput?.value || "");
        const inlineTags = new Set(["b", "i", "u", "s", "color", "size", "url"]);
        const unsupportedTag = [...customStartText.matchAll(/\[\/?([a-z][a-z0-9]*)(?:=[^\]]*)?\]/gi)]
            .find(match => !inlineTags.has(match[1].toLowerCase()));
        if (unsupportedTag || /<\/?[a-z][^>]*>/i.test(customStartText)) {
            window.alert("GIVEAWAY ERROR: Custom message contains unsupported BBCode/HTML. " +
                "Remove the markup before starting. Nothing was posted.");
            customMessageInput?.focus();
            return;
        }

        // Never overwrite a recoverable opening whose public POST was ambiguous.
        // The pending snapshot is the only path to reconcile entrants/sponsors
        // after a reload. A second start could otherwise destroy that evidence.
        // Pre-lock validation is read-only. Any migration of a legacy key
        // happens only after exclusive ownership has been acquired.
        const prior = readActiveGiveawayRawForHost(getLoggedInUsername(), {
            migrateLegacy: false
        });
        // localStorage failures must block starts, never look like absence.
        if (!prior.readOk || !prior.storageKey) {
            window.alert("GIVEAWAY START BLOCKED: Cannot read recovery storage reliably. No opening was posted.");
            return;
        }
        if (prior.hasStoredState) {
            try {
                const saved = JSON.parse(prior.raw);
                const proof = saved?.giveawayData?.openingCheckpoint;
                if (saved?.giveawayData && (!proof || proof.status !== "confirmed" ||
                    !Number.isFinite(Number(saved.giveawayData.openedAt)) ||
                    Number(saved.giveawayData.openedAt) <= 0 ||
                    !Number.isFinite(Number(saved.giveawayData.sponsorStartTs)) ||
                    Number(saved.giveawayData.sponsorStartTs) <
                        Number(saved.giveawayData.openedAt))) {
                    window.alert(
                        "GIVEAWAY START BLOCKED: A saved opening still requires " +
                        "verification or manual review. The original recovery " +
                        "snapshot must not be overwritten by a new giveaway."
                    );
                    return;
                }
            } catch {
                // Unknown existing recovery data must not be overwritten.
                window.alert("GIVEAWAY START BLOCKED: Existing recovery data could not be read safely.");
                return;
            }
        }

        clearGiveawayLog();

        // Normalize and validate the giveaway amount separately so we tolerate
        // locale-specific separators like ' . , non-breaking spaces, etc.
        const rawAmount = coinInput.value;
        const cleanValue = rawAmount.replace(/[^0-9]/g, '');
        if (!cleanValue) {
            window.alert("Please enter a valid numeric giveaway amount.");
            return;
        }
        const amountInt = parseInt(cleanValue, 10);
        if (!Number.isFinite(amountInt) || amountInt <= 0) {
            window.alert("Please enter a giveaway amount greater than zero.");
            return;
        }

        const requestedWinners = Math.max(1, Math.min(MAX_WINNERS, parseInt(winnersInput.value, 10) || 1));
        const minimumPotForRequestedWinners = minimumPotForWeightedWinners(requestedWinners);
        if (amountInt < minimumPotForRequestedWinners) {
            window.alert(
                `GIVEAWAY ERROR: ${fmtBON(requestedWinners)} weighted winner(s) need a pot of at least ` +
                `${fmtBONCurrency(minimumPotForRequestedWinners)} BON so every winner receives at least 1 BON.`
            );
            return;
        }

        // Claim ownership BEFORE mutating UI/state. Never steal a fresh lock from
        // another tab: that is the primary cross-tab double-payout defence.
        if (!await acquireTabLock()) {
            window.alert("Could not acquire exclusive giveaway ownership. Another DarkPeers tab may already be running a giveaway, or this browser does not provide the Web Locks safety API.");
            return;
        }

        // The check above ran BEFORE ownership was acquired. Two tabs can
        // both see empty storage; the second may acquire the lock only after
        // the first has posted (or checkpointed) an ambiguous opening. Read
        // storage AGAIN while owning the lock. Any remaining snapshot is
        // recoverable state and must not be replaced by a second opening.
        const savedAfterLock = readActiveGiveawayRawForHost(getLoggedInUsername(), {
            migrateLegacy: true
        });
        if (!savedAfterLock.readOk || savedAfterLock.hasStoredState || !savedAfterLock.storageKey) {
            logEvent("Start blocked (post-lock recovery recheck)",
                "Saved giveaway state appeared while awaiting the exclusive lock; no new opening was posted.");
            window.alert(
                "GIVEAWAY START BLOCKED: A previous giveaway was saved while " +
                "waiting for this tab's lock. Recover or resolve it before " +
                "starting another. No new opening has been posted."
            );
            releaseTabLock();
            return;
        }

        if (sponsorsInterval) { clearInterval(sponsorsInterval); sponsorsInterval = null; }
        if (observer) { observer.disconnect(); observer = null; }

        if (chatbox == null) {
            chatbox = document.querySelector(`#${chatboxId}`);
        }

        cacheChatContext();

        // DarkPeers is the sole production target. Fail closed before creating any
        // giveaway state unless the authenticated identity + Main Chat API context
        // match the live DarkPeers contract that was verified during the incident
        // audit. Starting without this context would make commands/output unreliable.
        const authenticatedHost = getLoggedInUsername();
        const authenticatedUserId = Math.floor(Number(OT_USER_ID));
        const publicChatroomId = Math.floor(Number(OT_CHATROOM_ID));
        const expectedMainChatroomId = Math.floor(Number(DARKPEERS_MAIN_CHATROOM_ID));
        const startContextOk =
            !!authenticatedHost &&
            Number.isFinite(authenticatedUserId) &&
            authenticatedUserId > 0 &&
            Number.isFinite(publicChatroomId) &&
            publicChatroomId === expectedMainChatroomId &&
            !!OT_CSRF_TOKEN;

        if (!startContextOk) {
            logEvent(
                "Start aborted (DarkPeers chat context)",
                `host=${authenticatedHost || "missing"} | userId=${Number.isFinite(authenticatedUserId) ? authenticatedUserId : "missing"} | mainRoom=${Number.isFinite(publicChatroomId) ? publicChatroomId : "missing"} | expectedRoom=${expectedMainChatroomId} | csrf=${OT_CSRF_TOKEN ? "present" : "missing"}`
            );
            releaseTabLock();
            window.alert(
                "GIVEAWAY ERROR: DarkPeers authentication/Main Chat context could not be verified. " +
                "Nothing was started or posted. Reload DarkPeers and try again."
            );
            return;
        }

        startButton.disabled = true;
        coinInput.disabled = true;
        startInput.disabled = true;
        endInput.disabled = true;
        timerInput.disabled = true;
        customMessageInput.disabled = true;
        if (donationPercentInput) donationPercentInput.disabled = true;
        winnersInput.disabled = true;
        scaleWinnersToggleInput.disabled = true;
        maxScaledWinnersInput.disabled = true;
        if (scaleBonPerWinnerInput) scaleBonPerWinnerInput.disabled = true;
        remNumInput.disabled = true;
        reminderEvery.disabled = true;

        //startButton.parentElement.hidden = true;
        entriesWrapper.hidden = false;

        const totalTimeMs = totalTimeMin * 60000;
        let reminderNum = Math.min(Number(remNumInput.value), getReminderLimits(totalTimeMin)[0]);
        if (isNaN(reminderNum) || reminderNum < 0) reminderNum = 0;
        const schedule = getReminderSchedule(totalTimeMin, reminderNum);
        const cadenceSec = (reminderNum > 0) ? totalTimeMin * 60 / (reminderNum + 1) : 0;
        let winnersNum = requestedWinners;
        const scaleWinnersWithSponsors = !!(scaleWinnersToggleInput && scaleWinnersToggleInput.checked);
        const hostMaxScaledWinners = scaleWinnersWithSponsors
        ? Math.floor(Number(maxScaledWinnersRawValue || maxScaledWinnersInput.value) || winnersNum)
        : getClampedMaxScaledWinnersValue(winnersNum);

        // Custom scaling threshold (null = auto-calculate from starting pot / base winners).
        // The UI is auto-populated for convenience, so the numeric field having a value
        // does NOT by itself mean the host chose a custom threshold.
        const customBonPerWinner = scaleBonPerWinnerInput ? parseInt(scaleBonPerWinnerInput.value, 10) : NaN;
        const scaleBonPerWinner = (
            scaleWinnersWithSponsors &&
            bonPerWinnerManuallyEdited &&
            Number.isFinite(customBonPerWinner) &&
            customBonPerWinner > 0
        )
            ? customBonPerWinner
            : null;

        giveawayData = {
            rehearsalMode: REHEARSAL_MODE,
            host: authenticatedHost,
            amount: amountInt,
            startNum: parseInt(startInput.value, 10),
            endNum: parseInt(endInput.value, 10),
            totalEntries: parseInt(endInput.value, 10) - parseInt(startInput.value, 10) + 1,
            winningNumber: null,
            totalSeconds: totalTimeMs / 1000,
            openedAt: null,
            timeLeft: totalTimeMs / 1000,
            endTs: Date.now() + (totalTimeMs),
            winnersNum,
            baseWinnersAtStart: winnersNum,
            effectiveWinnersNum: winnersNum,
            scaleWinnersWithSponsors,
            hostMaxScaledWinners,
            scaleBonPerWinner,
            customMessage: customMessageInput.value,
            donationPercent: normalizeDonationPercent(donationPercentInput ? donationPercentInput.value : 0),
            hostAdded: amountInt,
            hostWalletAtStart: null,
            initialPotVerifiedAtStart: amountInt,
            reminderSchedule : schedule,
            reminderNum      : schedule.length,
            reminderFreqSec  : cadenceSec, // <- kept for legacy helpers
            nextReminderSec  : cadenceSec, // <- ditto (first reminder ETA)
            sponsorContribs: {},
            sponsors: [],
            sponsorGiftMessages: [],
        };
        lastKnownGiveawayHostKey = normUserKey(giveawayData.host) || lastKnownGiveawayHostKey;

        updateRigToggleUI();
        const currentBon = await getVerifiedHostBalance({ requireServer: true, maxAgeMs: 0 });
        // A pagehide while preflight was awaiting balance invalidates this
        // document. Don't continue into the public opening workflow.
        if (!ownsTabLock()) return;

        if (currentBon == null) {
            const startErr = "Unable to verify current BON balance.";
            logEvent("Start aborted", startErr);
            window.alert(
                "GIVEAWAY ERROR: Unable to verify your current BON balance right now. Please try again shortly."
            );
            resetGiveaway();
            return;
        }

        if (currentBon < giveawayData.amount) {
            const startErr = `Entered amount ${fmtBONCurrency(giveawayData.amount)} exceeds current BON ${fmtBONCurrency(currentBon)}.`;
            logEvent("Start aborted", startErr);
            window.alert(
                `GIVEAWAY ERROR: The amount entered (${giveawayData.amount}), is above your current BON (${currentBon}).`
            );
            resetGiveaway();
            return;
        }
        else {
            // Freeze the host's own pre-giveaway wallet. Sponsor gifts increase the
            // real DarkPeers wallet and the giveaway pot together, but must not make
            // the host appear to have more personal BON available to commit.
            giveawayData.hostWalletAtStart = Math.max(0, Math.floor(currentBon));
            giveawayData.initialPotVerifiedAtStart = giveawayData.amount;
            recomputeEffectiveWinners(giveawayData);
            initializeScaledWinnersAnnouncementState(giveawayData);
            logEvent(
                "Giveaway started",
                `Host=${sanitizeNick(giveawayData.host)} | Host-funded=${fmtBONCurrency(giveawayData.initialPotVerifiedAtStart)} BON | Base winners=${fmtBON(giveawayData.baseWinnersAtStart)} | Time=${fmtBON(totalTimeMin)} min | ${BONANZA.FUND_NAME}=${giveawayData.donationPercent}% | Flags: silent=${GENERAL_SETTINGS.silent_mode ? "on" : "off"}, rigged=${riggedMode ? "on" : "off"}, scale=${giveawayData.scaleWinnersWithSponsors ? "on" : "off"}${giveawayData.scaleWinnersWithSponsors ? `, max winners=${fmtBON(giveawayData.hostMaxScaledWinners)}` : ""}`
            );
            // The winning number is deliberately NOT drawn here. It is generated
            // only when endGiveaway() commits to payout, so DevTools/localStorage
            // cannot reveal the result while entries are still open.

            window.onbeforeunload = function (e) {
                try {
                    flushStatsNow();
                    if (giveawayData && !giveawayData.__ending) snapshotGiveaway();
                } catch {}
                e.preventDefault();
                e.returnValue = "";
                return "";
            };

            const donationPct = normalizeDonationPercent(giveawayData.donationPercent);
            const startMarker = donationPct > 0
                ? (riggedMode ? BRIDGE_MARKERS.START_TAXES : BRIDGE_MARKERS.START_POOL)
                : BRIDGE_MARKERS.START;
            const introHeader = donationPct > 0
                ? (riggedMode
                    ? `${bridgeMarker(startMarker, "🎁")} [b][color=#FF4F9A]RIGGING TAXES: ${donationPct}% TO THE ${BONANZA.FUND_NAME.toUpperCase()}[/color][/b]\nI am hosting a giveaway for `
                    : `${bridgeMarker(startMarker, "🎁")} 💙 [b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME.toUpperCase()} CONTRIBUTION GIVEAWAY[/color][/b] 💙\nI am hosting a giveaway for `)
                : `${bridgeMarker(startMarker, "🎁")} I am hosting a giveaway for `;
            const donationIntroLine = donationPct > 0
                ? (riggedMode
                    ? `\n[b][color=#FF4F9A]${donationPct}% rigging tax[/color][/b] will be taken from the final pot (including sponsor gifts) and paid directly into the [b]${BONANZA.FUND_NAME}[/b]. Winners keep the remaining ${100 - donationPct}%. Entirely legitimate accounting. 😈`
                    : `\n[b][color=${BONANZA.GIVEAWAY_COLOR}]${donationPct}%[/color][/b] of the final pot (including sponsor gifts) will be contributed directly to the [b]${BONANZA.FUND_NAME}[/b]. Winners receive the remaining ${100 - donationPct}%.`)
                : "";

            let introMessage = `${introHeader}[b][color=#ffc00a]${fmtBONCurrency(giveawayData.amount)} BON[/color][/b] | ` +
                `${buildWinnersAnnouncementLine(giveawayData)} | ` +
                `Open for [b][color=#1DDC5D]${parseTime(totalTimeMs)}[/color][/b]. ` +
                `Pick a number [b]between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color][/b]. ` +
                `[b][color=#5DE2E7]${giveawayData.customMessage}[/color][/b]` +
                donationIntroLine + `\n` +
                `✨[b][color=#FB4F4F]Gift the host to add to the pot! [color=${GIFT_HINT_COLOR}]/gift ${getGiftSyntaxHostName()} AMOUNT MESSAGE[/color][/color][/b]✨`;

            if (riggedMode) {
                introMessage += `\n[color=#FF4F9A][b]RIGGED MODE ENGAGED![/b][/color] ` +
                    `[i][color=#FF9AE6]Visual flair only. The math is still fair... probably.[/color][/i] 😈`;
            }

            if (GENERAL_SETTINGS.silent_mode) {
                introMessage += `\n[color=#ff3333][b]SILENT MODE ENABLED![/b][/color] ` +
                    `[i][color=#B0B0B0]Command replies will be sent privately via /msg.[/color][/i] 🤫`;
            }

            if (window.__activeTracker) window.__activeTracker = null;
            let tracker = new SponsorTracker({
                chatroomId,
                giveawayStartTime: new Date(),
                giveawayData
            });
            const sponsorBaselineReady = await tracker.bootstrapGiftHistory();
            if (!ownsTabLock()) return;
            if (!sponsorBaselineReady) {
                logEvent(
                    "Start aborted (Gift History baseline)",
                    "Persistent DarkPeers Gift History could not be read/calibrated before opening. Refusing to start with volatile System-room fallback only."
                );
                window.alert(
                    "GIVEAWAY ERROR: DarkPeers Gift History could not be prepared reliably. " +
                    "No giveaway has been opened. Try again when DarkPeers is responding normally."
                );
                resetGiveaway();
                return;
            }

            // Read a Main Chat cursor BEFORE preparing the durable checkpoint.
            // UNIT3D may ignore after_id; the verifier also filters by author,
            // exact prepared message and publication-time window.
            const afterMessageId = REHEARSAL_MODE
                ? null : await getLatestChatMessageId(DARKPEERS_MAIN_CHATROOM_ID);
            if (!ownsTabLock()) return;
            if (!REHEARSAL_MODE &&
                (!Number.isSafeInteger(afterMessageId) || afterMessageId <= 0)) {
                logEvent("Opening blocked (Main Chat cursor)",
                    "Unable to obtain a trustworthy pre-send Main Chat message ID. No opening was posted.");
                window.alert(
                    "GIVEAWAY ERROR: Cannot verify the latest Main Chat message. " +
                    "Nothing has been posted. Please try again when DarkPeers is responding."
                );
                resetGiveaway();
                return;
            }

            // Deadline: conservative PRE-SEND time. Sponsorship: independently
            // verified PUBLICATION time (never the earlier request timestamp).
            const openingSendStartedAt = Date.now();
            const openingProof = REHEARSAL_MODE ? null : createOpeningProofMarker();
            if (!REHEARSAL_MODE && !openingProof) {
                window.alert("GIVEAWAY ERROR: Secure opening proof unavailable. No message was posted.");
                resetGiveaway();
                return;
            }
            const preparedOpening = prepareOutgoingMessage(introMessage) + (openingProof || "");
            giveawayStartTime = new Date(openingSendStartedAt);
            giveawayData.openedAt = openingSendStartedAt;
            giveawayData.endTs = openingSendStartedAt + totalTimeMs;
            giveawayData.__sponsorAccountingVerified = false;
            giveawayData.openingCheckpoint = {
                status: "pending",
                host: giveawayData.host,
                openingProof,
                sendAcknowledged: false,
                startedAt: openingSendStartedAt,
                afterMessageId,
                windowEndAt: openingSendStartedAt + OPENING_POST_MAX_PUBLICATION_WINDOW_MS,
                preparedMessage: preparedOpening
            };
            window.__activeTracker = tracker;
            // If this write/read-back fails, DO NOT send anything publicly.
            if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                logEvent("Opening blocked", "Could not persist the opening checkpoint before posting.");
                window.alert("GIVEAWAY ERROR: Unable to save the opening recovery checkpoint. No message was sent.");
                resetGiveaway();
                return;
            }

            const introSent = await sendMessage(preparedOpening, {
                prepared: true,
                requireExclusiveGiveawayOwnership: true,
                noFallbackOnApiException: true
            });
            if (!ownsTabLock()) return;
            // Constrain reconciliation to the ACTUAL time of completion if
            // this document survived the POST. If it did not, recovery uses
            // the previously persisted bounded upper limit instead.
            giveawayData.openingCheckpoint.sendCompletedAt = Date.now();
            giveawayData.openingCheckpoint.sendAcknowledged = introSent === true;
            if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                logEvent("Opening delivery checkpoint not durable",
                    "Could not preserve the end of the opening attempt; recovery remains pending.");
                window.alert("GIVEAWAY OPENING PAUSED: Delivery timing could not be stored. Reload to retry verification.");
                releaseTabLock();
                return;
            }

            // Rehearsal announcements deliberately go to a private host message;
            // real openings require authoritative Main Chat confirmation.
            const verifiedOpening = introSent !== false && REHEARSAL_MODE
                ? { messageId: null, sponsorStartTs: openingSendStartedAt }
                : await verifyPendingGiveawayOpening(giveawayData.openingCheckpoint);

            if (!verifiedOpening) {
                logEvent("Opening unconfirmed (checkpoint retained)",
                    "Main Chat publication could not be verified; payout and sponsor tracking remain disabled until recovery verifies the exact opening.");
                window.alert(
                    "GIVEAWAY OPENING UNCONFIRMED: The opening message might already be public. " +
                    "A recovery checkpoint was saved. Reload Main Chat to retry verification. " +
                    "Do NOT start another giveaway or send BON manually."
                );
                // Keep the snapshot. Never reset or re-send an ambiguous opening.
                releaseTabLock();
                return;
            }

            giveawayData.sponsorStartTs = verifiedOpening.sponsorStartTs;
            giveawayData.openingCheckpoint.status = "confirmed";
            giveawayData.openingCheckpoint.messageId = verifiedOpening.messageId;
            tracker.giveawayStartTs = verifiedOpening.sponsorStartTs;
            syncGiveawayTimeLeft(giveawayData);
            if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                logEvent("Opening confirmation not durable", "Recovery checkpoint retained; settlement remains blocked.");
                window.alert("GIVEAWAY OPENING PAUSED: Confirmed opening could not be saved. Reload to recover.");
                releaseTabLock();
                return;
            }

            // The pre-send checkpoint deliberately starts with accounting
            // disabled. Once publication has been verified, reconcile the
            // canonical Gift History BEFORE re-enabling pot mutations. Otherwise
            // !addbon stays blocked forever on a fresh, otherwise healthy start.
            try {
                await tracker.reconcileCanonicalSponsorAccounting({ repairStats: false });
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    throw new Error("Opening sponsor reconciliation snapshot did not persist");
                }
                setSponsorAccountingVerificationState(
                    true, "Opening and canonical Gift History sponsor boundary verified."
                );
            } catch (error) {
                setSponsorAccountingVerificationState(
                    false, "Sponsor reconciliation deferred after public opening: " +
                    String(error?.message || error)
                );
                scheduleSponsorAccountingRecovery(tracker);
            }

            if (giveawayData.__sponsorAccountingVerified === true) {
                try { await tracker.poll(); } catch (error) { console.error(error); }
                sponsorsInterval = setInterval(
                    () => tracker.poll(), SPONSOR_GIFT_HISTORY_POLL_MS
                );
            }

            chatReplayIgnoreBeforeTs = null;
            if (observer) {
                startObserver();
            } else {
                addObserver(giveawayData);
            }

            giveawayData.countdownTimerID = countdownTimer(countdownHeader, giveawayData);

            giveawayData.potUpdater = setInterval(() => {
                coinHeader.innerHTML = `${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON`;
                coinHeader.prepend(goldCoins.cloneNode(false));
            }, 5000);

            // Start button → Stop button wiring stays the same...
        }

        // ** TOGGLE BUTTON TO STOP **
        startButton.textContent = "Stop";
        startButton.style.backgroundColor = "#b32525"; // red to indicate Stop
        startButton.title = "This will end the giveaway and send gifts to the winners";
        startButton.disabled = false;
        startButton.onclick = () => {
            logEvent("Giveaway stop requested", "Requested from UI Stop button.");
            endGiveaway();
        };

        // Persist giveaway state so it can survive a page reload
        snapshotGiveaway();

        updateHostPanelUI();
    }

    function resetGiveaway() {
        if (hasIncompleteSettlement(giveawayData)) {
            logEvent(
                "Reset blocked (settlement incomplete)",
                "Refusing to clear active recovery state while settlement is incomplete."
            );
            try {
                window.alert(
                    "Reset blocked: this giveaway still has an incomplete settlement. " +
                    "The recovery state has been preserved."
                );
            } catch {}
            return false;
        }

        entriesWrapper.hidden = true;
        clearWinnersStatusUI();

        countdownHeader.textContent = "";
        countdownHeader.hidden = true;
        startButton.parentElement.hidden = false;

        coinInput.disabled = false;
        startInput.disabled = false;
        endInput.disabled = false;
        timerInput.disabled = false;
        customMessageInput.disabled = false;
        if (donationPercentInput) donationPercentInput.disabled = false;
        winnersInput.disabled = false;
        scaleWinnersToggleInput.disabled = false;
        remNumInput.disabled = false;
        reminderEvery.disabled = false;

        giveawayForm.reset()
        if (donationPercentInput) {
            donationPercentInput.value = String(normalizeDonationPercent(localStorage.getItem(LS_DONATION_PERCENT)));
            updateDonationHint();
        }
        updateScaleWinnersControls();
        if (maxScaledWinnersDebounceTimer) {
            clearTimeout(maxScaledWinnersDebounceTimer);
            maxScaledWinnersDebounceTimer = null;
        }
        maxScaledWinnersRawValue = String(maxScaledWinnersInput?.value || winnersInput?.value || "1");
        setMaxScaledWinnersError("");
        updateStartButtonState();

        stopGiveaway();

        updateEntries();

        // Restore host balance display
        const hostBalance = readHostBalance();

        // update the header
        coinHeader.textContent = `${fmtBONCurrency(hostBalance)} BON`;
        coinHeader.prepend(goldCoins.cloneNode(false));


        // ** RESET BUTTON TO START **
        startButton.textContent = "Start";
        startButton.style.backgroundColor = "#02B008"; // green for Start
        startButton.title = "Start the giveaway";
        startButton.onclick = startGiveaway;
        startButton.disabled = false;

        updateHostPanelUI();
        return true;
    }

    function stopGiveaway() {
        if (hasIncompleteSettlement(giveawayData)) {
            logEvent(
                "Stop cleanup blocked (settlement incomplete)",
                "Refusing to clear snapshot/ledgers before the settlement reaches phase=complete."
            );
            return false;
        }

        startButton.disabled = true; //prevents stop button from being clicked once giveaway has ended
        // Flush any pending stats writes before tearing down
        try { flushStatsNow(); } catch {}

        // Clear persisted giveaway state (giveaway is ending normally)
        clearGiveawaySnapshot();
        releaseTabLock();

        // ── timers ──
        if (giveawayData?.countdownTimerID) clearInterval(giveawayData.countdownTimerID);
        if (giveawayData?.potUpdater) clearInterval(giveawayData.potUpdater);
        if (sponsorsInterval) {
            clearInterval(sponsorsInterval);
            sponsorsInterval = null;
        }
        clearSponsorAccountingRecoveryTimer();
        clearHostSafetyBanner("accounting");
        if (window.__activeTracker) window.__activeTracker = null;

        if (observer) { observer.disconnect(); observer = null; }

        if (reminderRetryTimeout) { clearTimeout(reminderRetryTimeout); reminderRetryTimeout = null; }

        // ── growing maps / sets ──
        numberEntries.clear();
        numberTakenBy.clear();
        fancyNames.clear();
        userCooldown.clear();
        userCommandLog.clear();
        userLastActionAt.clear();
        userLastCommandAt.clear();
        userSpamStrikes.clear();
        userFeedbackCooldown.clear();
        naughtyWarned.clear();
        liveEnteredThisGiveaway.clear();
        liveSponsorSeenThisGiveaway.clear();
        liveSponsorTotalThisGiveaway.clear();
        _adminCache.clear();


        // reset rigged visuals for next giveaway
        riggedMode = false;
        if (rigBadge) {
            rigBadge.hidden = true;
            rigBadge.classList.remove('rigged-pulse');
        }
        if (bonanzaGiveawayFrame) {
            bonanzaGiveawayFrame.classList.remove('rigged');
        }

        // ── global event listeners ──
        document.removeEventListener("click", handleOutsideClick);

        giveawayData = null;
        window.onbeforeunload = null;

        updateRigToggleUI();
        updateHostPanelUI();
        return true;
    }

    // ───────────────────────────────────────────────────────────
