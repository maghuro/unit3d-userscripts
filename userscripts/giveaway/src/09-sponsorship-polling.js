    // SECTION 9: Sponsorhip Polling and Parsing
    // ───────────────────────────────────────────────────────────

    // Parse a BON gift chat message into { gifter, recipient, amount }
    function parseGiftMessage(html) {
        if (!html || !html.includes('has gifted')) return {};
        const perfStart = PERF ? performance.now() : 0;
        const doc = giftDOMParser.parseFromString(html, "text/html");
        const links = doc.querySelectorAll('a');
        const firstLink = links[0] || null;
        const secondLink = links[1] || null;
        const text = doc.body.textContent || "";
        const m = text.match(GIFT_AMOUNT_RE);

        const amount = m ? Number(m[1]) : NaN;

        const parsed = m && firstLink && secondLink && Number.isFinite(amount) && amount > 0
        ? {
            gifter: firstLink.textContent.trim(),
            recipient: secondLink.textContent.trim(),
            amount
        }
        : {};

        if (PERF) perfMeasure('message_parse_gift_html', perfStart);
        return parsed;
    }

    function giftHistoryUsernameFromCell(cell) {
        if (!cell) return "";
        const link = cell.querySelector('a[href*="/users/"]');
        if (link) {
            try {
                const url = new URL(link.getAttribute("href") || link.href || "", location.origin);
                const parts = url.pathname.split("/").filter(Boolean);
                const idx = parts.findIndex(part => part.toLowerCase() === "users");
                if (idx !== -1 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
            } catch {}
        }
        return String(cell.textContent || "").trim();
    }

    function parseUnit3dTimestamp(value) {
        const raw = String(value || "").trim();
        if (!raw) return NaN;

        // DarkPeers Gift History currently renders Carbon timestamps without a
        // timezone suffix. Preserve both browser-local and UTC-scale interpretations;
        // SponsorTracker learns the actual site-wall-clock ↔ chat-API offset from
        // unambiguous gifts instead of assuming either interpretation is canonical.
        const dbStyle = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
        if (dbStyle) return Date.parse(`${dbStyle[1]}T${dbStyle[2]}${dbStyle[3] || ""}`);

        return Date.parse(raw);
    }

    function parseUnit3dTimestampUtcFallback(value) {
        const raw = String(value || "").trim();
        const dbStyle = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
        return dbStyle ? Date.parse(`${dbStyle[1]}T${dbStyle[2]}${dbStyle[3] || ""}Z`) : NaN;
    }

    function unit3dTimestampResolutionMs(value) {
        const raw = String(value || "").trim();
        const timestamp = raw.match(
            /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/
        );
        if (!timestamp) return 1;
        if (!timestamp[1]) return 1000;
        const fractionalDigits = Math.min(timestamp[1].length, 3);
        return Math.max(1, 1000 / (10 ** fractionalDigits));
    }

    // Parse the logged-in user's gift-history table. UNIT3D stores the gift
    // message here, but deliberately omits it from the public SystemBot line.
    function parseGiftHistoryPage(html) {
        if (!html) return [];
        const doc = giftDOMParser.parseFromString(html, "text/html");
        return Array.from(doc.querySelectorAll("table.data-table tbody tr"))
            .map(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length < 5) return null;

                const amountText = String(cells[2].textContent || "")
                    .replace(/[\s\u00A0]+/g, "")
                    .replace(/,/g, "");
                const amountMatch = amountText.match(/[0-9]+(?:\.[0-9]+)?/);
                const amount = amountMatch ? Number(amountMatch[0]) : NaN;

                const timeEl = cells[4].querySelector("time");
                const rawTimestamp = timeEl?.getAttribute("datetime") || "";
                const createdAtTs = parseUnit3dTimestamp(rawTimestamp);
                const createdAtAltTs = parseUnit3dTimestampUtcFallback(rawTimestamp);
                const timestampResolutionMs = unit3dTimestampResolutionMs(rawTimestamp);

                const rawMessage = String(cells[3].textContent || "")
                    .replace(/\s+/g, " ")
                    .trim();
                const message = /^no note$/i.test(rawMessage) ? "" : rawMessage;

                return {
                    sender: giftHistoryUsernameFromCell(cells[0]),
                    recipient: giftHistoryUsernameFromCell(cells[1]),
                    amount,
                    message,
                    rawTimestamp,
                    createdAtTs,
                    createdAtAltTs,
                    timestampResolutionMs
                };
            })
            .filter(item =>
                item &&
                item.sender &&
                item.recipient &&
                Number.isFinite(item.amount) &&
                item.amount > 0
            );
    }

    function parseGiftNotificationsPage(html, hostName) {
        if (!html) return [];
        const doc = giftDOMParser.parseFromString(html, "text/html");
        const host = String(hostName || "").trim();

        return Array.from(doc.querySelectorAll("table.data-table tbody tr"))
            .map(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length < 3) return null;

                const title = String(cells[0].textContent || "").replace(/\s+/g, " ").trim();
                const body = String(cells[1].textContent || "").replace(/\s+/g, " ").trim();
                const timeEl = cells[2].querySelector("time");
                const rawTimestamp = timeEl?.getAttribute("datetime") || "";
                const createdAtTs = parseUnit3dTimestamp(rawTimestamp);
                const createdAtAltTs = parseUnit3dTimestampUtcFallback(rawTimestamp);

                const titleMatch = title.match(/^(.+?)\s+Has Gifted You\s+([0-9]+(?:\.[0-9]+)?)\s+BON$/i);
                const bodyMatch = body.match(/^(.+?)\s+has gifted you\s+([0-9]+(?:\.[0-9]+)?)\s+BON\s+with the following note:\s*(.*)$/i);
                if (!titleMatch || !bodyMatch) return null;

                const sender = String(bodyMatch[1] || titleMatch[1] || "").trim();
                const titleAmount = Number(titleMatch[2]);
                const bodyAmount = Number(bodyMatch[2]);
                if (!sender || !Number.isFinite(titleAmount) || !Number.isFinite(bodyAmount)) return null;
                if (Math.abs(titleAmount - bodyAmount) > 0.001) return null;

                const rawNote = String(bodyMatch[3] || "").replace(/\s+/g, " ").trim();
                const message = /^no note$/i.test(rawNote) ? "" : rawNote;

                // UNIT3D renders one CSRF-protected PATCH form per notification.
                // Preserve the form's own action/hidden fields so cleanup can mirror
                // the site's supported "mark read" operation instead of guessing an API.
                const markReadForm = Array.from(row.querySelectorAll('form[method="POST"], form[method="post"]'))
                    .find(form =>
                        String(form.querySelector('input[name="_method"]')?.value || "").toUpperCase() === "PATCH"
                    ) || null;
                const markReadButton = markReadForm?.querySelector("button");
                const markReadAction = String(markReadForm?.getAttribute("action") || "").trim();
                const markReadFields = markReadForm
                    ? Array.from(markReadForm.querySelectorAll("input[name]"))
                        .map(input => [
                            String(input.getAttribute("name") || "").trim(),
                            String(input.value ?? "")
                        ])
                        .filter(([name]) => !!name)
                    : [];
                const unread =
                    cells[0].classList.contains("notification--unread") ||
                    (!!markReadButton && !markReadButton.disabled);

                return {
                    sender,
                    recipient: host,
                    amount: bodyAmount,
                    message,
                    rawTimestamp,
                    createdAtTs,
                    createdAtAltTs,
                    unread,
                    markReadAction,
                    markReadFields
                };
            })
            .filter(item =>
                item &&
                item.sender &&
                Number.isFinite(item.amount) &&
                item.amount > 0
            );
    }

    function giftNotificationOverlapsWindow(notification, startTs, endTs) {
        const start = Number(startTs);
        const end = Number(endTs);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;

        const resolutionMs = unit3dTimestampResolutionMs(notification?.rawTimestamp);
        const candidates = [
            Number(notification?.createdAtTs),
            Number(notification?.createdAtAltTs)
        ].filter(Number.isFinite);

        return candidates.some(ts =>
            (ts + resolutionMs) >= start &&
            ts <= (end + resolutionMs)
        );
    }

    async function markGiveawayBonNotificationsRead({ hostName, startTs, endTs } = {}) {
        // Cleanup is deliberately outside settlement correctness. It never runs in
        // rehearsal mode and every failure is absorbed by this helper/caller.
        if (REHEARSAL_MODE) {
            return { matched: 0, marked: 0, failed: 0, skipped: "rehearsal" };
        }

        const host = String(hostName || "").trim();
        const start = Number(startTs);
        const end = Number(endTs);
        const senderSlug = getAuthenticatedUserSlug();
        if (
            !host ||
            !senderSlug ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            end < start
        ) {
            return { matched: 0, marked: 0, failed: 0, skipped: "invalid-context" };
        }

        const notificationsPath = `/users/${encodeURIComponent(decodeURIComponent(senderSlug))}/notifications`;
        const targetsByAction = new Map();
        const maxPages = 6;

        for (let page = 1; page <= maxPages; page++) {
            try {
                const notificationsUrl = new URL(notificationsPath, location.origin);
                if (page > 1) notificationsUrl.searchParams.set("page", String(page));
                notificationsUrl.searchParams.set("_dpgw_cleanup", String(Date.now()));

                const res = await fetchWithTimeout(
                    notificationsUrl,
                    {
                        credentials: "same-origin",
                        cache: "no-store"
                    },
                    5000
                );
                if (!res?.ok) continue;

                const rows = parseGiftNotificationsPage(await res.text(), host);
                for (const notification of rows) {
                    if (!notification.unread) continue;
                    if (!notification.markReadAction || !notification.markReadFields?.length) continue;
                    if (!giftNotificationOverlapsWindow(notification, start, end)) continue;

                    let actionUrl;
                    try {
                        actionUrl = new URL(notification.markReadAction, location.origin);
                    } catch {
                        continue;
                    }

                    // Never POST a parsed form away from DarkPeers or outside this
                    // authenticated user's notification routes.
                    if (actionUrl.origin !== location.origin) continue;
                    if (!actionUrl.pathname.startsWith(notificationsPath + "/")) continue;

                    targetsByAction.set(actionUrl.href, {
                        actionUrl,
                        fields: notification.markReadFields
                    });
                }
            } catch (e) {
                console.warn(`[BON Giveaway] Notification cleanup page ${page} skipped:`, e);
            }
        }

        const targets = Array.from(targetsByAction.values());
        let marked = 0;
        let failed = 0;
        const concurrency = 4;

        for (let offset = 0; offset < targets.length; offset += concurrency) {
            const batch = targets.slice(offset, offset + concurrency);
            const results = await Promise.allSettled(batch.map(async target => {
                const body = new URLSearchParams();
                for (const [name, value] of target.fields) body.append(name, value);

                const res = await fetchWithTimeout(
                    target.actionUrl,
                    {
                        method: "POST",
                        credentials: "same-origin",
                        cache: "no-store",
                        redirect: "follow",
                        headers: {
                            "Accept": "text/html",
                            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                        },
                        body: body.toString()
                    },
                    5000
                );
                if (!res?.ok) {
                    throw new Error(`HTTP ${res?.status || "unknown"}`);
                }
            }));

            for (const result of results) {
                if (result.status === "fulfilled") marked += 1;
                else failed += 1;
            }
        }

        console.info(
            `[BON Giveaway] BON notification cleanup: matched=${targets.length}, marked=${marked}, failed=${failed}`
        );
        return { matched: targets.length, marked, failed };
    }

    function giftHistoryBaseKey(item) {
        const sender = normalizeUserKey(item?.sender);
        const recipient = normalizeUserKey(item?.recipient);
        const amount = Number(item?.amount);
        const timestamp = String(item?.rawTimestamp || "");
        const message = String(item?.message || "");
        if (!sender || !recipient || !Number.isFinite(amount)) return "";
        return [sender, recipient, amount.toFixed(2), timestamp, message].join("\u001f");
    }

    function indexGiftHistoryRows(rows) {
        const counts = new Map();
        return (Array.isArray(rows) ? rows : []).map(item => {
            const baseKey = giftHistoryBaseKey(item);
            if (!baseKey) return { ...item, historyKey: "" };
            const occurrence = (counts.get(baseKey) || 0) + 1;
            counts.set(baseKey, occurrence);
            return { ...item, historyKey: `${baseKey}\u001f${occurrence}` };
        });
    }

    function sanitizeSponsorGiftMessage(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 255)
            // Gift messages are user-controlled. Neutralize BBCode delimiters
            // before echoing them into a userscript-generated chat message.
            .replace(/\[/g, "［")
            .replace(/\]/g, "］");
    }

    function truncateSponsorGiftMessage(value, maxChars = SPONSOR_ANNOUNCE.max_note_chars) {
        const clean = sanitizeSponsorGiftMessage(value);
        const limit = Math.max(8, Math.floor(Number(maxChars) || 0));
        if (!clean || clean.length <= limit) return clean;
        return clean.slice(0, Math.max(1, limit - 1)).trimEnd() + "…";
    }

    function visibleChatLength(value) {
        return String(value || "")
            .replace(/\[[^\]]+\]/g, "")
            .replace(/[\u200B\u2063]/g, "")
            .length;
    }

    function recordSponsorGiftMessage(data, event) {
        if (!data || !event) return false;
        const message = sanitizeSponsorGiftMessage(event.message);
        const sponsor = String(event.gifter || "").trim();
        const sponsorKey = normalizeUserKey(sponsor);
        const amount = Math.max(0, Math.floor(Number(event.amount) || 0));
        const createdAtTs = Number.isFinite(Number(event.createdAtTs))
            ? Number(event.createdAtTs)
            : null;

        if (!message || !sponsorKey || !(amount > 0)) return false;
        if (!Array.isArray(data.sponsorGiftMessages)) data.sponsorGiftMessages = [];

        const duplicate = data.sponsorGiftMessages.some(item =>
            normalizeUserKey(item?.sponsor) === sponsorKey &&
            Math.max(0, Math.floor(Number(item?.amount) || 0)) === amount &&
            String(item?.message || "") === message &&
            (
                createdAtTs === null ||
                item?.createdAtTs == null ||
                Math.abs(Number(item.createdAtTs) - createdAtTs) < 1000
            )
        );
        if (duplicate) return false;

        data.sponsorGiftMessages.push({
            sponsor,
            amount,
            message,
            createdAtTs
        });
        return true;
    }

    function optionalFiniteNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }

    class SponsorTracker {
        /** @param {{chatroomId:string, giveawayStartTime:Date, giveawayData:Object, lastMsgId?:number, cursorInitialized?:boolean, giftHistoryClockOffsetMs?:number|null, giftHistoryInitialized?:boolean, giftHistorySeenKeys?:string[], historyFallbackActive?:boolean}} opts */
        constructor({
            chatroomId,
            giveawayStartTime,
            giveawayData,
            lastMsgId = 0,
            cursorInitialized = false,
            giftHistoryClockOffsetMs = null,
            giftHistoryInitialized = false,
            giftHistorySeenKeys = [],
            historyFallbackActive = false,
            maxAcceptedCreatedAtTs = null
        }) {
            this.chatroomId = chatroomId;
            this.giveawayStartTs = giveawayStartTime.getTime();
            this.data = giveawayData;

            this.lastMsgId = Math.max(0, Math.floor(Number(lastMsgId) || 0)); // persisted API cursor
            this.cursorInitialized = !!cursorInitialized;
            this.giftHistoryClockOffsetMs = optionalFiniteNumber(giftHistoryClockOffsetMs);
            this.giftHistoryInitialized = !!giftHistoryInitialized;
            this.giftHistorySeenKeys = new Set(
                (Array.isArray(giftHistorySeenKeys) ? giftHistorySeenKeys : [])
                    .filter(key => typeof key === "string" && key)
            );
            this.historyFallbackActive = !!historyFallbackActive;
            this.maxAcceptedCreatedAtTs = optionalFiniteNumber(maxAcceptedCreatedAtTs);
            this.pollInFlight = null; // serialize/coalesce polling so the same gift cannot be applied twice
            this.processedIds = new Set(); // chat-fallback de-dupe within this page lifetime
            this.buffer = []; // gifts waiting to be announced
            this.sponsorWindowStartAt = 0; // digest window start (ms)
            this.sponsorSet = new Set(
                (Array.isArray(giveawayData.sponsors) ? giveawayData.sponsors : [])
                    .map(normalizeUserKey)
                    .filter(Boolean)
            );
        }

        /* ---- poll for any chat messages since last cursor ---- */
        async fetchNew() {
            const url = new URL(`/api/chat/messages/${this.chatroomId}`, location.origin);
            // Some UNIT3D versions ignore after_id. Send it as an optimization,
            // but poll() also enforces lastMsgId locally for correctness.
            if (this.lastMsgId) url.searchParams.set("after_id", this.lastMsgId);

            const res = await fetchWithTimeout(url, { credentials: "include" }, 7000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const payload = await res.json();
            return Array.isArray(payload && payload.data) ? payload.data : [];
        }

        /**
         * Establish a cursor without applying messages. Used only for legacy
         * snapshots that pre-date cursor persistence, preventing sponsor replay.
         */
        async bootstrapCursor() {
            const url = new URL(`/api/chat/messages/${this.chatroomId}`, location.origin);
            const res = await fetchWithTimeout(url, { credentials: "include" }, 7000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            const messages = Array.isArray(payload && payload.data) ? payload.data : [];
            for (const m of messages) {
                const id = Math.floor(Number(m && m.id));
                if (Number.isFinite(id) && id > this.lastMsgId) this.lastMsgId = id;
            }
            this.cursorInitialized = true;
            snapshotGiveaway();
        }

        trimGiftHistorySeenKeys() {
            if (this.giftHistorySeenKeys.size <= 250) return;
            this.giftHistorySeenKeys = new Set(
                Array.from(this.giftHistorySeenKeys).slice(-250)
            );
        }

        setGiftHistoryBaseline(rows) {
            for (const item of indexGiftHistoryRows(rows)) {
                if (item.historyKey) this.giftHistorySeenKeys.add(item.historyKey);
            }
            this.trimGiftHistorySeenKeys();
            this.giftHistoryInitialized = true;
        }

        async bootstrapGiftHistory() {
            try {
                const rows = await this.fetchRecentGiftHistory();
                const offset = await this.ensureGiftHistoryClockOffset(rows);

                // DarkPeers Gift History currently renders site wall-clock time,
                // while Notifications/System API timestamps are UTC. If historical
                // rows exist, starting without a calibrated offset would recreate
                // the exact sponsor-window bug from v1.4.3. Empty histories are
                // allowed; the first received gift can establish the calibration.
                if (rows.length && optionalFiniteNumber(offset) === null) {
                    throw new Error(
                        "Gift History contains rows but its DarkPeers wall-clock offset could not be calibrated."
                    );
                }

                this.setGiftHistoryBaseline(rows);
                this.historyFallbackActive = false;
                return true;
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("Gift History bootstrap failed; Chat API fallback armed:", e);
                }
                this.historyFallbackActive = true;
                return false;
            }
        }

        async reconcileCanonicalSponsorAccounting({ repairStats = false } = {}) {
            const endpointPath = getGiftEndpointPath(getAuthenticatedUserSlug());
            if (!endpointPath) {
                throw new Error("Cannot resolve Gift History endpoint for sponsor reconciliation.");
            }

            const rows = [];
            const MAX_RECONCILE_PAGES = 20;
            let reachedWindowStart = false;

            for (let page = 1; page <= MAX_RECONCILE_PAGES; page++) {
                const historyUrl = new URL(endpointPath, location.origin);
                if (page > 1) historyUrl.searchParams.set("page", String(page));
                historyUrl.searchParams.set("_dpgw_reconcile", String(Date.now()));

                const res = await fetchWithTimeout(
                    historyUrl,
                    {
                        credentials: "same-origin",
                        cache: "no-store"
                    },
                    7000
                );
                if (!res.ok) {
                    throw new Error(`Gift History reconciliation page ${page} HTTP ${res.status}`);
                }

                const pageRows = parseGiftHistoryPage(await res.text());
                if (!pageRows.length) {
                    reachedWindowStart = true;
                    break;
                }

                rows.push(...pageRows);

                const offset = optionalFiniteNumber(this.giftHistoryClockOffsetMs)
                    ?? await this.ensureGiftHistoryClockOffset(rows);

                if (offset !== null) {
                    reachedWindowStart = rows.some(item => {
                        const wallTs = Number.isFinite(Number(item?.createdAtAltTs))
                            ? Number(item.createdAtAltTs)
                            : Number(item?.createdAtTs);
                        if (!Number.isFinite(wallTs)) return false;
                        const resolutionMs = Math.max(
                            1,
                            Number.isFinite(Number(item?.timestampResolutionMs))
                                ? Number(item.timestampResolutionMs)
                                : unit3dTimestampResolutionMs(item?.rawTimestamp)
                        );
                        return ((wallTs - offset) + resolutionMs) <= this.giveawayStartTs;
                    });
                    if (reachedWindowStart) break;
                }

                if (page === MAX_RECONCILE_PAGES) {
                    throw new Error(
                        "Gift History reconciliation reached its page safety cap before proving coverage back to giveaway start."
                    );
                }
            }

            const offset = await this.ensureGiftHistoryClockOffset(rows);
            if (rows.length && optionalFiniteNumber(offset) === null) {
                throw new Error("Gift History reconciliation could not calibrate DarkPeers wall-clock time.");
            }

            if (!reachedWindowStart && rows.length) {
                // We deliberately do not guess completeness here. The loop normally
                // exits on an empty page or once an older pre-giveaway row proves the
                // window boundary. Anything else is unsafe to auto-repair.
                throw new Error("Gift History reconciliation could not prove complete coverage of the giveaway window.");
            }

            const indexed = indexGiftHistoryRows(rows);
            const hostKey = normalizeUserKey(this.data.host);
            const hostRows = indexed.filter(item =>
                item.historyKey &&
                normalizeUserKey(item.recipient) === hostKey
            );

            const maxTs =
                optionalFiniteNumber(this.maxAcceptedCreatedAtTs) ??
                optionalFiniteNumber(this.data?.settlement?.cutoffTs) ??
                optionalFiniteNumber(this.data?.endTs);

            const filtered = await this.filterHistoryRowsByWindow(
                hostRows,
                this.giveawayStartTs,
                maxTs,
                indexed
            );
            if (filtered.retryableKeys.size) {
                throw new Error(
                    "Gift History reconciliation found timestamp-boundary rows that are not yet safe to classify."
                );
            }

            const canonicalRows = filtered.accepted;
            const canonicalContribs = {};
            const canonicalNamesByKey = new Map();
            const canonicalMessages = [];
            let canonicalSponsoredTotal = 0;

            for (const item of canonicalRows) {
                const sponsor = String(item?.sender || "").trim();
                const sponsorKey = normalizeUserKey(sponsor);
                const amount = Math.max(0, Math.floor(Number(item?.amount) || 0));
                if (!sponsorKey || !(amount > 0)) continue;

                const displayName = canonicalNamesByKey.get(sponsorKey) || sponsor;
                canonicalNamesByKey.set(sponsorKey, displayName);
                canonicalContribs[displayName] =
                    (Number(canonicalContribs[displayName]) || 0) + amount;
                canonicalSponsoredTotal += amount;

                const message = sanitizeSponsorGiftMessage(item?.message);
                if (message) {
                    canonicalMessages.push({
                        sponsor: displayName,
                        amount,
                        message,
                        createdAtTs: Number.isFinite(Number(item?.createdAtTs))
                            ? Number(item.createdAtTs)
                            : null
                    });
                }
            }

            const oldLiveTotals = new Map(liveSponsorTotalThisGiveaway);
            const oldLiveSeen = new Set(liveSponsorSeenThisGiveaway);
            const canonicalTotalsByKey = new Map();
            for (const [name, amount] of Object.entries(canonicalContribs)) {
                const key = normalizeUserKey(name);
                if (key) canonicalTotalsByKey.set(key, Math.max(0, Math.floor(Number(amount) || 0)));
            }

            const hostAdded = Math.max(
                0,
                Math.floor(
                    Number(this.data.hostAdded ?? this.data.initialPotVerifiedAtStart) || 0
                )
            );
            const previousPot = Math.max(0, Math.floor(Number(this.data.amount) || 0));
            const previousSponsoredTotal = Math.max(
                0,
                Math.floor(sumSponsorContribs(this.data.sponsorContribs, this.data.host) || 0)
            );
            const canonicalPot = hostAdded + canonicalSponsoredTotal;

            this.data.sponsorContribs = canonicalContribs;
            this.data.sponsors = Array.from(canonicalNamesByKey.values());
            this.data.sponsorGiftMessages = canonicalMessages;
            this.data.amount = canonicalPot;

            liveSponsorSeenThisGiveaway.clear();
            liveSponsorTotalThisGiveaway.clear();
            for (const [name, amount] of Object.entries(canonicalContribs)) {
                const key = normalizeUserKey(name);
                if (!key || !(amount > 0)) continue;
                liveSponsorSeenThisGiveaway.add(key);
                liveSponsorTotalThisGiveaway.set(key, amount);
            }

            if (repairStats) {
                const stats = getStatsCached();
                const keys = new Set([
                    ...oldLiveTotals.keys(),
                    ...canonicalTotalsByKey.keys(),
                    ...oldLiveSeen
                ]);

                let statsChanged = false;
                for (const key of keys) {
                    const oldAmount = Math.max(0, Math.floor(Number(oldLiveTotals.get(key)) || 0));
                    const newAmount = Math.max(0, Math.floor(Number(canonicalTotalsByKey.get(key)) || 0));
                    const amountDelta = newAmount - oldAmount;
                    const wasSeen = oldLiveSeen.has(key);
                    const isSeen = canonicalTotalsByKey.has(key) && newAmount > 0;
                    const displayName =
                        canonicalNamesByKey.get(key) ||
                        this.data.sponsors.find(name => normalizeUserKey(name) === key) ||
                        key;
                    const rec = getOrCreateUserStats(stats, displayName);
                    if (!rec) continue;

                    if (amountDelta !== 0) {
                        rec.sponsoredTotal = Math.max(
                            0,
                            Math.floor(Number(rec.sponsoredTotal) || 0) + amountDelta
                        );
                        statsChanged = true;
                    }

                    if (wasSeen !== isSeen) {
                        rec.sponsorCount = Math.max(
                            0,
                            Math.floor(Number(rec.sponsorCount) || 0) + (isSeen ? 1 : -1)
                        );
                        statsChanged = true;
                    }

                    // Increasing this max is always safe. Decreasing it is not: the
                    // previous legitimate per-giveaway maximum is not retained
                    // separately, so an inflated live max is audited manually instead
                    // of risking destruction of an older valid record.
                    if (newAmount > Math.max(0, Math.floor(Number(rec.biggestSponsor) || 0))) {
                        rec.biggestSponsor = newAmount;
                        statsChanged = true;
                    }
                }

                if (statsChanged) {
                    saveGiveawayStats(stats);
                    _statsCache = stats;
                    _statsDirty = false;
                    if (_statsFlushTimer) {
                        clearTimeout(_statsFlushTimer);
                        _statsFlushTimer = null;
                    }
                }
            }

            recomputeEffectiveWinners(this.data);
            this.setGiftHistoryBaseline(rows);
            this.historyFallbackActive = false;

            logEvent(
                previousPot === canonicalPot && previousSponsoredTotal === canonicalSponsoredTotal
                    ? "Sponsor accounting verified from Gift History"
                    : "Sponsor accounting repaired from Gift History",
                `Persistent Gift History canonical total=${fmtBONCurrency(canonicalSponsoredTotal)} BON | pot ${fmtBONCurrency(previousPot)} -> ${fmtBONCurrency(canonicalPot)} BON`
            );

            return {
                repaired:
                    previousPot !== canonicalPot ||
                    previousSponsoredTotal !== canonicalSponsoredTotal,
                previousPot,
                canonicalPot,
                previousSponsoredTotal,
                canonicalSponsoredTotal,
                canonicalContribs
            };
        }

        async fetchRecentChatGiftEvents() {
            const messages = await this.fetchNew();
            return messages
                .filter(m => !!m?.bot?.is_systembot && String(m?.message || "").includes("has gifted"))
                .map(m => {
                    const parsed = this.parseGiftMsg(m.message);
                    const createdAtTs = Date.parse(m.created_at);
                    return {
                        messageId: Math.floor(Number(m?.id)),
                        gifter: parsed.gifter,
                        recipient: parsed.recipient,
                        amount: Math.max(0, Math.floor(Number(parsed.amount) || 0)),
                        rawAmount: Number(parsed.amount),
                        createdAtTs,
                        timestampResolutionMs: unit3dTimestampResolutionMs(m.created_at)
                    };
                })
                .filter(event =>
                    event.gifter &&
                    normalizeUserKey(event.recipient) === normalizeUserKey(this.data.host) &&
                    event.amount > 0
                );
        }

        async filterHistoryRowsByWindow(rows, minTs = null, maxTs = null, evidenceRows = null) {
            if (!Array.isArray(rows) || !rows.length) {
                return {
                    accepted: Array.isArray(rows) ? rows : [],
                    retryableKeys: new Set()
                };
            }

            const min = optionalFiniteNumber(minTs);
            let max = optionalFiniteNumber(maxTs);
            const liveMax = optionalFiniteNumber(this.maxAcceptedCreatedAtTs);
            const scheduledMax = optionalFiniteNumber(this.data?.endTs);
            for (const bound of [liveMax, scheduledMax]) {
                if (bound !== null) max = max === null ? bound : Math.min(max, bound);
            }
            if (min === null && max === null) {
                return { accepted: rows, retryableKeys: new Set() };
            }

            let offset = optionalFiniteNumber(this.giftHistoryClockOffsetMs);
            let chatEvents = null;

            const loadChatEvents = async () => {
                if (chatEvents !== null) return chatEvents;
                try {
                    chatEvents = await this.fetchRecentChatGiftEvents();
                } catch (e) {
                    chatEvents = [];
                    if (DEBUG_SETTINGS.log_chat_messages) {
                        console.warn("Sponsor history boundary chat fallback failed:", e);
                    }
                }
                return chatEvents;
            };

            if (offset === null) {
                offset = await this.ensureGiftHistoryClockOffset(rows);
            }

            // Re-read the closing latch after the await above. If endGiveaway()
            // closed the window while this ordinary poll was already in flight,
            // this pass must immediately inherit that cutoff.
            const latestMax = optionalFiniteNumber(this.maxAcceptedCreatedAtTs);
            if (latestMax !== null) max = max === null ? latestMax : Math.min(max, latestMax);

            // Coarse Gift History timestamps can straddle an exact manual closing
            // instant. Fetch chat evidence even when the site-clock offset is known.
            if (
                max !== null &&
                chatEvents === null &&
                rows.some(item => unit3dTimestampResolutionMs(item?.rawTimestamp) > 1)
            ) {
                await loadChatEvents();
            }

            const rowMatchesChatEvent = (item, event) =>
                normalizeUserKey(item?.sender) === normalizeUserKey(event?.gifter) &&
                normalizeUserKey(item?.recipient) === normalizeUserKey(event?.recipient) &&
                Math.abs(Number(item?.amount) - Number(event?.rawAmount)) <= 0.001;

            const intervalsOverlap = (aStart, aResolution, bStart, bResolution) =>
                aStart < (bStart + bResolution) &&
                bStart < (aStart + aResolution);

            const consumedBoundaryChatEvents = new Set();
            const boundaryEvidenceKey = (event, index) => {
                const id = Math.floor(Number(event?.messageId));
                return Number.isFinite(id) ? "id:" + id : "idx:" + index;
            };

            const historyStartsForBoundary = (item, resolutionMs) => {
                const wallTs = Number.isFinite(Number(item?.createdAtAltTs))
                    ? Number(item.createdAtAltTs)
                    : Number(item?.createdAtTs);

                if (offset !== null && Number.isFinite(wallTs)) {
                    const start = wallTs - offset;
                    return (min === null || (start + resolutionMs) > min) ? [start] : [];
                }

                return [
                    Number(item?.createdAtTs),
                    Number(item?.createdAtAltTs)
                ].filter(ts =>
                    Number.isFinite(ts) &&
                    (min === null || (ts + resolutionMs) > min)
                );
            };

            const chatProvesBeforeClose = (item, historyStarts, historyResolutionMs) => {
                if (max === null || !Array.isArray(chatEvents) || !chatEvents.length) return false;

                for (let index = 0; index < chatEvents.length; index++) {
                    const event = chatEvents[index];
                    const evidenceKey = boundaryEvidenceKey(event, index);
                    if (consumedBoundaryChatEvents.has(evidenceKey)) continue;
                    if (!rowMatchesChatEvent(item, event)) continue;

                    const chatStart = Number(event?.createdAtTs);
                    const chatResolution = Math.max(
                        1,
                        Number.isFinite(Number(event?.timestampResolutionMs))
                            ? Number(event.timestampResolutionMs)
                            : 1
                    );
                    if (!Number.isFinite(chatStart)) continue;

                    // A chat event only proves pre-cutoff timing when its entire
                    // source-time interval finishes by the inclusive close instant.
                    if ((chatStart + chatResolution) > (max + 1)) continue;

                    const overlaps = historyStarts.some(historyStart =>
                        Number.isFinite(historyStart) &&
                        intervalsOverlap(
                            historyStart,
                            historyResolutionMs,
                            chatStart,
                            chatResolution
                        )
                    );
                    if (!overlaps) continue;

                    consumedBoundaryChatEvents.add(evidenceKey);
                    return true;
                }
                return false;
            };

            // Reserve evidence for matching occurrences already seen in earlier
            // polls. This prevents a later identical post-cutoff history row from
            // reusing an older pre-cutoff SystemBot event.
            if (max !== null && Array.isArray(evidenceRows) && chatEvents?.length) {
                for (const priorItem of evidenceRows) {
                    if (!priorItem?.historyKey || !this.giftHistorySeenKeys.has(priorItem.historyKey)) {
                        continue;
                    }
                    const priorResolution = Math.max(
                        1,
                        Number.isFinite(Number(priorItem?.timestampResolutionMs))
                            ? Number(priorItem.timestampResolutionMs)
                            : 1
                    );
                    const priorStarts = historyStartsForBoundary(priorItem, priorResolution)
                        .filter(ts => ts <= max);
                    if (!priorStarts.length) continue;

                    chatProvesBeforeClose(priorItem, priorStarts, priorResolution);
                }
            }

            const accepted = [];
            const retryableKeys = new Set();
            for (const item of rows) {
                const resolutionMs = Math.max(
                    1,
                    Number.isFinite(Number(item?.timestampResolutionMs))
                        ? Number(item.timestampResolutionMs)
                        : 1
                );
                const wallTs = Number.isFinite(Number(item?.createdAtAltTs))
                    ? Number(item.createdAtAltTs)
                    : Number(item?.createdAtTs);

                if (offset !== null && Number.isFinite(wallTs)) {
                    const eventTs = wallTs - offset;
                    const afterOpen = min === null || (eventTs + resolutionMs) > min;
                    if (!afterOpen) continue;

                    if (max === null) {
                        accepted.push(item);
                        continue;
                    }

                    if (eventTs > max) continue;

                    if ((eventTs + resolutionMs) <= (max + 1)) {
                        accepted.push(item);
                        continue;
                    }

                    if (chatProvesBeforeClose(item, [eventTs], resolutionMs)) {
                        accepted.push(item);
                    } else {
                        if (item?.historyKey) retryableKeys.add(item.historyKey);
                        logEvent(
                            "Sponsor closing-boundary ambiguity",
                            `Deferred ${sanitizeNick(item?.sender || "unknown")} (${fmtBONCurrency(item?.amount || 0)} BON): source timestamp straddles the exact closing instant and chat timing could not yet prove it was pre-cutoff.`
                        );
                    }
                    continue;
                }

                const candidates = [
                    Number(item?.createdAtTs),
                    Number(item?.createdAtAltTs)
                ].filter(Number.isFinite);

                const openingCandidates = candidates.filter(ts =>
                    min === null || (ts + resolutionMs) > min
                );
                if (!openingCandidates.length) continue;

                if (max === null) {
                    accepted.push(item);
                    continue;
                }

                const notAfterClose = openingCandidates.filter(ts => ts <= max);
                if (!notAfterClose.length) continue;

                if (notAfterClose.some(ts => (ts + resolutionMs) <= (max + 1))) {
                    accepted.push(item);
                    continue;
                }

                if (chatProvesBeforeClose(item, notAfterClose, resolutionMs)) {
                    accepted.push(item);
                } else {
                    if (item?.historyKey) retryableKeys.add(item.historyKey);
                    logEvent(
                        "Sponsor closing-boundary ambiguity",
                        `Deferred ${sanitizeNick(item?.sender || "unknown")} (${fmtBONCurrency(item?.amount || 0)} BON): no timestamp interpretation yet proves a pre-cutoff gift.`
                    );
                }
            }
            return { accepted, retryableKeys };
        }

        async processGiftHistoryRows(rows, options = {}) {
            const optionMax = optionalFiniteNumber(options.maxCreatedAtTs);
            const trackerMax = optionalFiniteNumber(this.maxAcceptedCreatedAtTs);
            const scheduledMax = optionalFiniteNumber(this.data?.endTs);
            let maxCreatedAtTs = optionMax;
            for (const bound of [trackerMax, scheduledMax]) {
                if (bound !== null) {
                    maxCreatedAtTs = maxCreatedAtTs === null ? bound : Math.min(maxCreatedAtTs, bound);
                }
            }
            const minCreatedAtTs = optionalFiniteNumber(this.giveawayStartTs);
            const announce = options.announce !== false;
            const indexed = indexGiftHistoryRows(rows);
            const hostKey = normalizeUserKey(this.data.host);

            let newRows = indexed.filter(item =>
                item.historyKey &&
                !this.giftHistorySeenKeys.has(item.historyKey) &&
                normalizeUserKey(item.recipient) === hostKey
            );

            newRows.reverse();

            let retryableBoundaryKeys = new Set();
            if (newRows.length && (minCreatedAtTs !== null || maxCreatedAtTs !== null)) {
                const filtered = await this.filterHistoryRowsByWindow(
                    newRows,
                    minCreatedAtTs,
                    maxCreatedAtTs,
                    indexed
                );
                newRows = filtered.accepted;
                retryableBoundaryKeys = filtered.retryableKeys;
            }

            if (!canMutateActiveGiveaway()) return false;

            let recordedGiftNote = false;
            for (const item of newRows) {
                const cleanAmount = Math.max(0, Math.floor(Number(item.amount) || 0));
                if (!(cleanAmount > 0)) continue;

                const event = {
                    gifter: item.sender,
                    recipient: item.recipient,
                    amount: cleanAmount,
                    rawAmount: Number(item.amount),
                    message: sanitizeSponsorGiftMessage(item.message),
                    createdAtTs: Number.isFinite(Number(item.createdAtTs))
                        ? Number(item.createdAtTs)
                        : null
                };

                this.applyGift(event.gifter, event.amount);
                if (recordSponsorGiftMessage(this.data, event)) recordedGiftNote = true;
                this.buffer.push({
                    gifter: event.gifter,
                    amount: event.amount,
                    message: event.message || ""
                });
            }

            let seenStateChanged = false;
            for (const item of indexed) {
                if (!item.historyKey || retryableBoundaryKeys.has(item.historyKey)) continue;
                if (!this.giftHistorySeenKeys.has(item.historyKey)) {
                    this.giftHistorySeenKeys.add(item.historyKey);
                    seenStateChanged = true;
                }
            }
            this.trimGiftHistorySeenKeys();
            this.giftHistoryInitialized = true;
            this.historyFallbackActive = false;

            if (recordedGiftNote || newRows.length || seenStateChanged) snapshotGiveaway();

            if (this.buffer.length) {
                if (announce) await this.maybeFlush();
                else await this.flushBuffer(Date.now(), { announce: false });
            }

            return retryableBoundaryKeys.size === 0;
        }

        /* ---- Primary sponsor poll: UNIT3D Gift History ---- */
        async poll(options = {}) {
            const requestedCutoff = optionalFiniteNumber(options?.maxCreatedAtTs);
            if (requestedCutoff !== null) {
                const existingCutoff = optionalFiniteNumber(this.maxAcceptedCreatedAtTs);
                this.maxAcceptedCreatedAtTs = existingCutoff !== null
                    ? Math.min(existingCutoff, requestedCutoff)
                    : requestedCutoff;
            }

            const needsDedicatedPass =
                requestedCutoff !== null ||
                options?.announce === false;

            // Ordinary interval ticks coalesce onto the active poll. Settlement/final
            // passes wait for it and then run once with their own cutoff/options.
            if (this.pollInFlight) {
                if (!needsDedicatedPass) return this.pollInFlight;
                try { await this.pollInFlight; } catch {}
            }

            const run = this._pollOnce(options);
            this.pollInFlight = run;
            try {
                return await run;
            } finally {
                if (this.pollInFlight === run) this.pollInFlight = null;
            }
        }

        async _pollOnce(options = {}) {
            const perfStart = PERF ? performance.now() : 0;
            let historyRows;

            try {
                historyRows = await this.fetchRecentGiftHistory();
            } catch (e) {
                // Persistent Gift History is the canonical sponsorship ledger.
                // Do NOT mutate the pot from the rolling System/DPBot room here:
                // its cursor can lag behind Gift History and replay gifts that were
                // already counted during an earlier healthy history poll.
                this.historyFallbackActive = true;
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("Gift History unavailable; sponsor accounting paused until recovery:", e);
                }
                logEvent(
                    "Sponsor accounting paused (Gift History unavailable)",
                    "Keeping the current pot unchanged until persistent Gift History recovers; System/DPBot is diagnostic evidence only."
                );
                if (PERF) perfMeasure('sponsor_poll', perfStart);
                return false;
            }

            if (this.historyFallbackActive) {
                // Reconcile against the existing persistent boundary. Never replace
                // it with a fresh baseline after an outage: doing so can either hide
                // gifts missed during the outage or, when chat fallback was involved,
                // make stale System-room messages look new.
                if (this.giftHistoryInitialized) {
                    const ok = await this.processGiftHistoryRows(historyRows, options);
                    if (PERF) perfMeasure('sponsor_poll', perfStart);
                    return ok;
                }

                // Legacy snapshots may pre-date Gift History cursor persistence. For
                // those only, establish a baseline without applying historical rows;
                // this deliberately favors manual under-count recovery over duplicates.
                this.setGiftHistoryBaseline(historyRows);
                this.historyFallbackActive = false;
                snapshotGiveaway();
                if (PERF) perfMeasure('sponsor_poll', perfStart);
                return true;
            }

            if (!this.giftHistoryInitialized) {
                // Same conservative legacy-bootstrap rule as above. New giveaways
                // always initialize Gift History before their opening announcement.
                this.setGiftHistoryBaseline(historyRows);
                snapshotGiveaway();
                if (PERF) perfMeasure('sponsor_poll', perfStart);
                return true;
            }

            const ok = await this.processGiftHistoryRows(historyRows, options);
            if (PERF) perfMeasure('sponsor_poll', perfStart);
            return ok;
        }

        /* ---- pull gifter / recipient / amount from the HTML blob ---- */
        parseGiftMsg(html) {
            return parseGiftMessage(html);
        }

        async fetchRecentGiftNotifications() {
            const senderSlug = getAuthenticatedUserSlug();
            if (!senderSlug) return [];

            const notificationsPath = `/users/${encodeURIComponent(decodeURIComponent(senderSlug))}/notifications`;
            const rows = [];

            for (const page of [1, 2]) {
                const notificationsUrl = new URL(notificationsPath, location.origin);
                if (page > 1) notificationsUrl.searchParams.set("page", String(page));
                notificationsUrl.searchParams.set("_dpgw", String(Date.now()));

                const res = await fetchWithTimeout(
                    notificationsUrl,
                    {
                        credentials: "same-origin",
                        cache: "no-store"
                    },
                    7000
                );
                if (!res.ok) throw new Error(`Gift notifications page ${page} HTTP ${res.status}`);
                rows.push(...parseGiftNotificationsPage(await res.text(), this.data?.host || ""));
            }

            return rows;
        }

        async fetchRecentGiftHistory() {
            const senderSlug = getAuthenticatedUserSlug();
            const endpointPath = getGiftEndpointPath(senderSlug);
            if (!endpointPath) return [];

            const rows = [];

            for (const page of [1, 2]) {
                const historyUrl = new URL(endpointPath, location.origin);
                if (page > 1) historyUrl.searchParams.set("page", String(page));
                historyUrl.searchParams.set("_dpgw", String(Date.now()));

                const res = await fetchWithTimeout(
                    historyUrl,
                    {
                        credentials: "same-origin",
                        cache: "no-store"
                    },
                    7000
                );
                if (!res.ok) throw new Error(`Gift history page ${page} HTTP ${res.status}`);
                rows.push(...parseGiftHistoryPage(await res.text()));
            }

            return rows;
        }

        notificationRowsToClockEvents(rows) {
            return (Array.isArray(rows) ? rows : [])
                .map(item => {
                    const createdAtTs = Number.isFinite(Number(item?.createdAtAltTs))
                        ? Number(item.createdAtAltTs)
                        : Number(item?.createdAtTs);
                    return {
                        messageId: null,
                        gifter: String(item?.sender || "").trim(),
                        recipient: String(item?.recipient || "").trim(),
                        amount: Math.max(0, Math.floor(Number(item?.amount) || 0)),
                        rawAmount: Number(item?.amount),
                        createdAtTs,
                        timestampResolutionMs: unit3dTimestampResolutionMs(item?.rawTimestamp)
                    };
                })
                .filter(event =>
                    event.gifter &&
                    normalizeUserKey(event.recipient) === normalizeUserKey(this.data.host) &&
                    Number.isFinite(event.createdAtTs) &&
                    event.amount > 0
                );
        }

        async ensureGiftHistoryClockOffset(rows) {
            let offset = optionalFiniteNumber(this.giftHistoryClockOffsetMs);
            if (offset !== null) return offset;
            if (!Array.isArray(rows) || !rows.length) return null;

            // DarkPeers Gift History renders site wall-clock time while persistent
            // "Has Gifted You" notifications use UTC-scale event time. Notifications
            // survive the rolling System-room window, so use them for calibration.
            try {
                const notifications = await this.fetchRecentGiftNotifications();
                offset = this.inferGiftHistoryClockOffset(
                    this.notificationRowsToClockEvents(notifications),
                    rows
                );
                if (offset !== null) return offset;
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("Gift History clock calibration via notifications failed:", e);
                }
            }

            // Secondary only: System room is a rolling 100-message window.
            try {
                offset = this.inferGiftHistoryClockOffset(
                    await this.fetchRecentChatGiftEvents(),
                    rows
                );
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("Gift History clock calibration via System room failed:", e);
                }
            }

            return optionalFiniteNumber(offset);
        }

        inferGiftHistoryClockOffset(events, rows) {
            const persisted = optionalFiniteNumber(this.giftHistoryClockOffsetMs);
            if (!Array.isArray(events) || !events.length || !Array.isArray(rows) || !rows.length) {
                return persisted;
            }

            const MAX_PLAUSIBLE_OFFSET_MS = 12 * 60 * 60 * 1000;
            const samples = [];

            for (const event of events) {
                if (!Number.isFinite(Number(event?.createdAtTs)) || !Number.isFinite(Number(event?.rawAmount))) continue;

                const exactRows = rows.filter(item =>
                    normalizeUserKey(item?.sender) === normalizeUserKey(event.gifter) &&
                    normalizeUserKey(item?.recipient) === normalizeUserKey(event.recipient) &&
                    Math.abs(Number(item?.amount) - Number(event.rawAmount)) <= 0.001
                );

                // Only use a unique sender/recipient/amount pair as a clock anchor.
                // Repeated same-value gifts (e.g. multiple 69 BON gifts) are exactly
                // what the learned offset is meant to disambiguate later.
                if (exactRows.length !== 1) continue;

                const item = exactRows[0];
                const historyWallTs = Number.isFinite(Number(item.createdAtAltTs))
                    ? Number(item.createdAtAltTs) // naive yyyy-mm-dd HH:mm:ss interpreted as site wall-clock on a UTC scale
                    : Number(item.createdAtTs);
                if (!Number.isFinite(historyWallTs)) continue;

                const offset = historyWallTs - Number(event.createdAtTs);
                if (Math.abs(offset) <= MAX_PLAUSIBLE_OFFSET_MS) samples.push(offset);
            }

            if (!samples.length) return persisted;

            // Choose the densest 2-minute cluster, then its median. This rejects an
            // unrelated historical exact-value row without hardcoding any timezone.
            samples.sort((a, b) => a - b);
            const CLUSTER_MS = 120_000;
            let best = [];

            for (let i = 0; i < samples.length; i++) {
                const cluster = [];
                for (let j = i; j < samples.length; j++) {
                    if (samples[j] - samples[i] > CLUSTER_MS) break;
                    cluster.push(samples[j]);
                }
                if (cluster.length > best.length) best = cluster;
            }

            if (!best.length) return persisted;
            const mid = Math.floor(best.length / 2);
            const inferred = best.length % 2
                ? best[mid]
                : Math.round((best[mid - 1] + best[mid]) / 2);

            // If we already learned a clock offset, don't replace it with a lone,
            // materially different sample. Multiple agreeing anchors may update it
            // after a DST/site-timezone transition.
            if (
                persisted !== null &&
                best.length === 1 &&
                Math.abs(inferred - persisted) > CLUSTER_MS
            ) {
                return persisted;
            }

            this.giftHistoryClockOffsetMs = inferred;
            return inferred;
        }

        matchGiftEventsToRows(events, rows) {
            if (!Array.isArray(events) || !events.length) return [];
            if (!Array.isArray(rows) || !rows.length) {
                return events.map(event => ({ ...event, _noteSourceMatched: false }));
            }

            const usedRows = new Set();
            const MATCH_WINDOW_MS = 120_000;
            const learnedOffsetMs = this.inferGiftHistoryClockOffset(events, rows);

            const rowMatchesEventIdentity = (item, event) =>
                normalizeUserKey(item?.sender) === normalizeUserKey(event?.gifter) &&
                normalizeUserKey(item?.recipient) === normalizeUserKey(event?.recipient) &&
                Math.abs(Number(item?.amount) - Number(event?.rawAmount)) <= 0.001;

            const rowSiteClockTs = item => {
                if (Number.isFinite(Number(item?.createdAtAltTs))) return Number(item.createdAtAltTs);
                if (Number.isFinite(Number(item?.createdAtTs))) return Number(item.createdAtTs);
                return NaN;
            };

            return events.map(event => {
                if (!Number.isFinite(Number(event.createdAtTs)) || !Number.isFinite(Number(event.rawAmount))) {
                    return { ...event, _noteSourceMatched: false };
                }

                const exactCandidates = [];
                for (let i = 0; i < rows.length; i++) {
                    if (usedRows.has(i)) continue;
                    if (rowMatchesEventIdentity(rows[i], event)) exactCandidates.push(i);
                }

                if (!exactCandidates.length) return { ...event, _noteSourceMatched: false };

                // One exact identity match is unambiguous even if the site's displayed
                // clock and chat API disagree. This also provides an anchor for future
                // repeated-value gifts.
                let bestIndex = exactCandidates.length === 1 ? exactCandidates[0] : -1;

                if (bestIndex === -1) {
                    let bestDelta = Infinity;

                    for (const i of exactCandidates) {
                        const item = rows[i];
                        const siteTs = rowSiteClockTs(item);
                        if (!Number.isFinite(siteTs)) continue;

                        let delta = Infinity;

                        if (Number.isFinite(Number(learnedOffsetMs))) {
                            delta = Math.abs(
                                (siteTs - Number(event.createdAtTs)) - Number(learnedOffsetMs)
                            );
                        } else {
                            // Compatibility fallback for UNIT3D installs whose two
                            // timestamp sources already agree in local or UTC terms.
                            const timestampCandidates = [
                                Number(item.createdAtTs),
                                Number(item.createdAtAltTs)
                            ].filter(Number.isFinite);
                            if (timestampCandidates.length) {
                                delta = Math.min(
                                    ...timestampCandidates.map(ts =>
                                        Math.abs(ts - Number(event.createdAtTs))
                                    )
                                );
                            }
                        }

                        if (delta > MATCH_WINDOW_MS || delta >= bestDelta) continue;
                        bestDelta = delta;
                        bestIndex = i;
                    }
                }

                if (bestIndex === -1) return { ...event, _noteSourceMatched: false };
                usedRows.add(bestIndex);

                const message = sanitizeSponsorGiftMessage(rows[bestIndex].message);
                return {
                    ...event,
                    message,
                    _noteSourceMatched: true
                };
            });
        }

        async enrichGiftEventsWithMessages(events) {
            if (!Array.isArray(events) || !events.length) return [];

            // Canonical source: Gift History is backed directly by UNIT3D's Gift
            // records. The gift is persisted with its message before any notification
            // is queued/suppressed, so use history first.
            let historyRows = [];
            try {
                historyRows = await this.fetchRecentGiftHistory();
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("Sponsor gift-history lookup failed:", e);
                }
            }

            let enriched = this.matchGiftEventsToRows(events, historyRows);

            // Notifications are only a fallback for events that Gift History could
            // not match. UNIT3D notifications can be disabled by recipient settings,
            // blocked by sender group, or delayed by the queue.
            const unmatchedIndexes = [];
            const unmatchedEvents = [];
            enriched.forEach((event, index) => {
                if (!event._noteSourceMatched) {
                    unmatchedIndexes.push(index);
                    unmatchedEvents.push(events[index]);
                }
            });

            if (unmatchedEvents.length) {
                let notificationRows = [];
                try {
                    notificationRows = await this.fetchRecentGiftNotifications();
                } catch (e) {
                    if (DEBUG_SETTINGS.log_chat_messages) {
                        console.warn("Sponsor notification fallback failed:", e);
                    }
                }

                if (notificationRows.length) {
                    const fallbackMatches = this.matchGiftEventsToRows(unmatchedEvents, notificationRows);
                    fallbackMatches.forEach((event, i) => {
                        if (event._noteSourceMatched) enriched[unmatchedIndexes[i]] = event;
                    });
                }
            }

            return enriched.map(({ _noteSourceMatched, ...event }) => event);
        }

        /* ---- update pot + per-sponsor running totals ---- */
        applyGift(gifter, amount) {
            if (!canMutateActiveGiveaway()) return false;
            const cleanAmount = Math.max(0, Math.floor(Number(amount) || 0));
            const sponsorKey = normalizeUserKey(gifter);
            if (!sponsorKey || !(cleanAmount > 0)) return false;

            this.data.amount += cleanAmount;

            // Preserve the first-seen display casing while merging later gifts from
            // the same username case-insensitively.
            const existingName = Object.keys(this.data.sponsorContribs || {})
                .find(name => normalizeUserKey(name) === sponsorKey) || gifter;
            this.data.sponsorContribs[existingName] =
                (Number(this.data.sponsorContribs[existingName]) || 0) + cleanAmount;

            recomputeEffectiveWinners(this.data);
            flashPotTotalUI();

            const totalSponsoredNow = sumSponsorContribs(this.data.sponsorContribs, this.data.host);
            logEvent("Sponsorship recorded", `${sanitizeNick(gifter)} added ${fmtBONCurrency(cleanAmount)} BON | Total sponsored=${fmtBONCurrency(totalSponsoredNow)} BON`);

            if (!this.sponsorSet.has(sponsorKey)) {
                this.sponsorSet.add(sponsorKey);
                this.data.sponsors.push(gifter);
            }

            recordLiveSponsorGift(gifter, cleanAmount); // live sponsor stats update
            snapshotGiveaway();
            return true;
        }

        async announceWinnerScalingIfNeeded() {
            if (!canMutateActiveGiveaway()) return;
            const data = this.data;
            if (!data || data !== giveawayData || !data.scaleWinnersWithSponsors) return;
            if (isGiveawaySettling(data) || getGiveawayRemainingMs(data) <= 0) return;

            const baseWinners = Math.max(1, Math.min(MAX_WINNERS, Math.floor(Number(data.baseWinnersAtStart || data.winnersNum) || 1)));
            const newWinners = recomputeEffectiveWinners(data);
            const oldWinners = Math.max(1, Math.floor(Number(data.lastAnnouncedWinners ?? baseWinners) || baseWinners));

            if (newWinners <= oldWinners) return;

            const delta = newWinners - oldWinners;
            const cap = Math.min(
                Math.max(baseWinners, Math.min(Math.floor(Number(data.hostMaxScaledWinners) || baseWinners), MAX_WINNERS)),
                MAX_WINNERS
            );
            const totalContribForScaling = getTotalContribForScaling(data);
            const threshold = getScalingBonPerWinner(data);

            let message =
                `[b][color=${SCALING_ACCENT_COLOR}]Scaling:[/color][/b] [b]Winners increased[/b]: ${oldWinners} → ${newWinners} (+${delta}). ` +
                `Total scaling contributions: ${fmtBONCurrency(totalContribForScaling)} BON. ` +
                `Threshold: ${fmtBONCurrency(threshold)} BON/winner.`;

            const reachedCap = newWinners >= cap;
            if (reachedCap) {
                message += ` [b]Max winners reached[/b] (${cap}).`;
            }

            logEvent("Scaled winners increased", `${oldWinners} -> ${newWinners} (+${delta})${reachedCap ? ` | cap reached=${fmtBON(cap)}` : ""}`);
            if (!canMutateActiveGiveaway()) return;
            await sendMessage(message);
            if (!canMutateActiveGiveaway()) return;
            flashWinnersUI();
            data.lastAnnouncedWinners = newWinners;
        }


        /* ---- decide when to announce buffered sponsor gifts ---- */
        async maybeFlush(force = false) {
            if (!this.buffer.length) return;

            // In off mode, don't clutter chat at all (still counts + updates pot)
            if (SPONSOR_ANNOUNCE.mode === "off") {
                await this.announceWinnerScalingIfNeeded();
                if (!canMutateActiveGiveaway()) return;
                this.buffer.length = 0;
                this.sponsorWindowStartAt = 0;
                return;
            }

            const now = Date.now();

            // Start (or restart) the digest window when the first pending gift arrives
            if (!this.sponsorWindowStartAt) this.sponsorWindowStartAt = now;

            // Old behavior: announce immediately whenever new gifts arrive
            if (SPONSOR_ANNOUNCE.mode === "immediate") {
                await this.flushBuffer(now);
                return;
            }

            const deltaTotalNum = this.buffer.reduce((s, g) => s + (Number(g.amount) || 0), 0);
            const hasBigSingle = this.buffer.some(g => (Number(g.amount) || 0) >= SPONSOR_ANNOUNCE.immediate_single_min);
            const tooManyEvents = this.buffer.length >= SPONSOR_ANNOUNCE.max_pending_events;
            const hitMinTotal = deltaTotalNum >= SPONSOR_ANNOUNCE.flush_min_total;
            const hitTime = (now - this.sponsorWindowStartAt) >= SPONSOR_ANNOUNCE.digest_ms;

            if (force || hasBigSingle || tooManyEvents || hitMinTotal || hitTime) {
                await this.flushBuffer(now);
            }
        }

        /* ---- build a single chat line & clear buffer ---- */
        async flushBuffer(nowTs = Date.now(), options = {}) {
            const announce = !(options && options.announce === false);
            if (!canMutateActiveGiveaway()) return;
            if (!this.buffer.length) return;

            const grouped = this.buffer.reduce((acc, { gifter, amount, message }) => {
                const key = normalizeUserKey(gifter);
                if (!key) return acc;
                if (!acc[key]) acc[key] = { name: gifter, amt: 0, messages: [] };

                acc[key].amt += Number(amount) || 0;

                const cleanMessage = sanitizeSponsorGiftMessage(message);
                if (cleanMessage && !acc[key].messages.includes(cleanMessage)) {
                    acc[key].messages.push(cleanMessage);
                }
                return acc;
            }, {});

            const entries = Object.values(grouped)
            .map(entry => ({
                name: entry.name,
                amt: Number(entry.amt) || 0,
                messages: Array.isArray(entry.messages) ? entry.messages : []
            }))
            .filter(e => e.name && e.amt > 0)
            .sort((a, b) => b.amt - a.amt);

            const sponsorCount = entries.length;
            const deltaTotalNum = entries.reduce((s, e) => s + e.amt, 0);

            if (!sponsorCount || !deltaTotalNum) {
                this.buffer.length = 0;
                this.sponsorWindowStartAt = 0;
                return;
            }

            const deltaTotal = fmtBONCurrency(deltaTotalNum);
            const potTotal = fmtBONCurrency(cleanPotString(this.data.amount));

            // Keep the line short: show only the biggest contributors in this digest
            const topN = Math.max(0, Number(SPONSOR_ANNOUNCE.show_top_n) || 0);
            const minPerUser = Math.max(0, Number(SPONSOR_ANNOUNCE.show_min_per_user) || 0);

            const nextWinnerLine = getSponsorshipNextWinnerLine(this.data);
            const prefix =
                `${bridgeMarker(BRIDGE_MARKERS.SPONSORS, "✨")} Sponsors just added [color=#DC3D1D][b]${deltaTotal} BON[/b][/color] ` +
                `from [b]${sponsorCount} sponsor${sponsorCount === 1 ? "" : "s"}[/b]! `;
            const donationContext = buildDonationContext(this.data, { compact: true });
            const suffix =
                `Total pot is now [b][color=#ffc00a]${potTotal} BON[/color][/b].` +
                (donationContext ? ` ${donationContext}.` : "") +
                (nextWinnerLine ? ` ${nextWinnerLine}` : "");

            const maxVisible = Math.max(180, Math.floor(Number(SPONSOR_ANNOUNCE.max_visible_chars) || 300));
            const maxNotes = Math.max(0, Math.floor(Number(SPONSOR_ANNOUNCE.max_notes_per_sponsor) || 0));
            const shownParts = [];
            const overflowNotes = [];
            let shownCount = 0;

            for (const e of entries) {
                if (shownCount >= topN) {
                    if (e.messages.length) overflowNotes.push(e);
                    continue;
                }
                if (sponsorCount > 1 && e.amt < minPerUser) {
                    if (e.messages.length) overflowNotes.push(e);
                    continue;
                }

                const basePart =
                    `[color=#1DDC5D][b]${sanitizeNick(e.name)}[/b][/color] ` +
                    `([color=#DC3D1D][b]${fmtBONCurrency(e.amt)}[/b][/color])`;

                const notes = e.messages
                    .slice(0, maxNotes)
                    .map(note => truncateSponsorGiftMessage(note))
                    .filter(Boolean);

                let detailedPart = basePart;
                if (notes.length === 1) {
                    detailedPart += ` with the message [i]"${notes[0]}"[/i]`;
                } else if (notes.length > 1) {
                    detailedPart += ` with the messages ` +
                        notes.map(note => `[i]"${note}"[/i]`).join(", ");
                    if (e.messages.length > notes.length) {
                        detailedPart += ` [i](+${e.messages.length - notes.length} more)[/i]`;
                    }
                }

                const separator = shownParts.length ? ", " : "";
                const remainingAfterThis = sponsorCount - (shownCount + 1);
                const candidateTail = remainingAfterThis > 0 ? `, [i]+${remainingAfterThis} more[/i]. ` : ". ";
                const candidateDetailed =
                    prefix + shownParts.join(", ") + separator + detailedPart + candidateTail + suffix;

                if (visibleChatLength(candidateDetailed) <= maxVisible) {
                    shownParts.push(detailedPart);
                    shownCount += 1;
                    continue;
                }

                const candidateBase =
                    prefix + shownParts.join(", ") + separator + basePart + candidateTail + suffix;
                if (visibleChatLength(candidateBase) <= maxVisible) {
                    shownParts.push(basePart);
                    shownCount += 1;
                    if (notes.length) overflowNotes.push(e);
                    continue;
                }

                if (notes.length) overflowNotes.push(e);
            }

            const othersCount = Math.max(0, sponsorCount - shownCount);
            let msg = prefix;

            if (shownParts.length) {
                msg += shownParts.join(", ");
                if (othersCount > 0) msg += `, [i]+${othersCount} more[/i]`;
                msg += ". ";
            }

            msg += suffix;

            const noteContinuationMessages = [];
            if (overflowNotes.length) {
                const noteParts = [];

                for (const e of overflowNotes) {
                    const notes = e.messages
                        .slice(0, maxNotes)
                        .map(note => truncateSponsorGiftMessage(note))
                        .filter(Boolean);
                    if (!notes.length) continue;

                    const noteText = notes.length === 1
                        ? `[color=#1DDC5D][b]${sanitizeNick(e.name)}[/b][/color]: [i]"${notes[0]}"[/i]`
                        : `[color=#1DDC5D][b]${sanitizeNick(e.name)}[/b][/color]: ` +
                            notes.map(note => `[i]"${note}"[/i]`).join(", ");

                    noteParts.push(noteText);
                }

                const continuationPrefix = `${bridgeMarker(BRIDGE_MARKERS.SPONSOR_MESSAGES, "💬")} Sponsor message`;
                let currentParts = [];

                const flushNoteChunk = () => {
                    if (!currentParts.length) return;
                    noteContinuationMessages.push(
                        `${continuationPrefix}${currentParts.length === 1 ? "" : "s"}: ` +
                        currentParts.join(" | ") + "."
                    );
                    currentParts = [];
                };

                for (const part of noteParts) {
                    const candidateParts = currentParts.concat(part);
                    const candidate =
                        `${continuationPrefix}${candidateParts.length === 1 ? "" : "s"}: ` +
                        candidateParts.join(" | ") + ".";

                    if (currentParts.length && visibleChatLength(candidate) > maxVisible) {
                        flushNoteChunk();
                    }
                    currentParts.push(part);
                }
                flushNoteChunk();
            }

            if (announce) {
                if (!canMutateActiveGiveaway()) return;
                await sendMessage(msg);
                if (!canMutateActiveGiveaway()) return;

                for (const noteMessage of noteContinuationMessages) {
                    if (!canMutateActiveGiveaway()) return;
                    await sendMessage(noteMessage);
                    if (!canMutateActiveGiveaway()) return;
                }

                if (!canMutateActiveGiveaway()) return;
                flashPotTotalUI();

                if (!canMutateActiveGiveaway()) return;
                await this.announceWinnerScalingIfNeeded();
                if (!canMutateActiveGiveaway()) return;
            }

            if (!canMutateActiveGiveaway()) return;
            this.buffer.length = 0; // clear the batch/digest
            this.sponsorWindowStartAt = 0; // reset digest window
        }
    }

    // ───────────────────────────────────────────────────────────
