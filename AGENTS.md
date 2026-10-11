# Repository instructions for coding agents

These instructions apply to the whole repository. Read them before editing code.
Keep changes focused on the affected component; this repository contains
multiple userscripts, not just BONanza.

## DarkPeers BONanza Giveaway (important)

- **Single source of truth:** `userscripts/giveaway/src/*.js` (15 ordered
  fragments). Never edit
  `userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js` directly.
  That file is **generated and committed** to Git for Tampermonkey.
- To modify the script, edit the relevant fragment. The file
  `scripts/build-bonanza.mjs` defines the **exact concatenation order**.
  Fragments are not independent JavaScript modules and must keep the
  existing single-IIFE runtime intact.
- Update metadata, version notes and `@version` in
  `userscripts/giveaway/src/00-preamble.js`, not in the generated file.
  When bumping the version, adjust tests that assert the precise version.
  Do not change `@namespace` or the update/download URLs unintentionally.
- From the repository root, **after every source change**, run:
  
  ```bash
  node scripts/build-bonanza.mjs
  node scripts/build-bonanza.mjs --check
  node --check userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js
  node --test tests/bonanza-*.test.mjs
  git diff --check
  ```

- Commit both the changed fragments and the regenerated
  `DarkPeers_BONanza_Giveaway.user.js` (plus any tests/docs) in the same PR.
  A source-only commit will fail CI because the generated file is stale.
  Do not patch the generated file by hand, even to repair a review finding:
  fix the source, then rebuild.
- The **Validate BONanza** GitHub Action verifies the tracked bundle, checks
  syntax and runs tests on PRs and relevant pushes to `main`. It does not
  commit the generated file for you.
- On relevant pushes to `main`, **Publish BONanza to Gist** rebuilds,
  fails if the committed bundle differs, and then publishes the userscript
  plus a generated `.meta.js` update manifest. No deployment occurs merely
  from opening a PR. Do not manually publish or maintain the Gist.
- The script can transfer real BON. Preserve safety gates around ownership,
  recovery, gift history, settlement and transfers. Add regression tests for
  affected behavior, and use rehearsal mode for validation that would
  otherwise post public chat messages or move real currency/points. Never
  initiate a live payout for a routine code test.

## Opening / sponsor accounting invariants

- Before posting a LIVE opening, require a trustworthy positive Main Chat
  message cursor. If it is unavailable, abort BEFORE posting (otherwise an
  identical old announcement might falsely verify the new opening).
- Before posting the public giveaway opening, persist and read back a
  **pending opening checkpoint** with the exact prepared announcement,
  pre-send timestamp, Main Chat cursor and a bounded publication window.
  When the send resolves, persist its completion timestamp to further
  narrow that window. Reconciliation must prove the **entire** server-side
  timestamp-resolution bucket lies inside the original opening attempt:
  same-second overlap or later identical announcements are NOT sufficient.
  ANY opening API failure, including non-OK HTTP responses, must never
  trigger the chatbox fallback: the server may already have published
  the opening, so reconcile the original checkpoint instead.
  A timeout/ownership loss is ambiguous: do not erase the checkpoint,
  re-post blindly, or settle BON.
  Restore must verify the exact own-user announcement in authoritative
  Main Chat history before enabling entries or any sponsor/payout action.
- The 45-minute absolute deadline is anchored to the conservative
  **pre-send** time, so server response latency cannot extend the event.
  **Sponsor eligibility must NOT use that time.** It begins strictly after
  the independently verified publication timestamp bucket. Each Gift
  History timestamp bucket must START at/after `sponsorStartTs`, not
  merely overlap it; uncalibrated history must be deferred altogether.
  Omit ambiguous boundary gifts rather than risking inflation of a real
  BON payout. Persist `sponsorStartTs` and
  use it for both live Gift History polling and reload reconciliation.
- After acquiring the exclusive Web Lock, read saved recovery storage AGAIN
  before mutating state or posting. Another tab may have saved an uncertain
  opening while waiting for the lock; do not overwrite any such state.
  **Restores must also re-read and revalidate the COMPLETE latest snapshot
  under that lock**, discarding the pre-lock in-memory object: another tab
  could have persisted payout/settlement progress while ownership was queued.
  Pre-lock `__expiredBeyondGrace`, `__legacyOpeningUnverified`, proof and
  host data are stale hints, NEVER grounds for rejecting before the lock.
  Classify only the latest post-lock snapshot.
  Never replace a newer committed settlement with stale recovery data.
  The recovery reader reports `readOk` separately from `raw`: a denied
  localStorage read, corrupt legacy JSON or migration failure MUST block the
  start, never appear as empty storage. An empty STRING in an existing
  recovery slot is still an occupied (corrupt) record. Keep pre-lock reads
  read-only, performing any legacy migration under exclusive ownership.
  A legacy key containing an empty string is PRESENT, not absent: test
  `getItem() === null` to prove absence. Even valid JSON without an
  identifiable host (such as `{}` or `{"giveawayData":{}}`) remains an
  occupied, unidentified record. Fail closed and preserve it for manual
  review: ONLY a positively identified foreign host may be ignored.
  ALWAYS inspect the old legacy slot even when namespaced recovery exists.
  Corrupt, unidentified or different SAME-HOST snapshots must block automatic
  recovery/settlement; identical same-host records are safe to read, as is
  a positively identified different host. On post-lock recovery, first
  verify byte-identical same-host snapshots, then retire their duplicate
  legacy slot with before/after read-back checks BEFORE writing a new
  confirmed opening checkpoint. If cleanup fails, abort without payout;
  pre-lock discovery must remain read-only. Never delete a legacy record
  until its namespaced copy has been verified durably.
  `loadGiveawaySnapshot()` must never
  delete, migrate, or alter recovery storage before acquiring the Web Lock;
  stale/expired data needs manual review, not speculative cleanup.
- **Preflight is not an opening.** Before a durable `openingCheckpoint`
  exists, the in-memory configuration MUST NOT be snapshotted by pagehide,
  beforeunload or other background persistence. A BFCache handoff during
  balance/history/cursor awaits must not generate a false legacy giveaway
  or allow the abandoned tab to post.
- Malformed, unreadable or incomplete recovery data may contain settlement
  evidence. Preserve its raw storage for manual investigation; a parse error
  is not permission to delete it or start a replacement.
- Reverify every locally **confirmed** LIVE opening during restore against
  the exact original Main Chat message ID, authenticated author, full
  announcement text, bounded send window and sponsor boundary. If that
  authoritative evidence is unavailable, preserve the snapshot without
  enabling entries or BON transfers.
- With no calibrated Gift History offset, neither UTC nor browser-local
  timestamps are trustworthy: defer ALL gifts as retryable and block
  final canonical settlement until calibration succeeds.
- Leave unresolved opening checkpoints intact for later recovery; never
  overwrite them with a new giveaway or auto-settle a recovered ancient
  opening beyond the one-hour expiry grace. **Pre-checkpoint legacy snapshots
  without proven publication and a conservative pre-send opening time are
  quarantined unchanged for MANUAL review**, including already-expired or
  committed settlement state. Never cap their deadlines using a post-send
  `startTime` or automatically resume entries and BON settlement. Never
  overwrite such a preserved snapshot with a new start.
- A Gift History clock offset calibrated against precise notification/chat
  events and second-precision history rows has **fractional calibration
  uncertainty**. Persist an upper error bound with the inferred offset and
  subtract it from the calibrated bucket start BEFORE checking
  `sponsorStartTs`. This also applies to the boundary-evidence path and
  across reloads. Keep all BON-moving operations blocked while publication
  or sponsor timing remains unverified.
- In **Silent Mode**, ordinary command replies (staff responses, errors,
  `!winners`, `!addbon` etc.) use private messages. **`!reminder` is NOT
  an ordinary reply:** it explicitly requests an announcement for everyone.
  Both manual `!reminder` and scheduled automatic reminders MUST broadcast
  to Main Chat even in Silent Mode. Rehearsal Mode still redirects both
  reminder types privately to the host and never transfers real BON.

Full source layout and examples:
[`userscripts/giveaway/src/README.md`](userscripts/giveaway/src/README.md).

If repository conventions or workflows change, update **both** this file
and the component's README in the same PR so future agents get accurate
instructions.
