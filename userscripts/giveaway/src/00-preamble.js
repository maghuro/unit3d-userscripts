// ==UserScript==
// @name         DarkPeers BONanza Giveaway | Maghuro Fork
// @namespace    https://darkpeers.org/users/maghuro
// @description  BON giveaways on DarkPeers with an optional direct contribution to the BON Pool
// @version      1.5.14
// @author       🤖 T.R.A.V.I.S., Maghuro & M.A.E.S.T.R.O.
// @homepageURL  https://darkpeers.org/users/maghuro
// @updateURL    https://gist.githubusercontent.com/maghuro/da2dbfec94951990cbc54e75a9aee318/raw/DarkPeers_BONanza_Giveaway.meta.js
// @downloadURL  https://gist.githubusercontent.com/maghuro/da2dbfec94951990cbc54e75a9aee318/raw/DarkPeers_BONanza_Giveaway.user.js
// @icon         https://darkpeers.org/img/logo.png
// @grant        GM_getValue
// @grant        GM_setValue
// @license      GPL-3.0-or-later
// @match        https://darkpeers.org/
// @run-at document-idle
// ==/UserScript==

// NOTE: v1.5.10 intentionally changes @namespace. This release is treated as a
// fresh userscript identity rather than an in-place identity migration.

// DarkPeers-only fork of "Blutopia BON Giveaway" v6.2.2 by Nums (GPL-3.0-or-later).
// Changes in this fork:
//   - All non-DarkPeers tracker support, the upload.cx extra commands and the
//     openuserjs update check have been removed.
//   - A host-selected percentage (0-50%, steps of 5) of the final pot is
//     contributed directly to the DarkPeers BON Pool (/bon-pool).
//   - Winning number is drawn with crypto.getRandomValues (Math.random fallback).
//   - Storage keys and panel IDs are namespaced; if the original script is also
//     installed on the page, this one stands down; its toolbar button stays but
//     fades on hover, and blinks red on click while highlighting the original.
//   - A plain-text statement of every transaction is produced at the end of each
//     giveaway (Save .txt / Copy in the panel); the last two are kept locally.
//   - Player stats share the original script's localStorage record, so a host's
//     history carries across; a pre-1.2.0 fork record is merged in once.
//   - v1.2.1 hardens reload/multi-tab safety, persists sponsor/stat cursors,
//     draws the winning number only at payout time, makes !random range-safe,
//     and strengthens payout verification against stale gift messages.
//   - v1.2.2 added an interim TLCC bridge signature and cosmetic Rigged taxes.
//   - v1.2.3 contributes the selected share directly to DarkPeers /bon-pool,
//     verifies it before announcing success, and introduces authoritative URL
//     markers so TLCC can prefer this fork over legacy heuristic classifiers.
//   - v1.2.4 removes the obsolete fund-manager debug hook after the direct-pool migration.
//   - v1.2.5 matches the verified DarkPeers BON Pool browser form encoding.
//   - v1.2.6 audit-hardens live settlement: final sponsor sync, frozen entries,
//     authenticated gift endpoint resolution, ordered critical announcements,
//     bounded chat API sends, robust gift parsing, and exact BON Pool request semantics.
//   - v1.2.7 makes the persisted sponsor cursor authoritative client-side even
//     when UNIT3D ignores after_id, and retries the final sponsor sync three times.
//   - v1.2.8 guarantees every announced winner can receive at least 1 BON by
//     validating manual winner counts and capping sponsor-driven scaling to the pot.
//   - v1.2.9 makes giveaway closure a strict temporal boundary: the final sponsor
//     sync counts only gifts created before closure and never emits a racing digest.
//     It also normalizes fractional sponsor gifts to whole BON and narrows the
//     pre-draw crash window by keeping the active snapshot until sponsor sync ends.
//   - v1.2.10 recovers recently-expired snapshots instead of silently abandoning
//     them, and uses the scheduled endTs as the cutoff when a timer fires late.
//   - v1.2.11 makes the selected BON Pool percentage exact at pot level:
//     floor(total pot * pct / 100), while preserving at least 1 BON per winner.
//   - v1.2.12 gives the userscript an unambiguous Tampermonkey display name:
//     "DarkPeers BONanza Giveaway | Maghuro Fork".
//   - v1.2.13 makes bridge markers machine-only: the semantic emoji stays plain,
//     marker anchors self-label with their URL for clean IRC conversion, and giveaway
//     starts distinguish standard, BON Pool and Rigged Taxes structurally.
//   - v1.2.14 introduced a dedicated gift marker.
//   - v1.2.15 moves that marker to the actual standalone "/gift" help response;
//     giveaway announcement/reminder continuations remain part of GIVEAWAY.
//   - v1.2.16 enriches sponsor digests with matched gift-history messages, keeps
//     multi-gift/multi-sponsor notes attached to the correct donor, aligns digest
//     accounting to whole BON, improves punctuation, and marks host pot top-ups.
//   - v1.2.17 bounds sponsor digest detail so gift notes and multi-sponsor bursts
//     stay in one logical chat/IRC message instead of provoking bridge [1/2] splits.
//   - v1.3.0 promotes the live-tested fork: sponsor gift notes, multi-gift digest
//     correlation, authoritative TLCC markers and direct BON Pool settlement are
//     now the stable 1.3 baseline. Monetary BON values use the official ฿ symbol.
//   - v1.3.2 prefixes the self-duplicate-entry rejection with 🚫 so bridge clients
//     and TLCC can classify it unambiguously like the other rejected entry states.
//   - v1.3.3 fixes UNIT3D gift-history timestamp matching so sponsor notes survive
//     timezone differences, and makes machine bridge anchors empty/invisible on the
//     DarkPeers website for every viewer, not only hosts running the userscript.
//   - v1.3.4 persists matched sponsor gift notes in the active giveaway snapshot and
//     final statement, including multiple gifts/messages per sponsor and final-poll gifts.
//   - v1.3.5 added UNIT3D notification parsing for sponsor notes.
//   - v1.3.6 makes the persistent Gift History the canonical sponsor-note source and
//     uses notifications only per-event as fallback. UNIT3D can suppress/queue BON
//     notifications, while every successful gift is stored with its message first.
//   - v1.3.7 fixes real DarkPeers Gift History parsing: BON cells include a "Points"
//     suffix, "No note" is treated as no message, and naive history timestamps are
//     matched safely using both browser-local and UTC interpretations.
//   - v1.3.8 learns the real DarkPeers Gift-History ↔ chat-API clock offset from
//     unambiguous gifts instead of assuming browser-local/UTC equivalence. This
//     survives site-timezone/DST differences and disambiguates repeated same-value gifts.
//   - v1.3.9 makes authenticated UNIT3D Gift History the primary sponsor source for
//     sender, recipient, BON, note and event discovery. Chat API/SystemBot is now
//     fallback-only (history outage/recovery and exact final-cutoff disambiguation).
//   - v1.3.10 forces fresh Gift History/notification reads and guarantees matched
//     sponsor notes are never silently dropped by digest-length trimming: notes stay
//     inline when they fit and overflow into marked sponsor-note continuations.
//   - v1.3.11 announces every newly discovered sponsor batch on the next poll instead
//     of waiting up to 60 seconds. Multiple gifts discovered in the same poll remain
//     grouped, with each matched note attached to the correct sponsor.
//   - v1.3.12 restores self-labelled machine bridge anchors so the HTML→IRC bridge
//     no longer leaves orphaned "()" after giveaway emojis; TLCC still hides the URL.
//   - v1.3.13 gives BON Pool contribution giveaways a dedicated blue visual identity
//     (💙) while leaving regular giveaways, BONanza donations and Rigged Taxes distinct.
//   - v1.3.14 replaces public URL bridge markers with invisible styled sentinels. Every
//     marker kind now survives DarkPeers -> IRC -> The Lounge without exposing a URL
//     on the website or leaving bridge-generated "()" around a hidden link.
//   - v1.3.15 adds a final sponsor-note recap from canonical Gift History, introduces
//     a dedicated sponsor-messages bridge marker, and carries BON Pool / Rigged Taxes
//     context through every authoritative marker so TLCC can keep one event identity.
//   - v1.3.16 polishes the closing sequence: sponsors get a dedicated list line,
//     Gift History notes are grouped by sponsor under "Messages from our sponsors",
//     BON Pool prize accounting is explicit (gross vs pool), and pool settlement uses
//     the blue BON Pool identity consistently.
//   - v1.3.17 follows a full-source audit: final sponsor thanks/notes now also run
//     when a giveaway ends with zero entrants, the zero-entry audit log preserves the
//     real host/sponsor split, and repeated identical Gift History notes from distinct
//     gifts are no longer collapsed a second time during presentation.
//   - v1.3.18 completes the audit hardening: sponsor digest sends are serialized so
//     summaries, note continuations and scaling notices cannot race each other; live
//     note-only continuations use the dedicated MESSAGES marker; and large final
//     sponsor lists are proactively chunked before the website/IRC bridge can split them.
//   - v1.3.19 removes proactive chunking from the final sponsor list and makes the
//     zero-entry outcome explicit: there are no winners and 100% of the final pot
//     (host funding + sponsors) is contributed directly to the BON Pool and verified.
//   - v1.3.20 makes zero-entry settlement respect the selected BON Pool mode: with
//     Pool > 0 the full pot still goes to the Pool; with Pool = 0 the host keeps only
//     their own funding and every sponsor contribution is returned in full, with
//     idempotent refund gifts, chat verification and statement/audit tracking.
//   - v1.3.21 shortens refund gift notes to "Giveaway refund" and verifies outgoing
//     sponsor refunds primarily against authenticated Gift History; the chat API is
//     retained only as a fallback when Gift History itself is unavailable.
//   - v1.3.22 hardens the chat fallback: only genuine SystemBot gift events whose
//     parsed sender is one of the host/self identities may satisfy an expected payout
//     or refund. User-written lookalike messages can never confirm a transaction.
//   - v1.3.23 full-audit hardening: serialize sponsor polls to prevent overlapping
//     Gift History/chat-fallback passes from double-counting gifts, restore the intended
//     six-reminder cap, normalize host checks, await host pot announcements, and make
//     refund verification/status labels accurately distinguish Gift History from chat.
//   - v1.3.24 closes the one-shot audit findings: restores are host-bound and active
//     snapshots are namespaced per authenticated account; atomic cross-tab ownership
//     requires the browser Web Locks API; settlement remains resumable through transfer
//     verification; sponsor opening/closing boundaries constrain Gift History and both
//     in-flight Gift History/chat-fallback polls; host top-ups are serialized; delayed
//     verification is statement-bound with persisted pre-transfer verification boundaries;
//     BFCache documents quarantine all giveaway mutations/snapshots from pagehide and
//     persisted pageshow always reloads authoritative saved state instead of resuming stale
//     memory, pagehide quarantines even pre-data queued ownership work, quarantined
//     documents cannot acquire/reacquire ownership even from queued Web Lock callbacks,
//     and settlement resumes
//     must also reacquire exclusive ownership before transfers;
//     cross-tab gift attempts stay pending until their originating request resolves; a
//     new exclusive owner converts foreign orphaned pendings to ambiguous terminal work,
//     while superseded fallbacks abort before sending; rejected attempts remain retryable;
//     unknown Gift History clock offsets accept either timestamp interpretation when it
//     overlaps the window, while coarse closing-second rows require one-to-one precise
//     chat proof reserved across polling passes and the chat-only fallback applies the
//     same timestamp intervals; ambiguous cutoff rows remain unseen/retryable until
//     evidence resolves, and authoritative settlement output rechecks ownership before
//     and after every awaited closing send while its internal chatbox fallback also
//     fails closed after an ownership/quarantine handoff; closing outputs persist
//     pending/sent checkpoints, preserve null replay cursors, wait out the unresolved
//     POST window and require at least one authoritative cursor/time-bounded chat read
//     before replay; payout/refund verifiers
//     abort stale writes after ownership handoff; committed settlements freeze their
//     complete financial/payout/refund plan and never rediscover sponsors on resume;
//     optional sponsor cutoffs/clock offsets
//     preserve null instead of coercing it to epoch zero; and Gift
//     History opening bounds honor the source timestamp precision (including fractions).
//   - v1.3.25 promotes the completed v1.3.24 full-audit hardening to the stable
//     post-audit release. No new settlement logic is introduced in this bump.
//   - v1.3.26 fixes sponsor-scaling status semantics, keeps auto thresholds auto
//     unless explicitly edited, centralizes next-winner progress math, raises the
//     final sponsor-note recap limit to 900 visible characters, improves the bridge
//     marker used by sponsor-message recaps, and uses "spot on!" for exact guesses.
//     Follow-up: scaling status now distinguishes auto vs custom thresholds correctly,
//     uses one canonical next-winner progress calculation, and reports explicit
//     "progress" / "still needed" values at zero and exact-threshold boundaries.
//     Live-result polish: final sponsor-message recaps use a 900-visible-character
//     website-first limit, exact guesses say "spot on!", and the MESSAGES sentinel
//     uses canonical IRC 05 + bold instead of extended colour 16 for bridge reliability.
//   - v1.5.0 deliberately returns to the proven DarkPeers-only v1.3.26 engine.
//     The multi-tracker adapter layer is removed. Current UNIT3D navbar
//     compatibility is retained, and BON Pool choices extend to 50% in 5% steps.
//     Live DarkPeers endpoint audits additionally harden sponsor clock calibration
//     from persistent notifications, absolute-deadline/settlement command gating,
//     Main Chat settlement-output reconciliation and fail-closed chatbox fallback.
//     DarkPeers remains the sole production target; another tracker must use a
//     separate userscript rather than changing this engine.
//   - v1.5.1 keeps BON Pool context visible during an active giveaway: reminders,
//     !bon, sponsor digests and host top-ups now repeat the selected pool percentage
//     near the live pot/status information instead of relying only on the opening header.
//     Sponsor accounting is also Gift-History-only: transient Gift History outages no
//     longer let stale System/DPBot messages increment the pot a second time; recovery
//     reconciles unseen persistent Gift History rows instead of replacing the baseline.
//   - v1.5.2 polishes winner gift notes. A single winner receives
//     "🥇 YOU WON!! Congratulations!". Multi-winner giveaways use podium medals for
//     1st, 2nd and 3rd place, then 🎉 for every later ordinal place.
//   - v1.5.3 follows the 2026-09-24 live post-audit: restored pages ignore pre-reload
//     chat hydration so old entries/commands cannot be replayed, and statement host
//     top-ups are derived from cumulative host funding minus the opening host contribution.
//   - v1.5.4 moves public distribution to a secret GitHub Gist. The repository remains
//     the development source of truth, while Tampermonkey updates use the stable Gist RAW URL.
//   - v1.5.5 applies the post-live safety review: reload replay boundaries come from
//     Main Chat server timestamps, host lockouts cannot block emergency recovery,
//     winner-count controls are host-only, dead sponsor chat fallback is removed,
//     public winner names use the same anti-ping sanitization as other chat output,
//     settlement message checkpoints use the Main Chat cursor while gift diagnostics
//     use the System cursor, restore can remain entry-live while sponsor accounting is
//     unavailable, and rehearsal mode suppresses every script chat message and
//     BON-moving operation while isolating snapshots, ledgers, stats, statements and
//     naughty-list state from live giveaways.
//   - v1.5.6 makes emergency staff intervention explicit: non-host staff actions for
//     rig/unrig, time adjustments, naughty-list operations and !end <host> are
//     identified publicly by staff username. Staff also shares the host's emergency
//     spam-lockout exemption, while !winners and !maxwinners remain host-only.
//   - v1.5.7 closes the remaining review races: restored sponsor accounting starts
//     fail-closed, Main Chat is observed while its server replay boundary is fetched,
//     historical commands use a strict cutoff, staff attribution stays public even in
//     Silent Mode, and Rehearsal / Debug mode is toggleable from the settings UI.
//   - v1.5.8 makes the Rehearsal / Debug UI toggle honest under forced overrides:
//     URL-forced rehearsal can be switched off from the UI, while a source-level
//     DEBUG_SETTINGS.dry_run override is shown as forced instead of pretending to disable.
//   - v1.5.9 routes rehearsal chat output privately to the host instead of suppressing
//     it, while keeping winner/refund gifts and BON Pool contributions fully simulated.
//   - v1.5.10 separates update metadata from the install payload: @updateURL now uses
//     a minimal .meta.js published beside the full .user.js, while @downloadURL keeps
//     fetching the full userscript. @homepageURL and @namespace now point to Maghuro's
//     DarkPeers profile; v1.5.10 is intentionally treated as a fresh userscript identity.
//     Rehearsal statements and settlement messages now label simulated transfers
//     explicitly, preserve that status through finalization, and infer/sanitize
//     rehearsal-only v1.5.9 statements so dry-run success cannot be mistaken for
//     proof of a real BON movement.
//   - v1.5.12 adds best-effort post-settlement cleanup for unread BON gift
//     notifications received during the giveaway window. It reuses UNIT3D's own
//     per-notification CSRF-protected PATCH forms, never mass-marks unrelated
//     notifications, and runs fire-and-forget so cleanup failure cannot block or
//     roll back giveaway settlement.
//   - v1.5.13 fixes chat number formatting so comma-separated giveaway values are
//     never collapsed into a fake thousands-grouped number. Usernames containing
//     digits (for example Sch2021) no longer trigger unrelated formatting, while
//     genuine 1,000 / 1 000 / 1'000-style amounts remain normalized with spaces.
//   - v1.5.14 keeps a definitively rejected /gift chat fallback retryable. The
//     fallback now preserves exclusive ownership, uses the chatbox-only slash-command
//     path so an ambiguous chat-API timeout can never be mistaken for a definite
//     no-send, and restores only the exact unsent terminal marker after durable read-back.
//// DarkPeers BONanza fork created and maintained by T.R.A.V.I.S. for the DarkPeers staff.
// Further development and maintenance by Maghuro & M.A.E.S.T.R.O.

// Original credits (Blutopia BON Giveaway)
// @Nums - original author
// Additional credits
// @TheEther - Integration with Aither + some additional features
// @Nums - added new commands, command spam detection, admin controls, multi-winners, refactored BON API polling + trying to keep the public version updated
// @ahoimate - got BON gifting API polling working + added new commands
// @ruckus612 - fixed BON gift bug
// @ZukoXZuko - added formatting to the giveaway menu

(function() {
    'use strict';

    // ───────────────────────────────────────────────────────────
