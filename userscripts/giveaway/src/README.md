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

The validation workflow rejects stale generated output. The publishing workflow rebuilds and verifies the userscript before sending the single generated file to the secret Gist.

When changing BONanza code, edit the relevant source fragment, rebuild, and commit both the source change and the generated userscript.
