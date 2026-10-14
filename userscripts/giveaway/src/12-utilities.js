    // SECTION 12: Utility Functions
    // ───────────────────────────────────────────────────────────
    // Returns true when we're in the "just started" window where entry attempts
    // should be silently ignored (to catch ultra-fast auto-joiners).
    function isWithinEntryIgnoreWindow() {
        if (!giveawayStartTime) return false;
        const elapsed = Date.now() - giveawayStartTime.getTime();
        return elapsed >= 0 && elapsed < ENTRY_IGNORE_WINDOW_MS;
    }

    /**
     * Uniformly pick one FREE number without materialising the entire numeric range.
     * Complexity depends on the number of existing entries, not on end-start.
     */
    function pickRandomFreeNumber(data) {
        if (!data) return null;
        const start = Math.ceil(Number(data.startNum));
        const end = Math.floor(Number(data.endNum));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

        const taken = Array.from(new Set(numberEntries.values()))
            .map(Number)
            .filter(n => Number.isInteger(n) && n >= start && n <= end)
            .sort((a, b) => a - b);

        const totalSlots = end - start + 1;
        const freeCount = totalSlots - taken.length;
        if (freeCount <= 0) return null;

        // Pick a zero-based rank among free numbers, then map that rank back into
        // the full interval by skipping occupied values. This is exactly uniform.
        const freeRank = getRandomInt(0, freeCount - 1);
        let candidate = start + freeRank;
        for (const occupied of taken) {
            if (occupied <= candidate) candidate++;
            else break;
        }

        return candidate <= end ? candidate : null;
    }

    // Return a small random sample of free numbers in the current range
    // (used by both !free and the "number already taken" messages)
    function getFreeNumberSample(giveawayData, sampleSize = 5) {
        if (!giveawayData) return [];

        const taken = new Set(numberEntries.values());
        const startNum = giveawayData.startNum;
        const endNum = giveawayData.endNum;
        const totalSlots = endNum - startNum + 1;

        if (totalSlots <= 0) return [];

        // Same optimization as !free: for huge ranges with very few taken numbers
        if (totalSlots > 100000 && taken.size / totalSlots < 0.01) {
            const sample = new Set();
            let attempts = 0, maxAttempts = 1000;

            while (sample.size < sampleSize && attempts < maxAttempts) {
                attempts++;
                const candidate = getRandomInt(startNum, endNum);
                if (!taken.has(candidate)) sample.add(candidate);
            }

            const result = [...sample];
            result.sort((a, b) => a - b);
            return result;
        }

        // Normal case: build an array of all free numbers and shuffle a subset
        const freeNumbers = [];
        for (let k = startNum; k <= endNum; k++) {
            if (!taken.has(k)) freeNumbers.push(k);
        }
        if (!freeNumbers.length) return [];

        const actualSampleSize = Math.min(sampleSize, freeNumbers.length);
        // Fisher–Yates style partial shuffle
        for (let i = 0; i < actualSampleSize; i++) {
            const j = i + Math.floor(Math.random() * (freeNumbers.length - i));
            [freeNumbers[i], freeNumbers[j]] = [freeNumbers[j], freeNumbers[i]];
        }

        const result = freeNumbers.slice(0, actualSampleSize);
        result.sort((a, b) => a - b);
        return result;
    }

    // Nicely format "here are some free numbers you can try…" text.
    // Respects the "Free" toggle: if !free is disabled, this returns an empty string.
    function formatFreeNumberSuggestion(giveawayData) {
        if (!giveawayData || GENERAL_SETTINGS.disable_free) return "";

        const sample = getFreeNumberSample(giveawayData, 5);
        if (!sample.length) {
            return " There are no free numbers left!";
        }

        const rigHint = rigNote("(these are some [b]suspiciously good[/b] numbers, trust me...) 😏");
        return ` Here are some free numbers you can try: [b][color=#1DDC5D]${sample.join(", ")}[/color][/b].` + rigHint;
    }

    /**
     * Uniform random integer in [min, max]. Uses the browser's cryptographic
     * source (crypto.getRandomValues) with rejection sampling so every value in
     * the range is equally likely; falls back to Math.random only if the crypto
     * API is unavailable.
     */
    function getRandomInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        if (!(max >= min)) return min;
        const range = max - min + 1;

        const c = (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") ? crypto : null;
        if (c && range <= 0x100000000) {
            const buf = new Uint32Array(1);
            const limit = 0x100000000 - (0x100000000 % range); // reject values above this to avoid modulo bias
            for (let i = 0; i < 64; i++) {
                c.getRandomValues(buf);
                if (buf[0] < limit) return min + (buf[0] % range);
            }
            // Statistically unreachable (each rejection has probability < 0.5); fall through.
        }
        return Math.floor(Math.random() * range) + min;
    }

    /**
     * Minimum gross pot needed for the weighted N..1 payout scheme to give every
     * announced winner at least 1 BON. The last rank has weight 1, so the exact
     * threshold is the triangular number N(N+1)/2.
     */
    function minimumPotForWeightedWinners(count) {
        const n = Math.max(1, Math.min(MAX_WINNERS, Math.floor(Number(count) || 1)));
        return (n * (n + 1)) / 2;
    }

    function maxWeightedWinnersForPot(pot) {
        const available = Math.max(0, Math.floor(Number(pot) || 0));
        let max = 0;
        for (let n = 1; n <= MAX_WINNERS; n++) {
            if (minimumPotForWeightedWinners(n) > available) break;
            max = n;
        }
        return Math.max(1, max);
    }

    // ───────────── BON Pool helpers ─────────────

    /**
     * Split gross prizes into winner net prizes plus one exact BON Pool share.
     *
     * The public percentage applies to the whole pot:
     *   poolTarget = floor(sum(gross) * pct / 100)
     *
     * We first floor each proportional per-winner deduction, then distribute the
     * small rounding remainder by largest fractional remainder. A deduction is
     * never allowed to reduce a positive gross prize below 1 BON.
     *
     * @param {number[]} allocated gross prizes
     * @param {number} percent 0..50 in steps of 5
     * @returns {{percent:number, net:number[], donations:number[], total:number}}
     */
    function computeDonationSplit(allocated, percent) {
        const pct = normalizeDonationPercent(percent);
        const gross = (Array.isArray(allocated) ? allocated : [])
            .map(a => Math.max(0, Math.floor(Number(a) || 0)));

        if (pct <= 0 || !gross.length) {
            return { percent: 0, net: gross.slice(), donations: gross.map(() => 0), total: 0 };
        }

        const grossTotal = gross.reduce((sum, g) => sum + g, 0);
        const target = Math.floor(grossTotal * pct / 100);
        const donations = gross.map(g => Math.floor(g * pct / 100));
        let remaining = target - donations.reduce((sum, d) => sum + d, 0);

        if (remaining > 0) {
            const order = gross.map((g, i) => ({
                i,
                remainder: (g * pct) % 100,
                gross: g
            })).sort((a, b) =>
                (b.remainder - a.remainder) ||
                (b.gross - a.gross) ||
                (a.i - b.i)
            );

            for (const item of order) {
                if (remaining <= 0) break;
                const i = item.i;
                if (donations[i] < Math.max(0, gross[i] - 1)) {
                    donations[i] += 1;
                    remaining -= 1;
                }
            }

            // Defensive fallback. With pct <= 30 and funded weighted prizes the
            // first pass is sufficient, but never return an under-target pool.
            if (remaining > 0) {
                for (let i = 0; i < gross.length && remaining > 0; i++) {
                    while (remaining > 0 && donations[i] < Math.max(0, gross[i] - 1)) {
                        donations[i] += 1;
                        remaining -= 1;
                    }
                }
            }
        }

        const net = gross.map((g, i) => g - donations[i]);
        const total = donations.reduce((sum, d) => sum + d, 0);

        selfCheck(total === target, "BON Pool split did not reach exact target", {
            grossTotal, pct, target, total, remaining
        });
        selfCheck(net.every((n, i) => gross[i] === 0 ? n === 0 : n >= 1), "BON Pool split produced zero/negative winner payout", {
            gross, donations, net
        });

        return { percent: pct, net, donations, total };
    }

    // ───────────── End-of-giveaway statements ─────────────
    // A plain-text record of every transaction in a giveaway, built when the
    // giveaway ends and updated as gift confirmations arrive. The last few are
    // kept in localStorage so the host (or the BON Pool) can save them later.

    let currentStatement = null; // record for the giveaway that just ended

    function normalizeStatementRecord(record) {
        if (!record || typeof record !== "object") return record;

        const normalized = { ...record };
        const hasExplicitMode = typeof normalized.rehearsalMode === "boolean";

        // v1.5.9 statements predate rehearsalMode but already lived in a
        // rehearsal-specific storage namespace. Therefore the current storage
        // context is authoritative when the field is absent.
        if (!hasExplicitMode) {
            normalized.rehearsalMode = REHEARSAL_MODE;
        }

        if (normalized.rehearsalMode && !hasExplicitMode) {
            if (
                normalized.donationTotal > 0 &&
                /^confirmed directly in BON Pool/.test(String(normalized.donationStatus || ""))
            ) {
                normalized.donationStatus =
                    "simulated only (legacy rehearsal; no BON Pool contribution sent)";
            }

            if (
                normalized.verification === "nothing to verify" ||
                normalized.verification === "all gifts confirmed in DarkPeers"
            ) {
                normalized.verification =
                    "rehearsal simulation complete; no BON-moving requests sent";
            }
        }

        return normalized;
    }

    function isRehearsalStatementRecord(record) {
        if (!record || typeof record !== "object") return false;
        return typeof record.rehearsalMode === "boolean"
            ? record.rehearsalMode
            : REHEARSAL_MODE;
    }

    function readStatements() {
        try {
            const raw = localStorage.getItem(LS_STATEMENTS);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.map(normalizeStatementRecord) : [];
        } catch { return []; }
    }

    function writeStatements(list) {
        try { localStorage.setItem(LS_STATEMENTS, JSON.stringify(list.slice(0, STATEMENTS_KEEP))); } catch {}
    }

    function persistStatementRecord(record, { selectLatest = false } = {}) {
        if (!record || record.id == null) return;
        const list = readStatements();
        const index = list.findIndex(r => r && String(r.id) === String(record.id));
        if (index >= 0) {
            list[index] = record;
        } else {
            list.unshift(record);
        }
        writeStatements(list);
        if (currentStatement && String(currentStatement.id) === String(record.id)) {
            currentStatement = record;
        }
        renderStatementControls({ selectLatest });
    }

    function persistCurrentStatement() {
        if (!currentStatement) return;
        persistStatementRecord(currentStatement, { selectLatest: true });
    }

    function getStatementRecordById(statementId) {
        if (statementId == null) return currentStatement;
        if (currentStatement && String(currentStatement.id) === String(statementId)) {
            return currentStatement;
        }
        return readStatements().find(r => r && String(r.id) === String(statementId)) || null;
    }

    function statementTimestamp(ms) {
        const d = new Date(ms);
        const pad = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function statementFilename(rec) {
        const d = new Date(rec.endedAt);
        const pad = n => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
        const host = String(rec.host || "host").replace(/[^A-Za-z0-9_-]/g, "");
        return `BONanza-statement_${stamp}_${host}.txt`;
    }

    /**
     * Create the statement record at the end of a giveaway.
     * @param {object} p  { winners, gross, net, donations, split, poolStatus, entrants, refunds? }
     */
    function createStatementRecord(p) {
        const data = giveawayData;
        if (!data) return null;
        const hostKey = normalizeUserKey(data.host);
        const potTotal = Math.max(0, Math.floor(Number(data.amount) || 0));
        const sponsorGiftMessages = Array.isArray(data.sponsorGiftMessages)
            ? data.sponsorGiftMessages
            : [];
        const sponsors = Object.entries(data.sponsorContribs || {})
            .map(([name, amt]) => ({
                name,
                amount: Math.max(0, Math.floor(Number(amt) || 0)),
                isHost: normalizeUserKey(name) === hostKey,
                messages: sponsorGiftMessages
                    .filter(item => normalizeUserKey(item?.sponsor) === normalizeUserKey(name))
                    .map(item => ({
                        amount: Math.max(0, Math.floor(Number(item?.amount) || 0)),
                        message: sanitizeSponsorGiftMessage(item?.message),
                        createdAtTs: Number.isFinite(Number(item?.createdAtTs))
                            ? Number(item.createdAtTs)
                            : null
                    }))
                    .filter(item => item.message)
            }))
            .filter(x => x.amount > 0)
            .sort((a, b) => b.amount - a.amount);
        const sponsoredTotal = sponsors.filter(x => !x.isHost).reduce((s, x) => s + x.amount, 0);
        const initialHostFunding = Math.max(0, Math.floor(Number(data.initialPotVerifiedAtStart) || 0));
        const cumulativeHostFunding = Math.max(
            initialHostFunding,
            Math.floor(Number(data.hostAdded ?? initialHostFunding) || 0)
        );
        const hostTopUps = Math.max(0, cumulativeHostFunding - initialHostFunding);

        const winners = (p.winners || []).map((w, i) => ({
            place: i + 1,
            user: w.author,
            guess: w.guess,
            gap: w.gap,
            gross: p.gross[i],
            donation: p.donations[i],
            net: p.net[i],
            status: (normalizeUserKey(w.author) === hostKey)
                ? (REHEARSAL_MODE ? "simulated self (host, no gift sent)" : "self (host, no gift sent)")
                : "sent, awaiting confirmation"
        }));

        const pct = p.split ? p.split.percent : 0;
        const donationTotal = p.split ? p.split.total : 0;
        const refunds = (Array.isArray(p.refunds) ? p.refunds : [])
            .map(item => ({
                user: String(item?.user || item?.recipient || "").trim(),
                amount: Math.max(0, Math.floor(Number(item?.amount) || 0)),
                status: String(item?.status || "sent, awaiting confirmation")
            }))
            .filter(item => item.user && item.amount > 0);

        return {
            id: getActiveGiveawayId() || Date.now(),
            scriptVersion: SCRIPT_VERSION,
            rehearsalMode: REHEARSAL_MODE,
            site: location.hostname,
            host: data.host,
            startedAt: giveawayStartTime ? giveawayStartTime.getTime() : null,
            endedAt: Date.now(),
            range: [data.startNum, data.endNum],
            winningNumber: data.winningNumber,
            entrants: p.entrants,
            winnersDrawn: winners.length,
            baseWinners: data.baseWinnersAtStart || data.winnersNum,
            potTotal,
            hostFunded: Math.max(0, potTotal - sponsoredTotal),
            hostTopUps,
            sponsoredTotal,
            sponsors,
            donationPercent: pct,
            donationTotal,
            donationRecipient: "DarkPeers /bon-pool",
            donationStatus: donationTotal <= 0 ? "none" : (p.poolStatus || "contribution pending verification"),
            refunds,
            winners,
            verification: "in progress",
            notes: []
        };
    }

    /** Update a gift line in the statement captured by the verifier. */
    function updateStatementGiftStatus(recipient, purpose, status, statementId = null) {
        const targetStatement = getStatementRecordById(statementId);
        if (!targetStatement) return;
        const label = ({
            confirmed: "confirmed",
            "confirmed-history": "confirmed in Gift History",
            "confirmed-system": "confirmed in System room",
            "observed-system": "seen in System room; awaiting Gift History",
            "dry-run": "simulated (no BON sent)",
            failed: "NOT CONFIRMED, check manually",
            self: "self (host, no gift sent)"
        })[status] || status;
        const key = normalizeUserKey(recipient);

        if (purpose === GIFT_PURPOSE.SPONSOR_REFUND) {
            (targetStatement.refunds || []).forEach(refund => {
                if (normalizeUserKey(refund.user) === key) refund.status = label;
            });
        } else {
            (targetStatement.winners || []).forEach(w => {
                if (normalizeUserKey(w.user) === key) w.status = label;
            });
        }
        persistStatementRecord(targetStatement);
    }

    function finalizeStatementVerification(ok, missingCount, statementId = null) {
        const targetStatement = getStatementRecordById(statementId);
        if (!targetStatement) return;
        targetStatement.verification = isRehearsalStatementRecord(targetStatement)
            ? (
                ok
                    ? "rehearsal simulation complete; no BON-moving requests sent"
                    : `rehearsal simulation incomplete; ${missingCount} simulated gift(s) unresolved`
            )
            : (
                ok
                    ? "all gifts confirmed in DarkPeers"
                    : `${missingCount} gift(s) could not be confirmed`
            );
        persistStatementRecord(targetStatement);
    }

    function buildStatementText(rec) {
        if (!rec) return "";
        const L = [];
        const line = (ch = "=") => ch.repeat(72);
        const money = n => `${fmtBONCurrency(n)} BON`;
        const padR = (t, n) => String(t).padEnd(n);
        const padL = (t, n) => String(t).padStart(n);

        L.push(line());
        L.push("DARKPEERS BONanza GIVEAWAY STATEMENT");
        L.push(line());
        L.push(`Giveaway ID     : ${rec.id}`);
        L.push(`Site            : ${rec.site}`);
        L.push(`Host            : ${rec.host}`);
        L.push(`Mode            : ${isRehearsalStatementRecord(rec) ? "REHEARSAL / SIMULATION (no BON-moving requests sent)" : "LIVE"}`);
        L.push(`Started         : ${rec.startedAt ? statementTimestamp(rec.startedAt) : "n/a"}`);
        L.push(`Ended           : ${statementTimestamp(rec.endedAt)}`);
        L.push(`Number range    : ${rec.range[0]} - ${rec.range[1]}`);
        L.push(`Winning number  : ${rec.winningNumber}`);
        L.push(`Entrants        : ${rec.entrants}`);
        L.push(`Winners drawn   : ${rec.winnersDrawn} (base ${rec.baseWinners})`);
        L.push(`Script version  : ${rec.scriptVersion}`);
        L.push("");
        L.push(line("-"));
        L.push("POT");
        L.push(line("-"));
        L.push(`Host funded     : ${money(rec.hostFunded)}${rec.hostTopUps > 0 ? ` (includes ${money(rec.hostTopUps)} added by host during the giveaway)` : ""}`);
        L.push(`Sponsored       : ${money(rec.sponsoredTotal)}`);
        rec.sponsors.filter(x => !x.isHost).forEach(x => {
            L.push(`  ${padR(x.name, 28)} ${padL(money(x.amount), 16)}`);
            const messages = Array.isArray(x.messages) ? x.messages : [];
            messages.forEach(item => {
                const giftAmount = Number(item?.amount) > 0 ? ` [${money(item.amount)}]` : "";
                L.push(`    Message${giftAmount}: "${String(item?.message || "")}"`);
            });
        });
        L.push(`TOTAL POT       : ${money(rec.potTotal)}`);
        L.push("");
        L.push(line("-"));
        L.push(`BON POOL CONTRIBUTION`);
        L.push(line("-"));
        if (rec.donationTotal > 0) {
            L.push(`Percentage      : ${rec.donationPercent}% of the total pot (host + sponsors)`);
            L.push(`Amount          : ${money(rec.donationTotal)}`);
            L.push(`Recipient       : ${rec.donationRecipient}`);
            L.push(`Status          : ${rec.donationStatus}`);
        } else {
            L.push("None (0%). Standard giveaway.");
        }
        const refunds = Array.isArray(rec.refunds) ? rec.refunds : [];
        if (refunds.length) {
            L.push("");
            L.push(line("-"));
            L.push("SPONSOR REFUNDS");
            L.push(line("-"));
            refunds.forEach(refund => {
                L.push(`  ${padR(refund.user, 28)} ${padL(money(refund.amount), 16)}  ${refund.status}`);
            });
            const refundTotal = refunds.reduce((sum, refund) => sum + Math.max(0, Number(refund.amount) || 0), 0);
            L.push(line("-"));
            L.push(`Refunded total  : ${money(refundTotal)}`);
            L.push(`Check           : host keeps ${money(rec.hostFunded)} + refunds ${money(refundTotal)} = ${money(rec.hostFunded + refundTotal)} (pot ${money(rec.potTotal)})${rec.hostFunded + refundTotal === rec.potTotal ? " OK" : " MISMATCH"}`);
        }

        L.push("");
        L.push(line("-"));
        L.push("WINNERS AND TRANSACTIONS");
        L.push(line("-"));
        if (!rec.winners.length) {
            L.push("No entrants, no winners. No winner payout was made.");
        } else {
            L.push(`${padR("#", 3)} ${padR("User", 22)} ${padL("Guess", 6)} ${padL("Off", 5)} ${padL("Prize", 12)} ${padL("Donated", 12)} ${padL("Received", 12)}  Status`);
            rec.winners.forEach(w => {
                L.push(`${padR(w.place, 3)} ${padR(w.user, 22)} ${padL(w.guess, 6)} ${padL(w.gap, 5)} ${padL(money(w.gross), 12)} ${padL(money(w.donation), 12)} ${padL(money(w.net), 12)}  ${w.status}`);
            });
            const sumGross = rec.winners.reduce((s, w) => s + w.gross, 0);
            const sumNet = rec.winners.reduce((s, w) => s + w.net, 0);
            L.push(line("-"));
            L.push(`${padR("", 3)} ${padR("Totals", 22)} ${padL("", 6)} ${padL("", 5)} ${padL(money(sumGross), 12)} ${padL(money(rec.donationTotal), 12)} ${padL(money(sumNet), 12)}`);
            L.push("");
            L.push(`Check: winners received ${money(sumNet)} + fund ${money(rec.donationTotal)} = ${money(sumNet + rec.donationTotal)} (pot ${money(rec.potTotal)})${sumNet + rec.donationTotal === rec.potTotal ? " OK" : " MISMATCH"}`);
        }
        L.push("");
        L.push(`Gift verification: ${rec.verification}`);
        if (rec.notes && rec.notes.length) { L.push(""); rec.notes.forEach(n => L.push(`Note: ${n}`)); }
        L.push("");
        L.push(`Generated ${statementTimestamp(Date.now())} by DarkPeers BONanza Giveaway v${rec.scriptVersion}`);
        L.push(line());
        return L.join("\n");
    }

    function renderStatementControls({ selectLatest = false } = {}) {
        const row = document.getElementById("bonanzaStatementRow");
        const select = document.getElementById("bonanzaStatementSelect");
        if (!row || !select) return;
        const list = readStatements();
        if (!list.length) { row.style.display = "none"; return; }
        const previous = select.value;
        select.innerHTML = "";
        list.forEach((rec, i) => {
            const opt = document.createElement("option");
            opt.value = String(rec.id);
            const fund = rec.donationTotal > 0 ? ` | ${BONANZA.FUND_NAME} ${fmtBONCurrency(rec.donationTotal)} BON (${rec.donationPercent}%)` : " | no donation";
            opt.textContent = `${i === 0 ? "Latest: " : ""}${statementTimestamp(rec.endedAt)} | ${rec.host} | pot ${fmtBONCurrency(rec.potTotal)} BON${fund}`;
            select.appendChild(opt);
        });
        if (!selectLatest && previous && Array.from(select.options).some(o => o.value === previous)) select.value = previous;
        row.style.display = "block";
    }

    function getSelectedStatement() {
        const select = document.getElementById("bonanzaStatementSelect");
        const list = readStatements();
        if (!list.length) return null;
        const id = select ? select.value : null;
        return list.find(r => String(r.id) === String(id)) || list[0];
    }

    function downloadSelectedStatement() {
        const rec = getSelectedStatement();
        if (!rec) return;
        const text = buildStatementText(rec);
        try {
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = statementFilename(rec);
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            logEvent("Statement saved", statementFilename(rec));
        } catch (e) {
            logEvent("Statement save failed", String(e && e.message || e));
        }
    }

    async function copySelectedStatement() {
        const rec = getSelectedStatement();
        if (!rec) return;
        const text = buildStatementText(rec);
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                logEvent("Statement copied", "Copied to clipboard.");
                return;
            }
        } catch {}
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); logEvent("Statement copied", "Copied to clipboard."); } catch {}
        ta.remove();
    }

    function updateDonationHint() {
        if (!donationHint) return;
        const pct = normalizeDonationPercent(donationPercentInput ? donationPercentInput.value : 0);
        if (pct <= 0) {
            donationHint.innerHTML = riggedMode
                ? `Rigged mode is active, but the tax rate is <b>0%</b>. Suspiciously generous. No ${BONANZA.FUND_NAME} contribution.`
                : `Standard giveaway. No ${BONANZA.FUND_NAME} contribution.`;
            return;
        }
        const potRaw = coinInput ? String(coinInput.value || "").replace(/[^0-9]/g, "") : "";
        const pot = potRaw ? parseInt(potRaw, 10) : 0;
        const est = pot > 0 ? Math.floor(pot * pct / 100) : 0;
        const estText = pot > 0 ? ` About <b>${fmtBONCurrency(est)} BON</b> of a ${fmtBONCurrency(pot)} BON pot (more if sponsored).` : "";
        donationHint.innerHTML = riggedMode
            ? `🧾 <b style="color:#FF4F9A;">${pct}% rigging taxes</b> will be taken from the final pot (host + sponsors) and paid <b>directly</b> into the ${BONANZA.FUND_NAME}. Your outlay is unchanged.${estText}`
            : `<b style="color:${BONANZA.ACCENT_COLOR};">${pct}%</b> of the final pot (host + sponsors) will be contributed <b>directly</b> to the ${BONANZA.FUND_NAME}. Comes out of winnings; your outlay is unchanged.${estText}`;
    }

    function sendReminder(options = {}) {
        if (
            !giveawayData ||
            isGiveawaySettling(giveawayData) ||
            getGiveawayRemainingMs(giveawayData) <= 0
        ) {
            if (reminderRetryTimeout) {
                clearTimeout(reminderRetryTimeout);
                reminderRetryTimeout = null;
            }
            return false;
        }

        const force = !!(options && options.force);
        if (!force && !shouldSendReminder(giveawayData)) {
            // Try again in 15 seconds if still eligible
            if (!reminderRetryTimeout) {
                reminderRetryTimeout = setTimeout(() => {
                    reminderRetryTimeout = null;
                    sendReminder();
                }, 15000);
            }
            return;
        }
        // Clear retry timer if any
        if (reminderRetryTimeout) {
            clearTimeout(reminderRetryTimeout);
            reminderRetryTimeout = null;
        }

        const silentLine = silentNote("(Silent mode is enabled. Command replies are sent via /msg.) 🤫");
        const rigLine = rigNote("(Rigged mode is currently enabled, but the math is [b]definitely[/b] still legit) 😉");
        const reminderPct = normalizeDonationPercent(giveawayData.donationPercent);
        const reminderPrefix = reminderPct > 0
            ? (riggedMode
                ? `🧾 [b][color=#FF4F9A]Rigging taxes: ${reminderPct}% to the ${BONANZA.FUND_NAME}[/color][/b] 🧾\n`
                : `💙 [b][color=${BONANZA.GIVEAWAY_COLOR}]${BONANZA.FUND_NAME} contribution giveaway (${reminderPct}% to the pool)[/color][/b] 💙\n`)
            : "";
        const reminderStartMarker = reminderPct > 0
            ? (riggedMode ? BRIDGE_MARKERS.START_TAXES : BRIDGE_MARKERS.START_POOL)
            : BRIDGE_MARKERS.START;
        const reminderDonationContext = buildDonationContext(giveawayData);
        const msg = reminderPrefix +
              `${bridgeMarker(reminderStartMarker, "🎁")} Ongoing giveaway for [b][color=#ffc00a]${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON[/color][/b] | ` +
              `${buildWinnersAnnouncementLine(giveawayData)} | ` +
              `Time left: [b][color=#1DDC5D]${parseTime(getGiveawayRemainingMs(giveawayData))}[/color][/b]. ` +
              `Pick a number [b]between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color][/b]. ` +
              `[b][color=#5DE2E7]${giveawayData.customMessage}[/color][/b]` +
              (reminderDonationContext ? `\n${reminderDonationContext}` : "") +
              `\n` +
              `✨[b][color=#FB4F4F]Gift the host to add to the pot! [color=${GIFT_HINT_COLOR}]/gift ${getGiftSyntaxHostName()} AMOUNT MESSAGE[/color][/color][/b]✨` +
              silentLine +
              rigLine;
        sendMessage(msg);
    }

    // ───────────── HTTP-based BON gifting helper ─────────────

    /**
     * Per-giveaway ledger of (recipient, amount) tuples that have already been
     * attempted in this payout. Persisted to localStorage so:
     *   - A crash + restore can't replay payouts
     *   - A second tab that somehow ends the same giveaway can't double-pay
     * Keyed by giveawayId (millisecond start timestamp) + lowercase recipient + amount.
     */
    function getActiveGiveawayId() {
        // Prefer the start time of the currently-active giveaway. Falls back to
        // the snapshot's startTime field if needed. Returns null if neither exists,
        // in which case idempotency is best-effort (we still send, just don't track).
        if (giveawayStartTime) return giveawayStartTime.getTime();
        try {
            const hostName = giveawayData?.host || getLoggedInUsername();
            const stored = readActiveGiveawayRawForHost(hostName, { migrateLegacy: false });
            if (!stored.raw) return null;
            const snap = JSON.parse(stored.raw);
            return snap && snap.startTime ? snap.startTime : null;
        } catch { return null; }
    }

    function readPaidGiftsLedger() {
        try {
            const raw = localStorage.getItem(LS_PAID_GIFTS);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === "object") ? parsed : {};
        } catch { return {}; }
    }

    function writePaidGiftsLedger(ledger, { verifyWrite = false } = {}) {
        try {
            // Cap size by dropping oldest giveaway-id entries (numeric, ms timestamps)
            const ids = Object.keys(ledger).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            while (ids.length > PAID_GIFTS_MAX_GIVEAWAYS) {
                const oldest = ids.shift();
                delete ledger[oldest];
            }
            const serialized = JSON.stringify(ledger);
            localStorage.setItem(LS_PAID_GIFTS, serialized);
            if (verifyWrite && localStorage.getItem(LS_PAID_GIFTS) !== serialized) {
                throw new Error("Winner gift ledger read-back verification failed.");
            }
            return true;
        } catch (e) {
            console.warn("Winner gift ledger write failed:", e);
            return false;
        }
    }

    function readPoolContributionLedger() {
        try {
            const raw = localStorage.getItem(LS_POOL_CONTRIBUTIONS);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch { return {}; }
    }

    function writePoolContributionLedger(ledger, { verifyWrite = false } = {}) {
        try {
            const ids = Object.keys(ledger).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            while (ids.length > PAID_GIFTS_MAX_GIVEAWAYS) delete ledger[ids.shift()];
            const serialized = JSON.stringify(ledger);
            localStorage.setItem(LS_POOL_CONTRIBUTIONS, serialized);
            if (verifyWrite && localStorage.getItem(LS_POOL_CONTRIBUTIONS) !== serialized) {
                throw new Error("BON Pool contribution ledger read-back verification failed.");
            }
            return true;
        } catch (e) {
            console.warn("BON Pool contribution ledger write failed:", e);
            return false;
        }
    }

    function savePoolContributionAttempt(giveawayId, record, { verifyWrite = false } = {}) {
        if (!giveawayId) return false;
        const ledger = readPoolContributionLedger();
        ledger[String(giveawayId)] = { ...(ledger[String(giveawayId)] || {}), ...record };
        return writePoolContributionLedger(ledger, { verifyWrite });
    }

    function getPoolContributionAttempt(giveawayId) {
        if (!giveawayId) return null;
        return readPoolContributionLedger()[String(giveawayId)] || null;
    }

    function poolContributionRetryableKey(giveawayId) {
        return `${LS_POOL_CONTRIBUTIONS}::retryable::${encodeURIComponent(String(giveawayId || ""))}`;
    }

    function markPoolContributionRetryable(giveawayId, attemptToken) {
        if (!giveawayId || !attemptToken) return false;
        try {
            localStorage.setItem(poolContributionRetryableKey(giveawayId), attemptToken);
            return true;
        } catch {
            return false;
        }
    }

    function getPoolContributionRetryableState(giveawayId, record) {
        const attemptToken = typeof record?.attemptToken === "string"
            ? record.attemptToken
            : "";
        if (!giveawayId || !attemptToken) return "not-retryable";
        try {
            return localStorage.getItem(poolContributionRetryableKey(giveawayId)) === attemptToken
                ? "retryable"
                : "not-retryable";
        } catch {
            // An unreadable marker cannot safely be interpreted either way: a
            // retry might duplicate a real POST, while treating it as terminal
            // could strand a known-unsent pre-POST checkpoint.
            return "indeterminate";
        }
    }

    function isPoolContributionRetryable(giveawayId, record) {
        return getPoolContributionRetryableState(giveawayId, record) === "retryable";
    }

    function parsePoolCounter(text, label) {
        const source = String(text || "");
        const needle = String(label || "");
        const pos = source.toLowerCase().indexOf(needle.toLowerCase());
        if (pos < 0) return null;
        const tail = source.slice(pos + needle.length);
        const m = tail.match(/[0-9][0-9.,\s]*/);
        if (!m) return null;
        const digits = m[0].replace(/[^0-9]/g, "");
        const n = parseInt(digits, 10);
        return Number.isFinite(n) ? n : null;
    }

    async function fetchBonPoolPage() {
        const url = new URL(BONANZA.POOL_PATH, location.origin);
        const res = await fetchWithTimeout(url, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers: { "Accept": "text/html" }
        }, BONANZA.FETCH_TIMEOUT_MS);
        if (!res.ok) throw new Error(`BON Pool GET failed: HTTP ${res.status}`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const text = (doc.body?.textContent || "").replace(/\u00a0/g, " ");
        const total = parsePoolCounter(text, "Total contributions:");
        const mine = parsePoolCounter(text, "Your contribution:");
        const form = Array.from(doc.querySelectorAll("form")).find(el => {
            try {
                const u = new URL(el.getAttribute("action") || "", location.origin);
                return u.origin === location.origin && u.pathname === BONANZA.POOL_STORE_PATH;
            } catch { return false; }
        });
        if (!form || total == null || mine == null) throw new Error("Could not parse BON Pool form/counters.");
        const action = new URL(form.getAttribute("action") || BONANZA.POOL_STORE_PATH, location.origin);
        return { form, action: action.href, total, mine };
    }

    function urlEncodedDataFromParsedForm(form) {
        const data = new URLSearchParams();
        form.querySelectorAll("input, select, textarea").forEach(el => {
            if (!el.name || el.disabled) return;
            const type = String(el.type || "").toLowerCase();
            if ((type === "radio" || type === "checkbox") && !el.checked) return;
            data.append(el.name, el.value ?? "");
        });
        return data;
    }

    async function verifyBonPoolContribution(record) {
        const targetMine = Number(record.beforeMine) + Number(record.amount);
        const targetTotal = Number(record.beforeTotal) + Number(record.amount);
        let last = null;
        for (let i = 0; i < BONANZA.VERIFY_ATTEMPTS; i++) {
            if (i > 0) await new Promise(resolve => setTimeout(resolve, BONANZA.VERIFY_DELAY_MS));
            try {
                last = await fetchBonPoolPage();
                if (last.mine >= targetMine && last.total >= targetTotal) return { confirmed: true, snapshot: last };
            } catch (e) {
                logEvent("BON Pool verify retry", String(e?.message || e));
            }
        }
        return { confirmed: false, snapshot: last };
    }

    async function contributeBonPool(amount) {
        const safeAmount = Math.floor(Number(amount));
        if (!Number.isFinite(safeAmount) || safeAmount <= 0) return { attempted: false, confirmed: false, reason: "invalid" };
        const giveawayId = getActiveGiveawayId();
        if (!giveawayId) return { attempted: false, confirmed: false, reason: "missing-giveaway-id" };
        if (!(await ensureExclusiveTabOwnership())) {
            return { attempted: false, confirmed: false, reason: "ownership-lost" };
        }

        if (REHEARSAL_MODE) {
            logEvent(
                "Rehearsal BON Pool contribution suppressed",
                `${fmtBONCurrency(safeAmount)} BON`
            );
            return {
                attempted: true,
                confirmed: true,
                dryRun: true,
                reason: "rehearsal"
            };
        }
    
        const existing = getPoolContributionAttempt(giveawayId);
        if (existing) {
            if (existing.amount !== safeAmount) return { attempted: false, confirmed: false, reason: "amount-conflict" };
            if (existing.status === "confirmed") return { attempted: false, confirmed: true, reason: "already-confirmed", reused: true };

            // A retryable checkpoint is known to have failed before any POST was
            // initiated (typically setItem succeeded but its read-back failed).
            // Do not treat it as an ambiguous money-moving attempt: take a fresh
            // remote baseline and create a new token below. If the retryable marker
            // itself is unreadable, verification may confirm an existing transfer
            // but a new POST is forbidden until storage becomes readable again.
            const retryableState = getPoolContributionRetryableState(giveawayId, existing);
            if (retryableState !== "retryable") {
                const checked = await verifyBonPoolContribution(existing);
                if (checked.confirmed) {
                    savePoolContributionAttempt(giveawayId, {
                        status: "confirmed",
                        confirmedAt: Date.now(),
                        afterMine: checked.snapshot.mine,
                        afterTotal: checked.snapshot.total
                    });
                    return { attempted: false, confirmed: true, reason: "verified-existing", reused: true };
                }
                return {
                    attempted: false,
                    confirmed: false,
                    reason: retryableState === "indeterminate"
                        ? "retryable-marker-unavailable"
                        : "existing-unconfirmed",
                    reused: true
                };
            }

            logEvent(
                "BON Pool retrying unsent checkpoint",
                "A prior contribution checkpoint failed durability verification before POST; taking a fresh baseline and retrying safely."
            );
        }
    
        let before;
        try {
            before = await fetchBonPoolPage();
        } catch (e) {
            logEvent("BON Pool contribution aborted", String(e?.message || e));
            return { attempted: false, confirmed: false, reason: "preflight-failed" };
        }

        // The preflight itself can be frozen in BFCache. Never record/send a pool
        // transfer after that await unless this tab still owns the giveaway.
        if (!(await ensureExclusiveTabOwnership())) {
            return { attempted: false, confirmed: false, reason: "ownership-lost" };
        }
    
        const record = {
            amount: safeAmount,
            beforeMine: before.mine,
            beforeTotal: before.total,
            attemptedAt: Date.now(),
            attemptToken: `${TAB_ID}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
            status: "attempted"
        };
        if (!savePoolContributionAttempt(giveawayId, record, { verifyWrite: true })) {
            // As with winner gifts, setItem() may have succeeded even though the
            // verification read failed. No POST has happened yet, so tag this exact
            // token as retryable. A later successful attempt uses a new token, making
            // any stale marker harmless rather than risking a duplicate contribution.
            markPoolContributionRetryable(giveawayId, record.attemptToken);
            logEvent(
                "BON Pool contribution blocked",
                "The contribution-attempt ledger could not be persisted safely; refusing the irreversible POST."
            );
            return { attempted: false, confirmed: false, reason: "pool-ledger-unavailable" };
        }
    
        const data = urlEncodedDataFromParsedForm(before.form);
        data.set("type", "bon");
        data.set("contribution", String(safeAmount));
        data.set("contributionTokens", "");
        data.set("anon", "0");
    
        try {
            const res = await fetchWithTimeout(before.action, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                redirect: "follow",
                headers: {
                    "Accept": "text/html",
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                },
                body: data.toString()
            }, BONANZA.FETCH_TIMEOUT_MS);
            savePoolContributionAttempt(giveawayId, {
                httpStatus: res.status,
                postFinishedAt: Date.now(),
                status: res.ok ? "posted" : "posted-http-error"
            });
        } catch (e) {
            savePoolContributionAttempt(giveawayId, {
                postError: String(e?.message || e),
                status: "post-uncertain"
            });
        }
    
        const checked = await verifyBonPoolContribution(record);
        if (checked.confirmed) {
            savePoolContributionAttempt(giveawayId, {
                status: "confirmed",
                confirmedAt: Date.now(),
                afterMine: checked.snapshot.mine,
                afterTotal: checked.snapshot.total
            });
            logEvent(
                "BON Pool contribution confirmed",
                `${fmtBONCurrency(safeAmount)} BON | Mine ${fmtBONCurrency(before.mine)} -> ${fmtBONCurrency(checked.snapshot.mine)} | Total ${fmtBONCurrency(before.total)} -> ${fmtBONCurrency(checked.snapshot.total)}`
            );
            return { attempted: true, confirmed: true, before, after: checked.snapshot };
        }
    
        savePoolContributionAttempt(giveawayId, { status: "unconfirmed", verifyFinishedAt: Date.now() });
        return { attempted: true, confirmed: false, reason: "not-confirmed", before, after: checked.snapshot };
    }

    // Winner gifts use the gift ledger. BON Pool contributions have their own
    // persisted ledger and are verified against /bon-pool counters.
    const GIFT_PURPOSE = Object.freeze({
        WINNER: "winner",
        SPONSOR_REFUND: "sponsor-refund"
    });
    const SPONSOR_REFUND_NOTE = "Giveaway refund";

    function paidGiftKey(recipient, amount, purpose = GIFT_PURPOSE.WINNER) {
        return `${String(recipient || "").trim().toLowerCase()}::${Math.floor(Number(amount) || 0)}::${purpose}`;
    }

    function paidGiftRetryableKey(giveawayId, recipient, amount, purpose = GIFT_PURPOSE.WINNER) {
        const giftKey = paidGiftKey(recipient, amount, purpose);
        return `${LS_PAID_GIFTS}::retryable::${encodeURIComponent(String(giveawayId || ""))}::${encodeURIComponent(giftKey)}`;
    }

    function giftAttemptTokenOwner(attemptToken) {
        if (typeof attemptToken !== "string") return "";
        const separator = attemptToken.indexOf(":");
        return separator > 0 ? attemptToken.slice(0, separator) : "";
    }

    function getGiftAttemptState(giveawayId, recipient, amount, purpose) {
        if (!giveawayId) return { state: "none", token: null };
        const ledger = readPaidGiftsLedger();
        const bucket = ledger[giveawayId];
        if (!bucket) return { state: "none", token: null };

        const giftKey = paidGiftKey(recipient, amount, purpose);
        const stored = bucket[giftKey];
        if (!stored) return { state: "none", token: null };

        // Current-format string tokens are pending until the originating request
        // resolves. A matching retryable marker means a proven-rejected attempt
        // can be replaced by the next exclusive owner. Numeric/other legacy values
        // are terminal attempted entries and retain their original semantics.
        if (typeof stored === "string") {
            try {
                const retryableToken = localStorage.getItem(
                    paidGiftRetryableKey(giveawayId, recipient, amount, purpose)
                );
                if (retryableToken === stored) {
                    return { state: "retryable", token: stored };
                }
            } catch {
                // We cannot safely distinguish a known-unsent retryable token from
                // an actually pending/ambiguous transfer if this marker read fails.
                // Fail closed: never orphan-terminalize or resend it until storage
                // becomes readable again.
                return { state: "indeterminate", token: stored };
            }
            return { state: "pending", token: stored };
        }

        return { state: "attempted", token: null };
    }

    /** Returns true for a pending, indeterminate, or terminal non-retryable attempt. */
    function hasGiftBeenAttempted(giveawayId, recipient, amount, purpose) {
        const { state } = getGiftAttemptState(giveawayId, recipient, amount, purpose);
        return state === "pending" || state === "attempted" || state === "indeterminate";
    }

    /** Record a unique attempt token before an ambiguous send can happen. */
    function recordGiftAttempt(giveawayId, recipient, amount, purpose) {
        if (!giveawayId) return null;
        const ledger = readPaidGiftsLedger();
        if (!ledger[giveawayId]) ledger[giveawayId] = {};
        const giftKey = paidGiftKey(recipient, amount, purpose);
        const attemptToken = `${TAB_ID}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
        ledger[giveawayId][giftKey] = attemptToken;
        if (!writePaidGiftsLedger(ledger, { verifyWrite: true })) {
            // A failed read-back can happen after setItem() itself succeeded. No
            // transfer has been sent yet, so make that exact token explicitly
            // retryable. If the ledger write never landed this marker is harmless;
            // if it did land, a later Retry will not mistake an unsent gift for an
            // ambiguous/terminal transfer.
            try {
                localStorage.setItem(
                    paidGiftRetryableKey(giveawayId, recipient, amount, purpose),
                    attemptToken
                );
            } catch {}
            return null;
        }
        try {
            localStorage.removeItem(paidGiftRetryableKey(giveawayId, recipient, amount, purpose));
        } catch {}
        return attemptToken;
    }

    function markGiftAttemptRetryable(giveawayId, recipient, amount, purpose, attemptToken) {
        if (!giveawayId || !attemptToken) return false;
        const ledger = readPaidGiftsLedger();
        const current = ledger[giveawayId]?.[paidGiftKey(recipient, amount, purpose)];
        if (current !== attemptToken) return false;
        try {
            localStorage.setItem(
                paidGiftRetryableKey(giveawayId, recipient, amount, purpose),
                attemptToken
            );
            return true;
        } catch {
            return false;
        }
    }

    function clearGiftAttemptRetryable(giveawayId, recipient, amount, purpose, attemptToken) {
        if (!giveawayId || !attemptToken) return;
        try {
            const key = paidGiftRetryableKey(giveawayId, recipient, amount, purpose);
            if (localStorage.getItem(key) === attemptToken) localStorage.removeItem(key);
        } catch {}
    }

    function markGiftAttemptTerminal(giveawayId, recipient, amount, purpose, attemptToken) {
        if (!giveawayId || !attemptToken) return false;
        const ledger = readPaidGiftsLedger();
        const giftKey = paidGiftKey(recipient, amount, purpose);
        const current = ledger[giveawayId]?.[giftKey];
        if (current !== attemptToken) return false;

        // A numeric value is the established terminal-attempt representation and
        // remains compatible with ledgers written by older stable versions.
        // Return the exact marker so a definitively rejected fallback can restore
        // only the terminal value written by this specific attempt.
        const terminalMarker = Date.now();
        ledger[giveawayId][giftKey] = terminalMarker;
        if (!writePaidGiftsLedger(ledger, { verifyWrite: true })) return false;
        clearGiftAttemptRetryable(giveawayId, recipient, amount, purpose, attemptToken);
        return terminalMarker;
    }

    function restoreDefinitivelyRejectedGiftAttempt(
        giveawayId,
        recipient,
        amount,
        purpose,
        attemptToken,
        terminalMarker
    ) {
        if (
            !giveawayId ||
            !attemptToken ||
            !Number.isFinite(Number(terminalMarker)) ||
            !ownsTabLock()
        ) {
            return false;
        }

        const ledger = readPaidGiftsLedger();
        const giftKey = paidGiftKey(recipient, amount, purpose);
        if (ledger[giveawayId]?.[giftKey] !== terminalMarker) return false;

        // Publish the retryable marker before restoring the token. If the ledger
        // rewrite fails, the old numeric terminal value still wins and the stale
        // retry marker is harmless. If it succeeds, both durable pieces identify
        // this exact known-unsent attempt as safe to retry.
        const retryKey = paidGiftRetryableKey(giveawayId, recipient, amount, purpose);
        try {
            localStorage.setItem(retryKey, attemptToken);
            if (localStorage.getItem(retryKey) !== attemptToken) return false;
        } catch {
            return false;
        }

        ledger[giveawayId][giftKey] = attemptToken;
        if (!writePaidGiftsLedger(ledger, { verifyWrite: true })) return false;

        const verified = readPaidGiftsLedger();
        if (verified[giveawayId]?.[giftKey] !== attemptToken) return false;

        try {
            return localStorage.getItem(retryKey) === attemptToken;
        } catch {
            return false;
        }
    }

    function recoverOrphanedPendingGiftAttempt(giveawayId, recipient, amount, purpose, attemptState) {
        if (!ownsTabLock()) return false;
        if (!attemptState || attemptState.state !== "pending" || !attemptState.token) return false;

        const originTabId = giftAttemptTokenOwner(attemptState.token);
        if (!originTabId || originTabId === TAB_ID) return false;

        // This document now owns the exclusive Web Lock, so the originating
        // document can no longer safely continue settlement. Its unresolved HTTP
        // request is treated as ambiguous terminal work: never auto-retry it,
        // but do verify whether the transfer landed before settlement completes.
        return markGiftAttemptTerminal(
            giveawayId,
            recipient,
            amount,
            purpose,
            attemptState.token
        );
    }

    function giftAttemptStillNeedsResolution(giveawayId, gift) {
        const state = getGiftAttemptState(
            giveawayId,
            gift?.recipient,
            gift?.amount,
            gift?.purpose
        ).state;
        return state === "none" || state === "pending" || state === "retryable" || state === "indeterminate";
    }

    /**
     * Try to send BON using the site's HTTP gift endpoint.
     *
     * Idempotency: if this exact (recipient, amount) has already been attempted
     * for the current giveaway (in this tab, another tab, or a previous session),
     * the call is a no-op. The host can verify in the gift-status column / chat.
     *
     * Fallback policy: we ONLY fall back to /gift when we have strong evidence
     * the server rejected the request without processing it (specific 4xx codes
     * that mean "input/auth was bad"). We do NOT fall back on:
     *   - network errors / aborted requests (server may have processed it)
     *   - 5xx server errors (server may have processed it then failed to respond)
     *   - 408 / 429 (timeout / rate-limit; request may or may not have landed)
     * In those cases we leave it to verifyWinnerGifts to confirm; if verification
     * fails the host gets a warning and can resend manually. Better to under-pay
     * and warn than to over-pay silently.
     */
    async function giftBon(recipient, amount, messageText, purpose = GIFT_PURPOSE.WINNER) {
        const safeRecipient = (recipient || "").trim();
        const numericAmount = Math.floor(Number(amount));
        const safeMessage = (messageText || "").trim();

        if (!safeRecipient || !Number.isFinite(numericAmount) || numericAmount <= 0) {
            return { attempted: false, reason: "invalid" };
        }
        const safeAmount = numericAmount;

        if (!(await ensureExclusiveTabOwnership())) {
            logEvent(
                "Gift paused (ownership lost)",
                `Refusing to send ${fmtBONCurrency(safeAmount)} BON to ${sanitizeNick(safeRecipient)} because this tab cannot prove exclusive giveaway ownership.`
            );
            return { attempted: false, reason: "ownership-lost" };
        }

        if (REHEARSAL_MODE) {
            logEvent(
                "Rehearsal gift suppressed",
                `${sanitizeNick(safeRecipient)} | ${fmtBONCurrency(safeAmount)} BON | purpose=${purpose}`
            );
            return {
                attempted: true,
                confirmed: true,
                dryRun: true,
                transport: "rehearsal"
            };
        }

        // ── Idempotency check ─────────────────────────────────────────────
        const giveawayId = getActiveGiveawayId();
        const existingAttempt = getGiftAttemptState(
            giveawayId,
            safeRecipient,
            safeAmount,
            purpose
        );
        if (existingAttempt.state === "indeterminate") {
            logEvent(
                "Gift deferred (retryable marker unreadable)",
                `The transfer ledger for ${sanitizeNick(safeRecipient)} (${fmtBONCurrency(safeAmount)} BON, ${purpose}) cannot currently distinguish a known-unsent retryable attempt from an ambiguous pending transfer. Refusing to resend or terminalize it until local storage is readable again.`
            );
            return { attempted: false, reason: "attempt-state-indeterminate" };
        }
        if (existingAttempt.state === "pending") {
            if (
                recoverOrphanedPendingGiftAttempt(
                    giveawayId,
                    safeRecipient,
                    safeAmount,
                    purpose,
                    existingAttempt
                )
            ) {
                logEvent(
                    "Gift recovered as ambiguous",
                    `Recovered an orphaned pending attempt for ${sanitizeNick(safeRecipient)} (${fmtBONCurrency(safeAmount)} BON, ${purpose}); no automatic resend will occur until verification determines whether the original request landed.`
                );
                return { attempted: false, reason: "duplicate", orphanedPending: true };
            }

            logEvent(
                "Gift deferred (attempt still pending)",
                `This tab still has an unresolved transfer attempt for ${sanitizeNick(safeRecipient)} (${fmtBONCurrency(safeAmount)} BON, ${purpose}). Settlement will verify it before deciding whether to resume.`
            );
            return { attempted: false, reason: "pending" };
        }
        if (existingAttempt.state === "attempted") {
            logEvent(
                "Gift skipped (duplicate)",
                `Already attempted: ${sanitizeNick(safeRecipient)} for ${fmtBONCurrency(safeAmount)} BON (${purpose}) in this giveaway.`
            );
            return { attempted: false, reason: "duplicate" };
        }
        // Record BEFORE sending. If the send half-completes we still want
        // future calls (this tab, another tab, post-restore) to skip. Current
        // entries carry a unique token so a proven-rejected request can make only
        // its own attempt retryable without clearing a newer owner's attempt.
        const attemptToken = recordGiftAttempt(
            giveawayId,
            safeRecipient,
            safeAmount,
            purpose
        );
        if (!attemptToken) {
            logEvent(
                "Gift blocked (idempotency ledger unavailable)",
                `Refusing to send ${fmtBONCurrency(safeAmount)} BON to ${sanitizeNick(safeRecipient)} because the transfer-attempt ledger could not be persisted safely.`
            );
            return { attempted: false, reason: "attempt-ledger-unavailable" };
        }

        async function fallbackToChat() {
            // No chat fallback has been sent yet, and a safe HTTP 4xx (when this
            // helper is reached after POST) proves the HTTP transfer did not land.
            // Publish retryability before trying to reclaim ownership so a new
            // owner can resume instead of treating this rejected attempt as paid.
            if (!markGiftAttemptRetryable(
                giveawayId,
                safeRecipient,
                safeAmount,
                purpose,
                attemptToken
            )) {
                logEvent(
                    "Gift fallback aborted (attempt superseded)",
                    `The transfer token for ${sanitizeNick(safeRecipient)} was replaced by a newer owner before fallback could run.`
                );
                return { sent: false, reason: "attempt-superseded" };
            }

            if (!(await ensureExclusiveTabOwnership())) {
                logEvent(
                    "Gift fallback paused (ownership lost)",
                    `Refusing chat fallback for ${sanitizeNick(safeRecipient)} because this tab cannot prove exclusive giveaway ownership; the rejected attempt remains retryable.`
                );
                return { sent: false, reason: "ownership-lost" };
            }

            // We own the giveaway again and are about to make the fallback send
            // ambiguous. Make this exact attempt terminal before sending.
            const terminalMarker = markGiftAttemptTerminal(
                giveawayId,
                safeRecipient,
                safeAmount,
                purpose,
                attemptToken
            );
            if (!terminalMarker) {
                logEvent(
                    "Gift fallback aborted (attempt superseded)",
                    `The transfer token for ${sanitizeNick(safeRecipient)} changed before the chat fallback send; refusing to risk a duplicate payment.`
                );
                return { sent: false, reason: "attempt-superseded" };
            }

            const cmd = safeMessage
                ? `/gift ${safeRecipient} ${safeAmount} ${safeMessage}`
                : `/gift ${safeRecipient} ${safeAmount}`;

            const sent = await sendMessage(cmd, {
                requireExclusiveGiveawayOwnership: true,
                forceChatboxOnly: true
            });
            if (sent) return { sent: true };

            // This fallback is deliberately chatbox-only. Therefore a false result
            // cannot hide an ambiguous /api/chat/messages timeout: no chat API
            // request was attempted. If we still own the giveaway, the command was
            // definitively not dispatched and this exact attempt is safe to retry.
            if (!ownsTabLock()) {
                logEvent(
                    "Gift fallback rejected after ownership loss",
                    `The chat fallback for ${sanitizeNick(safeRecipient)} was not sent and this tab no longer owns the giveaway; settlement will resume from the durable state.`
                );
                return { sent: false, reason: "ownership-lost" };
            }

            if (!restoreDefinitivelyRejectedGiftAttempt(
                giveawayId,
                safeRecipient,
                safeAmount,
                purpose,
                attemptToken,
                terminalMarker
            )) {
                logEvent(
                    "Gift fallback rejected (retry state unavailable)",
                    `The chat fallback for ${sanitizeNick(safeRecipient)} was definitively rejected, but its retryable ledger state could not be restored safely.`
                );
                return { sent: false, reason: "attempt-ledger-unavailable" };
            }

            logEvent(
                "Gift fallback rejected (retryable)",
                `The chat fallback for ${sanitizeNick(safeRecipient)} was definitively rejected before send; the exact transfer attempt remains safe to retry.`
            );
            return { sent: false, reason: "chat-send-rejected" };
        }

        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfToken = csrfMeta && csrfMeta.content ? csrfMeta.content : null;

        // Resolve UNIT3D's sender-scoped gift route:
        // /users/{authenticated-user}/gifts. The recipient itself is carried in
        // recipient_username, so never derive this URL from an arbitrary visible user.
        let giftUrl = null;
        const senderSlug = getAuthenticatedUserSlug();
        if (senderSlug) {
            const endpointPath = getGiftEndpointPath(senderSlug);
            giftUrl = endpointPath ? (location.origin + endpointPath) : null;
        }

        // If we can't resolve the HTTP endpoint or token, fall back immediately.
        // This is safe: we haven't sent anything yet, so /gift is the first attempt.
        if (!csrfToken || !giftUrl) {
            const fallback = await fallbackToChat();
            if (!fallback.sent) {
                return { attempted: false, reason: fallback.reason || "chat-send-rejected" };
            }
            return { attempted: true, transport: "chat" };
        }

        const formData = new FormData();
        formData.append("_token", csrfToken);
        formData.append("recipient_username", safeRecipient);

        formData.append("type", "bon");

        formData.append("bon", String(safeAmount));
        formData.append("message", safeMessage);

        // Codes that mean "server definitely did not process this gift":
        //   400 bad request, 401 unauthorized, 403 forbidden, 404 not found,
        //   422 unprocessable entity. Safe to fall back to /gift.
        // Notably NOT in this list: 408 (timeout), 429 (rate limit), 5xx,
        // and network errors. For those we trust verifyWinnerGifts to flag
        // any actually-missing gifts.
        const SAFE_FALLBACK_STATUSES = new Set([400, 401, 403, 404, 422]);

        try {
            const resp = await fetchWithTimeout(giftUrl, {
                method: "POST",
                credentials: "same-origin",
                body: formData
            }, 10_000);

            if (resp && SAFE_FALLBACK_STATUSES.has(resp.status)) {
                logEvent(
                    "Gift HTTP rejected, falling back",
                    `${sanitizeNick(safeRecipient)} ${fmtBONCurrency(safeAmount)} BON | status=${resp.status}`
                );
                const fallback = await fallbackToChat();
                if (!fallback.sent) {
                    return {
                        attempted: false,
                        reason: fallback.reason || "chat-send-rejected",
                        httpStatus: resp.status
                    };
                }
                return { attempted: true, transport: "chat-fallback", httpStatus: resp.status };
            }

            if (!resp || resp.status >= 400) {
                // Ambiguous failure. Server may or may not have processed it.
                // Do NOT fall back. The request is now terminal/ambiguous rather
                // than pending; verification decides whether it actually landed.
                markGiftAttemptTerminal(
                    giveawayId,
                    safeRecipient,
                    safeAmount,
                    purpose,
                    attemptToken
                );
                logEvent(
                    "Gift HTTP ambiguous (no fallback)",
                    `${sanitizeNick(safeRecipient)} ${fmtBONCurrency(safeAmount)} BON | status=${resp ? resp.status : "no-response"} | will verify via chat poll`
                );
                return { attempted: true, transport: "http-ambiguous", httpStatus: resp ? resp.status : null };
            }

            markGiftAttemptTerminal(
                giveawayId,
                safeRecipient,
                safeAmount,
                purpose,
                attemptToken
            );
            return { attempted: true, transport: "http", httpStatus: resp.status };
        } catch (e) {
            // A thrown fetch/network error is ambiguous: the server may have received
            // the request. Do NOT replay it via /gift; let verification decide.
            markGiftAttemptTerminal(
                giveawayId,
                safeRecipient,
                safeAmount,
                purpose,
                attemptToken
            );
            logEvent(
                "Gift HTTP network error (no fallback)",
                `${sanitizeNick(safeRecipient)} ${fmtBONCurrency(safeAmount)} BON | ${e && e.message ? e.message : "unknown error"} | will verify via chat poll`
            );
            return { attempted: true, transport: "http-ambiguous", error: e && e.message ? e.message : "unknown" };
        }
    }

    // Chat formatting: use spaces as thousands separators in outgoing messages.
    // (Menu/UI formatting is intentionally left alone.)
    function formatChatNumbersWithSpaces(str) {
        try {
            if (!str) return str;

            const raw = String(str);

            // Only treat one lexical numeric token at a time as a thousands-formatted
            // number. In particular, comma+space is intentionally NOT a thousands
            // separator because giveaway lists use it between independent values:
            // "28, 36, 52, 83, 89" must never become "28, 365 283, 89".
            //
            // Supported forms:
            //   1000 / 1000000
            //   1,000 / 1,000,000
            //   1 000 / 1 000 000 (including NBSP/narrow NBSP)
            //   1'000 / 1’000’000
            const formattableNumberRe =
                /\b(?:\d{4,}|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d{1,3}(?:['’]\d{3})+)\b/;

            // Quick bailout also avoids usernames such as "Sch2021" waking the
            // formatter up merely because they contain four consecutive digits.
            if (!formattableNumberRe.test(raw)) return raw;

            // Protect URL segments and BBCode tags/attributes from numeric formatting.
            // This keeps [tag=...], [url=...], and color hexes untouched.
            const protectedParts = [];
            const protectedText = raw.replace(/\[[^\]]*\]|https?:\/\/[^\s\]]+|#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g, (segment) => {
                const idx = protectedParts.push(segment) - 1;
                return `__BG_PROTECTED_${idx}__`;
            });

            const formatted = protectedText.replace(
                /\b(?:\d{4,}|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d{1,3}(?:['’]\d{3})+)\b/g,
                (match) => {
                    const digits = match.replace(/[^\d]/g, "");
                    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
                }
            );

            return formatted.replace(/__BG_PROTECTED_(\d+)__/g, (_, i) => protectedParts[Number(i)] ?? "");
        } catch {
            return str;
        }
    }
    function formatRehearsalPrivateOutput(messageStr) {
        const raw = String(messageStr ?? "").replace(/[\r\n]+/g, " ").trim();
        const privateMatch = raw.match(/^\/msg\s+(\S+)\s*(.*)$/i);

        if (privateMatch) {
            const intendedRecipient = sanitizeNick(privateMatch[1]);
            const body = String(privateMatch[2] || "").trim();
            return `[b][color=#ff3333][REHEARSAL][/color][/b] [i](would PM ${intendedRecipient})[/i]${body ? ` ${body}` : ""}`;
        }

        return `[b][color=#ff3333][REHEARSAL][/color][/b]${raw ? ` ${raw}` : ""}`;
    }

    async function sendPrivateMessage(username, messageStr, options = {}) {
        const to = String(username || "").trim();
        if (!to) {
            // No target -> fall back to the normal output path.
            return sendMessage(messageStr, options);
        }

        let body = String(messageStr ?? "");

        // Preserve the "spaces for thousands separators" behavior in silent mode by applying the
        // formatter to the message body BEFORE we wrap it in /msg (sendMessage skips formatting for slash commands).
        try {
            body = formatChatNumbersWithSpaces(body);
        } catch { /* ignore */ }

        // Avoid newlines which can confuse slash-command parsers
        body = body.replace(/[\r\n]+/g, " ").trim();

        return sendMessage(`/msg ${to} ${body}`, options);
    }

    async function sendCommandResponse(username, messageStr) {
        if (GENERAL_SETTINGS.silent_mode) {
            return sendPrivateMessage(username, messageStr);
        }
        return sendMessage(messageStr);
    }

    /** Prepare a message for sending: obfuscate "giveaway" and apply number formatting. */
    function prepareOutgoingMessage(messageStr) {
        // Obfuscate "giveaway" in all messages except the intro announcement
        if (!(messageStr.includes("I am hosting a giveaway for") &&
              messageStr.includes("Pick a number between"))) {
            messageStr = obfuscateGiveaway(messageStr);
        }

        // Apply chat-only number formatting (spaces for thousands separators).
        // Never touch slash-commands (e.g., /gift) since the site expects raw digits.
        try {
            const trimmed = String(messageStr || "").trimStart();
            if (!trimmed.startsWith("/")) {
                messageStr = formatChatNumbersWithSpaces(messageStr);
            }
        } catch { /* ignore */ }

        return messageStr;
    }

    /** Try to send via API POST. Returns true on success, false otherwise. */
    async function trySendViaApi(messageStr) {
        if (!OT_USER_ID || !OT_CHATROOM_ID || !OT_CSRF_TOKEN) return false;

        const payload = {
            bot_id: null,
            chatroom_id: Number(OT_CHATROOM_ID),
            message: messageStr,
            receiver_id: null,
            save: true,
            targeted: 0,
            user_id: Number(OT_USER_ID)
        };

        const resp = await fetchWithTimeout(`/api/chat/messages`, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": OT_CSRF_TOKEN,
                "X-Requested-With": "XMLHttpRequest"
            },
            body: JSON.stringify(payload)
        }, 7000);

        const respText = await resp.text();
        if (resp.ok) {
            if (DEBUG_SETTINGS.log_chat_messages) console.log(`API send: ${messageStr}`);
            if (DEBUG_SETTINGS.verify_sendmessage) console.debug("sendMessage: API message sent successfully");
            return true;
        }

        try { console.error("API error", JSON.parse(respText)); }
        catch (e) { console.error("API error (raw):", respText); }
        return false;
    }

    /** Legacy fallback: inject message into the chatbox input and simulate Enter. */
    function sendViaChatbox(messageStr) {
        if (!chatbox) return false;
        if (DEBUG_SETTINGS.log_chat_messages) console.log(`Fallback send (chatbox): ${messageStr}`);
        if (DEBUG_SETTINGS.verify_sendmessage) console.debug("sendMessage: sending message via chatbox fallback");

        const originalValue = chatbox.value;
        chatbox.value = messageStr;
        chatbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

        setTimeout(() => {
            chatbox.value = originalValue;
            if (DEBUG_SETTINGS.verify_sendmessage) console.debug("sendMessage: restored chatbox original value");
        }, 50);
        return true;
    }

    async function sendMessage(messageStr, options = {}) {
        messageStr = options?.prepared === true
            ? String(messageStr ?? "")
            : prepareOutgoingMessage(messageStr);
        const requireExclusiveGiveawayOwnership =
            options?.requireExclusiveGiveawayOwnership === true;
        const allowRehearsalPrivateOutput =
            options?.rehearsalPrivateOutput === true;
        const forceChatboxOnly = options?.forceChatboxOnly === true;

        if (REHEARSAL_MODE && !allowRehearsalPrivateOutput) {
            const rehearsalHost = String(giveawayData?.host || getLoggedInUsername() || "").trim();
            const rehearsalBody = formatRehearsalPrivateOutput(messageStr);

            logEvent(
                "Rehearsal chat redirected",
                rehearsalHost
                    ? `Private host output -> ${sanitizeNick(rehearsalHost)}: ${rehearsalBody}`
                    : `No host identity available; output suppressed: ${rehearsalBody}`
            );

            if (!rehearsalHost) {
                if (DEBUG_SETTINGS.log_chat_messages || DEBUG_SETTINGS.verify_sendmessage) {
                    console.warn("[BON Giveaway rehearsal] host identity unavailable; output suppressed:", messageStr);
                }
                return true;
            }

            if (DEBUG_SETTINGS.log_chat_messages || DEBUG_SETTINGS.verify_sendmessage) {
                console.debug("[BON Giveaway rehearsal] redirecting output privately to host:", rehearsalHost, messageStr);
            }

            return sendPrivateMessage(rehearsalHost, rehearsalBody, {
                rehearsalPrivateOutput: true,
                requireExclusiveGiveawayOwnership
            });
        }
        if (DEBUG_SETTINGS.disable_chat_output) return true;

        if (DEBUG_SETTINGS.verify_sendmessage) console.debug("sendMessage: caching chat context if needed");

        // If cache is missing, try to refresh
        if (!OT_USER_ID || !OT_CHATROOM_ID || !OT_CSRF_TOKEN) cacheChatContext();

        // --- Attempt API POST, fall back to chatbox on failure ---
        // Slash-command gift fallbacks can force the synchronous chatbox path so
        // an ambiguous API timeout can never be mistaken for a definite no-send.
        if (!forceChatboxOnly && !DEBUG_SETTINGS.suppressApiMessages) {
            try {
                if (await trySendViaApi(messageStr)) return true;
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) console.warn("API send failed, falling back to chatbox method:", e);
                if (DEBUG_SETTINGS.verify_sendmessage) console.debug("sendMessage: API send failed, falling back to chatbox method");
            }
        }

        // Settlement output is authoritative. If the API attempt yielded while a
        // BFCache/pagehide handoff quarantined this document, never let the stale
        // continuation escape through the synchronous chatbox fallback.
        if (
            requireExclusiveGiveawayOwnership &&
            !canMutateActiveGiveaway()
        ) {
            logEvent(
                "Chatbox fallback blocked (ownership lost)",
                "Authoritative settlement output was not retried through the chatbox because this tab no longer owns the giveaway."
            );
            return false;
        }

        return sendViaChatbox(messageStr);
    }

    function countdownTimer (display, giveawayData) {
        display.hidden = false;

        const timerID = setInterval(() => {
            const msLeft = syncGiveawayTimeLeft(giveawayData);

            // update MM:SS
            const m = Math.floor(giveawayData.timeLeft / 60);
            const s = giveawayData.timeLeft % 60;
            display.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");

            // finish conditions
            if (giveawayData.timeLeft === 0) return endGiveaway();
            if (numberEntries.size === giveawayData.totalEntries) {
                sendMessage(`All [b][color=#ffc00a]${giveawayData.totalEntries}[/color][/b] slot(s) filled! Ending early with ` +
                            `[b][color=#1DDC5D]${parseTime(msLeft)}[/color][/b] remaining!`);
                return endGiveaway();
            }

            // automatic reminders (based on time *remaining* until end)
            const msToNext = nextReminderMs(giveawayData.reminderSchedule, msLeft);
            if (msToNext !== null && msToNext <= 1000) {
                // Consume this slot so retries (if any) don't double-send.
                if (giveawayData.reminderSchedule && giveawayData.reminderSchedule.length) {
                    giveawayData.reminderSchedule.shift();
                }
                sendReminder();
            }
        }, 1000);

        return timerID;
    }


    // Inserts a zero-width space after the first character
    function sanitizeNick(nick) {
        if (typeof nick !== "string" || nick.length < 2) return nick;
        return nick[0] + "\u200B" + nick.slice(1);
    }

    // Normalize usernames to a stable, case-insensitive key used for comparisons and map keys.
    // - trims whitespace
    // - strips a leading @ (common in mentions)
    // - lowercases
    function normalizeUserKey(name) {
        return String(name || "")
            .trim()
            .replace(/^@+/, "")
            .toLowerCase();
    }

    // Best-effort: derive the logged-in username from the navbar /users/<name> link
    // so it matches what getAuthor() extracts from chat messages.
    function getLoggedInUsername() {
        const navLink = getTopNavUserLink();
        if (navLink) {
            const href = navLink.getAttribute("href") || navLink.href || "";
            const m = href.match(/\/users\/([^/?#]+)/i);
            if (m && m[1]) {
                try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
            }
        }

        const t = navLink?.textContent || "";
        return String(t || "").trim();
    }

    // Returns a set of possible "self" keys (host + logged-in user).
    // We use a set because some sites display a different name than they use in /users/<...> links.
    function resolveSelfKeys(hostName) {
        const keys = new Set();
        const a = normalizeUserKey(hostName);
        if (a) keys.add(a);
        const b = normalizeUserKey(getLoggedInUsername());
        if (b) keys.add(b);
        return keys;
    }

    function obfuscateGiveaway(text) {
        return text.replace(/giveaway/gi, match => {
            return match[0] + "\u200B" + match.slice(1); // g + zero-width + iveaway
        });
    }

    // ───────────────────────────────
    // Persistent stats (localStorage)
    // ───────────────────────────────

    function defaultGiveawayStats() {
        return { version: 1, users: {}, giveaways: [], updatedAt: 0 };
    }


    // Write-behind stats cache (reduces GM/localStorage churn during busy giveaways)
    // - Commands prefer the in-memory cache so results reflect live updates immediately.
    // - Flush happens automatically after a short delay, and is forced on giveaway end/unload.
    const STATS_WRITE_BEHIND_MS = 1500;
    let _statsCache = null;
    let _statsDirty = false;
    let _statsFlushTimer = null;

    function getStatsCached() {
        if (_statsCache) return _statsCache;
        _statsCache = loadGiveawayStats();
        return _statsCache;
    }

    function getStatsForRead() {
        // Prefer in-memory cache so commands reflect latest live updates
        return _statsCache || loadGiveawayStats();
    }

    function scheduleStatsFlush(ms = STATS_WRITE_BEHIND_MS) {
        if (_statsFlushTimer) return;
        _statsFlushTimer = setTimeout(() => {
            _statsFlushTimer = null;
            flushStatsNow();
        }, ms);
    }

    function markStatsDirty() {
        _statsDirty = true;
        scheduleStatsFlush();
    }

    function flushStatsNow() {
        try {
            if (_statsFlushTimer) {
                clearTimeout(_statsFlushTimer);
                _statsFlushTimer = null;
            }
            if (!_statsDirty) return;
            const stats = _statsCache || loadGiveawayStats();
            _statsCache = stats;
            saveGiveawayStats(stats);
            _statsDirty = false;
        } catch {
            // If something goes wrong (or during early init), fail closed.
        }
    }

    function normalizeGiveawayStatsShape(stats) {
        if (!stats || typeof stats !== "object") return defaultGiveawayStats();

        if (!stats.users || typeof stats.users !== "object") stats.users = {};
        if (!Array.isArray(stats.giveaways)) stats.giveaways = [];

        if (typeof stats.version !== "number") stats.version = STATS_VERSION;
        if (typeof stats.updatedAt !== "number") stats.updatedAt = 0;

        return stats;
    }

    function safeParseLocalStorage(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            return obj && typeof obj === "object" ? obj : null;
        } catch {
            return null;
        }
    }

    function safeGetUpdatedAt(obj) {
        const n = obj && typeof obj.updatedAt === "number" ? obj.updatedAt : 0;
        return Number.isFinite(n) ? n : 0;
    }

    /**
     * One-time migration for hosts who ran fork versions 1.0.1 - 1.1.0, which kept
     * stats under a private key. Folds that record into the shared one (counters
     * added, giveaways de-duplicated by end time) and removes the private key.
     */
    function migrateLegacyForkStats() {
        let legacy = null;
        try { legacy = safeParseLocalStorage(STATS_KEY_LS_LEGACY_FORK); } catch {}
        if (!legacy) return;
        try {
            const shared = safeParseLocalStorage(STATS_KEY_LS);
            if (!shared) {
                // Nothing to merge into: the private record simply becomes the shared one.
                localStorage.setItem(STATS_KEY_LS, JSON.stringify(normalizeGiveawayStatsShape(legacy)));
            } else {
                const target = normalizeGiveawayStatsShape(shared);
                const source = normalizeGiveawayStatsShape(legacy);

                const seen = new Set((target.giveaways || []).map(g => `${g.endedAt}|${g.host}|${g.amount}`));
                for (const g of (source.giveaways || [])) {
                    const k = `${g.endedAt}|${g.host}|${g.amount}`;
                    if (!seen.has(k)) { target.giveaways.push(g); seen.add(k); }
                }
                target.giveaways.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));

                const MAX_FIELDS = new Set(["biggestWin", "biggestSponsor", "lastSeenAt"]);
                for (const [key, srcRec] of Object.entries(source.users || {})) {
                    if (!srcRec || typeof srcRec !== "object") continue;
                    const dst = target.users[key];
                    if (!dst) { target.users[key] = srcRec; continue; }
                    for (const [field, val] of Object.entries(srcRec)) {
                        if (typeof val !== "number") continue;
                        if (MAX_FIELDS.has(field)) dst[field] = Math.max(Number(dst[field]) || 0, val);
                        else dst[field] = (Number(dst[field]) || 0) + val;
                    }
                    if (srcRec.name && (srcRec.lastSeenAt || 0) >= (dst.lastSeenAt || 0)) dst.name = srcRec.name;
                }
                target.updatedAt = Date.now();
                localStorage.setItem(STATS_KEY_LS, JSON.stringify(target));
            }
            localStorage.removeItem(STATS_KEY_LS_LEGACY_FORK);
            console.info("[DarkPeers BONanza Giveaway] Merged pre-1.2.0 fork stats into the shared stats record.");
        } catch (e) {
            console.warn("[DarkPeers BONanza Giveaway] Legacy stats merge failed; leaving both records untouched.", e);
        }
    }

    function loadGiveawayStats() {
        migrateLegacyForkStats();

        // Read both locations
        const gmVal = (typeof GM_getValue === "function") ? GM_getValue(STATS_KEY_GM, null) : null;
        const gmObj = (gmVal && typeof gmVal === "object") ? normalizeGiveawayStatsShape(gmVal) : null;

        const lsRaw = safeParseLocalStorage(STATS_KEY_LS);
        const lsObj = lsRaw ? normalizeGiveawayStatsShape(lsRaw) : null;

        // If both missing/corrupt
        if (!gmObj && !lsObj) {
            const fresh = defaultGiveawayStats();
            // Seed both so they stay in sync from day 1
            if (typeof GM_setValue === "function") GM_setValue(STATS_KEY_GM, fresh);
            try { localStorage.setItem(STATS_KEY_LS, JSON.stringify(fresh)); } catch {}
            return fresh;
        }

        // Choose the newest
        const gmUpdated = safeGetUpdatedAt(gmObj);
        const lsUpdated = safeGetUpdatedAt(lsObj);
        const best = (gmUpdated >= lsUpdated) ? (gmObj || lsObj) : (lsObj || gmObj);

        // Heal the other side if needed
        if (best) {
            if (!gmObj || gmUpdated < safeGetUpdatedAt(best)) {
                if (typeof GM_setValue === "function") GM_setValue(STATS_KEY_GM, best);
            }
            if (!lsObj || lsUpdated < safeGetUpdatedAt(best)) {
                try { localStorage.setItem(STATS_KEY_LS, JSON.stringify(best)); } catch {}
            }
            return best;
        }

        // Absolute fallback
        return defaultGiveawayStats();
    }

    function saveGiveawayStats(stats) {
        if (!stats || typeof stats !== "object") return;
        stats.updatedAt = Date.now();

        // Write GM
        if (typeof GM_setValue === "function") {
            GM_setValue(STATS_KEY_GM, stats);
        }

        // Write localStorage
        try {
            localStorage.setItem(STATS_KEY_LS, JSON.stringify(stats));
        } catch {
            // If LS quota is exceeded or blocked, we still at least have GM storage.
        }
    }

    function getNonHostSponsorContributions(data) {
        if (!data || !data.sponsorContribs || typeof data.sponsorContribs !== "object") return [];

        const hostKey = normalizeUserKey(data.host);
        const grouped = new Map();

        for (const [rawName, rawAmount] of Object.entries(data.sponsorContribs)) {
            const name = String(rawName || "").trim();
            const key = normalizeUserKey(name);
            const amount = Math.max(0, Math.floor(Number(rawAmount) || 0));
            if (!key || key === hostKey || amount <= 0) continue;

            if (!grouped.has(key)) grouped.set(key, { name, amount: 0 });
            grouped.get(key).amount += amount;
        }

        return Array.from(grouped.values()).sort((a, b) =>
            (b.amount - a.amount) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
    }

    function sumSponsorContribs(contribs, hostName) {
        if (!contribs || typeof contribs !== "object") return 0;
        const hostKey = hostName ? normUserKey(hostName) : null;

        let sum = 0;
        for (const [name, v] of Object.entries(contribs)) {
            if (hostKey && normUserKey(name) === hostKey) continue; // ignore host self-gifting
            sum += Math.max(0, Math.floor(Number(v) || 0));
        }
        return sum;
    }

    function normUserKey(name) {
        // Back-compat alias used throughout the script. Keep behavior consistent with normalizeUserKey().
        return normalizeUserKey(name);
    }

    function getOrCreateUserStats(stats, username) {
        const key = normUserKey(username);
        if (!key) return null;

        if (!stats.users[key]) {
            stats.users[key] = {
                name: String(username || "").trim() || key,
                entered: 0,
                wins: 0,
                losses: 0,
                totalWon: 0,
                biggestWin: 0,
                sponsoredTotal: 0,
                sponsorCount: 0,
                biggestSponsor: 0,
                hosted: 0,
                hostedTotal: 0,
                lastSeenAt: 0,
                sponsorReceivedTotal: 0
            };
        } else if (username) {
            // keep most recently seen casing
            stats.users[key].name = String(username).trim() || stats.users[key].name;
        }
        return stats.users[key];
    }
    function recordLiveEntry(username) {
        const key = normUserKey(username);
        if (!key) return;
        if (liveEnteredThisGiveaway.has(key)) return;

        liveEnteredThisGiveaway.add(key);

        const stats = getStatsCached();
        const rec = getOrCreateUserStats(stats, username);
        if (!rec) return;

        rec.entered = (rec.entered || 0) + 1;
        rec.lastSeenAt = Date.now();

        markStatsDirty();
    }

    function recordLiveSponsorGift(gifter, amount) {
        const key = normUserKey(gifter);
        const delta = Math.max(0, Math.floor(Number(amount) || 0));
        if (!key || !delta) return;

        // track running total for "biggestSponsor" per giveaway
        const prevTotal = liveSponsorTotalThisGiveaway.get(key) || 0;
        const nowTotal = prevTotal + delta;
        liveSponsorTotalThisGiveaway.set(key, nowTotal);

        const stats = getStatsCached();
        const rec = getOrCreateUserStats(stats, gifter);
        if (!rec) return;

        rec.sponsoredTotal = (rec.sponsoredTotal || 0) + delta;

        // Count “how many giveaways they sponsored” once per giveaway
        if (!liveSponsorSeenThisGiveaway.has(key)) {
            liveSponsorSeenThisGiveaway.add(key);
            rec.sponsorCount = (rec.sponsorCount || 0) + 1;
        }

        // biggestSponsor = biggest total they added in any single giveaway
        rec.biggestSponsor = Math.max(rec.biggestSponsor || 0, nowTotal);

        rec.lastSeenAt = Date.now();
        markStatsDirty();
    }

    function recordGiveawayStats(giveawayData, winners, allocated, entriesMap, donation = null, settlement = {}) {
        if (!giveawayData) return;
        const donatedTotal = donation && donation.total > 0 && donation.confirmed ? Math.floor(donation.total) : 0;
        const donationPercent = donation && donation.total > 0 ? donation.percent : 0;
        const sponsorRefundedTotal = Math.max(0, Math.floor(Number(settlement?.sponsorRefundedTotal) || 0));

        const stats = getStatsCached();
        const now = Date.now();

        // Giveaway totals (for host stats + !largest)
        const potTotal = Math.max(0, Math.floor(Number(giveawayData.amount) || 0));

        // Total non-host sponsor BON for this giveaway (exclude host self-gifting)
        const sponsorTotal = sumSponsorContribs(giveawayData.sponsorContribs, giveawayData.host);

        // Prefer explicit hostAdded (new behavior)
        let hostOnly = giveawayData.hostAdded;
        hostOnly = Number.isFinite(hostOnly) ? Math.max(0, Math.floor(hostOnly)) : null;

        // Back-compat fallback for older giveaways that don’t have hostAdded saved
        if (hostOnly === null) {
            hostOnly = Math.max(0, potTotal - sponsorTotal);
        }

        // Record giveaway history (per-site) for !largest
        try {
            if (!Array.isArray(stats.giveaways)) stats.giveaways = [];
            stats.giveaways.push({
                amount: potTotal,
                host: String(giveawayData.host || "").trim(),
                hostOnly,
                sponsorTotal,
                sponsorRefundedTotal,
                winners: Array.isArray(winners) ? winners.length : 0,
                entries: entriesMap ? entriesMap.size : 0,
                donationPercent,
                donatedTotal,
                poolConfirmed: !!(donation && donation.confirmed),
                endedAt: now,
                endedDate: (new Date(now)).toLocaleDateString("en-CA")
            });

            const MAX_HISTORY = 250;
            if (stats.giveaways.length > MAX_HISTORY) {
                stats.giveaways = stats.giveaways.slice(-MAX_HISTORY);
            }
        } catch (e) { /* ignore */ }

        // Host tracking
        const hostRec = getOrCreateUserStats(stats, giveawayData.host);
        if (hostRec) {
            hostRec.hosted = (hostRec.hosted || 0) + 1;

            // Host pot only (excludes sponsors)
            hostRec.hostedTotal = (hostRec.hostedTotal || 0) + hostOnly;

            // Total sponsor BON the host actually retained across hosted giveaways.
            // A zero-entry / 0%-Pool settlement can return sponsor gifts in full.
            const sponsorRetainedTotal = Math.max(0, sponsorTotal - sponsorRefundedTotal);
            if (sponsorRetainedTotal > 0) {
                hostRec.sponsorReceivedTotal = (hostRec.sponsorReceivedTotal || 0) + sponsorRetainedTotal;
            }

            // BON Pool contributions generated by this host's giveaways
            if (donatedTotal > 0) {
                hostRec.fundDonatedTotal = (hostRec.fundDonatedTotal || 0) + donatedTotal;
                hostRec.fundDonationCount = (hostRec.fundDonationCount || 0) + 1;
            }

            hostRec.lastSeenAt = now;
        }

        // Sponsors (per giveaway; uses sponsorContribs totals)
        if (giveawayData.sponsorContribs && typeof giveawayData.sponsorContribs === "object") {
            for (const [sponsor, amt] of Object.entries(giveawayData.sponsorContribs)) {
                const finalTotal = Math.max(0, Math.floor(Number(amt) || 0));
                if (!sponsor || !finalTotal) continue;

                const sKey = normUserKey(sponsor);
                const alreadyCounted = liveSponsorTotalThisGiveaway.get(sKey) || 0;
                const delta = Math.max(0, finalTotal - alreadyCounted);

                const rec = getOrCreateUserStats(stats, sponsor);
                if (!rec) continue;

                if (delta > 0) rec.sponsoredTotal += delta;

                if (!liveSponsorSeenThisGiveaway.has(sKey)) {
                    rec.sponsorCount += 1;
                }

                rec.biggestSponsor = Math.max(rec.biggestSponsor || 0, finalTotal);
                rec.lastSeenAt = now;
            }
        }

        // Winners + payouts
        const winKeySet = new Set((winners || []).map(w => normUserKey(w.author)));
        const payoutByKey = new Map();

        (winners || []).forEach((w, i) => {
            const key = normUserKey(w.author);
            const pay = Math.max(0, Math.floor(Number((allocated || [])[i]) || 0));
            if (!key) return;
            payoutByKey.set(key, (payoutByKey.get(key) || 0) + pay);
        });

        // Participants
        const participants = entriesMap ? Array.from(entriesMap.keys()) : [];
        participants.forEach(name => {
            const rec = getOrCreateUserStats(stats, name);
            if (!rec) return;

            const uKey = normUserKey(name);

            if (!liveEnteredThisGiveaway.has(uKey)) {
                rec.entered += 1;
            }

            if (winKeySet.has(uKey)) {
                rec.wins += 1;
                const pay = payoutByKey.get(uKey) || 0;
                rec.totalWon += pay;
                rec.biggestWin = Math.max(rec.biggestWin || 0, pay);
            } else {
                rec.losses += 1;
            }
            rec.lastSeenAt = now;
        });

        markStatsDirty();
        flushStatsNow();

    }

    function getLeaderboardRows(sorter, topN, filterFn) {
        const stats = getStatsForRead();
        const users = Object.values(stats.users || {})
        .filter(u => u && typeof u === "object")
        .filter(u => (filterFn ? filterFn(u) : true))
        .sort(sorter);

        return users.slice(0, topN);
    }

    function fmtBON(value) {
        let n;
        if (typeof value === "number") {
            n = Math.max(0, Math.floor(value));
        } else {
            const digitsOnly = String(value ?? "").replace(/[^\d]/g, "");
            n = Number.isNaN(parseInt(digitsOnly || "0", 10)) ? 0 : parseInt(digitsOnly || "0", 10);
        }
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    }

    // Monetary display only. Counts, ranges and winning numbers still use fmtBON().
    // DarkPeers' official BON symbol is ฿; money uses PT-style thousands dots.
    function fmtBONCurrency(value) {
        return BON_SYMBOL + fmtBON(value).replace(/ /g, ".");
    }

    function safeNameForChat(name) {
        return sanitizeNick(String(name || "").trim());
    }


    // Small helper for rig-mode suffixes
    function rigNote(inner) {
        if (!riggedMode) return "";

        // Extract trailing emoji(s) or punctuation like "😈", "👀", "😏"
        // This catches anything NOT in parentheses.
        const match = inner.match(/^(.*?)(\s*[^\w\s\)\(]+)?$/);
        const text = match[1].trim(); // "(entry logged ... conditions)"
        const trailing = (match[2] || "").trim(); // "😈" or "👀" or empty

        return ` [i][color=#FF4F9A]${text}[/color][/i]${trailing ? " " + trailing : ""}`;
    }




    // Small helper for silent-mode suffixes (only for public announcements)
    function silentNote(inner) {
        if (!GENERAL_SETTINGS.silent_mode) return "";

        // Extract trailing emoji(s) or punctuation like "🤫"
        const match = inner.match(/^(.*?)(\s*[^\w\s\)\(]+)?$/);
        const text = match[1].trim();
        const trailing = (match[2] || "").trim();

        return ` [i][color=#999999]${text}[/color][/i]${trailing ? " " + trailing : ""}`;
    }

    // Fun denial message when non-hosts try to use !rig / !unrig (rate-limited per user)
    function maybeSendRigDeny(author, safeAuthor, action) {
        const now = Date.now();
        const nextOk = rigDenyCooldown.get(author) || 0;
        if (now < nextOk) return;
        rigDenyCooldown.set(author, now + RIG_DENY_COOLDOWN_MS);

        const who = `[color=#d85e27]${safeAuthor}[/color]`;

        const linesRig = [
            `🛑 Nice try ${who}. The Rigging Lever™ is behind host-only glass.`,
            `🚨 Unauthorized rig attempt by ${who}. Deploying the Fairness Police…`,
            `${who} tried to rig the giveaway. The universe said: “lol, no.”`,
            `Sorry ${who}! Only the host has a license to operate the Rig-O-Matic™.`
        ];

        const linesUnrig = [
            `Hold up ${who}… you can’t unrig what you never rigged.`,
            `🚫 Access denied, ${who}. The “Unrig” button is guarded by a tiny, angry moderator.`,
            `Nice try ${who}. Only the host can turn off the Chaos Generator™.`,
            `${who} reached for the unrig switch… and touched nothing but air.`
        ];

        const pool = (action === "unrig") ? linesUnrig : linesRig;
        const msg = pool[Math.floor(Math.random() * pool.length)];
        sendCommandResponse(author, msg);
    }

    function updateRigToggleUI() {
        if (!rigToggleInput) return;

        rigToggleInput.disabled = false;
        rigToggleInput.checked = !!riggedMode;
        rigToggleInput.title = riggedMode
            ? "Rigged mode is ON (cosmetic only). Click to disable."
        : "Rigged mode is OFF (cosmetic only). Click to enable.";

        // Keep the donation/tax hint in sync when Rigged Mode is toggled.
        updateDonationHint();
    }

    function fmtUserList(arr) {
        return arr.map(n => `[b]${sanitizeNick(n)}[/b]`).join(", ");
    }

    // Safely read the host's BON balance from the page, regardless of locale separators
    function readHostBalance() {
        try {
            const points = document.querySelector(".ratio-bar__points");
            if (!points) return 0;
            const raw = points.textContent || "";
            // DarkPeers currently renders values such as "9 961". Parse the full
            // element text so this remains correct whether the theme uses a child
            // element or renders the number directly in .ratio-bar__points.
            const digitsOnly = raw.replace(/[^\d]/g, "");
            const n = parseInt(digitsOnly, 10);
            return Number.isNaN(n) ? 0 : n;
        } catch {
            return 0;
        }
    }
    // ---- Live BON balance refresh (no page reload) ----
    // Some UNIT3D pages don't live-update the ratio bar when BON changes.
    // For host-only funding checks (start / !addbon), we pull a fresh snapshot via background fetch.
    const BON_BALANCE_FETCH_MAX_AGE_MS = 1200; // cache window to avoid spam-click bursts
    const BON_BALANCE_FETCH_TIMEOUT_MS = 7000;

    let bonBalanceFetchCache = {
        value: null,     // number | null
        fetchedAt: 0,    // ms
        inFlight: null   // Promise<number|null> | null
    };

    function parseBonBalanceFromDocument(doc) {
        try {
            const points = doc?.querySelector?.(".ratio-bar__points");
            if (!points) return null;

            // use full textContent (covers sites/themes that don't have a single child)
            const raw = (points.textContent || "").trim();
            const digitsOnly = raw.replace(/[^\d]/g, "");
            if (!digitsOnly) return null;

            const n = parseInt(digitsOnly, 10);
            return Number.isNaN(n) ? null : n;
        } catch {
            return null;
        }
    }

    async function fetchFreshBonBalance({ maxAgeMs = BON_BALANCE_FETCH_MAX_AGE_MS, timeoutMs = BON_BALANCE_FETCH_TIMEOUT_MS } = {}) {
        const now = Date.now();

        // Reuse a recent value
        if (bonBalanceFetchCache.value != null && (now - bonBalanceFetchCache.fetchedAt) <= maxAgeMs) {
            return bonBalanceFetchCache.value;
        }

        // Reuse an in-flight request
        if (bonBalanceFetchCache.inFlight) return bonBalanceFetchCache.inFlight;

        bonBalanceFetchCache.inFlight = (async () => {
            try {
                // Home page usually includes the top nav ratio bar on UNIT3D installs.
                // If a particular theme/routeset doesn't, fall back to the current page.
                const tryUrls = [
                    new URL("/", location.origin),
                    new URL(location.pathname, location.origin)
                ];

                let n = null;

                for (const url of tryUrls) {
                    const res = await fetchWithTimeout(url, {
                        credentials: "include",
                        cache: "no-store",
                        headers: { "Accept": "text/html" }
                    }, timeoutMs);

                    if (!res.ok) continue;

                    const html = await res.text();
                    const doc = new DOMParser().parseFromString(html, "text/html");
                    n = parseBonBalanceFromDocument(doc);

                    if (n != null) break;
                }

                if (n != null) {
                    bonBalanceFetchCache.value = n;
                    bonBalanceFetchCache.fetchedAt = Date.now();
                }

                return n;
            } catch {
                return null;
            } finally {
                bonBalanceFetchCache.inFlight = null;
            }
        })();

        return bonBalanceFetchCache.inFlight;
    }

    /**
     * Get the host BON balance.
     * - requireServer=true: only return a value if we successfully fetched/parsing server HTML (safest for funding checks).
     * - requireServer=false: fallback to DOM if fetch fails.
     */
    async function getVerifiedHostBalance({ requireServer = false, maxAgeMs = BON_BALANCE_FETCH_MAX_AGE_MS } = {}) {
        const fresh = await fetchFreshBonBalance({ maxAgeMs });

        if (typeof fresh === "number" && Number.isFinite(fresh) && fresh >= 0) return fresh;

        if (requireServer) return null;

        const dom = readHostBalance();
        return (typeof dom === "number" && Number.isFinite(dom)) ? dom : 0;
    }



    function ordinal(n){
        const rem100 = n % 100;
        if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
        switch (n % 10){
            case 1: return `${n}st`;
            case 2: return `${n}nd`;
            case 3: return `${n}rd`;
            default: return `${n}th`;
        }
    }

    function getLuckyNumber(giveawayData) {
        // Returns a FREE number centered in the largest gap (or null if none left).
        const start = giveawayData.startNum;
        const end = giveawayData.endNum;

        // Unique + sorted taken list
        const taken = Array.from(new Set(numberEntries.values()))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b);

        let bestLen = 0;
        let bestPick = null;

        // Sentinel at the end so the final gap is considered
        const boundaries = taken.concat([end + 1]);

        let prev = start - 1;
        for (const current of boundaries) {
            // Free interval: (prev, current) => [prev+1 .. current-1]
            const freeLen = current - prev - 1;
            if (freeLen > bestLen) {
                // Pick the center-left number of the free interval
                bestLen = freeLen;
                bestPick = prev + 1 + Math.floor((freeLen - 1) / 2);
            }
            prev = current;
        }

        if (bestPick === null || bestLen <= 0) return null;

        // Clamp just in case
        if (bestPick < start) bestPick = start;
        if (bestPick > end) bestPick = end;

        return bestPick;
    }




    function cleanPotString(giveawayPotAmount) {
        // Always returns a number. Rounds to integer if whole, otherwise keeps 2 decimals.
        const n = Number(giveawayPotAmount) || 0;
        return Number.isInteger(n) ? n : Math.round(n * 100) / 100;
    }

    function getGiveawayRemainingMs(data = giveawayData) {
        if (!data) return 0;
        const endTs = Number(data.endTs);
        if (Number.isFinite(endTs)) return Math.max(0, endTs - Date.now());
        return Math.max(0, Number(data.timeLeft) || 0) * 1000;
    }

    function syncGiveawayTimeLeft(data = giveawayData) {
        const ms = getGiveawayRemainingMs(data);
        if (data) data.timeLeft = Math.max(0, Math.ceil(ms / 1000));
        return ms;
    }

    function isGiveawaySettling(data = giveawayData) {
        return !!(
            data &&
            (
                data.__ending ||
                data.__closingIntent === true ||
                data.__closingNoticeSent === true ||
                data?.settlement?.phase === "settling"
            )
        );
    }

    function hasIncompleteSettlement(data = giveawayData) {
        if (!data) return false;
        if (data?.settlement?.phase === "complete") return false;
        return !!(
            data.__ending ||
            data.__closingIntent === true ||
            data.__closingNoticeSent === true ||
            data?.settlement?.committed === true ||
            data?.settlement?.phase === "settling"
        );
    }

    function parseTime(ms) {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        const parts = [];
        if (hours) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
        if (minutes) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
        if (seconds) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
        return parts.join(", ");
    }
    function getChatMsgText(msgNode) {
        const raw = (getMessageContentElement(msgNode)?.textContent || "");
        // Remove zero-width obfuscation chars so regex/includes work reliably
        return raw.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim();
    }


    function totalMinutes () {
        const t = parseInt(String(timerInput?.value ?? ""), 10);
        return (Number.isFinite(t) && t > 0) ? t : 0;
    }

    function nextReminderMs(schedule, msLeft) {
        if (!schedule || !schedule.length) return null;

        // Drop reminders we've clearly passed (more than ~1s behind us)
        // e.g. if the tab was suspended or the host adjusted the end time.
        while (schedule.length && msLeft < schedule[0] - 1000) {
            schedule.shift();
        }
        if (!schedule.length) return null;

        // Next upcoming reminder triggers when msLeft shrinks down to schedule[0].
        // msToNext is positive before we reach it, ~0 around the tick it fires,
        // and negative if we're a little bit late.
        return msLeft - schedule[0];
    }

    // Returns [maxReminders, minInterval (in min)]
    function getReminderLimits(totalMinutes) {
        const MIN_INTERVAL = 5; // 5 min between reminders
        if (totalMinutes < MIN_INTERVAL) return [0, null];
        const max = Math.min(MAX_REMINDERS, Math.floor(totalMinutes / MIN_INTERVAL));
        return [max, MIN_INTERVAL];
    }

    // Returns [N reminders] timestamps (ms before end) evenly spaced
    function getReminderSchedule(totalMinutes, numReminders) {
        if (numReminders < 1) return [];
        const interval = totalMinutes / (numReminders + 1);
        return Array.from({length: numReminders}, (_,i) =>
                          Math.round((totalMinutes - (i + 1) * interval) * 60_000)
                         );
    }

    function shouldSendReminder(giveawayData) {
        // Look at a small recent window to avoid duplicate reminders.
        const messages = Array.from(document.querySelectorAll('.chatbox-message'));

        for (let i = messages.length - 1; i >= Math.max(messages.length - 7, 0); i--) {
            const msgNode = messages[i];
            const author = getAuthor(msgNode);
            const text = getChatMsgText(msgNode);

            if (
                normalizeUserKey(author) === normalizeUserKey(giveawayData.host) &&
                text.includes("Gift the host to add to the pot")
            ) {
                return false; // Recent visible reminder by host exists
            }
        }
        return true;
    }

    // Live sync reminder number field with allowed max/min and show interval
    function syncReminderNumUI() {
        if (!giveawayForm) return;
        const totMin = totalMinutes();
        const [maxRem, minInterval] = getReminderLimits(totMin);

        remNumInput.max = maxRem;
        remNumInput.min = 0;

        // Clamp to allowed range
        if (Number(remNumInput.value) > maxRem) remNumInput.value = maxRem;
        if (Number(remNumInput.value) < 0) remNumInput.value = 0;

        // Show interval in "Every" field
        if (Number(remNumInput.value) > 0) {
            const interval = totMin / (Number(remNumInput.value) + 1);
            reminderEvery.value = interval.toFixed(2).replace(/\.00$/,"") + " min";
        } else {
            reminderEvery.value = "–";
        }
        const label = giveawayForm.querySelector('label[for="reminderNum"]');
        if (label) {
            label.textContent = "# Reminders" + (maxRem ? ` (max ${maxRem})` : '');
        }
    }

    function cacheChatContext() {
        OT_USER_ID = null;
        OT_CHATROOM_ID = null;
        OT_CSRF_TOKEN = null;

        if (DEBUG_SETTINGS.verify_cacheChatContext) {
            console.debug("cacheChatContext: starting cache refresh");
        }

        // Try the Unit3D chatbox x-data payload first
        const section = document.querySelector('section#chatbody[x-data]');
        if (section) {
            try {
                const raw = section.getAttribute('x-data');
                if (DEBUG_SETTINGS.verify_cacheChatContext) {
                    console.debug("cacheChatContext: found x-data attribute:", raw);
                }
                // Extract the substring 'JSON.parse(...)' from raw
                const jsonParseMatch = raw.match(/JSON\.parse\((['"])([\s\S]*?)\1\)/);
                if (jsonParseMatch) {
                    let jsonContent = jsonParseMatch[2]; // the JSON string inside the quotes
                    if (DEBUG_SETTINGS.verify_cacheChatContext) {
                        console.debug("cacheChatContext: extracted JSON content:", jsonContent);
                    }
                    try {
                        // The x-data attribute contains JavaScript-escaped strings (\x7B, \x22, \\, \/, etc.)
                        // that JSON.parse can't handle directly. Decode JS escapes in a single pass so that
                        // \\ is consumed before \uNNNN. This matches how JS string literal parsing works.
                        jsonContent = jsonContent.replace(
                            /\\(u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|\\|'|\/|n|r|t|b|f)/g,
                            (_, esc) => {
                                if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
                                if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
                                const simple = { '\\': '\\', "'": "'", '/': '/', 'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f' };
                                return simple[esc] || esc;
                            }
                        );

                        const jsonData = JSON.parse(jsonContent);
                        if (jsonData) {
                            OT_USER_ID = Number(jsonData.id);
                            OT_CHATROOM_ID = Number(jsonData.chatroom_id);
                        }
                    } catch (e) {
                        if (DEBUG_SETTINGS.verify_cacheChatContext) {
                            console.debug("cacheChatContext: error parsing JSON content", e);
                        }
                    }
                } else {
                    if (DEBUG_SETTINGS.verify_cacheChatContext) {
                        console.debug("cacheChatContext: JSON.parse(...) pattern not found in x-data");
                    }
                }
            } catch (e) {
                if (DEBUG_SETTINGS.verify_cacheChatContext) {
                    console.debug("cacheChatContext: error reading x-data attribute", e);
                }
            }
        }

        // CSRF token
        const xsrfToken = document.querySelector('meta[name=csrf-token]')?.content ||
              window?.CSRF_TOKEN ||
              (document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || "");
        OT_CSRF_TOKEN = xsrfToken ? decodeURIComponent(xsrfToken) : "";

        if (DEBUG_SETTINGS.verify_cacheChatContext) {
            console.debug("cacheChatContext: final OT_CSRF_TOKEN =", OT_CSRF_TOKEN ? "[token present]" : "[token missing]");
        }
    }

    // ───────────────────────────────────────────────────────────
