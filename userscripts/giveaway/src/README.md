# BONanza source layout

The Tampermonkey release remains one generated file:

`userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js`

The maintainable source is split into ordered fragments in this directory. They preserve the existing single-IIFE runtime exactly and are not intended to run independently.

Build:

```bash
node scripts/build-bonanza.mjs
```

Verify that the committed generated userscript is current:

```bash
node scripts/build-bonanza.mjs --check
```

Ordered source:

1. `00-preamble.js`
2. `01-global-constants.js`
3. `02-runtime-state.js`
4. `03-metadata-parsing.js`
5. `04-ui-template.js`
6. `05-initialization.js`
7. `06-lifecycle.js`
8. `07-chat-observation.js`
9. `08-entry-management.js`
10. `09-sponsorship-polling.js`
11. `10-command-handling.js`
12. `11-winner-selection-payouts.js`
13. `12-utilities.js`
14. `13-menu-validation.js`
15. `14-internal-namespaces.js`

The validation workflow rejects stale generated output. The publishing workflow rebuilds, verifies and publishes the generated script.

## Maintenance rule (source of truth)

**Edit `userscripts/giveaway/src/*.js`, never the generated `.user.js` directly.**
The bundle is a byte-for-byte concatenation of the 15 fragments in the
order declared in `scripts/build-bonanza.mjs`. If you need to change the
runtime or metadata (`@version`, `@updateURL`, etc.), edit the appropriate
fragment (typically `00-preamble.js`), then rebuild. When the fragment list
changes, update the build script as well.

From the **repository root**, before committing:

```bash
node scripts/build-bonanza.mjs
node scripts/build-bonanza.mjs --check
node --check userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js
node --test tests/bonanza-*.test.mjs
git diff --check
```

**Commit the edited source, relevant tests/docs and the regenerated
`userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js` together.**
The bundle is tracked in Git; it is *not* automatically updated in the
repository on a pull request. The validation workflow runs `--check` and
fails if the committed bundle is stale.

On pushes to `main`, `.github/workflows/publish-bonanza-gist.yml`
**rebuilds and requires a clean bundle diff** before publishing the
generated userscript and an independently generated `.meta.js` manifest
to the configured Gist. A stale committed bundle fails publication; the
workflow does not commit generated files back to GitHub. Do not manually
maintain the Gist or its `.meta.js`.

For Tampermonkey auto-updates, bump `@version` in `00-preamble.js` when
releasing changes, and update any tests asserting the exact version.
Preserve the existing `@namespace`, `@updateURL` and `@downloadURL`
unless deliberately migrating the script's update identity.

Because the giveaway can move real BON, cover relevant start, restore,
timeout, settlement and idempotency boundaries with regression tests,
and prefer rehearsal mode for browser-level checks. Do not trigger a live
giveaway or actual BON transfers simply to validate a code change.

See [the repository's agent instructions](../../../AGENTS.md).
