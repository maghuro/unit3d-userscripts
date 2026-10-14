# BONanza operations runbook

This is the operational reference for hosting, rehearsing and recovering a DarkPeers BONanza giveaway.

## If the pot or sponsor accounting looks wrong

1. Extend the giveaway time if entries are still open, without exceeding 45 minutes in total from public opening.
2. Do not settle while the accounting warning is visible.
3. Do not manually resend winner gifts or BON Pool contributions unless the persisted settlement state explicitly says they were never attempted.
4. Reload Main Chat. The userscript restores the giveaway and reconciles sponsor accounting against persistent DarkPeers Gift History.
5. Check the host panel. If the red accounting banner remains visible, entries and time controls continue to work, but pot mutations and settlement remain blocked.
6. Wait for Gift History reconciliation to recover. The script retries automatically.
7. When the banner clears, verify the displayed pot against Gift History before ending the giveaway.
8. Use Retry settlement only after the accounting state is verified.

The settlement engine is intentionally conservative. Ambiguous transfer state means verify first, never blindly resend.

## Emergency staff controls

The host owns the giveaway and all payout-shape decisions.

DarkPeers staff may use operational recovery controls:

- end, with the host explicitly named, for example `!end maghuro`
- rig / unrig
- time add / remove
- addtime / removetime

The 45-minute maximum applies to the initial form duration, saved presets and every host/staff extension. An extension cannot push the deadline beyond 45 minutes after the original public opening, even after a reload.
- naughty

Every non-host staff action is identified publicly in the command output with the staff username.

The following payout-shape controls are host-only:

- winners, which changes the base number of winners and therefore the prize split
- maxwinners, which changes the scaling cap and therefore the maximum payout shape

The host and recognized staff are exempt from the escalating command spam lockout, but the ultra-fast duplicate-send guard still applies.

## Rehearsal mode

Rehearsal mode runs the userscript logic without moving BON. Output that would normally be sent by the userscript is redirected privately to the host via `/msg` instead of being posted in public chat.

Enable it from the host panel:

1. Open Settings.
2. Under **Safety & Testing**, enable **Rehearsal / Debug mode**.
3. The page reloads automatically.
4. Confirm that the red REHEARSAL MODE banner appears in the host panel.

The toggle is deliberately blocked while a giveaway is active or recoverable.

For diagnostic fallback only, the same mode can still be enabled from the browser console:

```js
localStorage.setItem("BONANZA_GIVEAWAY_REHEARSAL", "true");
location.reload();
```

While rehearsal mode is active:

- script-generated output is redirected privately to the host via `/msg`, prefixed as rehearsal output;
- output that would normally be a private reply to another user is still shown only to the host, with the intended recipient identified;
- winner gifts are simulated only;
- sponsor refunds are simulated only;
- BON Pool contributions are simulated only;
- Gift History and other read-only checks may still run;
- settlement calculations and restore paths still execute;
- active snapshots, transfer ledgers, statements, stats and naughty-list state use a rehearsal-only namespace;
- the cross-tab ownership lock remains shared with live mode, so a rehearsal cannot run alongside a real giveaway in another tab.

Suggested pre-release rehearsal:

1. Start with a very small test pot, such as 10 BON.
2. Add at least two entries.
3. Reload.
4. Use addbon.
5. Reload again.
6. Exercise time controls.
7. End the giveaway.
8. Inspect the host log and statement.
9. Confirm that no script output appeared in public chat, the host received the rehearsal output by private message, and no BON moved.

Disable rehearsal mode from **Settings > Safety & Testing** by turning off **Rehearsal / Debug mode**. The page reloads automatically.

Console fallback:

```js
localStorage.removeItem("BONANZA_GIVEAWAY_REHEARSAL");
location.reload();
```

Never run a real giveaway while the REHEARSAL MODE banner is visible.

## Unverified opening in LIVE mode

If Main Chat shows an announcement but it cannot be proved by the userscript, the
checkpoint stays pending and **no giveaway settlement, sponsor processing, or
BON transfer runs**. The recovery alert is now a non-modal notice.

Use **Cancel & archive pending giveaway** only after checking the Main Chat and
canonical Gift History. It requires a manual confirmation and an exclusive tab
lock. The script re-reads the latest exact pending checkpoint, rejects any
settlement evidence, writes a verified original-state archive, and only then
removes the active key. It does **not** delete public chat messages or refund
gifts received from sponsors. Those remain a manual follow-up with donors.
If the archive cannot be persisted, the active snapshot remains untouched.

New LIVE announcements carry a cryptographic invisible 128-bit per-opening
proof to disambiguate whole-second API timestamps, and older snapshots cannot
be silently upgraded to that proof. Rehearsal mode cannot establish that an
invisible proof survives the real Main Chat rendering pipeline; validate this
against the site before merging a new release.
