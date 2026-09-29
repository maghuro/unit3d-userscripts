    // SECTION 11: Winner Selection and Payouts
    // ───────────────────────────────────────────────────────────
    async function endGiveaway() {
        // ---- re-entry guard (prevents double gifting) ----
        if (!giveawayData) return;
        if (giveawayData.__ending) return;
        giveawayData.__ending = true;
        giveawayData.timeLeft = 0;
        try {
            if (countdownHeader) countdownHeader.textContent = "00:00";
            if (startButton) {
                startButton.disabled = true;
                startButton.textContent = "Settling…";
                startButton.title = "Entries are closed; final settlement is in progress";
            }
        } catch {}
        const nowAtSettlement = Date.now();
        const scheduledEndTs = Number(giveawayData.endTs);
        const committedCutoffTs = Number(giveawayData?.settlement?.cutoffTs);
        const settlementCutoffTs = Number.isFinite(committedCutoffTs)
            ? committedCutoffTs
            : (Number.isFinite(scheduledEndTs)
                ? Math.min(nowAtSettlement, scheduledEndTs)
                : nowAtSettlement);

        // ---- cross-tab guard ----
        // If another tab currently owns the giveaway (fresh heartbeat in the last
        // TAB_LOCK_STALE_MS), do NOT proceed with payout. Without this, a tab that
        // restored from snapshot while the original tab was alive could end up
        // paying every winner twice.
        if (!ownsTabLock()) {
            logEvent(
                "End aborted (this tab does not own the giveaway)",
                "Refusing to send gifts because this tab cannot prove exclusive ownership. Reload the owning tab to resume safely."
            );
            // Do not tear down state here. The verified owning tab is the source of truth.
            // Just back off and let it run.
            giveawayData.__ending = false;
            return;
        }

        // Persist the intent to close BEFORE the first asynchronous side effect.
        // A crash/BFCache handoff while the closing announcement POST is pending
        // must restore directly into settlement, never reopen entries/countdown.
        giveawayData.__closingIntent = true;
        if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
            logEvent(
                "Settlement paused (closing intent not durable)",
                "Could not persist and read back the closing intent. No closing announcement or BON transfer was attempted."
            );
            giveawayData.__ending = false;
            try {
                if (startButton) {
                    startButton.disabled = false;
                    startButton.textContent = "Retry settlement";
                    startButton.title = "Retry after local recovery storage becomes writable";
                    startButton.onclick = () => endGiveaway();
                }
                window.alert(
                    "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                    "The closing state could not be stored safely. No settlement action was attempted. " +
                    "Free some browser storage/reload and retry."
                );
            } catch {}
            return;
        }

        const reconcileSettlementOutput = async (checkpoint, preparedMessage) => {
            const expectedPreparedMessage =
                typeof checkpoint?.preparedMessage === "string"
                    ? checkpoint.preparedMessage
                    : String(preparedMessage || "");
            const rawAfterMessageId = checkpoint?.afterMessageId;
            const afterId =
                rawAfterMessageId !== null &&
                rawAfterMessageId !== undefined &&
                Number.isFinite(Number(rawAfterMessageId))
                    ? Math.floor(Number(rawAfterMessageId))
                    : null;
            const startedAt = Number.isFinite(Number(checkpoint?.startedAt))
                ? Number(checkpoint.startedAt)
                : Date.now();
            const unresolvedSendUntil = startedAt + 9000;

            // The previous owner's POST may still be alive for the full 7-second
            // API timeout. Never replay while that original send can still commit.
            const waitMs = Math.max(0, unresolvedSendUntil - Date.now());
            if (waitMs > 0) {
                await new Promise(resolve => setTimeout(resolve, waitMs));
                if (!canMutateActiveGiveaway()) return { owned: false, found: false };
            }

            // A prior owner may have successfully posted even if its API response
            // was lost during BFCache/pagehide. Check a few times for that exact
            // prepared message before allowing a replay. A replay is permitted only
            // after at least one authoritative chat read succeeds.
            let authoritativeReads = 0;
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (!canMutateActiveGiveaway()) return { owned: false, found: false };

                try {
                    if (!OT_CHATROOM_ID) cacheChatContext();
                    const publicChatroomId = Math.floor(Number(OT_CHATROOM_ID));
                    if (!Number.isFinite(publicChatroomId) || publicChatroomId <= 0) {
                        throw new Error("Public chatroom id unavailable for settlement reconciliation");
                    }
                    const url = new URL(`/api/chat/messages/${publicChatroomId}`, location.origin);
                    if (afterId !== null) url.searchParams.set("after_id", String(afterId));
                    const res = await fetchWithTimeout(url, { credentials: "include" }, 5000);
                    if (!canMutateActiveGiveaway()) return { owned: false, found: false };

                    if (res?.ok) {
                        const payload = await res.json();
                        if (!canMutateActiveGiveaway()) return { owned: false, found: false };
                        if (!Array.isArray(payload?.data)) throw new Error("Malformed chat reconciliation payload");

                        authoritativeReads += 1;
                        const messages = payload.data;
                        const ownUserId = Number(OT_USER_ID);
                        const match = messages.find(m => {
                            const id = Math.floor(Number(m?.id));
                            if (afterId !== null && Number.isFinite(id) && id <= afterId) return false;

                            if (afterId === null) {
                                const createdAtTs = Date.parse(m?.created_at);
                                const resolutionMs = unit3dTimestampResolutionMs(m?.created_at);
                                if (
                                    !Number.isFinite(createdAtTs) ||
                                    (createdAtTs + resolutionMs) <= startedAt
                                ) return false;
                            }

                            const senderId = Number(m?.user_id ?? m?.user?.id);
                            if (
                                Number.isFinite(ownUserId) &&
                                Number.isFinite(senderId) &&
                                senderId !== ownUserId
                            ) return false;

                            return String(m?.message ?? "") === expectedPreparedMessage;
                        });
                        if (match) {
                            return {
                                owned: true,
                                found: true,
                                conclusive: true,
                                messageId: Number.isFinite(Number(match?.id))
                                    ? Math.floor(Number(match.id))
                                    : null
                            };
                        }
                    }
                } catch {
                    // Bounded reconciliation retry below.
                }

                if (attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 700));
                    if (!canMutateActiveGiveaway()) return { owned: false, found: false };
                }
            }

            return {
                owned: canMutateActiveGiveaway(),
                found: false,
                conclusive: authoritativeReads > 0
            };
        };

        const sendSettlementMessage = async (message, label = "closing output", stepKey = null) => {
            if (!(await ensureExclusiveTabOwnership())) {
                logEvent(
                    "Settlement output paused (ownership lost)",
                    `Refusing ${label}: this tab no longer has exclusive giveaway ownership.`
                );
                giveawayData.__ending = false;
                return false;
            }

            const settlement = giveawayData?.settlement;
            if (!settlement?.committed) {
                logEvent("Settlement output paused", `Refusing ${label}: settlement is not committed.`);
                giveawayData.__ending = false;
                return false;
            }

            const preparedMessage = prepareOutgoingMessage(message);
            const outputKey = String(stepKey || label || "closing-output");
            settlement.outputProgress =
                settlement.outputProgress && typeof settlement.outputProgress === "object"
                    ? settlement.outputProgress
                    : {};

            let checkpoint = settlement.outputProgress[outputKey];
            if (checkpoint?.status === "sent") return true;

            let replayingPendingCheckpoint = false;
            if (checkpoint?.status === "pending") {
                const reconciled = await reconcileSettlementOutput(checkpoint, preparedMessage);
                if (!reconciled.owned) {
                    giveawayData.__ending = false;
                    return false;
                }
                if (reconciled.found) {
                    checkpoint.status = "sent";
                    checkpoint.messageId = reconciled.messageId;
                    checkpoint.confirmedAt = Date.now();
                    snapshotGiveaway({ force: true });
                    return true;
                }
                if (!reconciled.conclusive) {
                    logEvent(
                        "Settlement output reconciliation deferred",
                        `Preserving pending checkpoint for ${label}: chat could not be read authoritatively, so replay is unsafe.`
                    );
                    giveawayData.__ending = false;
                    return false;
                }

                // The previous attempt is authoritatively absent. Any replay is a
                // new side-effect window, so give it a fresh cursor/timestamp and
                // durably persist that boundary before sending again.
                checkpoint.afterMessageId = await getLatestChatMessageId(DARKPEERS_MAIN_CHATROOM_ID);
                checkpoint.startedAt = Date.now();
                checkpoint.preparedMessage =
                    typeof checkpoint.preparedMessage === "string"
                        ? checkpoint.preparedMessage
                        : preparedMessage;
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    logEvent(
                        "Settlement output paused (replay checkpoint not durable)",
                        `Could not persist/read back the refreshed replay checkpoint for ${label}. The message was not resent.`
                    );
                    giveawayData.__ending = false;
                    return false;
                }
                replayingPendingCheckpoint = true;
            } else {
                const afterMessageId = await getLatestChatMessageId(DARKPEERS_MAIN_CHATROOM_ID);
                if (!(await ensureExclusiveTabOwnership())) {
                    giveawayData.__ending = false;
                    return false;
                }

                checkpoint = {
                    status: "pending",
                    afterMessageId,
                    preparedMessage,
                    startedAt: Date.now()
                };
                settlement.outputProgress[outputKey] = checkpoint;
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    logEvent(
                        "Settlement output paused (checkpoint not durable)",
                        `Could not persist/read back the pre-send checkpoint for ${label}. The message was not sent.`
                    );
                    giveawayData.__ending = false;
                    return false;
                }
            }

            if (!(await ensureExclusiveTabOwnership())) {
                giveawayData.__ending = false;
                return false;
            }

            const messageToSend = replayingPendingCheckpoint
                ? checkpoint.preparedMessage
                : preparedMessage;
            const sent = await sendMessage(messageToSend, {
                requireExclusiveGiveawayOwnership: true,
                prepared: true
            });
            if (sent === false) {
                giveawayData.__ending = false;
                return false;
            }

            if (!(await ensureExclusiveTabOwnership())) {
                // Leave the persisted checkpoint pending. The next owner will
                // reconcile the chat before deciding whether a replay is needed.
                giveawayData.__ending = false;
                return false;
            }

            checkpoint.status = "sent";
            checkpoint.sentAt = Date.now();
            snapshotGiveaway({ force: true });
            return true;
        };

        // Stop additional triggers ASAP (but don't clear entries/state yet)
        try {
            startButton.disabled = true;
            startButton.onclick = null; // prevent double-click / queued clicks from re-ending
        } catch {}

        if (giveawayData.countdownTimerID) {
            clearInterval(giveawayData.countdownTimerID);
            giveawayData.countdownTimerID = null;
        }
        if (giveawayData.potUpdater) {
            clearInterval(giveawayData.potUpdater);
            giveawayData.potUpdater = null;
        }
        if (sponsorsInterval) {
            clearInterval(sponsorsInterval);
            sponsorsInterval = null;
        }

        // Participant input is frozen by handleEntryMessage()/command gating above.
        // Keep the observer alive during settlement so !time and other read-only
        // status commands remain responsive instead of making the bot appear hung.

        // Tell chat immediately that the entry window is closed. This deliberately
        // happens BEFORE sponsor reconciliation or any money-moving operation.
        //
        // The closing announcement has its own durable pending checkpoint because
        // it happens before settlement is committed. If the POST lands and this
        // page crashes/BFCache-handoffs before the response is persisted, recovery
        // reconciles the exact message instead of posting it a second time.
        if (!giveawayData.__closingNoticeSent) {
            const closedByTimer =
                Number.isFinite(Number(scheduledEndTs)) &&
                nowAtSettlement >= scheduledEndTs;
            const closingMessage = closedByTimer
                ? "⏱️ [b][color=#FFDE59]Time is up! Entries are now closed.[/color][/b] Finalising sponsor accounting and settlement…"
                : "⏱️ [b][color=#FFDE59]Entries are now closed by the host.[/color][/b] Finalising sponsor accounting and settlement…";
            const preparedClosingMessage = prepareOutgoingMessage(closingMessage);

            try {
                let closingCheckpoint =
                    giveawayData.__closingNoticeProgress &&
                    typeof giveawayData.__closingNoticeProgress === "object"
                        ? giveawayData.__closingNoticeProgress
                        : null;

                if (closingCheckpoint?.status === "sent") {
                    giveawayData.__closingNoticeSent = true;
                } else {
                    if (closingCheckpoint?.status === "pending") {
                        const reconciled = await reconcileSettlementOutput(
                            closingCheckpoint,
                            closingCheckpoint.preparedMessage || preparedClosingMessage
                        );

                        if (!reconciled.owned) {
                            giveawayData.__ending = false;
                            return;
                        }

                        if (reconciled.found) {
                            closingCheckpoint.status = "sent";
                            closingCheckpoint.messageId = reconciled.messageId;
                            closingCheckpoint.confirmedAt = Date.now();
                            giveawayData.__closingNoticeSent = true;
                            snapshotGiveaway({ force: true });
                        } else if (!reconciled.conclusive) {
                            logEvent(
                                "Closing notice reconciliation deferred",
                                "The persisted closing announcement attempt could not be checked authoritatively; refusing to replay it."
                            );
                            giveawayData.__ending = false;
                            return;
                        } else {
                            closingCheckpoint.afterMessageId = await getLatestChatMessageId(DARKPEERS_MAIN_CHATROOM_ID);
                            closingCheckpoint.startedAt = Date.now();
                            closingCheckpoint.preparedMessage =
                                typeof closingCheckpoint.preparedMessage === "string"
                                    ? closingCheckpoint.preparedMessage
                                    : preparedClosingMessage;
                            if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                                logEvent(
                                    "Closing notice paused (replay checkpoint not durable)",
                                    "Could not persist/read back the refreshed closing-message replay checkpoint. The announcement was not resent."
                                );
                                giveawayData.__ending = false;
                                return;
                            }
                        }
                    }

                    if (!giveawayData.__closingNoticeSent) {
                        // A pending checkpoint may already represent an earlier
                        // host-close wording. Preserve that exact payload; only
                        // create a fresh checkpoint when no pending attempt exists.
                        if (closingCheckpoint?.status !== "pending") {
                            const afterMessageId = await getLatestChatMessageId(DARKPEERS_MAIN_CHATROOM_ID);

                            if (!(await ensureExclusiveTabOwnership())) {
                                giveawayData.__ending = false;
                                return;
                            }

                            closingCheckpoint = {
                                status: "pending",
                                afterMessageId,
                                preparedMessage: preparedClosingMessage,
                                startedAt: Date.now()
                            };
                            giveawayData.__closingNoticeProgress = closingCheckpoint;

                            if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                                logEvent(
                                    "Closing notice paused (checkpoint not durable)",
                                    "Could not persist/read back the pre-send closing-message checkpoint. The announcement was not sent."
                                );
                                giveawayData.__ending = false;
                                return;
                            }
                        }

                        if (!(await ensureExclusiveTabOwnership())) {
                            giveawayData.__ending = false;
                            return;
                        }

                        const closingNoticeSent = await sendMessage(
                            closingCheckpoint.preparedMessage,
                            {
                                requireExclusiveGiveawayOwnership: true,
                                prepared: true
                            }
                        );

                        if (closingNoticeSent === false) {
                            logEvent(
                                "Closing notice deferred",
                                "Entries are closed locally, but the closing chat notice was not accepted for sending. Settlement will not move BON until the closing state can be announced."
                            );
                            giveawayData.__ending = false;
                            try {
                                if (startButton) {
                                    startButton.disabled = false;
                                    startButton.textContent = "Retry settlement";
                                    startButton.title = "Retry the closing announcement and settlement";
                                    startButton.onclick = () => endGiveaway();
                                }
                            } catch {}
                            return;
                        }

                        closingCheckpoint.status = "sent";
                        closingCheckpoint.sentAt = Date.now();
                        giveawayData.__closingNoticeSent = true;
                        snapshotGiveaway({ force: true });
                    }
                }
            } catch (e) {
                logEvent("Closing notice warning", String(e?.message || e));
                giveawayData.__ending = false;
                try {
                    if (startButton) {
                        startButton.disabled = false;
                        startButton.textContent = "Retry settlement";
                        startButton.title = "Retry the closing announcement and settlement";
                        startButton.onclick = () => endGiveaway();
                    }
                } catch {}
                return;
            }
        }

        const buildSettlementFinancialPlan = () => {
            const potTotal = Math.max(0, Math.floor(Number(giveawayData.amount) || 0));
            const sponsoredTotal = Math.max(
                0,
                Math.floor(sumSponsorContribs(giveawayData.sponsorContribs, giveawayData.host) || 0)
            );
            const hostFundedTotal = Math.max(0, potTotal - sponsoredTotal);
            const donationPercent = normalizeDonationPercent(giveawayData.donationPercent);
            const baseWinners = Math.max(
                1,
                Math.floor(Number(giveawayData.baseWinnersAtStart || giveawayData.winnersNum) || 1)
            );
            const rawState = {
                amount: potTotal,
                sponsorContribs: { ...(giveawayData.sponsorContribs || {}) },
                sponsors: Array.isArray(giveawayData.sponsors) ? [...giveawayData.sponsors] : [],
                sponsorGiftMessages: Array.isArray(giveawayData.sponsorGiftMessages)
                    ? giveawayData.sponsorGiftMessages.map(item => ({ ...item }))
                    : [],
                donationPercent,
                scaleWinnersWithSponsors: !!giveawayData.scaleWinnersWithSponsors,
                baseWinnersAtStart: baseWinners,
                winnersNum: Math.max(1, Math.floor(Number(giveawayData.winnersNum) || 1)),
                riggedMode: !!riggedMode
            };

            if (numberEntries.size === 0) {
                return {
                    version: 1,
                    mode: donationPercent > 0 ? "no-entries-pool" : "no-entries-refund",
                    potTotal,
                    sponsoredTotal,
                    hostFundedTotal,
                    donationPercent,
                    refunds: getNonHostSponsorContributions(giveawayData)
                        .map(item => ({ name: item.name, amount: item.amount })),
                    rawState
                };
            }

            const winNum = Number(giveawayData.winningNumber);
            const sortedEntries = Array.from(numberEntries.entries())
                .map(([author, guess], idx) => ({
                    author,
                    guess,
                    gap: Math.abs(guess - winNum),
                    order: idx
                }))
                .sort((a, b) => a.gap - b.gap || a.order - b.order);
            const effectiveWinners = recomputeEffectiveWinners(giveawayData);
            const winnersCount = Math.min(effectiveWinners, sortedEntries.length);
            const winners = sortedEntries.slice(0, winnersCount).map(item => ({ ...item }));
            const ties = sortedEntries
                .filter(item => item.gap === sortedEntries[0].gap)
                .map(item => ({ ...item }));
            const weights = winners.map((_, i) => winnersCount - i);
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
            const gross = winners.map((_, i) =>
                Math.floor(potTotal * weights[i] / totalWeight)
            );
            const allocated = gross.reduce((sum, amount) => sum + amount, 0);
            if (gross.length && allocated < potTotal) {
                gross[0] += potTotal - allocated;
            }
            const split = computeDonationSplit(gross, donationPercent);

            return {
                version: 1,
                mode: "winners",
                potTotal,
                sponsoredTotal,
                hostFundedTotal,
                donationPercent,
                entrantsTotal: numberEntries.size,
                baseWinners,
                winnersCount,
                scaleIncrease: Math.max(0, winnersCount - baseWinners),
                sortedEntries,
                ties,
                winners,
                gross: [...gross],
                net: [...split.net],
                donations: [...split.donations],
                split: {
                    percent: split.percent,
                    total: split.total,
                    net: [...split.net],
                    donations: [...split.donations]
                },
                rawState
            };
        };

        const applySettlementFinancialPlan = (plan) => {
            if (!plan || typeof plan !== "object" || !plan.rawState) {
                throw new Error("Committed settlement is missing its immutable financial plan.");
            }
            const raw = plan.rawState;
            giveawayData.amount = Math.max(0, Math.floor(Number(raw.amount) || 0));
            giveawayData.sponsorContribs = { ...(raw.sponsorContribs || {}) };
            giveawayData.sponsors = Array.isArray(raw.sponsors) ? [...raw.sponsors] : [];
            giveawayData.sponsorGiftMessages = Array.isArray(raw.sponsorGiftMessages)
                ? raw.sponsorGiftMessages.map(item => ({ ...item }))
                : [];
            giveawayData.donationPercent = normalizeDonationPercent(raw.donationPercent);
            giveawayData.scaleWinnersWithSponsors = !!raw.scaleWinnersWithSponsors;
            giveawayData.baseWinnersAtStart = Math.max(1, Math.floor(Number(raw.baseWinnersAtStart) || 1));
            giveawayData.winnersNum = Math.max(1, Math.floor(Number(raw.winnersNum) || 1));
            riggedMode = !!raw.riggedMode;
        };

        if (
            giveawayData?.settlement?.committed !== true &&
            giveawayData?.__sponsorAccountingVerified === false
        ) {
            const tracker = window.__activeTracker;
            try {
                if (!tracker || typeof tracker.reconcileCanonicalSponsorAccounting !== "function") {
                    throw new Error("Canonical sponsor tracker is unavailable.");
                }
                const recovered = await tracker.reconcileCanonicalSponsorAccounting({
                    repairStats: false
                });
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    throw new Error("Recovered sponsor accounting could not be persisted safely.");
                }
                setSponsorAccountingVerificationState(
                    true,
                    recovered?.repaired
                        ? `Canonical pot repaired before settlement: ${fmtBONCurrency(recovered.previousPot)} -> ${fmtBONCurrency(recovered.canonicalPot)} BON.`
                        : "Persistent Gift History reconciliation succeeded before settlement."
                );
                clearSponsorAccountingRecoveryTimer();
            } catch (e) {
                setSponsorAccountingVerificationState(
                    false,
                    `Settlement remains blocked: ${String(e?.message || e)}`
                );
                snapshotGiveaway({ force: true });
                giveawayData.__ending = false;
                try {
                    if (startButton) {
                        startButton.disabled = false;
                        startButton.textContent = "Retry settlement";
                        startButton.title = "Retry after persistent Gift History reconciliation is healthy";
                        startButton.onclick = () => endGiveaway();
                    }
                    window.alert(
                        "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                        "Persistent Gift History reconciliation is not currently available. " +
                        "Entries are already closed if time expired, but no winner draw or BON transfer will occur until accounting is verified."
                    );
                } catch {}
                scheduleSponsorAccountingRecovery(tracker, { expiredOnRestore: true });
                return;
            }
        }

        // Close the sponsor accounting window with one final synchronous API poll.
        // The regular tracker runs every 10s, so without this a gift in the final
        // seconds could be omitted from the pot. snapshotGiveaway() is suppressed
        // while __ending is true, so this cannot resurrect the active snapshot.
        if (
            giveawayData?.settlement?.committed !== true &&
            window.__activeTracker &&
            typeof window.__activeTracker.poll === "function"
        ) {
            let finalSponsorSyncOk = false;
            for (let attempt = 1; attempt <= 3 && !finalSponsorSyncOk; attempt++) {
                try {
                    finalSponsorSyncOk = (await window.__activeTracker.poll({
                        maxCreatedAtTs: settlementCutoffTs,
                        announce: false
                    })) === true;
                } catch (e) {
                    finalSponsorSyncOk = false;
                    logEvent("Final sponsor sync retry", `Attempt ${attempt}/3: ${String(e?.message || e)}`);
                }
                if (!finalSponsorSyncOk && attempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }
            if (!finalSponsorSyncOk) {
                logEvent(
                    "Settlement paused (final sponsor sync failed)",
                    "Could not establish an authoritative final sponsor state after 3 attempts. Refusing to draw winners or move BON with stale sponsor accounting."
                );
                try {
                    window.alert(
                        "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                        "The final sponsor reconciliation failed after 3 attempts. " +
                        "No winner draw, winner gift or BON Pool contribution will be performed from stale sponsor data.\n\n" +
                        "Retry settlement after connectivity/DarkPeers is healthy."
                    );
                } catch {}
                try {
                    if (startButton) {
                        startButton.disabled = false;
                        startButton.textContent = "Retry settlement";
                        startButton.title = "Retry final sponsor reconciliation and settlement";
                        startButton.onclick = () => endGiveaway();
                    }
                } catch {}
                snapshotGiveaway({ force: true });
                giveawayData.__ending = false;
                return;
            }
        }

        // A BFCache pagehide may have released our Web Lock while the final sponsor
        // poll above was awaiting network I/O. Reclaim ownership before committing
        // a draw or producing any settlement output.
        if (!(await ensureExclusiveTabOwnership())) {
            logEvent(
                "Settlement paused (ownership lost)",
                "Exclusive giveaway ownership could not be reacquired after the final sponsor sync. Reload the owning tab to resume safely."
            );
            giveawayData.__ending = false;
            return;
        }

        // Sponsor accounting is frozen. Commit and persist the outcome BEFORE
        // any closing output or transfer. The active snapshot remains until the
        // settlement reaches a terminal state; gift/pool ledgers retain the
        // per-transfer attempt state, so a crash can resume without double-paying.
        if (!giveawayData.settlement || giveawayData.settlement.committed !== true) {
            const committedWinningNumber = numberEntries.size > 0
                ? getRandomInt(giveawayData.startNum, giveawayData.endNum)
                : null;
            giveawayData.winningNumber = committedWinningNumber;
            giveawayData.settlement = {
                committed: true,
                phase: "settling",
                cutoffTs: settlementCutoffTs,
                winningNumber: committedWinningNumber,
                committedAt: Date.now(),
                giveawayId: getActiveGiveawayId()
            };
            giveawayData.settlement.financialPlan = buildSettlementFinancialPlan();
            logEvent(
                "Settlement committed",
                numberEntries.size > 0
                    ? `Cutoff=${new Date(settlementCutoffTs).toISOString()} | Winning number=${committedWinningNumber}`
                    : `Cutoff=${new Date(settlementCutoffTs).toISOString()} | No entrants`
            );
        } else {
            giveawayData.winningNumber = Number.isFinite(Number(giveawayData.settlement.winningNumber))
                ? Number(giveawayData.settlement.winningNumber)
                : null;
            giveawayData.settlement.phase = "settling";

            // Backward-compatible recovery for a committed snapshot created by an
            // earlier v1.3.24 audit build: freeze the persisted committed state once,
            // but never run sponsor discovery again after side effects may have begun.
            if (!giveawayData.settlement.financialPlan) {
                giveawayData.settlement.financialPlan = buildSettlementFinancialPlan();
            }
        }
        applySettlementFinancialPlan(giveawayData.settlement.financialPlan);
        snapshotGiveaway({ force: true });

        const pauseSettlementForRetry = (eventName, details, alertText = "") => {
            logEvent(eventName, details);
            try {
                if (alertText) window.alert(alertText);
            } catch {}
            snapshotGiveaway({ force: true });
            giveawayData.__ending = false;
            try {
                if (startButton) {
                    startButton.disabled = false;
                    startButton.textContent = "Retry settlement";
                    startButton.title = "Re-check the preserved settlement without duplicating confirmed transfers";
                    startButton.onclick = () => endGiveaway();
                }
            } catch {}
        };

        // One funding invariant for all terminal modes. On the first settlement
        // attempt this is the complete external outflow. On recovery/retry, count
        // only transfers that the persisted ledgers still permit us to initiate.
        // Already-attempted gifts/pool transfers are verification-only work and
        // MUST NOT be budgeted again or resent automatically.
        const settlementPlan = giveawayData.settlement.financialPlan;
        const settlementSelfKeys = resolveSelfKeys(giveawayData.host);
        const settlementGiveawayId = getActiveGiveawayId();

        const giftNeedsNewTransfer = (recipient, amount, purpose) => {
            const state = getGiftAttemptState(
                settlementGiveawayId,
                recipient,
                amount,
                purpose
            ).state;
            return state === "none" || state === "retryable" || state === "indeterminate";
        };

        const poolNeedsNewTransfer = amount => {
            const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
            if (!safeAmount) return false;
            const existing = getPoolContributionAttempt(settlementGiveawayId);
            if (!existing) return true;
            if (Math.floor(Number(existing.amount) || 0) !== safeAmount) {
                throw new Error(
                    `Persisted BON Pool attempt amount conflict: expected ${safeAmount}, found ${existing.amount}`
                );
            }
            if (existing.status === "confirmed") return false;
            const retryableState = getPoolContributionRetryableState(
                settlementGiveawayId,
                existing
            );
            // Known-unsent retryable checkpoints still require funds. If the
            // marker cannot currently be read, budget conservatively as though
            // the outflow may still be required; the send path itself remains
            // fail-closed until that ambiguity is resolved.
            return retryableState === "retryable" || retryableState === "indeterminate";
        };

        const requiredSettlementOutflow = (() => {
            if (settlementPlan.mode === "winners") {
                const winners = Array.isArray(settlementPlan.winners) ? settlementPlan.winners : [];
                const net = Array.isArray(settlementPlan.net) ? settlementPlan.net : [];
                const winnerOutflow = winners.reduce((sum, winner, index) => {
                    const amount = Math.max(0, Math.floor(Number(net[index]) || 0));
                    if (!amount) return sum;
                    if (settlementSelfKeys.has(normalizeUserKey(winner?.author))) return sum;
                    return giftNeedsNewTransfer(winner?.author, amount, GIFT_PURPOSE.WINNER)
                        ? sum + amount
                        : sum;
                }, 0);
                const poolOutflow = Math.max(0, Math.floor(Number(settlementPlan.split?.total) || 0));
                return winnerOutflow + (poolNeedsNewTransfer(poolOutflow) ? poolOutflow : 0);
            }

            if (settlementPlan.mode === "no-entries-pool") {
                const poolOutflow = Math.max(0, Math.floor(Number(settlementPlan.potTotal) || 0));
                return poolNeedsNewTransfer(poolOutflow) ? poolOutflow : 0;
            }

            if (settlementPlan.mode === "no-entries-refund") {
                return (Array.isArray(settlementPlan.refunds) ? settlementPlan.refunds : [])
                    .reduce((sum, item) => {
                        const amount = Math.max(0, Math.floor(Number(item?.amount) || 0));
                        if (!amount) return sum;
                        return giftNeedsNewTransfer(item?.name, amount, GIFT_PURPOSE.SPONSOR_REFUND)
                            ? sum + amount
                            : sum;
                    }, 0);
            }

            return NaN;
        })();

        if (!Number.isFinite(requiredSettlementOutflow)) {
            throw new Error(`Unsupported committed settlement mode: ${String(settlementPlan.mode || "")}`);
        }

        if (requiredSettlementOutflow > 0) {
            const verifiedSettlementBalance =
                await getVerifiedHostBalance({ requireServer: true, maxAgeMs: 0 });

            if (
                !Number.isFinite(verifiedSettlementBalance) ||
                verifiedSettlementBalance < requiredSettlementOutflow
            ) {
                const availableText = Number.isFinite(verifiedSettlementBalance)
                    ? fmtBONCurrency(verifiedSettlementBalance)
                    : "unavailable";
                pauseSettlementForRetry(
                    "Settlement paused (insufficient verified BON)",
                    `Remaining automatic outflow=${fmtBONCurrency(requiredSettlementOutflow)} BON | verified balance=${availableText} BON. No new transfer was attempted.`,
                    `GIVEAWAY SETTLEMENT PAUSED\n\n` +
                    `Still required for new automatic transfers: ${fmtBONCurrency(requiredSettlementOutflow)} BON\n` +
                    `Verified balance: ${availableText} BON\n\n` +
                    `Previously attempted transfers are not counted again and will not be resent automatically.`
                );
                return;
            }
        }

        // Sponsor acknowledgement is independent of whether anyone entered. Gifts
        // were already received and the final sync above has frozen the authoritative
        // sponsor state, so thank sponsors (and preserve their notes) in either path.
        const finalSponsoredTotal = Math.max(0, Math.floor(Number(settlementPlan.sponsoredTotal) || 0));
        if (finalSponsoredTotal > 0) {
            const sponsorsMessage = buildSponsorsSummaryMessage(giveawayData);
            if (
                sponsorsMessage &&
                !(await sendSettlementMessage(sponsorsMessage, "final sponsor summary", "sponsor-summary"))
            ) return;

            // Gift History is already the canonical sponsor-note source and the
            // final sponsor sync above has just refreshed it. Reuse the persisted
            // matched notes here instead of performing a second network scrape.
            const sponsorMessageRecap = buildFinalSponsorMessageRecap(giveawayData);
            for (let i = 0; i < sponsorMessageRecap.length; i++) {
                const sponsorNoteMessage = sponsorMessageRecap[i];
                if (!(await sendSettlementMessage(
                    sponsorNoteMessage,
                    "final sponsor note",
                    `sponsor-note-${i}`
                ))) return;
            }
        }

        // No entries → no winners. Settlement follows the selected BON Pool mode:
        //   - Pool > 0: 100% of the final pot goes to BON Pool.
        //   - Pool = 0: host funding stays with the host and sponsors are refunded in full.
        if (numberEntries.size === 0) {
            const noEntryTotal = Math.max(0, Math.floor(Number(settlementPlan.potTotal) || 0));
            const noEntryHostFunded = Math.max(0, Math.floor(Number(settlementPlan.hostFundedTotal) || 0));
            const noEntryPoolPct = normalizeDonationPercent(settlementPlan.donationPercent);

            if (noEntryPoolPct > 0) {
                if (!(await sendSettlementMessage(
                    `Unfortunately, no one has entered the giveaway, so there are no winners.\n` +
                    `💙 The full pot of [b][color=${BONANZA.GIVEAWAY_COLOR}]${fmtBONCurrency(noEntryTotal)} BON[/color][/b] will be contributed directly to the [b]${BONANZA.FUND_NAME}[/b].`,
                    "zero-entry BON Pool outcome",
                    "zero-entry-pool-outcome"
                ))) return;

                let noEntryPoolResult = { attempted: false, confirmed: noEntryTotal <= 0, reason: noEntryTotal <= 0 ? "empty-pot" : "not-attempted" };
                if (noEntryTotal > 0) {
                    noEntryPoolResult = await contributeBonPool(noEntryTotal);

                    if (noEntryPoolResult.confirmed) {
                        const zeroEntryPoolMessage = noEntryPoolResult.dryRun
                            ? `[b][color=#FFC00A]REHEARSAL:[/color][/b] ${fmtBONCurrency(noEntryTotal)} BON full-pot contribution simulated. No BON was sent to the ${BONANZA.FUND_NAME}.`
                            : `${bridgeMarker(BRIDGE_MARKERS.POOL_PAID, "💙", "pool")} ` +
                                `[b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME} contribution confirmed:[/color][/b] ` +
                                `[b][color=${BONANZA.GIVEAWAY_COLOR}]${fmtBONCurrency(noEntryTotal)} BON[/color][/b] paid directly into the pool.\n` +
                                `No entrants. 100% of the pot was contributed. ✨`;
                        if (!(await sendSettlementMessage(
                            zeroEntryPoolMessage,
                            "zero-entry BON Pool confirmation",
                            "zero-entry-pool-confirmation"
                        ))) return;
                    } else {
                        try {
                            const noEntrySplit = {
                                percent: noEntryTotal > 0 ? 100 : 0,
                                net: [],
                                donations: [],
                                total: noEntryTotal
                            };
                            currentStatement = createStatementRecord({
                                winners: [],
                                gross: [],
                                net: [],
                                donations: [],
                                split: noEntrySplit,
                                poolStatus: "NOT CONFIRMED; zero-entry settlement preserved",
                                entrants: 0,
                                refunds: []
                            });
                            if (currentStatement) {
                                currentStatement.verification =
                                    "zero-entry BON Pool contribution not confirmed";
                                persistCurrentStatement();
                            }
                        } catch {}

                        pauseSettlementForRetry(
                            "Settlement paused (zero-entry BON Pool not confirmed)",
                            `The full-pot contribution of ${fmtBONCurrency(noEntryTotal)} BON is not yet confirmed. No automatic resend will occur.`,
                            `BON Pool warning: the zero-entry full-pot contribution of ${fmtBONCurrency(noEntryTotal)} BON could not be confirmed.\n\n` +
                            `The settlement has been preserved. Check /bon-pool and use Retry settlement to verify the existing attempt.`
                        );
                        return;
                    }
                }

                logEvent(
                    "Giveaway ended",
                    `Entrants=0 | Winners=0 | Host-funded=${fmtBONCurrency(noEntryHostFunded)} BON | Sponsored=${fmtBONCurrency(finalSponsoredTotal)} BON | Total=${fmtBONCurrency(noEntryTotal)} BON | BON Pool=${fmtBONCurrency(noEntryTotal)} BON (100%, ${noEntryPoolResult.dryRun ? "simulated" : (noEntryPoolResult.confirmed ? "confirmed" : "NOT CONFIRMED")})`
                );

                const noEntryDonationInfo = {
                    total: noEntryTotal,
                    percent: noEntryTotal > 0 ? 100 : 0,
                    confirmed: !!noEntryPoolResult.confirmed
                };
                try {
                    if (!giveawayData.settlement?.statsRecorded) {
                        recordGiveawayStats(giveawayData, [], [], numberEntries, noEntryDonationInfo);
                        giveawayData.settlement.statsRecorded = true;
                        snapshotGiveaway({ force: true });
                    }
                } catch (e) { /* ignore stats errors */ }

                try {
                    const noEntrySplit = {
                        percent: noEntryDonationInfo.percent,
                        net: [],
                        donations: [],
                        total: noEntryTotal
                    };
                    currentStatement = createStatementRecord({
                        winners: [],
                        gross: [],
                        net: [],
                        donations: [],
                        split: noEntrySplit,
                        poolStatus: noEntryPoolResult.dryRun
                            ? "simulated only (zero entrants; no BON Pool contribution sent)"
                            : noEntryPoolResult.confirmed
                                ? "confirmed directly in BON Pool (zero entrants, 100% of pot)"
                                : "NOT CONFIRMED, zero-entry full pot requires manual /bon-pool check",
                        entrants: 0,
                        refunds: []
                    });
                    if (currentStatement) {
                        currentStatement.verification = noEntryPoolResult.dryRun
                            ? "rehearsal simulation complete; no BON-moving requests sent"
                            : noEntryPoolResult.confirmed
                                ? "nothing to verify"
                                : "BON Pool contribution requires manual verification";
                        persistCurrentStatement();
                    }
                } catch (e) { /* statements are best-effort */ }
            } else {
                const sponsorRefunds = Array.isArray(settlementPlan.refunds)
                    ? settlementPlan.refunds.map(item => ({ ...item }))
                    : [];
                const refundTotal = sponsorRefunds.reduce((sum, item) => sum + item.amount, 0);
                const refundList = sponsorRefunds
                    .map(item =>
                        `[color=#1DDC5D][b]${sanitizeNick(item.name)}[/b][/color] ([color=#ffc00a][b]${fmtBONCurrency(item.amount)} BON[/b][/color])`
                    )
                    .join(" · ");

                if (!(await sendSettlementMessage(
                    `Unfortunately, no one has entered the giveaway, so there are no winners.\n` +
                    `${bridgeMarker(BRIDGE_MARKERS.SPONSORS, "↩️")} BON Pool is [b]0%[/b]: ` +
                    `the host-funded [b][color=#ffc00a]${fmtBONCurrency(noEntryHostFunded)} BON[/color][/b] remains with the host.` +
                    (refundList
                        ? ` Sponsor contributions will be returned in full: ${refundList}.`
                        : ` There are no sponsor contributions to return.`),
                    "zero-entry refund outcome",
                    "zero-entry-refund-outcome"
                ))) return;

                const refundExpectedGifts = [];
                const refundDeferredGifts = [];
                const refundRecords = sponsorRefunds.map(item => ({
                    user: item.name,
                    amount: item.amount,
                    status: "pending"
                }));
                // Freeze verification boundaries before the first refund. A resumed
                // settlement must reuse these original boundaries; taking a fresh
                // baseline/cursor after a crash would make already-sent refunds look old.
                const settlement = giveawayData.settlement;
                let hasSavedRefundBaseline = Object.prototype.hasOwnProperty.call(
                    settlement,
                    "refundGiftHistoryBaseline"
                );
                let refundGiftHistoryBaseline = hasSavedRefundBaseline
                    ? settlement.refundGiftHistoryBaseline
                    : null;

                // A failed preflight from an older/current attempt may have left a
                // non-array sentinel (notably null). That is NOT an initialized
                // verification boundary. Drop it so this attempt can retry Gift
                // History once DarkPeers is healthy again.
                if (hasSavedRefundBaseline && !Array.isArray(refundGiftHistoryBaseline)) {
                    delete settlement.refundGiftHistoryBaseline;
                    hasSavedRefundBaseline = false;
                    refundGiftHistoryBaseline = null;
                }

                if (!hasSavedRefundBaseline) {
                    try {
                        const fetchedRefundBaseline = sponsorRefunds.length &&
                            window.__activeTracker &&
                            typeof window.__activeTracker.fetchRecentGiftHistory === "function"
                            ? await window.__activeTracker.fetchRecentGiftHistory()
                            : [];

                        if (Array.isArray(fetchedRefundBaseline)) {
                            refundGiftHistoryBaseline = fetchedRefundBaseline;
                            // Persist only a valid baseline. Never serialize null/error
                            // as though the pre-transfer boundary had been captured.
                            settlement.refundGiftHistoryBaseline = fetchedRefundBaseline;
                        } else {
                            refundGiftHistoryBaseline = null;
                            delete settlement.refundGiftHistoryBaseline;
                            logEvent(
                                "Sponsor refund Gift History preflight",
                                "Gift History returned a non-array baseline; refund settlement remains retryable."
                            );
                        }
                    } catch (e) {
                        refundGiftHistoryBaseline = null;
                        delete settlement.refundGiftHistoryBaseline;
                        logEvent("Sponsor refund Gift History preflight", String(e?.message || e));
                    }
                }

                if (sponsorRefunds.length && !Array.isArray(refundGiftHistoryBaseline)) {
                    // Keep the property absent while paused so Retry performs a fresh
                    // preflight instead of treating a previous failure as initialized.
                    delete settlement.refundGiftHistoryBaseline;
                    pauseSettlementForRetry(
                        "Settlement paused (refund baseline unavailable)",
                        "Persistent Gift History could not be captured before sponsor refunds. No refund was attempted.",
                        "Sponsor refunds require a durable pre-transfer Gift History baseline. Retry settlement when DarkPeers Gift History is available."
                    );
                    return;
                }

                const refundNotBeforeTs = Number.isFinite(settlement.refundNotBeforeTs)
                    ? settlement.refundNotBeforeTs
                    : Date.now();

                const hasSavedRefundCursor = Object.prototype.hasOwnProperty.call(
                    settlement,
                    "refundAfterMessageId"
                );
                const refundAfterMessageId = hasSavedRefundCursor
                    ? settlement.refundAfterMessageId
                    : (sponsorRefunds.length ? await getLatestChatMessageId(DARKPEERS_CHATROOM_ID) : null);

                settlement.refundNotBeforeTs = refundNotBeforeTs;
                settlement.refundAfterMessageId = refundAfterMessageId;
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    pauseSettlementForRetry(
                        "Settlement paused (refund baseline not durable)",
                        "The refund Gift History baseline/cursor could not be persisted and read back. No refund was attempted.",
                        "No sponsor refund has been sent. Free localStorage capacity if needed and retry settlement."
                    );
                    return;
                }

                let refundSendFailure = false;

                for (const refund of sponsorRefunds) {
                    // Every planned refund belongs to the verification set, even
                    // when giftBon() cannot initiate it. Otherwise a durable-ledger
                    // failure could be omitted from verification and settlement
                    // could incorrectly complete with a sponsor left unpaid.
                    const expectedRefund = {
                        recipient: refund.name,
                        amount: refund.amount,
                        purpose: GIFT_PURPOSE.SPONSOR_REFUND
                    };
                    refundExpectedGifts.push(expectedRefund);

                    const result = await giftBon(
                        refund.name,
                        refund.amount,
                        SPONSOR_REFUND_NOTE,
                        GIFT_PURPOSE.SPONSOR_REFUND
                    );

                    const record = refundRecords.find(item =>
                        normalizeUserKey(item.user) === normalizeUserKey(refund.name)
                    );
                    if (record) {
                        record.status = result?.attempted
                            ? "sent, awaiting confirmation"
                            : (result?.reason === "duplicate"
                                ? "already attempted, check verification"
                                : `NOT SENT (${result?.reason || "unknown error"})`);
                    }

                    if (
                        result?.reason === "pending" ||
                        result?.reason === "ownership-lost"
                    ) {
                        refundDeferredGifts.push(expectedRefund);
                    }

                    if (
                        !result?.attempted &&
                        result?.reason !== "duplicate" &&
                        result?.reason !== "pending" &&
                        result?.reason !== "ownership-lost"
                    ) {
                        refundSendFailure = true;
                        logEvent(
                            "Sponsor refund not initiated",
                            `${sanitizeNick(refund.name)} | ${fmtBONCurrency(refund.amount)} BON | reason=${result?.reason || "unknown"}`
                        );
                    }

                    if (PAYOUT_GIFT_GAP_MS > 0) {
                        await new Promise(resolve => setTimeout(resolve, PAYOUT_GIFT_GAP_MS));
                    }
                }

                logEvent(
                    "Giveaway ended",
                    `Entrants=0 | Winners=0 | Pool=0% | Host retained=${fmtBONCurrency(noEntryHostFunded)} BON | Sponsor refunds=${fmtBONCurrency(refundTotal)} BON | Total=${fmtBONCurrency(noEntryTotal)} BON`
                );

                try {
                    currentStatement = createStatementRecord({
                        winners: [],
                        gross: [],
                        net: [],
                        donations: [],
                        split: null,
                        poolStatus: "none (0% BON Pool; sponsor contributions returned)",
                        entrants: 0,
                        refunds: refundRecords
                    });
                    if (currentStatement) {
                        currentStatement.verification = refundExpectedGifts.length
                            ? "sponsor refunds awaiting verification"
                            : (refundRecords.length ? "refund attempts require manual verification" : "nothing to verify");
                        persistCurrentStatement();
                    }
                } catch (e) { /* statements are best-effort */ }

                let refundsVerified =
                    refundExpectedGifts.length === 0 &&
                    !refundSendFailure;
                if (refundExpectedGifts.length && !refundSendFailure) {
                    refundsVerified = await verifySponsorRefundGifts(
                        refundExpectedGifts,
                        giveawayData.host,
                        refundGiftHistoryBaseline,
                        {
                            afterId: refundAfterMessageId,
                            notBeforeTs: refundNotBeforeTs,
                            statementId: currentStatement?.id ?? null,
                            settlementOutputSender: sendSettlementMessage
                        }
                    );
                }

                if (!refundsVerified) {
                    const unresolved = refundDeferredGifts.some(gift =>
                        giftAttemptStillNeedsResolution(
                            getActiveGiveawayId(),
                            gift
                        )
                    );
                    pauseSettlementForRetry(
                        unresolved
                            ? "Settlement paused (refund attempt unresolved)"
                            : "Settlement paused (sponsor refund not confirmed)",
                        unresolved
                            ? "A sponsor refund is still pending/retryable after ownership handoff."
                            : "At least one sponsor refund could not be confirmed in persistent Gift History. No automatic resend will occur.",
                        "Sponsor refund verification is incomplete.\n\n" +
                        "The settlement has been preserved. Verify the recipient Gift History state and use Retry settlement after resolving any missing refund manually."
                    );
                    return;
                }

                try {
                    if (!giveawayData.settlement?.statsRecorded) {
                        recordGiveawayStats(
                            giveawayData,
                            [],
                            [],
                            numberEntries,
                            null,
                            { sponsorRefundedTotal: refundTotal }
                        );
                        giveawayData.settlement.statsRecorded = true;
                        snapshotGiveaway({ force: true });
                    }
                } catch (e) { /* ignore stats errors */ }
            }
        } else {
            // The draw was committed before any settlement side effect. A resumed
            // settlement must reuse this exact number.
            if (!Number.isFinite(Number(giveawayData.winningNumber))) {
                throw new Error("Committed settlement is missing its winning number.");
            }
            logEvent("Winning number committed", `Winning number=${giveawayData.winningNumber}`);

            const plan = settlementPlan;
            if (plan.mode !== "winners") {
                throw new Error("Committed settlement financial plan mode mismatch.");
            }

            const entries = Array.isArray(plan.sortedEntries)
                ? plan.sortedEntries.map(item => ({ ...item }))
                : [];
            const ties = Array.isArray(plan.ties) ? plan.ties.map(item => ({ ...item })) : [];
            if (ties.length > 1) {
                const tieMessage = ties.map(e => `[b][color=#DC3D1D]${sanitizeNick(e.author)}[/color][/b]`).join(", ");
                if (!(await sendSettlementMessage(
                    `${bridgeMarker(BRIDGE_MARKERS.TIE, "⚠️")} We have a tie between ${tieMessage}! [b][color=#DC3D1D]${sanitizeNick(entries[0].author)}[/color][/b] wins the tie-breaker as their entry was submitted first!`,
                    "tie result",
                    "tie-result"
                ))) return;
            }

            const winners = Array.isArray(plan.winners)
                ? plan.winners.map(item => ({ ...item }))
                : [];
            const N = Math.max(0, Math.floor(Number(plan.winnersCount) || winners.length));
            const allocated = Array.isArray(plan.gross) ? [...plan.gross] : [];
            const net = Array.isArray(plan.net) ? [...plan.net] : [];
            const split = {
                percent: normalizeDonationPercent(plan.split?.percent),
                total: Math.max(0, Math.floor(Number(plan.split?.total) || 0)),
                net: Array.isArray(plan.split?.net) ? [...plan.split.net] : [...net],
                donations: Array.isArray(plan.split?.donations) ? [...plan.split.donations] : []
            };
            const donationActive = split.total > 0;
            const donationInfo = donationActive
                ? { total: split.total, percent: split.percent, confirmed: false }
                : null;

            // Initialize winners / payout status UI so we can tick boxes as gifts are confirmed
            initWinnersStatusUI(winners, net, giveawayData.host, donationInfo);

            // 5) announce winners summary
            const winNum = giveawayData.winningNumber;
            const potTotal = Math.max(0, Math.floor(Number(plan.potTotal) || 0));
            const sponsoredTotal = Math.max(0, Math.floor(Number(plan.sponsoredTotal) || 0));
            const hostFundedTotal = Math.max(0, Math.floor(Number(plan.hostFundedTotal) || 0));
            const entrantsTotal = Math.max(0, Math.floor(Number(plan.entrantsTotal) || 0));
            const scaleIncrease = Math.max(0, Math.floor(Number(plan.scaleIncrease) || 0));

            //hard-coded emoji “podium”
            const podium = ["🥇", "🥈", "🥉", "🏅", "🎖️"];

            //build the tail: 6th, 7th, … up to the larger of N or MAX_WINNERS
            const need = Math.max(N, MAX_WINNERS) - podium.length;
            const tail = Array.from({ length: need }, (_, i) => {
                const n = i + podium.length + 1;
                const s = (n % 10 === 1 && n % 100 !== 11) ? "st" :
                (n % 10 === 2 && n % 100 !== 12) ? "nd" :
                (n % 10 === 3 && n % 100 !== 13) ? "rd" : "th";
                return `${n}${s}`; // "6th" … "15th"
            });

            //final list
            const medals = podium.concat(tail);

            // Rig note (rigNote() already checks riggedMode)
            const rigTag = rigNote(" (Rigged mode was active, but winners were still chosen [b]fairly[/b]… allegedly.) 👀");

            const summaryLine =
                  `🏆 ${bridgeMarker(BRIDGE_MARKERS.RESULT, "🎯")} Winning number: [b][color=#1DDC5D]${fmtBON(winNum)}[/color][/b]. ` +
                  `Winners drawn: [b][color=#5DE2E7]${fmtBON(N)}[/color][/b]. ` +
                  `Total entrants: [b][color=#5DE2E7]${fmtBON(entrantsTotal)}[/color][/b].`;
            const fundingLine =
                  `Funding - Host-funded: [b][color=#ffc00a]${fmtBONCurrency(hostFundedTotal)} BON[/color][/b] | ` +
                  `Sponsored: [b][color=#00abff]${fmtBONCurrency(sponsoredTotal)} BON[/color][/b] | ` +
                  `Total pot: [b][color=#FFC00A]${fmtBONCurrency(potTotal)} BON[/color][/b].`;
            const scalingLine = (giveawayData.scaleWinnersWithSponsors && scaleIncrease > 0)
            ? `[b][color=${SCALING_ACCENT_COLOR}]Scaling:[/color][/b] [b]Winners increased[/b] by [b][color=#5DE2E7]+${fmtBON(scaleIncrease)}[/color][/b] due to sponsorships.`
            : "";
            const donationLine = donationActive
                ? (riggedMode
                    ? `🧾 [b][color=#FF4F9A]Taxes due:[/color][/b] [b][color=#FFC00A]${fmtBONCurrency(split.total)} BON[/color][/b] (${split.percent}% of the pot) reserved for direct payment into the [b]${BONANZA.FUND_NAME}[/b]. Confirmation follows after settlement.`
                    : `💙 [b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME} allocation:[/color][/b] [b][color=${BONANZA.GIVEAWAY_COLOR}]${fmtBONCurrency(split.total)} BON[/color][/b] (${split.percent}% of the pot) reserved for direct contribution.`)
                : "";

            if (winners.length === 1) {
                // single‐winner public message
                const w = winners[0];
                const diff = Math.abs(w.guess - winNum);
                const prize = fmtBONCurrency(net[0]);
                const donatedNote = donationActive
                    ? (riggedMode
                        ? `\n[color=#aaaaaa](Gross prize: ${fmtBONCurrency(allocated[0])} BON · Taxes: ${fmtBONCurrency(split.donations[0])} BON)[/color]`
                        : `\n[color=#aaaaaa](Gross prize: ${fmtBONCurrency(allocated[0])} BON · ${BONANZA.FUND_NAME}: ${fmtBONCurrency(split.donations[0])} BON)[/color]`)
                    : "";

                const accuracyText = diff === 0
                    ? "[color=#1DDC5D][b](spot on!)[/b][/color]"
                    : `[color=#FB4F4F](off by ${fmtBON(diff)})[/color]`;

                const winnerLine =
                      `Congrats [b][color=#DC3D1D]${sanitizeNick(w.author)}[/color][/b]! ` +
                      `Guess [color=#1DDC5D][b]${fmtBON(w.guess)}[/b][/color] ` +
                      `${accuracyText} ` +
                      `wins [b][color=#FFC00A]${prize} BON[/color][/b].${donatedNote}`;

                if (!(await sendSettlementMessage(
                    [summaryLine, fundingLine, scalingLine, donationLine, winnerLine].filter(Boolean).join("\n") + rigTag,
                    "winner result",
                    "winner-result"
                ))) return;
            } else {
                // multi‐winner public message
                const lines = winners.map((w, i) => {
                    const diff = Math.abs(w.guess - winNum);
                    const prize = fmtBONCurrency(net[i]);
                    const medal = medals[i] || `${i + 1}.`;
                    const accuracyText = diff === 0
                        ? "[color=#1DDC5D][b](spot on!)[/b][/color]"
                        : `[color=#FB4F4F](off by ${fmtBON(diff)})[/color]`;
                    return `${medal} [b][color=#DC3D1D]${sanitizeNick(w.author)}[/color][/b]: ` +
                        `[color=#1DDC5D][b]${fmtBON(w.guess)}[/b][/color] ${accuracyText} ` +
                        `[color=#FFC00A][b]${prize} BON[/b][/color]`;
                });
                const multiDonatedNote = donationActive ? `\n[color=#aaaaaa]Amounts shown are after the ${split.percent}% ${BONANZA.FUND_NAME} donation.[/color]` : "";

                if (!(await sendSettlementMessage(
                    [summaryLine, fundingLine, scalingLine, donationLine, lines.join(', ')].filter(Boolean).join("\n") + multiDonatedNote + rigTag,
                    "winner results",
                    "winner-result"
                ))) return;
            }

            const winnerNames = winners.map(w => sanitizeNick(w.author)).join(", ") || "none";
            const payoutPerWinner = net.map((amt, i) => `${sanitizeNick(winners[i]?.author || "unknown")}: ${fmtBONCurrency(amt)} BON`).join(", ");
            const donationLog = donationActive
                ? ` | ${BONANZA.FUND_NAME}=${fmtBONCurrency(split.total)} BON (${split.percent}%, direct contribution pending)`
                : " | Contribution=0%";
            logEvent(
                "Giveaway ended",
                `Entrants=${fmtBON(entrantsTotal)} | Winners=${fmtBON(N)} | Host-funded=${fmtBONCurrency(hostFundedTotal)} BON | Sponsored=${fmtBONCurrency(sponsoredTotal)} BON | Total=${fmtBONCurrency(potTotal)} BON${donationLog} | Winners list=${winnerNames}${payoutPerWinner ? ` | Payouts=${payoutPerWinner}` : ""}`
            );

            // 6) Send gifts sequentially. Capture a chat cursor immediately before
            // payout so verification cannot accidentally match an older identical gift.
            const selfKeys = settlementSelfKeys;
            const expectedGifts = [];
            const deferredWinnerGifts = [];
            const settlement = giveawayData.settlement;

            // Persistent Gift History is the authoritative payout receipt on
            // DarkPeers. Capture the baseline once, BEFORE the first winner POST,
            // and persist it. If the baseline cannot be obtained we fail closed:
            // sending first and re-baselining later can permanently hide an
            // already-landed payout from durable verification.
            if (!Array.isArray(settlement.payoutGiftHistoryBaseline)) {
                const hasAmbiguousPriorWinnerAttempt = winners.some((winner, index) => {
                    const amount = Math.max(0, Math.floor(Number(net[index]) || 0));
                    if (!amount) return false;
                    if (selfKeys.has(normalizeUserKey(winner?.author))) return false;
                    const state = getGiftAttemptState(
                        settlementGiveawayId,
                        winner?.author,
                        amount,
                        GIFT_PURPOSE.WINNER
                    ).state;
                    return state === "pending" || state === "attempted" || state === "indeterminate";
                });

                if (hasAmbiguousPriorWinnerAttempt) {
                    settlement.payoutGiftHistoryBaselineState = "missing-after-attempt";
                    pauseSettlementForRetry(
                        "Settlement paused (payout baseline missing after prior attempt)",
                        "At least one winner transfer is already pending/attempted but the original pre-transfer Gift History baseline is missing. Refusing to re-baseline over a possibly landed payment.",
                        "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                        "A winner transfer may already have been attempted, but the original pre-transfer Gift History baseline is unavailable. " +
                        "Automatic payout/pool progression is blocked to avoid a duplicate or unverifiable payment."
                    );
                    return;
                }

                try {
                    const tracker = window.__activeTracker;
                    if (!tracker || typeof tracker.fetchRecentGiftHistory !== "function") {
                        throw new Error("DarkPeers Gift History tracker is unavailable");
                    }
                    const baseline = await tracker.fetchRecentGiftHistory();
                    if (!Array.isArray(baseline)) {
                        throw new Error("DarkPeers Gift History baseline returned an invalid payload");
                    }
                    settlement.payoutGiftHistoryBaseline = baseline;
                    settlement.payoutGiftHistoryBaselineState = "ready";
                    settlement.payoutGiftHistoryBaselineCapturedAt = Date.now();

                    if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                        // The fetched baseline exists only in volatile memory. Keeping
                        // the array would let a same-page Retry skip this persistence
                        // gate and begin winner transfers without a durable recovery
                        // boundary. Discard it completely so every retry must capture
                        // and verify-write a fresh pre-transfer baseline before any POST.
                        delete settlement.payoutGiftHistoryBaseline;
                        delete settlement.payoutGiftHistoryBaselineCapturedAt;
                        settlement.payoutGiftHistoryBaselineState = "persist-failed";
                        pauseSettlementForRetry(
                            "Settlement paused (payout baseline not durable)",
                            "The pre-transfer Gift History baseline was fetched but could not be persisted and read back. The volatile baseline was discarded; no winner transfer was attempted.",
                            "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                            "The authoritative pre-transfer Gift History baseline could not be stored safely. " +
                            "No winner gift or BON Pool contribution has been attempted by this payout step. Retry after storage is healthy."
                        );
                        return;
                    }
                } catch (e) {
                    settlement.payoutGiftHistoryBaselineState = "unavailable";
                    logEvent(
                        "Payout Gift History baseline unavailable",
                        String(e?.message || e)
                    );
                    pauseSettlementForRetry(
                        "Settlement paused (payout Gift History baseline unavailable)",
                        "Could not capture the authoritative pre-transfer Gift History baseline. No winner transfer was attempted.",
                        "GIVEAWAY SETTLEMENT PAUSED\n\n" +
                        "DarkPeers Gift History could not be baselined before payout. " +
                        "No winner gift or BON Pool contribution has been attempted by this payout step. Retry when Gift History is healthy."
                    );
                    return;
                }
            }

            const payoutGiftHistoryBaseline = settlement.payoutGiftHistoryBaseline;

            const payoutNotBeforeTs = Number.isFinite(settlement.payoutNotBeforeTs)
                ? settlement.payoutNotBeforeTs
                : Date.now();
            const hasSavedPayoutCursor = Object.prototype.hasOwnProperty.call(
                settlement,
                "payoutAfterMessageId"
            );
            const payoutAfterMessageId = hasSavedPayoutCursor
                ? settlement.payoutAfterMessageId
                : await getLatestChatMessageId(DARKPEERS_CHATROOM_ID);

            settlement.payoutNotBeforeTs = payoutNotBeforeTs;
            settlement.payoutAfterMessageId = payoutAfterMessageId;
            snapshotGiveaway({ force: true });

            for (let i = 0; i < winners.length; i++) {
                const w = winners[i];
                const amt = net[i];
                if (!amt || amt <= 0) {
                    // Possible only if a tiny prize was entirely consumed by the donation floor;
                    // computeDonationSplit guarantees net >= 1 whenever gross >= 1, so this is defensive.
                    continue;
                }
                if (selfKeys.size && selfKeys.has(normalizeUserKey(w.author))) {
                    // Host winner. Cannot gift to self
                    markWinnerGiftSelf(w.author);
                    continue;
                }

                const place = i + 1;
                const placeIcon = ["🥇", "🥈", "🥉"][i] || "🎉";
                const msg = (winners.length === 1)
                    ? "🥇 YOU WON!! Congratulations!"
                    : `${placeIcon} ${ordinal(place)} place! Congratulations!`;

                const giftResult = await giftBon(w.author, amt, msg, GIFT_PURPOSE.WINNER);
                const expectedGift = {
                    recipient: w.author,
                    amount: amt,
                    message: msg,
                    purpose: GIFT_PURPOSE.WINNER
                };
                expectedGifts.push(expectedGift);
                if (
                    giftResult?.reason === "pending" ||
                    giftResult?.reason === "ownership-lost"
                ) {
                    deferredWinnerGifts.push(expectedGift);
                }

                if (PAYOUT_GIFT_GAP_MS > 0) {
                    await new Promise(resolve => setTimeout(resolve, PAYOUT_GIFT_GAP_MS));
                }
            }

            // Create/recover the statement BEFORE verification so every individual
            // winner status is updated by the authoritative verifier. The record id
            // is the giveaway id, so a retry/reload resumes the same statement.
            try {
                const statementId = getActiveGiveawayId();
                currentStatement = getStatementRecordById(statementId) || createStatementRecord({
                    winners, gross: allocated, net, donations: split.donations, split,
                    poolStatus: donationActive
                        ? "NOT ATTEMPTED: winner payout verification pending"
                        : "none",
                    entrants: entrantsTotal
                });
                if (currentStatement) {
                    persistCurrentStatement();
                }
            } catch (e) {
                logEvent("Statement preflight warning", String(e?.message || e));
            }

            // 6a) Verify winner payouts BEFORE any irreversible BON Pool transfer.
            const winnersVerifiedBeforePool = await verifyWinnerGifts(expectedGifts, giveawayData.host, {
                giftHistoryBaseline: payoutGiftHistoryBaseline,
                afterId: payoutAfterMessageId,
                notBeforeTs: payoutNotBeforeTs,
                statementId: currentStatement?.id ?? null,
                settlementOutputSender: sendSettlementMessage
            });

            if (!winnersVerifiedBeforePool) {
                logEvent(
                    "Settlement paused (winner payout not confirmed)",
                    "At least one winner gift could not be confirmed. BON Pool contribution was not attempted."
                );
                if (currentStatement) {
                    currentStatement.donationStatus = donationActive
                        ? "NOT ATTEMPTED: winner payout not confirmed"
                        : "none";
                    currentStatement.verification =
                        "winner payout not confirmed; settlement paused before BON Pool";
                    currentStatement.endedAt = Date.now();
                    persistCurrentStatement();
                }
                snapshotGiveaway({ force: true });
                giveawayData.__ending = false;
                return;
            }

            if (currentStatement && !expectedGifts.length) {
                currentStatement.verification = REHEARSAL_MODE
                    ? "rehearsal simulation complete; no winner gift required"
                    : "nothing to verify";
                persistCurrentStatement();
            }

            // 6b) Direct BON Pool contribution. Success is announced publicly only
            //     after both the host's own contribution counter and the global pool
            //     total confirm the expected increase.
            let poolResult = { confirmed: false, attempted: false, reason: "not-active" };
            if (donationActive) {
                poolResult = await contributeBonPool(split.total);
                donationInfo.confirmed = !!poolResult.confirmed;
                if (poolResult.confirmed) {
                    const rehearsalPool = poolResult.dryRun === true;
                    markFundGiftStatus("confirmed");
                    if (currentStatement) {
                        currentStatement.donationStatus = rehearsalPool
                            ? "simulated only (no BON Pool contribution sent)"
                            : "confirmed directly in BON Pool";
                        if (rehearsalPool) {
                            currentStatement.verification =
                                "rehearsal simulation complete; no BON-moving requests sent";
                        }
                        currentStatement.endedAt = Date.now();
                        persistCurrentStatement();
                    }
                    const paidMessage = rehearsalPool
                        ? `[b][color=#FFC00A]REHEARSAL:[/color][/b] ${fmtBONCurrency(split.total)} BON ${riggedMode ? "Rigged Taxes payment" : BONANZA.FUND_NAME + " contribution"} simulated. No BON was sent.`
                        : riggedMode
                            ? `${bridgeMarker(BRIDGE_MARKERS.TAXES_PAID, "🧾")} [b][color=#FF4F9A]TAXES PAID:[/color][/b] [b][color=#FFC00A]${fmtBONCurrency(split.total)} BON[/color][/b] successfully paid directly into the [b]${BONANZA.FUND_NAME}[/b]. The taxman is satisfied. 😈`
                            : `${bridgeMarker(BRIDGE_MARKERS.POOL_PAID, "💙")} [b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME} contribution confirmed:[/color][/b] [b][color=${BONANZA.GIVEAWAY_COLOR}]${fmtBONCurrency(split.total)} BON[/color][/b] paid directly into the pool.\nThank you for supporting the event! ✨`;
                    if (!(await sendSettlementMessage(
                        paidMessage,
                        "BON Pool confirmation",
                        "bon-pool-confirmation"
                    ))) return;
                } else {
                    markFundGiftStatus("failed");
                    if (currentStatement) {
                        currentStatement.donationStatus =
                            "NOT CONFIRMED; settlement preserved for verification";
                        currentStatement.verification =
                            "winner payouts confirmed; BON Pool contribution not confirmed";
                        currentStatement.endedAt = Date.now();
                        persistCurrentStatement();
                    }

                    pauseSettlementForRetry(
                        "Settlement paused (BON Pool not confirmed)",
                        `Winner payouts are confirmed, but the ${fmtBONCurrency(split.total)} BON Pool contribution is not yet confirmed. No automatic resend will occur.`,
                        `BON Pool warning: the ${fmtBONCurrency(split.total)} BON contribution could not be confirmed.\n\n` +
                        `The settlement has been preserved. Check /bon-pool and use Retry settlement; the persisted pool ledger will verify the existing attempt before any further action.`
                    );
                    return;
                }
            }
            try {
                if (!giveawayData.settlement?.statsRecorded) {
                    recordGiveawayStats(giveawayData, winners, net, numberEntries, donationInfo);
                    giveawayData.settlement.statsRecorded = true;
                    snapshotGiveaway({ force: true });
                }
            } catch (e) { /* ignore stats errors */ }
            try {
                const finalPoolStatus = donationActive
                    ? (
                        poolResult.dryRun
                            ? "simulated only (no BON Pool contribution sent)"
                            : (
                                poolResult.confirmed
                                    ? "confirmed directly in BON Pool"
                                    : "NOT CONFIRMED, check /bon-pool manually"
                            )
                    )
                    : "none";

                if (!currentStatement) {
                    currentStatement = createStatementRecord({
                        winners, gross: allocated, net, donations: split.donations, split,
                        poolStatus: finalPoolStatus,
                        entrants: entrantsTotal
                    });
                }
                if (currentStatement) {
                    currentStatement.donationStatus = finalPoolStatus;
                    if (!expectedGifts.length) {
                        currentStatement.verification = poolResult.dryRun
                            ? "rehearsal simulation complete; no BON-moving requests sent"
                            : (
                                REHEARSAL_MODE
                                    ? "rehearsal simulation complete; no winner gift required"
                                    : "nothing to verify"
                            );
                    }
                    currentStatement.endedAt = Date.now();
                    persistCurrentStatement();
                }
            } catch (e) { /* statements are best-effort */ }

            // Winner payouts were already verified before the BON Pool transfer.
            const winnersVerified = winnersVerifiedBeforePool;

            if (
                !winnersVerified &&
                deferredWinnerGifts.some(gift =>
                    giftAttemptStillNeedsResolution(
                        getActiveGiveawayId(),
                        gift
                    )
                )
            ) {
                logEvent(
                    "Settlement paused (winner attempt unresolved)",
                    "A winner gift is still pending/retryable after ownership handoff; preserving the active settlement for a safe retry."
                );
                snapshotGiveaway({ force: true });
                giveawayData.__ending = false;
                return;
            }
        }

        // 7) Settlement is terminal only now. A BFCache transition can happen
        // during any verification await above, so prove ownership once more before
        // retiring the recoverable active snapshot.
        if (!(await ensureExclusiveTabOwnership())) {
            logEvent(
                "Settlement completion paused (ownership lost)",
                "The active settlement snapshot was preserved because this tab no longer owns the giveaway."
            );
            giveawayData.__ending = false;
            return;
        }

        // Persist completion once, then stopGiveaway() may safely retire the snapshot.
        if (giveawayData?.settlement?.committed) {
            giveawayData.settlement.phase = "complete";
            giveawayData.settlement.completedAt = Date.now();
            snapshotGiveaway({ force: true });
        }

        // Capture the notification window before stopGiveaway() clears runtime
        // state. Cleanup starts only after settlement is terminal and is explicitly
        // fire-and-forget: notification failures can never block or roll back BON
        // transfers, verification, statements, stats, or snapshot retirement.
        const notificationCleanupContext = {
            hostName: giveawayData?.host || "",
            startTs: giveawayStartTime instanceof Date ? giveawayStartTime.getTime() : null,
            endTs: settlementCutoffTs
        };
        const stopped = stopGiveaway();
        if (stopped) {
            void markGiveawayBonNotificationsRead(notificationCleanupContext)
                .catch(e => console.warn("[BON Giveaway] BON notification cleanup failed:", e));
        }
    }

    function clearWinnersStatusUI() {
        winnerPayouts.clear();
        winnerGiftStatus.clear();
        clearEntryRowCache();

        const table = getEntriesTable();
        if (!table) return;

        // Reset back to the basic two-column header.
        // Body will be repopulated by updateEntries() as entries arrive.
        table.innerHTML =
            "<thead><tr><th>User</th><th>Entry #</th></tr></thead><tbody></tbody>";
    }

    /**
     * @param {Array} winners
     * @param {number[]} allocated   net amounts actually gifted to each winner
     * @param {string} hostName
     * @param {{total:number, percent:number, retained:boolean}|null} donation
     */
    function initWinnersStatusUI(winners, allocated, hostName, donation = null) {
        winnerPayouts.clear();
        winnerGiftStatus.clear();

        const selfKeys = resolveSelfKeys(hostName);

        if (!Array.isArray(winners) || !Array.isArray(allocated) || !winners.length) {
            return;
        }

        const table = document.getElementById("entriesTable");
        if (!table) return;

        const thead = table.querySelector("thead");
        const tbody = table.querySelector("tbody");
        if (!thead || !tbody) return;

        const headerRow = thead.querySelector("tr");
        if (!headerRow) return;

        // If we're still in the plain 2-column mode, extend the header
        if (headerRow.children.length === 2) {
            const thPrize = document.createElement("th");
            thPrize.textContent = "Prize";
            const thGift = document.createElement("th");
            thGift.textContent = "Gift Status";
            headerRow.appendChild(thPrize);
            headerRow.appendChild(thGift);
        }

        // Build a lookup from entry number -> { author, prize }
        const byGuess = new Map();
        winners.forEach((w, idx) => {
            if (!w || typeof w.author !== "string") return;
            const prize = allocated[idx];
            if (!prize || prize <= 0) return;
            byGuess.set(w.guess, { author: w.author, prize });
        });

        Array.from(tbody.rows).forEach(row => {
            const cells = row.children;
            if (cells.length < 2) return;

            const entryNum = parseInt(cells[1].textContent, 10);
            const info = byGuess.get(entryNum);

            const prizeCell = document.createElement("td");
            const giftCell = document.createElement("td");
            giftCell.style.textAlign = "center";

            if (info) {
                const key = normalizeUserKey(info.author);
                winnerPayouts.set(key, info.prize);

                prizeCell.textContent = info.prize.toLocaleString();
                row.dataset.winnerKey = encodeURIComponent(key);

                if (selfKeys.size && selfKeys.has(key)) {
                    // Host winner. Cannot gift to self, so skip gifting/verification UI
                    winnerGiftStatus.set(key, "self");
                    giftCell.textContent = "Self";
                    giftCell.title = "Host winner (no self-gift)";
                    row.classList.add("gift-self");
                } else {
                    winnerGiftStatus.set(key, "pending");
                    giftCell.innerHTML = `<span class="gift-spinner" title="Checking gift status…"></span>`;
                    row.classList.add("gift-pending");
                }

            } else {
                // Non-winners still get empty cells so the table stays aligned
                prizeCell.textContent = "";
                giftCell.textContent = "";
            }

            row.appendChild(prizeCell);
            row.appendChild(giftCell);
        });

        // BON Pool row (only when a donation is in play)
        if (donation && donation.total > 0) {
            const fundRow = document.createElement("tr");
            fundRow.dataset.fundRow = "1";
            fundRow.style.borderTop = `2px solid ${BONANZA.ACCENT_COLOR}`;

            const userCell = document.createElement("td");
            userCell.innerHTML = `<span style="color:${BONANZA.ACCENT_COLOR};font-weight:600;">${BONANZA.FUND_NAME}</span> <small style="color:#aaa;">(direct)</small>`;
            const entryCell = document.createElement("td");
            entryCell.textContent = `${donation.percent}%`;
            const prizeCell = document.createElement("td");
            prizeCell.textContent = donation.total.toLocaleString();
            const giftCell = document.createElement("td");
            giftCell.style.textAlign = "center";

            giftCell.innerHTML = `<span class="gift-spinner" title="Checking BON Pool contribution…"></span>`;
            fundRow.classList.add("gift-pending");

            fundRow.append(userCell, entryCell, prizeCell, giftCell);
            tbody.appendChild(fundRow);
        }
    }

    function getFundRow() {
        const table = document.getElementById("entriesTable");
        return table ? table.querySelector('tbody tr[data-fund-row="1"]') : null;
    }

    function markFundGiftStatus(status) {
        const row = getFundRow();
        if (!row) return;
        row.classList.remove("gift-pending", "gift-failed", "gift-confirmed");
        const cell = row.children[3];
        if (status === "confirmed") {
            row.classList.add("gift-confirmed");
            if (cell) cell.textContent = "✓";
        } else {
            row.classList.add("gift-failed");
            if (cell) cell.textContent = "⚠";
        }
    }

    function getWinnerRowByRecipient(recipientName) {
        if (!recipientName) return null;
        const key = encodeURIComponent(normalizeUserKey(recipientName));

        const table = document.getElementById("entriesTable");
        if (!table) return null;

        return table.querySelector(`tbody tr[data-winner-key="${key}"]`);
    }

    function markWinnerGiftConfirmed(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-failed");
        row.classList.add("gift-confirmed");

        const key = normalizeUserKey(recipientName);
        winnerGiftStatus.set(key, "confirmed");

        const cells = row.children;
        if (cells.length >= 4) {
            cells[3].textContent = "✓";
        }
    }

    function markWinnerGiftSelf(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-failed", "gift-confirmed");
        row.classList.add("gift-self");

        const key = normalizeUserKey(recipientName);
        if (key) winnerGiftStatus.set(key, "self");

        const cells = row.children;
        if (cells.length >= 4) {
            // "No gift" indicator (host winner can't gift to self)
            cells[3].textContent = "Self";
            cells[3].title = "Host winner (no self-gift)";
        }
    }


    function markWinnerGiftFailed(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-confirmed");
        row.classList.add("gift-failed");

        const key = normalizeUserKey(recipientName);
        winnerGiftStatus.set(key, "failed");

        const cells = row.children;
        if (cells.length >= 4) {
            cells[3].textContent = "⚠";
        }
    }

    function markAllPendingWinnerGiftsFailed() {
        const table = document.getElementById("entriesTable");
        if (!table) return;

        const rows = table.querySelectorAll('tbody tr.gift-pending[data-winner-key]');
        rows.forEach(row => {
            const keyEnc = row.dataset.winnerKey || "";
            let key = "";
            try { key = decodeURIComponent(keyEnc); } catch (_) { key = keyEnc; }

            const normKey = normalizeUserKey(key);
            if (normKey) winnerGiftStatus.set(normKey, "failed");

            row.classList.remove("gift-pending", "gift-confirmed");
            row.classList.add("gift-failed");

            const cells = row.children;
            if (cells.length >= 4) {
                cells[3].textContent = "⚠";
            }
        });

        const fundRow = getFundRow();
        if (fundRow && fundRow.classList.contains("gift-pending")) markFundGiftStatus("failed");
    }

    // Fetch wrapper that *cannot* hang forever
    async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(t);
        }
    }

    async function getLatestMainChatReplayBoundary() {
        try {
            const url = new URL(`/api/chat/messages/${DARKPEERS_MAIN_CHATROOM_ID}`, location.origin);
            const res = await fetchWithTimeout(
                url,
                { credentials: "include", cache: "no-store" },
                5000
            );
            if (!res || !res.ok) return null;

            const payload = await res.json();
            const messages = Array.isArray(payload?.data) ? payload.data : [];
            let latest = null;

            for (const message of messages) {
                const rawTimestamp = String(message?.created_at || "").trim();
                const ts = Date.parse(rawTimestamp);
                if (!Number.isFinite(ts)) continue;

                const resolutionMs = unit3dTimestampResolutionMs(rawTimestamp);
                if (!latest || ts > latest.ts) {
                    latest = { ts, resolutionMs };
                } else if (latest && ts === latest.ts) {
                    latest.resolutionMs = Math.max(latest.resolutionMs, resolutionMs);
                }
            }

            return latest;
        } catch {
            return null;
        }
    }

    async function getLatestChatMessageId(roomId = chatroomId) {
        try {
            const targetRoomId = String(roomId || "").trim();
            if (!targetRoomId) return null;
            const url = new URL(`/api/chat/messages/${targetRoomId}`, location.origin);
            const res = await fetchWithTimeout(url, { credentials: "include" }, 5000);
            if (!res || !res.ok) return null;
            const payload = await res.json();
            const messages = Array.isArray(payload && payload.data) ? payload.data : [];
            let maxId = null;
            for (const m of messages) {
                const id = Math.floor(Number(m && m.id));
                if (!Number.isFinite(id)) continue;
                if (maxId === null || id > maxId) maxId = id;
            }
            return maxId;
        } catch {
            return null;
        }
    }

    /**
     * After gifts are sent, poll the chat API a few times to confirm that the
     * expected host→recipient gift messages appeared. If we can't confirm them,
     * warn in chat that gifting may have failed.
     *
     * Expected gifts are a list rather than a per-recipient map because the fund
     * manager may legitimately receive two gifts (winnings + donation), possibly
     * for identical amounts. Each chat message may satisfy at most one entry.
     *
     * @param {Array<{recipient:string, amount:number, purpose:string}>} expectedGifts
     * @param {string} hostName
     * @param {{afterId?:number|null, notBeforeTs?:number|null}} verificationContext
     */
    async function verifySponsorRefundGifts(expectedGifts, hostName, baselineRows, fallbackContext = {}) {
        const statementId = fallbackContext?.statementId ?? currentStatement?.id ?? null;
        fallbackContext = { ...fallbackContext, statementId };
        const verificationStillOwned = () => canMutateActiveGiveaway();
        const expected = (Array.isArray(expectedGifts) ? expectedGifts : [])
            .map(g => ({
                recipient: String(g?.recipient || "").trim(),
                key: normalizeUserKey(g?.recipient),
                amount: Math.max(0, Math.floor(Number(g?.amount) || 0)),
                purpose: GIFT_PURPOSE.SPONSOR_REFUND,
                done: false
            }))
            .filter(g => g.recipient && g.key && g.amount > 0);

        if (!expected.length) return true;

        if (REHEARSAL_MODE) {
            for (const gift of expected) {
                updateStatementGiftStatus(gift.recipient, gift.purpose, "dry-run", statementId);
            }
            logEvent(
                "Rehearsal refund verification",
                `Suppressed and accepted ${expected.length} simulated sponsor refund(s).`
            );
            return true;
        }

        const tracker = window.__activeTracker;
        const canUseHistory = Array.isArray(baselineRows) && tracker && typeof tracker.fetchRecentGiftHistory === "function";
        const selfKeys = resolveSelfKeys(hostName);

        if (!canUseHistory || !selfKeys.size) {
            logEvent("Sponsor refund verification fallback", "Gift History baseline unavailable; using chat API verification.");
            return await verifyWinnerGifts(expected, hostName, fallbackContext);
        }

        const baselineCounts = new Map();
        for (const row of baselineRows) {
            const key = giftHistoryBaseKey(row);
            if (!key) continue;
            baselineCounts.set(key, (baselineCounts.get(key) || 0) + 1);
        }

        const maxAttempts = 6;
        const delayMs = 2500;
        let successfulReads = 0;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (attempt > 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
                if (!verificationStillOwned()) return false;
            }

            let rows;
            try {
                rows = await tracker.fetchRecentGiftHistory();
                if (!verificationStillOwned()) return false;
                successfulReads += 1;
            } catch (e) {
                if (!verificationStillOwned()) return false;
                logEvent("Sponsor refund Gift History retry", `Attempt ${attempt}/${maxAttempts}: ${String(e?.message || e)}`);
                continue;
            }

            const currentCounts = new Map();
            const freshRows = [];
            for (const row of rows) {
                const key = giftHistoryBaseKey(row);
                if (!key) continue;
                const occurrence = (currentCounts.get(key) || 0) + 1;
                currentCounts.set(key, occurrence);
                if (occurrence > (baselineCounts.get(key) || 0)) freshRows.push(row);
            }

            const consumed = new Set();
            for (const gift of expected) {
                if (gift.done) continue;
                const index = freshRows.findIndex((row, idx) =>
                    !consumed.has(idx) &&
                    selfKeys.has(normalizeUserKey(row?.sender)) &&
                    normalizeUserKey(row?.recipient) === gift.key &&
                    Math.max(0, Math.floor(Number(row?.amount) || 0)) === gift.amount &&
                    sanitizeSponsorGiftMessage(row?.message) === SPONSOR_REFUND_NOTE
                );
                if (index < 0) continue;
                consumed.add(index);
                gift.done = true;
                updateStatementGiftStatus(gift.recipient, gift.purpose, "confirmed-history", statementId);
            }

            if (expected.every(g => g.done)) {
                if (!verificationStillOwned()) return false;
                const targetStatement = getStatementRecordById(statementId);
                if (targetStatement) {
                    targetStatement.verification = "all sponsor refunds confirmed in Gift History";
                    persistStatementRecord(targetStatement);
                }
                return true;
            }
        }

        if (successfulReads === 0) {
            if (!verificationStillOwned()) return false;
            logEvent("Sponsor refund verification fallback", "Gift History became unavailable; using chat API verification.");
            return await verifyWinnerGifts(expected, hostName, fallbackContext);
        }

        if (!verificationStillOwned()) return false;
        const missing = expected.filter(g => !g.done);
        missing.forEach(g => updateStatementGiftStatus(g.recipient, g.purpose, "failed", statementId));
        const targetStatement = getStatementRecordById(statementId);
        if (targetStatement) {
            targetStatement.verification = `${missing.length} sponsor refund(s) could not be confirmed in Gift History`;
            persistStatementRecord(targetStatement);
        }

        const missingList = missing
            .map(g => `${sanitizeNick(g.recipient)} (${fmtBONCurrency(g.amount)} BON)`)
            .join(", ");
        logEvent("Sponsor refund verification warning", `Gift History could not confirm: ${missingList}`);
        if (!verificationStillOwned()) return false;
        const refundWarning =
            `[color=#ff4f4f][b]Warning:[/b][/color] Some sponsor refunds could not be confirmed. ` +
            `Please verify manually: ${missingList}.`;
        const refundWarningSender = fallbackContext?.settlementOutputSender;
        if (typeof refundWarningSender !== "function") {
            logEvent(
                "Sponsor refund verification warning not emitted",
                "Checkpointed settlement-output sender is unavailable; refusing an uncheckpointed public warning."
            );
            return false;
        }
        if (!(await refundWarningSender(
            refundWarning,
            "sponsor refund verification warning",
            "sponsor-refund-verification-warning"
        ))) return false;
        if (!verificationStillOwned()) return false;
        return false;
    }

    async function verifyWinnerGifts(expectedGifts, hostName, verificationContext = {}) {
        const statementId = verificationContext?.statementId ?? currentStatement?.id ?? null;
        const verificationStillOwned = () => canMutateActiveGiveaway();
        const verificationGiveawayId = getActiveGiveawayId();

        try {
            const afterId = Number.isFinite(Number(verificationContext?.afterId))
                ? Math.floor(Number(verificationContext.afterId))
                : null;
            const notBeforeTs = Number.isFinite(Number(verificationContext?.notBeforeTs))
                ? Number(verificationContext.notBeforeTs)
                : null;
            const baselineRows = Array.isArray(verificationContext?.giftHistoryBaseline)
                ? verificationContext.giftHistoryBaseline
                : null;
            const selfKeys = resolveSelfKeys(hostName);

            if (!selfKeys.size) {
                if (currentStatement && statementId != null && String(currentStatement.id) === String(statementId)) {
                    markAllPendingWinnerGiftsFailed();
                }
                const targetStatement = getStatementRecordById(statementId);
                if (targetStatement) {
                    targetStatement.verification = "could not verify (host name unknown)";
                    persistStatementRecord(targetStatement);
                }
                return false;
            }

            const expected = (Array.isArray(expectedGifts) ? expectedGifts : [])
                .map(g => ({
                    recipient: String(g?.recipient || "").trim(),
                    key: normalizeUserKey(g?.recipient),
                    amount: Math.round(Number(g?.amount) || 0),
                    message: sanitizeSponsorGiftMessage(g?.message || ""),
                    purpose: g?.purpose || GIFT_PURPOSE.WINNER,
                    done: false
                }))
                .filter(g => g.recipient && g.amount > 0 && !selfKeys.has(g.key));

            if (!expected.length) return true;

            const describe = g => `${sanitizeNick(g.recipient)} (${fmtBONCurrency(g.amount)} BON)`;
            const canTouchLiveUI = () =>
                !!giveawayData &&
                getActiveGiveawayId() === verificationGiveawayId &&
                (
                    statementId == null ||
                    (
                        currentStatement &&
                        String(currentStatement.id) === String(statementId)
                    )
                );

            function markConfirmed(g, status = "confirmed") {
                if (canTouchLiveUI()) markWinnerGiftConfirmed(g.recipient);
                updateStatementGiftStatus(g.recipient, g.purpose, status, statementId);
            }

            function markFailed(g) {
                if (canTouchLiveUI()) markWinnerGiftFailed(g.recipient);
                updateStatementGiftStatus(g.recipient, g.purpose, "failed", statementId);
            }

            if (REHEARSAL_MODE) {
                for (const gift of expected) {
                    markConfirmed(gift, "dry-run");
                }
                finalizeStatementVerification(true, 0, statementId);
                logEvent(
                    "Rehearsal payout verification",
                    `Suppressed and accepted ${expected.length} simulated gift(s).`
                );
                return true;
            }

            // 1) PRIMARY RECEIPT: authenticated persistent Gift History.
            // System room is only a rolling 100-message view; Gift History is the
            // durable record of whether the transfer actually exists.
            const tracker = window.__activeTracker;
            const canUseHistory =
                baselineRows &&
                tracker &&
                typeof tracker.fetchRecentGiftHistory === "function";

            if (canUseHistory) {
                const baselineCounts = new Map();
                for (const row of baselineRows) {
                    const key = giftHistoryBaseKey(row);
                    if (!key) continue;
                    baselineCounts.set(key, (baselineCounts.get(key) || 0) + 1);
                }

                let successfulHistoryReads = 0;
                const historyAttempts = 6;
                const historyDelayMs = 2000;

                for (let attempt = 1; attempt <= historyAttempts; attempt++) {
                    if (attempt > 1) {
                        await new Promise(resolve => setTimeout(resolve, historyDelayMs));
                        if (!verificationStillOwned()) return false;
                    }

                    try {
                        const rows = await tracker.fetchRecentGiftHistory();
                        if (!verificationStillOwned()) return false;
                        successfulHistoryReads += 1;

                        const currentCounts = new Map();
                        const freshRows = [];
                        for (const row of rows) {
                            const key = giftHistoryBaseKey(row);
                            if (!key) continue;
                            const occurrence = (currentCounts.get(key) || 0) + 1;
                            currentCounts.set(key, occurrence);
                            if (occurrence > (baselineCounts.get(key) || 0)) {
                                freshRows.push(row);
                            }
                        }

                        const consumed = new Set();
                        for (const gift of expected) {
                            if (gift.done) continue;

                            let matchIndex = freshRows.findIndex((row, idx) =>
                                !consumed.has(idx) &&
                                selfKeys.has(normalizeUserKey(row?.sender)) &&
                                normalizeUserKey(row?.recipient) === gift.key &&
                                Math.max(0, Math.floor(Number(row?.amount) || 0)) === gift.amount &&
                                (
                                    !gift.message ||
                                    sanitizeSponsorGiftMessage(row?.message) === gift.message
                                )
                            );

                            // Message text is an additional discriminator, not a
                            // reason to reject an otherwise exact durable receipt if
                            // UNIT3D normalises whitespace/emoji in the stored note.
                            if (matchIndex < 0) {
                                matchIndex = freshRows.findIndex((row, idx) =>
                                    !consumed.has(idx) &&
                                    selfKeys.has(normalizeUserKey(row?.sender)) &&
                                    normalizeUserKey(row?.recipient) === gift.key &&
                                    Math.max(0, Math.floor(Number(row?.amount) || 0)) === gift.amount
                                );
                            }

                            if (matchIndex < 0) continue;
                            consumed.add(matchIndex);
                            gift.done = true;
                            markConfirmed(gift, "confirmed-history");
                        }

                        if (expected.every(g => g.done)) {
                            finalizeStatementVerification(true, 0, statementId);
                            return true;
                        }
                    } catch (e) {
                        if (!verificationStillOwned()) return false;
                        logEvent(
                            "Winner Gift History verify retry",
                            `Attempt ${attempt}/${historyAttempts}: ${String(e?.message || e)}`
                        );
                    }
                }

                if (successfulHistoryReads > 0) {
                    logEvent(
                        "Winner Gift History pending",
                        "Persistent Gift History did not yet confirm every expected payout; the System room will be checked for diagnostics only."
                    );
                } else {
                    logEvent(
                        "Winner Gift History unavailable",
                        "No authoritative Gift History read succeeded; the System room will be checked for diagnostics only."
                    );
                }
            } else {
                logEvent(
                    "Winner Gift History baseline unavailable",
                    "Durable payout verification is impossible without the pre-transfer Gift History baseline; System room evidence is diagnostic only."
                );
            }

            // 2) SECONDARY EVIDENCE ONLY: genuine DPBot/SystemBot messages in room 2.
            // A rolling chat event may show that a POST probably landed, but it is
            // NOT a durable receipt and can never unlock the irreversible BON Pool
            // leg. Only persistent Gift History may set gift.done=true.
            const systemObserved = new Set();
            const remainingBeforeChat = expected.filter(g => !g.done);
            if (remainingBeforeChat.length) {
                const maxAttempts = 5;
                const delayMs = 3000;
                const fetchTimeoutMs = 5000;
                const consumedMessageIds = new Set();

                // Allow DPBot a moment to emit the event.
                await new Promise(resolve => setTimeout(resolve, 1500));
                if (!verificationStillOwned()) return false;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                        const url = new URL(`/api/chat/messages/${chatroomId}`, location.origin);
                        if (afterId !== null) url.searchParams.set("after_id", String(afterId));
                        const res = await fetchWithTimeout(
                            url,
                            { credentials: "include", cache: "no-store" },
                            fetchTimeoutMs
                        );
                        if (!verificationStillOwned()) return false;

                        if (res?.ok) {
                            const payload = await res.json();
                            if (!verificationStillOwned()) return false;
                            const messages = Array.isArray(payload?.data) ? payload.data : [];

                            for (const m of messages) {
                                const numericMsgId = Math.floor(Number(m?.id));
                                if (
                                    afterId !== null &&
                                    Number.isFinite(numericMsgId) &&
                                    numericMsgId <= afterId
                                ) continue;

                                const createdAt = Date.parse(m?.created_at);
                                if (
                                    notBeforeTs !== null &&
                                    Number.isFinite(createdAt) &&
                                    createdAt < (notBeforeTs - 5000)
                                ) continue;

                                const msgId = m?.id != null ? String(m.id) : null;
                                if (msgId && consumedMessageIds.has(msgId)) continue;
                                if (!m?.bot?.is_systembot) continue;

                                const gift = parseGiftMessage(m.message);
                                if (!gift?.gifter || !gift?.recipient) continue;
                                if (!selfKeys.has(normalizeUserKey(gift.gifter))) continue;

                                const recKey = normalizeUserKey(gift.recipient);
                                const amt = Math.round(Number(gift.amount) || 0);
                                const match = expected.find(g =>
                                    !g.done &&
                                    g.key === recKey &&
                                    g.amount === amt
                                );
                                if (!match) continue;

                                if (msgId) consumedMessageIds.add(msgId);
                                systemObserved.add(match.key + "::" + match.amount);
                                updateStatementGiftStatus(
                                    match.recipient,
                                    match.purpose,
                                    "observed-system",
                                    statementId
                                );
                            }
                        }
                    } catch (e) {
                        if (!verificationStillOwned()) return false;
                        logEvent(
                            "Winner System-room verify retry",
                            `Attempt ${attempt}/${maxAttempts}: ${String(e?.message || e)}`
                        );
                    }

                    if (!verificationStillOwned()) return false;

                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        if (!verificationStillOwned()) return false;
                    }
                }
            }

            if (!verificationStillOwned()) return false;
            const missing = expected.filter(g => !g.done);
            for (const gift of missing) {
                const observedKey = gift.key + "::" + gift.amount;
                if (systemObserved.has(observedKey)) {
                    updateStatementGiftStatus(
                        gift.recipient,
                        gift.purpose,
                        "observed-system",
                        statementId
                    );
                } else {
                    markFailed(gift);
                }
            }
            finalizeStatementVerification(false, missing.length, statementId);

            const missingList = missing.map(describe).join(", ");
            const observedList = missing
                .filter(g => systemObserved.has(g.key + "::" + g.amount))
                .map(describe)
                .join(", ");
            logEvent(
                "Payout verification warning",
                `Persistent Gift History did not confirm: ${missingList}` +
                (observedList ? ` | System room observed (diagnostic only): ${observedList}` : "")
            );
            if (!verificationStillOwned()) return false;
            const payoutWarning =
                `[color=#ff4f4f][b]Warning:[/b][/color] ` +
                `Some giveaway gifts could not be confirmed. ` +
                `Please manually verify BON for: ${missingList}.`;
            const payoutWarningSender = verificationContext?.settlementOutputSender;
            if (typeof payoutWarningSender !== "function") {
                logEvent(
                    "Payout verification warning not emitted",
                    "Checkpointed settlement-output sender is unavailable; refusing an uncheckpointed public warning."
                );
                return false;
            }
            if (!(await payoutWarningSender(
                payoutWarning,
                "payout verification warning",
                "payout-verification-warning"
            ))) return false;
            if (!verificationStillOwned()) return false;
            return false;
        } catch (e) {
            if (!verificationStillOwned()) return false;
            logEvent(
                "Payout verification error",
                `Unexpected error while confirming winner gifts: ${String(e?.message || e)}`
            );
            if (
                currentStatement &&
                statementId != null &&
                String(currentStatement.id) === String(statementId)
            ) {
                markAllPendingWinnerGiftsFailed();
            }
            const targetStatement = getStatementRecordById(statementId);
            if (targetStatement) {
                targetStatement.verification = "verification error, check manually";
                persistStatementRecord(targetStatement);
            }
            return false;
        }
    }

    // ───────────────────────────────────────────────────────────
