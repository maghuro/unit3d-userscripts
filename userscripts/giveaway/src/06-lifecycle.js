    // SECTION 6: Giveaway Lifecycle
    // ───────────────────────────────────────────────────────────

    async function startGiveaway() {
        clearWinnersStatusUI();

        const maxScaledValid = validateMaxScaledWinnersInput({ forceMessage: true });
        if (scaleWinnersToggleInput && scaleWinnersToggleInput.checked && !maxScaledValid) {
            if (maxScaledWinnersInput) maxScaledWinnersInput.focus();
            return;
        }

        if (!giveawayForm.checkValidity()) {
            giveawayForm.reportValidity();
            return;
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

        let totalTimeMin = totalMinutes();
        let totalTimeMs = totalTimeMin * 60000;
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

            const introSent = await sendMessage(introMessage, {
                requireExclusiveGiveawayOwnership: true
            });
            if (introSent === false) {
                logEvent(
                    "Start aborted (opening announcement)",
                    "The public opening message could not be accepted for sending. Timers, entries and sponsor tracking were not started."
                );
                window.alert(
                    "GIVEAWAY ERROR: The opening message could not be sent safely to DarkPeers Main Chat. " +
                    "The giveaway was not started."
                );
                resetGiveaway();
                return;
            }

            // Public opening is the temporal boundary. The pre-opening Gift History
            // snapshot means every subsequently appearing received gift is new.
            giveawayStartTime = new Date();
            tracker.giveawayStartTs = giveawayStartTime.getTime();
            // The advertised duration begins at the same public-opening boundary,
            // not while balance/history preflight or chat delivery is still running.
            giveawayData.endTs = giveawayStartTime.getTime() + totalTimeMs;
            giveawayData.timeLeft = totalTimeMs / 1000;
            window.__activeTracker = tracker;

            try { await tracker.poll(); } catch (e) { console.error(e); }
            sponsorsInterval = setInterval(
                () => tracker.poll(),
                SPONSOR_GIFT_HISTORY_POLL_MS
            );

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
