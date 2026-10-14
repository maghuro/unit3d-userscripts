    // SECTION 5: Initialization and Bootstrapping
    // ───────────────────────────────────────────────────────────
    // Cache references for UI elements (populated in injectMenu)
    let bonanzaGiveawayFrame, coinHeader, countdownHeader,
        coinInput, startInput, endInput, timerInput, winnersInput, customMessageInput,
        scaleWinnersToggleInput, maxScaledWinnersInput, maxScaledWinnersGroup, maxScaledWinnersError,
        scaleBonPerWinnerInput, scaleBonPerWinnerGroup,
        donationPercentInput, donationHint,
        entriesWrapper, giveawayForm,
        giveawayLogPanel, giveawayLogContent,
        resetButton, closeButton, minimizeButton, startButton, settingsBtn, commandsBtn, settingsMenu, commandsMenu,
        remNumInput, reminderEvery, rigBadge, rigToggleInput,
        hostPanelToggleBtn, hostCommandPanel, hostCommandPanelBody, hostPanelCloseBtn, hostPanelHandle,
        hostPanelInitialized = false;
    const hostPanelCommandState = new Map();
    let maxScaledWinnersRawValue = "";
    let maxScaledWinnersDebounceTimer = null;
    let bonPerWinnerManuallyEdited = false;
    let pendingEffectiveWinnersDisplay = null;
    let lastKnownGiveawayHostKey = "";
    let hostPanelResizeBound = false;
    // Inject the giveaway menu into the chat UI
    injectMenu();

    if (REHEARSAL_MODE) {
        setHostSafetyBanner(
            "rehearsal",
            "REHEARSAL MODE: userscript output is sent privately to the host; winner/refund gifts and BON Pool contributions are simulated only.",
            "danger"
        );
        console.warn("[BON Giveaway] REHEARSAL MODE active: script output is redirected to a private host message; no BON-moving request will be sent.");
    }

    // ── Mutual exclusion with the original "Blutopia BON Giveaway" script ──
    // Both scripts drive the same chat and would both try to restore and pay out
    // the same giveaway after a reload. If the original is present, this script
    // stands down and says so in the chat header.

    function originalGiveawayScriptPresent() {
        return !!document.querySelector(ORIGINAL_SCRIPT_SELECTOR);
    }

    function findOriginalGiveawayButton() {
        const header = document.querySelector("#chatbox_header");
        if (!header) return null;
        const links = header.querySelectorAll("a.form__button--text");
        for (const a of links) {
            if (a.id === "bonanzaGiveawayBtn") continue;
            const hasCoins = !!a.querySelector("i.fa-coins, i.fas.fa-coins");
            const label = (a.textContent || "").trim().toLowerCase();
            if (hasCoins && label === "giveaway") return a;
        }
        return null;
    }

    let conflictToastTimer = null;
    function showConflictToast() {
        let toast = document.getElementById("bonanzaGiveawayConflictToast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "bonanzaGiveawayConflictToast";
            toast.setAttribute("role", "alert");
            document.body.appendChild(toast);
        }
        toast.textContent = "DEACTIVATE THE ORIGINAL GIVEAWAY SCRIPT";
        requestAnimationFrame(() => toast.classList.add("show"));
        if (conflictToastTimer) clearTimeout(conflictToastTimer);
        conflictToastTimer = setTimeout(() => {
            toast.classList.remove("show");
            conflictToastTimer = setTimeout(() => toast.remove(), 300);
        }, 7000);
    }

    function onConflictButtonClick(ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch {}

        // Ours: blink red
        giveawayBTN.classList.remove("bonanza-blink-red");
        void giveawayBTN.offsetWidth; // restart the animation
        giveawayBTN.classList.add("bonanza-blink-red");
        setTimeout(() => giveawayBTN.classList.remove("bonanza-blink-red"), 1000);

        // Theirs: glow orange and shake
        const orig = findOriginalGiveawayButton();
        if (orig) {
            orig.classList.add("bonanza-orig-btn");
            orig.classList.remove("bonanza-orig-alert");
            void orig.offsetWidth;
            orig.classList.add("bonanza-orig-alert");
            setTimeout(() => orig.classList.remove("bonanza-orig-alert"), 1000);
        }

        showConflictToast();
    }

    /**
     * Put this script into conflict mode: no panel, no giveaway logic, but the
     * toolbar button stays and looks normal until touched.
     */
    function enterConflictMode(chatboxHeader) {
        if (conflictWatchTimer) { clearInterval(conflictWatchTimer); conflictWatchTimer = null; }
        try { if (bonanzaGiveawayFrame) bonanzaGiveawayFrame.remove(); } catch {}
        try { releaseTabLock(); } catch {}

        giveawayBTN.classList.add("bonanza-btn--conflict");
        giveawayBTN.title = "Disabled: the original BON Giveaway script is also installed. Remove one of them.";
        giveawayBTN.setAttribute("aria-disabled", "true");
        giveawayBTN.onclick = onConflictButtonClick;
        if (!giveawayBTN.isConnected) {
            const host = chatboxHeader || document.querySelector("#chatbox_header div");
            if (host) {
                host.prepend(giveawayBTN);
                giveawayBTN.parentNode.insertBefore(document.createTextNode(" "), giveawayBTN.nextSibling);
            }
        }

        const orig = findOriginalGiveawayButton();
        if (orig) orig.classList.add("bonanza-orig-btn");

        console.warn("[DarkPeers BONanza Giveaway] Disabled: the original BON Giveaway script is also installed.");
    }

    async function injectMenu() {
        const chatboxHeader = document.querySelector(`#chatbox_header div`);
        if (!chatboxHeader) {
            setTimeout(injectMenu, 100);
            return;
        }

        addStyle(BUTTON_CSS, 'bonanza-giveaway-button-styles');

        if (originalGiveawayScriptPresent()) {
            enterConflictMode(chatboxHeader);
            return;
        }

        // The original may inject after us; keep watching and stand down if it appears
        // (unless a giveaway is already running here, in which case only warn).
        let conflictWarnedDuringGiveaway = false;
        conflictWatchTimer = setInterval(() => {
            if (!originalGiveawayScriptPresent()) return;
            if (giveawayData && isGiveawayCurrentlyActive(giveawayData)) {
                if (!conflictWarnedDuringGiveaway) {
                    conflictWarnedDuringGiveaway = true;
                    logEvent("Conflict", "The original BON Giveaway script appeared while a giveaway is running. Do not reload this page until it has ended, then remove one of the scripts.");
                    showConflictToast();
                }
                return;
            }
            enterConflictMode(chatboxHeader);
        }, 2000);

        addStyle(`
/* Keep vertical spacing tight */
#bonanzaGiveawayFrame .panel__body {
  gap: 2px !important;
  row-gap: 2px !important;
  margin-top: 2px !important;
  margin-bottom: 2px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

/* Specifically restore horizontal flex layout for the input rows */
#bonanzaGiveawayFrame .panel__body.flex-row {
  display: flex !important;
  flex-wrap: wrap !important;
  flex-direction: row !important;
  justify-content: center !important;
  gap: 20px !important; /* restore horizontal spacing */
}

#bonanzaGiveawayFrame .giveaway-number-row {
  width: 100%;
  justify-content: center !important;
  align-items: flex-end;
}

#bonanzaGiveawayFrame .giveaway-header-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#bonanzaGiveawayFrame .giveaway-header-actions {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  justify-content: flex-end;
}

#bonanzaGiveawayFrame .giveaway-header-actions__menu-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 0;
  margin-top: 6px;
  position: relative;
  z-index: 5;
}

#bonanzaGiveawayFrame .giveaway-btn {
  margin: 5px;
  position: relative;
  z-index: 6;
  pointer-events: auto;
}

#bonanzaGiveawayFrame .giveaway-number-col {
  width: 28%;
  min-width: 70px;
  max-width: 120px;
}

#bonanzaGiveawayFrame .giveaway-winners-row {
  margin-top: 12px;
  gap: 8px !important;
  flex-wrap: nowrap !important;
  align-self: stretch;
}

/* Custom message field should span full form width */
#bonanzaGiveawayFrame .giveaway-custom-message-row {
  align-self: stretch;
  width: 100% !important;
  padding: 0 10px;
  box-sizing: border-box;
}

/* Form groups still keep tight vertical margin */
#bonanzaGiveawayFrame .form__group {
  margin-top: 2px !important;
  margin-bottom: 2px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

#bonanzaGiveawayFrame .form__text {
  padding-top: 3px !important;
  padding-bottom: 3px !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}

#bonanzaGiveawayFrame .form__text.input-invalid {
  border-color: #dc3d1d !important;
  background-color: rgba(220, 61, 29, 0.16) !important;
}

#bonanzaGiveawayFrame .giveaway-inline-error {
  display: none;
  margin-top: 4px;
  color: #ff8f7d;
  font-size: 11px;
  line-height: 1.2;
}

#bonanzaGiveawayFrame .giveaway-inline-error.visible {
  display: block;
}

#bonanzaGiveawayFrame label.form__label {
  margin-top: 0 !important;
  margin-bottom: 2px !important;
  line-height: 1.1 !important;
}

/* Countdown timer fix: force block and full width below form */
#bonanzaGiveawayFrame #countdownHeader {
  display: block !important;
  width: 100% !important;
  margin-top: 10px;
  margin-bottom: 10px;
  text-align: center;
}

/* Entries wrapper full width with horizontal scroll if needed */
#bonanzaGiveawayFrame #entriesWrapper {
  width: 100% !important;
  overflow-x: auto;
  margin-top: 10px;
}

/* Entries table: flex to content, but never shrink below wrapper width
   and allow it to grow wider (triggering horizontal scroll). */
#bonanzaGiveawayFrame #entriesTable {
  border-collapse: collapse;
  table-layout: auto !important; /* override inline table-layout:fixed */
  min-width: 100%;               /* fill the frame at minimum */
  width: auto;                   /* but can grow past it if needed */
}

/* General cell padding */
#bonanzaGiveawayFrame #entriesTable th,
#bonanzaGiveawayFrame #entriesTable td {
  padding: 4px 6px;
}

/* User column: grow with username up to a cap, then ellipsis. */
#bonanzaGiveawayFrame #entriesTable th:nth-child(1),
#bonanzaGiveawayFrame #entriesTable td:nth-child(1) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;   /* hard upper bound for username column */
}

/* Entry # column: flex to content, keep centered */
#bonanzaGiveawayFrame #entriesTable th:nth-child(2),
#bonanzaGiveawayFrame #entriesTable td:nth-child(2) {
  text-align: center;
  white-space: nowrap;
}

/* Prize BON column: flex to content, keep centered */
#bonanzaGiveawayFrame #entriesTable th:nth-child(3),
#bonanzaGiveawayFrame #entriesTable td:nth-child(3) {
  text-align: center;
  white-space: nowrap;
}

/* Gift status column: fixed-ish narrow width, centered */
#bonanzaGiveawayFrame #entriesTable th:nth-child(4),
#bonanzaGiveawayFrame #entriesTable td:nth-child(4) {
  width: 70px !important;
  text-align: center;
}

/* Gift verification row states (color only Entry # / Prize / Gift, not Username) */
#bonanzaGiveawayFrame #entriesTable tr.gift-pending > td:nth-child(2),
#bonanzaGiveawayFrame #entriesTable tr.gift-pending > td:nth-child(3),
#bonanzaGiveawayFrame #entriesTable tr.gift-pending > td:nth-child(4) {
  background-color: rgba(255, 235, 59, 0.20) !important; /* yellow-ish */
}

#bonanzaGiveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(2),
#bonanzaGiveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(3),
#bonanzaGiveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(4) {
  background-color: rgba(76, 175, 80, 0.20) !important; /* green-ish */
}

#bonanzaGiveawayFrame #entriesTable tr.gift-self > td:nth-child(2),
#bonanzaGiveawayFrame #entriesTable tr.gift-self > td:nth-child(3),
#bonanzaGiveawayFrame #entriesTable tr.gift-self > td:nth-child(4) {
  background-color: rgba(158, 158, 158, 0.20) !important; /* grey-ish */
}

#bonanzaGiveawayFrame #entriesTable tr.gift-failed > td:nth-child(2),
#bonanzaGiveawayFrame #entriesTable tr.gift-failed > td:nth-child(3),
#bonanzaGiveawayFrame #entriesTable tr.gift-failed > td:nth-child(4) {
  background-color: rgba(244, 67, 54, 0.20) !important; /* red-ish */
}

/* Animated spinner for "checking" gift status */
#bonanzaGiveawayFrame .gift-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffeb3b; /* yellow-ish accent */
  animation: giftSpinnerSpin 0.8s linear infinite;
  box-sizing: border-box;
}

@keyframes giftSpinnerSpin {
  to {
    transform: rotate(360deg);
  }
}

/* Parent container vertical stacking with spacing */
#bonanzaGiveawayFrame #giveaway_body {
  display: flex !important;
  flex-direction: column !important;
  gap: 10px !important;
}

/* --- Improved vertical centering and layout for coinHeader --- */
#bonanzaGiveawayFrame #coinHeader.panel__heading--centered {
  margin-top: 14px !important;
  margin-bottom: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5em;
  gap: 6px;
}

#bonanzaGiveawayFrame .bg-flash {
  animation: bgFlashPulse 1s ease-out;
}

@keyframes bgFlashPulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 192, 10, 0.6);
    background-color: rgba(255, 192, 10, 0.26);
  }
  100% {
    box-shadow: 0 0 0 10px rgba(255, 192, 10, 0);
    background-color: rgba(255, 192, 10, 0);
  }
}

  ${settingsMenuStyle}
  ${commandsMenuStyle}
  ${hostPanelStyle}

/* Silence <h1> inside <section> console warning */
#bonanzaGiveawayFrame h1.panel__heading--centered {
  font-size: 1.5em;
  margin: 0;
}

/* ───────── Minimized state ───────── */

#bonanzaGiveawayFrame.minimized {
  height: auto !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

#bonanzaGiveawayFrame.minimized #giveaway_body,
#bonanzaGiveawayFrame.minimized #giveaway_settings_menu,
#bonanzaGiveawayFrame.minimized #giveaway_commands_menu,
#bonanzaGiveawayFrame.minimized .giveaway-header-actions__menu-row,
#bonanzaGiveawayFrame.minimized .rigged-watermark {
  display: none !important;
}

/* ───────── Rigged mode theming ───────── */

#bonanzaGiveawayFrame.rigged {
  border-color: #dc3d1d !important;
  box-shadow: 0 0 14px rgba(220, 61, 29, 0.75);
}

#bonanzaGiveawayFrame.rigged header.panel__heading {
  background: linear-gradient(90deg, #dc3d1d, #4e0000);
  color: #fff;
}

/* Watermark sits behind the content */
#bonanzaGiveawayFrame .rigged-watermark {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: none;              /* default hidden */
  align-items: center;
  justify-content: center;
  font-size: 4rem;
  font-weight: 900;
  opacity: 0.06;
  text-transform: uppercase;
  transform: rotate(-22deg);
  letter-spacing: 0.25em;
}

#bonanzaGiveawayFrame.rigged .rigged-watermark {
  display: flex;
  animation: rigWatermarkPulse 4s ease-in-out infinite;
}

/* Pulsing badge animation */
#riggedBadge.rigged-pulse {
  animation: rigPulse 1.2s ease-in-out infinite;
}

@keyframes rigPulse {
  0% {
    transform: scale(1);
    box-shadow: none;
  }
  50% {
    transform: scale(1.08);
    box-shadow: 0 0 8px rgba(220, 61, 29, 0.8);
  }
  100% {
    transform: scale(1);
    box-shadow: none;
  }
}

@keyframes rigWatermarkPulse {
  0% {
    opacity: 0.03;
    text-shadow: none;
    transform: rotate(-22deg) scale(1);
  }
  50% {
    opacity: 0.10;
    text-shadow: 0 0 10px rgba(220, 61, 29, 0.45);
    transform: rotate(-22deg) scale(1.03);
  }
  100% {
    opacity: 0.03;
    text-shadow: none;
    transform: rotate(-22deg) scale(1);
  }
}

#bonanzaGiveawayFrame.rigged #startButton {
  animation: rigStopPulse 1.5s ease-in-out infinite;
}

@keyframes rigStopPulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.03); }
  100% { transform: scale(1); }
}
`, 'bonanza-giveaway-styles');

        const existingGiveawayFrame = document.getElementById("bonanzaGiveawayFrame");
        if (existingGiveawayFrame) existingGiveawayFrame.remove();

        document.body.insertAdjacentHTML("beforeend", frameHTML);

        settingsMenu = document.getElementById('giveaway_settings_menu');
        commandsMenu = document.getElementById('giveaway_commands_menu');
        timerInput = document.getElementById("timerNum");
        remNumInput = document.getElementById("reminderNum");
        reminderEvery = document.getElementById("reminderEvery");

        // Enforce whole-number minutes in the Time field (no decimals / exponent notation)
        // (No page refresh required; prevents accidental fractional minutes.)
        (function enforceWholeMinutesOnTimerField() {
            if (!timerInput) return;

            let lastValid = String(timerInput.value || "5");
            const blockedKeys = new Set(['.', ',', 'e', 'E', '+', '-']);

            timerInput.addEventListener('keydown', (e) => {
                if (blockedKeys.has(e.key)) e.preventDefault();
            });

            timerInput.addEventListener('input', () => {
                const v = String(timerInput.value ?? "").trim();
                if (v === "") {
                    timerInput.setCustomValidity("");
                    return;
                }

                if (/^\d+$/.test(v)) {
                    const n = parseInt(v, 10);
                    if (Number.isFinite(n) && n >= 1) {
                        timerInput.setCustomValidity("");
                        lastValid = v;
                        return;
                    }
                }

                timerInput.setCustomValidity("Please enter a whole number of minutes (no decimals).");
                timerInput.value = lastValid;
            });
        })();

        bonanzaGiveawayFrame = document.getElementById('bonanzaGiveawayFrame');

        settingsBtn = bonanzaGiveawayFrame.querySelector('#giveawaySettingsBtn');
        commandsBtn = bonanzaGiveawayFrame.querySelector('#commandsButton');

        // Create / attach "RIGGED" badge next to the version
        const versionSmall = bonanzaGiveawayFrame.querySelector('header.panel__heading small');
        if (versionSmall) {
            rigBadge = document.createElement('span');
            rigBadge.id = 'riggedBadge';
            rigBadge.textContent = 'RIGGED';
            rigBadge.title = "Rigged mode is purely cosmetic… allegedly.";
            rigBadge.setAttribute("aria-label", "Rigged mode indicator");
            rigBadge.style.cssText = `

      margin-left: 8px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #dc3d1d;
      color: #fff;
      font-size: 0.75em;
      font-weight: 700;
    `;
            rigBadge.hidden = true;
            versionSmall.insertAdjacentElement('afterend', rigBadge);
        }

        // Update both when either changes
        timerInput.addEventListener("input", syncReminderNumUI);
        remNumInput.addEventListener("input", syncReminderNumUI);

        // Call on init
        syncReminderNumUI();


        /* kick-start synchronisation so defaults line up on first render */
        remNumInput.dispatchEvent(new Event("input"));

        settingsBtn.addEventListener('click', e => {
            e.stopPropagation(); // don’t bubble to outside-click
            if (commandsMenu.classList.contains('open')) hardCloseCommands(); // close the other pane first

            const open = settingsMenu.classList.toggle('open');

            if (open) { // ---------- OPEN ----------
                syncSettingsFromStorage();
                settingsMenu.style.display = 'flex';
                renderGiveawayLogPanel();
                fitSettingsMenuHeight();
                document.addEventListener('click', handleOutsideClick);
            } else { // ---------- CLOSE ----------
                hardCloseSettings();
            }
        });

        chatboxHeader.prepend(giveawayBTN);
        giveawayBTN.parentNode.insertBefore(document.createTextNode(" "), giveawayBTN.nextSibling);

        resetButton = document.getElementById("resetButton");
        resetButton.onclick = function () {
            if (hasIncompleteSettlement(giveawayData)) {
                window.alert(
                    "Reset is disabled while a giveaway settlement is incomplete. " +
                    "Use Retry settlement after resolving the warning; the recovery snapshot must be preserved."
                );
                return;
            }

            if (giveawayData && isGiveawayCurrentlyActive(giveawayData)) {
                if (window.confirm("Are you sure you want to reset the giveaway? This will clear all entries and cannot be undone.")) {
                    resetGiveaway();
                }
            } else {
                resetGiveaway();
            }
        };

        closeButton = document.getElementById("closeButton");
        closeButton.onclick = function () {
            // Check if a giveaway is active
            if (giveawayData && isGiveawayCurrentlyActive(giveawayData)) {
                if (window.confirm("A giveaway is currently running. Are you sure you want to close the menu? This will NOT end the giveaway, but you may lose track of its progress.")) {
                    toggleMenu();
                }
            } else {
                toggleMenu();
            }
        };

        minimizeButton = document.getElementById("minimizeButton");
        minimizeButton.onclick = function () {
            toggleMinimize();
        };
        // Restore minimized state from localStorage
        if (localStorage.getItem(LS_MINIMIZED) === "true") {
            setMinimized(true);
        }

        // Toggles
        const toggles = [
            // For these, localStorage stores "disabled/suppressed" (true), so checked means NOT stored.
            ["randomToggle", "bonanza-giveaway-disableRandom", "disable_random", false],
            ["luckyToggle", "bonanza-giveaway-disableLucky", "disable_lucky", false],
            ["freeToggle", "bonanza-giveaway-disableFree", "disable_free", false],
            ["entryrepliesToggle", LS_SUPPRESS, "suppress_entry_replies", false],

            // For silent mode / giveaway log, localStorage stores "enabled" (true), so checked mirrors stored.
            ["silentmodeToggle", LS_SILENT, "silent_mode", true],
            ["showgiveawaylogToggle", LS_SHOW_GIVEAWAY_LOG, "show_giveaway_log", true]
        ];

        function syncSettingsFromStorage() {
            for (const [id, key, setting, checkedWhenTrue = false] of toggles) {
                const el = document.getElementById(id);
                if (!el) continue;

                const fallback = checkedWhenTrue ? false : GENERAL_SETTINGS[setting] === true;
                const stored = readStoredBooleanSetting(key, fallback, true);

                // If stored=true means "disabled", checkbox should be unchecked; otherwise mirror stored.
                el.checked = checkedWhenTrue ? stored : !stored;

                // Keep GENERAL_SETTINGS value as the stored meaning (disabled/suppressed/enabled-for-silent/show-log)
                GENERAL_SETTINGS[setting] = stored;
            }
        }

        syncSettingsFromStorage();

        for (const [id, key, setting, checkedWhenTrue = false] of toggles) {
            const el = document.getElementById(id);
            if (!el) continue;

            el.addEventListener("change", () => {
                const newVal = checkedWhenTrue ? el.checked : !el.checked;
                GENERAL_SETTINGS[setting] = newVal;
                localStorage.setItem(key, String(newVal));
                if (setting === "show_giveaway_log") {
                    renderGiveawayLogPanel();
                }
                updateHostPanelUI();
            });
        }


        const rehearsalModeToggle = document.getElementById("rehearsalModeToggle");
        if (rehearsalModeToggle) {
            rehearsalModeToggle.checked = REHEARSAL_MODE;
            rehearsalModeToggle.disabled = REHEARSAL_FORCED_BY_DEBUG;

            if (REHEARSAL_FORCED_BY_DEBUG) {
                rehearsalModeToggle.title =
                    "Rehearsal / Debug mode is forced by DEBUG_SETTINGS.dry_run in the userscript source.";
            }

            rehearsalModeToggle.addEventListener("change", () => {
                const requested = !!rehearsalModeToggle.checked;
                const activeHere = !!giveawayData;
                const activeElsewhere = isLockedByAnotherTab();

                if (activeHere || activeElsewhere) {
                    rehearsalModeToggle.checked = REHEARSAL_MODE;
                    window.alert(
                        "Rehearsal / Debug mode cannot be changed while a giveaway is active or recoverable. " +
                        "Finish or settle the giveaway first."
                    );
                    return;
                }

                try {
                    localStorage.setItem(REHEARSAL_FLAG, String(requested));
                } catch {
                    rehearsalModeToggle.checked = REHEARSAL_MODE;
                    window.alert("Unable to save the Rehearsal / Debug mode setting.");
                    return;
                }

                if (!requested && REHEARSAL_FORCED_BY_QUERY) {
                    const cleanUrl = new URL(window.location.href);
                    for (const key of Array.from(cleanUrl.searchParams.keys())) {
                        if (key.toLowerCase() === "bg_rehearsal") {
                            cleanUrl.searchParams.delete(key);
                        }
                    }
                    window.history.replaceState(window.history.state, "", cleanUrl.toString());
                }

                window.location.reload();
            });
        }

        bindSettingsSectionToggleButtons();

        updateHostPanelUI();

        rigToggleInput = document.getElementById("rigModeToggle");
        if (rigToggleInput) {
            rigToggleInput.addEventListener("change", () => {
                const hostName = getLoggedInUsername();

                const ctx = {
                    author: hostName,
                    fancyName: "",
                    args: [],
                    giveawayData: giveawayData || { host: hostName },
                    safeAuthor: sanitizeNick(hostName),
                    safeHost: sanitizeNick(hostName)
                };

                if (rigToggleInput.checked && !riggedMode) {
                    COMMAND_HANDLERS.rig(ctx);
                } else if (!rigToggleInput.checked && riggedMode) {
                    COMMAND_HANDLERS.unrig(ctx);
                } else {
                    updateRigToggleUI();
                }
            });
            updateRigToggleUI();
        }

        coinHeader = document.getElementById("coinHeader");
        const hostBalance = readHostBalance();
        coinHeader.textContent = `${fmtBONCurrency(hostBalance)} BON`;
        coinHeader.prepend(goldCoins.cloneNode(false));

        coinInput = document.getElementById("giveawayAmount");

        // remove formatting while editing
        coinInput.addEventListener('focus', () => {
            coinInput.value = coinInput.value.replace(/[^0-9]/g, '');
        });

        // add locale formatting on blur if it’s a valid integer
        coinInput.addEventListener('blur', () => {
            const raw = coinInput.value.replace(/[^0-9]/g, '');
            if (/^\d+$/.test(raw)) {
                coinInput.value = parseInt(raw, 10).toLocaleString();
            }
        });

        startInput = document.getElementById("startNum");
        endInput = document.getElementById("endNum");
        winnersInput = document.getElementById("winnersNum");
        if (pendingEffectiveWinnersDisplay != null) syncWinnersDisplayValue(pendingEffectiveWinnersDisplay);
        scaleWinnersToggleInput = document.getElementById("scaleWinnersToggle");
        maxScaledWinnersInput = document.getElementById("maxScaledWinnersNum");
        maxScaledWinnersGroup = document.getElementById("maxScaledWinnersGroup");
        maxScaledWinnersError = document.getElementById("maxScaledWinnersError");
        maxScaledWinnersRawValue = String(maxScaledWinnersInput?.value || "1");
        scaleBonPerWinnerInput = document.getElementById("scaleBonPerWinnerNum");
        scaleBonPerWinnerGroup = document.getElementById("scaleBonPerWinnerGroup");
        customMessageInput = document.getElementById("customMessage");
        donationPercentInput = document.getElementById("donationPercent");
        donationHint = document.getElementById("donationHint");
        if (donationPercentInput) {
            donationPercentInput.value = String(normalizeDonationPercent(localStorage.getItem(LS_DONATION_PERCENT)));
            donationPercentInput.addEventListener("change", () => {
                const pct = normalizeDonationPercent(donationPercentInput.value);
                donationPercentInput.value = String(pct);
                try { localStorage.setItem(LS_DONATION_PERCENT, String(pct)); } catch {}
                updateDonationHint();
            });
        }
        giveawayForm = document.getElementById("giveawayForm");
        startButton = document.getElementById("startButton");

        startButton.onclick = startGiveaway;
        startButton.title = "Start the giveaway";

        // Presets
        bindPresetButtons();
        refreshPresetDropdown();

        countdownHeader = document.getElementById("countdownHeader");
        entriesWrapper = document.getElementById("entriesWrapper");
        giveawayLogPanel = document.getElementById("giveawayLogPanel");
        document.getElementById("bonanzaSaveStatementBtn")?.addEventListener("click", () => downloadSelectedStatement());
        document.getElementById("bonanzaCopyStatementBtn")?.addEventListener("click", () => copySelectedStatement());
        renderStatementControls();
        giveawayLogContent = document.getElementById("giveawayLogContent");
        document.getElementById("copyGiveawayLogButton")?.addEventListener("click", copyGiveawayLogToClipboard);
        document.getElementById("clearGiveawayLogButton")?.addEventListener("click", clearGiveawayLog);
        renderGiveawayLogPanel();
        document.body.appendChild(bonanzaGiveawayFrame);

        // Draggable panel (header title row only; menu/button row is excluded)
        bindHeaderInteractions();

        window.addEventListener('resize', () => {
            if (settingsMenu?.classList.contains('open')) fitSettingsMenuHeight();
        });

        timerInput.addEventListener("input", reminderAutoScaling);
        startInput.addEventListener("input", entryRangeValidation);
        endInput.addEventListener("input", entryRangeValidation);
        winnersInput.addEventListener("input", winnersValidation);
        coinInput.addEventListener("input", syncBonPerWinnerValue);
        winnersInput.addEventListener("input", syncBonPerWinnerValue);
        coinInput.addEventListener("input", updateDonationHint);
        updateDonationHint();
        if (scaleBonPerWinnerInput) {
            scaleBonPerWinnerInput.addEventListener("input", () => { bonPerWinnerManuallyEdited = true; });
            // If user clears the field entirely, revert to auto mode
            scaleBonPerWinnerInput.addEventListener("blur", () => {
                if (!String(scaleBonPerWinnerInput.value || "").trim()) {
                    bonPerWinnerManuallyEdited = false;
                    syncBonPerWinnerValue();
                }
            });
        }
        scaleWinnersToggleInput.addEventListener("change", updateScaleWinnersControls);
        maxScaledWinnersInput.addEventListener("input", handleMaxScaledWinnersInput);
        maxScaledWinnersInput.addEventListener("blur", () => validateMaxScaledWinnersInput({ forceMessage: true }));

        updateScaleWinnersControls();
        reminderAutoScaling();
        updateHostPanelUI();

        // ── Attempt to restore a giveaway that survived a page reload ──
        const savedSnap = loadGiveawaySnapshot();
        if (savedSnap) {
            if (isLockedByAnotherTab()) {
                // Another tab is actively running this giveaway. Do not duplicate it
                console.info("[BON Giveaway] Active giveaway detected in another tab, skipping restore.");
            } else {
                const restored = await restoreGiveawayFromSnapshot(savedSnap);
                if (restored) {
                    // Show the panel automatically so the host sees the restored state
                    bonanzaGiveawayFrame.hidden = false;
                    setMinimized(false);
                    console.info("[BON Giveaway] Restored active giveaway from snapshot.");
                }
            }
        }
    }

    function ensureHostPanelToggleButton() {
        if (!bonanzaGiveawayFrame) return null;
        const actionsRow = bonanzaGiveawayFrame.querySelector('.giveaway-header-actions__menu-row');
        if (!actionsRow) return null;
        let toggle = actionsRow.querySelector('#hostPanelToggle');
        if (!toggle) {
            actionsRow.insertAdjacentHTML('beforeend', `
      <button id="hostPanelToggle" class="form__button form__button--text giveaway-btn no-drag" data-no-drag="1" style="background-color:#ff9600;" title="Open/close host command panel.">
        <i class="fa-solid fa-sliders"></i> Host Panel
      </button>`);
            toggle = actionsRow.querySelector('#hostPanelToggle');
        }
        return toggle;
    }

    function toggleMenu() {
        bonanzaGiveawayFrame.hidden = !bonanzaGiveawayFrame.hidden;
        if (!bonanzaGiveawayFrame.hidden) {
            ensureHostPanelToggleButton();
            updateHostPanelUI();
        }
    }

    function setMinimized(minimized) {
        if (!bonanzaGiveawayFrame) return;
        const icon = minimizeButton?.querySelector("i");
        if (minimized) {
            bonanzaGiveawayFrame.classList.add("minimized");
            if (icon) { icon.className = "fa-solid fa-window-maximize"; }
            if (minimizeButton) minimizeButton.title = "Restore panel";
        } else {
            bonanzaGiveawayFrame.classList.remove("minimized");
            if (icon) { icon.className = "fa-solid fa-window-minimize"; }
            if (minimizeButton) minimizeButton.title = "Minimize panel";
        }
        localStorage.setItem(LS_MINIMIZED, String(minimized));
    }

    function toggleMinimize() {
        setMinimized(!bonanzaGiveawayFrame.classList.contains("minimized"));
    }

    // ───────────────────────────────────────────────────────────
    // Presets: save / load / delete form configurations
    // ───────────────────────────────────────────────────────────
    function loadPresetList() {
        try {
            return JSON.parse(localStorage.getItem(LS_PRESETS) || "[]");
        } catch { return []; }
    }

    function savePresetList(presets) {
        try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); } catch {}
    }

    function captureFormPreset() {
        return {
            amount: coinInput?.value || "",
            startNum: startInput?.value || "1",
            endNum: endInput?.value || "50",
            timer: timerInput?.value || "5",
            reminders: remNumInput?.value || "0",
            winners: winnersInput?.value || "1",
            scaleWinners: scaleWinnersToggleInput?.checked || false,
            maxScaledWinners: maxScaledWinnersInput?.value || "1",
            scaleBonPerWinner: scaleBonPerWinnerInput?.value || "",
            scaleBonPerWinnerCustom: bonPerWinnerManuallyEdited,
            customMessage: customMessageInput?.value || "",
            donationPercent: normalizeDonationPercent(donationPercentInput?.value)
        };
    }

    function applyFormPreset(preset) {
        if (!preset) return;
        if (coinInput && preset.amount) coinInput.value = preset.amount;
        if (startInput && preset.startNum) startInput.value = preset.startNum;
        if (endInput && preset.endNum) endInput.value = preset.endNum;
        if (timerInput && preset.timer) timerInput.value = preset.timer;
        if (remNumInput && preset.reminders != null) remNumInput.value = preset.reminders;
        if (winnersInput && preset.winners) winnersInput.value = preset.winners;
        if (scaleWinnersToggleInput) {
            scaleWinnersToggleInput.checked = !!preset.scaleWinners;
            scaleWinnersToggleInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (maxScaledWinnersInput && preset.maxScaledWinners) maxScaledWinnersInput.value = preset.maxScaledWinners;
        if (scaleBonPerWinnerInput) {
            const presetBonPerWinner = String(preset.scaleBonPerWinner || "").trim();
            if (preset.scaleBonPerWinnerCustom && presetBonPerWinner) {
                scaleBonPerWinnerInput.value = presetBonPerWinner;
                bonPerWinnerManuallyEdited = true;
            } else {
                bonPerWinnerManuallyEdited = false;
                syncBonPerWinnerValue();
            }
        }
        if (customMessageInput && preset.customMessage != null) customMessageInput.value = preset.customMessage;
        if (donationPercentInput && preset.donationPercent != null) {
            donationPercentInput.value = String(normalizeDonationPercent(preset.donationPercent));
            donationPercentInput.dispatchEvent(new Event("change", { bubbles: true }));
        }

        // Re-sync dependent UI
        syncReminderNumUI();
        if (typeof entryRangeValidation === "function") entryRangeValidation();
        if (typeof winnersValidation === "function") winnersValidation();
        if (typeof updateScaleWinnersControls === "function") updateScaleWinnersControls();
    }

    function refreshPresetDropdown() {
        const select = document.getElementById("presetSelect");
        if (!select) return;
        const presets = loadPresetList();

        // Preserve current selection if possible
        const prevVal = select.value;
        select.innerHTML = '<option value="">Presets</option>';
        presets.forEach((p, i) => {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = p.name || `Preset ${i + 1}`;
            select.appendChild(opt);
        });

        // Restore selection
        if (prevVal && select.querySelector(`option[value="${prevVal}"]`)) {
            select.value = prevVal;
        }
    }

    function bindPresetButtons() {
        const saveBtn = document.getElementById("presetSaveBtn");
        const loadBtn = document.getElementById("presetLoadBtn");
        const deleteBtn = document.getElementById("presetDeleteBtn");
        const select = document.getElementById("presetSelect");

        if (saveBtn) saveBtn.addEventListener("click", () => {
            const name = window.prompt("Name this preset:");
            if (!name || !name.trim()) return;
            const presets = loadPresetList();
            presets.push({ name: name.trim(), ...captureFormPreset() });
            savePresetList(presets);
            refreshPresetDropdown();
            if (select) select.value = String(presets.length - 1);
        });

        if (loadBtn) loadBtn.addEventListener("click", () => {
            if (!select || select.value === "") return;
            const presets = loadPresetList();
            const idx = parseInt(select.value, 10);
            if (presets[idx]) applyFormPreset(presets[idx]);
        });

        if (deleteBtn) deleteBtn.addEventListener("click", () => {
            if (!select || select.value === "") return;
            const presets = loadPresetList();
            const idx = parseInt(select.value, 10);
            const preset = presets[idx];
            if (!preset) return;
            if (!window.confirm(`Delete preset "${preset.name || "Preset " + (idx + 1)}"?`)) return;
            presets.splice(idx, 1);
            savePresetList(presets);
            refreshPresetDropdown();
        });
    }

    // ───────────────────────────────────────────────────────────
    // Giveaway persistence: survive page reloads mid-giveaway
    // ───────────────────────────────────────────────────────────

    function getActiveGiveawayStorageKey(hostName = "") {
        const hostKey = normalizeUserKey(hostName || getLoggedInUsername());
        return hostKey
            ? `${LS_ACTIVE_GIVEAWAY_LEGACY}${REHEARSAL_STORAGE_SUFFIX}::${encodeURIComponent(hostKey)}`
            : null;
    }

    function readActiveGiveawayRawForHost(hostName = "", { migrateLegacy = false } = {}) {
        const requestedHostKey = normalizeUserKey(hostName || getLoggedInUsername());
        const storageKey = getActiveGiveawayStorageKey(requestedHostKey);
        if (!requestedHostKey || !storageKey) return { storageKey, raw: null, migratedLegacy: false };

        try {
            const namespacedRaw = localStorage.getItem(storageKey);
            if (namespacedRaw) return { storageKey, raw: namespacedRaw, migratedLegacy: false };

            // Backwards-compatible migration from pre-v1.3.24 hostname-wide storage.
            // A legacy snapshot belonging to another account is deliberately left
            // untouched; the current account now has its own namespace and cannot
            // overwrite that foreign recovery state. Rehearsal storage never
            // imports a live legacy snapshot.
            if (REHEARSAL_MODE) {
                return { storageKey, raw: null, migratedLegacy: false };
            }
            const legacyRaw = localStorage.getItem(LS_ACTIVE_GIVEAWAY_LEGACY);
            if (!legacyRaw) return { storageKey, raw: null, migratedLegacy: false };

            const legacy = JSON.parse(legacyRaw);
            const legacyHostKey = normalizeUserKey(legacy?.giveawayData?.host);
            if (!legacyHostKey || legacyHostKey !== requestedHostKey) {
                return { storageKey, raw: null, migratedLegacy: false };
            }

            if (migrateLegacy) {
                localStorage.setItem(storageKey, legacyRaw);
                localStorage.removeItem(LS_ACTIVE_GIVEAWAY_LEGACY);
            }
            return { storageKey, raw: legacyRaw, migratedLegacy: !!migrateLegacy };
        } catch {
            return { storageKey, raw: null, migratedLegacy: false };
        }
    }

    /** Read and validate the shared cross-tab lock. */
    function readTabLock() {
        try {
            const raw = localStorage.getItem(LS_TAB_LOCK);
            if (!raw) return null;
            const lock = JSON.parse(raw);
            if (!lock || typeof lock.tabId !== "string" || !Number.isFinite(Number(lock.ts))) return null;
            return { tabId: lock.tabId, ts: Number(lock.ts) };
        } catch {
            return null;
        }
    }

    function isFreshTabLock(lock, now = Date.now()) {
        return !!(lock && (now - Number(lock.ts)) < TAB_LOCK_STALE_MS);
    }

    function startTabLockHeartbeat() {
        if (tabLockHeartbeatTimer) clearInterval(tabLockHeartbeatTimer);
        tabLockHeartbeatTimer = setInterval(() => {
            try {
                const lock = readTabLock();

                // Never overwrite a lock that another live tab acquired after us.
                if (!lock || lock.tabId !== TAB_ID) {
                    clearInterval(tabLockHeartbeatTimer);
                    tabLockHeartbeatTimer = null;
                    return;
                }

                localStorage.setItem(LS_TAB_LOCK, JSON.stringify({ tabId: TAB_ID, ts: Date.now() }));
            } catch {}
        }, TAB_LOCK_HEARTBEAT_MS);
    }

    /**
     * Try to claim the tab lock without stealing a fresh lock from another tab.
     * Returns true only if our claim is visible after the write.
     */
    async function acquireTabLock() {
        if (giveawayMutationQuarantined) return false;

        // Web Locks provides the atomic cross-tab mutex required for money/state
        // safety. A localStorage-only fallback cannot make compare-and-set atomic,
        // so unsupported browsers fail closed instead of risking double settlement.
        if (tabWebLockRelease) return true;

        if (!navigator.locks || typeof navigator.locks.request !== "function") {
            console.warn("[BON Giveaway] Web Locks API unavailable; refusing to start/restore because exclusive cross-tab ownership cannot be guaranteed.");
            return false;
        }

        if (tabWebLockAcquirePromise) {
            const acquired = await tabWebLockAcquirePromise;
            return !giveawayMutationQuarantined && !!acquired && ownsTabLock();
        }

        tabWebLockAcquirePromise = new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            navigator.locks.request(
                TAB_WEB_LOCK_NAME,
                { mode: "exclusive", ifAvailable: true },
                async (lock) => {
                    if (!lock || giveawayMutationQuarantined) {
                        settle(false);
                        return;
                    }

                    let releaseHold;
                    const hold = new Promise(r => { releaseHold = r; });
                    tabWebLockRelease = releaseHold;

                    let leasePersisted = false;
                    try {
                        localStorage.setItem(
                            LS_TAB_LOCK,
                            JSON.stringify({ tabId: TAB_ID, ts: Date.now(), transport: "web-lock" })
                        );
                        const lease = readTabLock();
                        leasePersisted = !!(lease && lease.tabId === TAB_ID);
                    } catch {}

                    if (!leasePersisted || giveawayMutationQuarantined) {
                        try {
                            const lease = readTabLock();
                            if (lease && lease.tabId === TAB_ID) {
                                localStorage.removeItem(LS_TAB_LOCK);
                            }
                        } catch {}
                        tabWebLockRelease = null;
                        try { releaseHold(); } catch {}
                        settle(false);
                        return;
                    }

                    startTabLockHeartbeat();
                    settle(true);

                    try {
                        await hold;
                    } finally {
                        tabWebLockRelease = null;
                    }
                }
            ).catch(() => settle(false));
        }).finally(() => {
            tabWebLockAcquirePromise = null;
        });

        const acquired = await tabWebLockAcquirePromise;
        return !giveawayMutationQuarantined && !!acquired && ownsTabLock();
    }

    /** Release the tab lock and stop the heartbeat. */
    function releaseTabLock() {
        if (tabLockHeartbeatTimer) { clearInterval(tabLockHeartbeatTimer); tabLockHeartbeatTimer = null; }
        try {
            const lock = readTabLock();
            if (lock && lock.tabId === TAB_ID) localStorage.removeItem(LS_TAB_LOCK);
        } catch {}

        if (tabWebLockRelease) {
            const release = tabWebLockRelease;
            tabWebLockRelease = null;
            try { release(); } catch {}
        }
    }

    /** Check if another tab currently owns the giveaway (fresh heartbeat). */
    function isLockedByAnotherTab() {
        const lock = readTabLock();
        if (!lock || lock.tabId === TAB_ID) return false;
        return isFreshTabLock(lock);
    }

    function ownsTabLock() {
        if (giveawayMutationQuarantined) return false;
        const lock = readTabLock();
        if (!lock || lock.tabId !== TAB_ID || !isFreshTabLock(lock)) return false;
        if (navigator.locks && typeof navigator.locks.request === "function") {
            return !!tabWebLockRelease;
        }
        return true;
    }

    async function ensureExclusiveTabOwnership() {
        if (giveawayMutationQuarantined) return false;
        if (ownsTabLock()) return true;
        try {
            const acquired = await acquireTabLock();
            if (giveawayMutationQuarantined) return false;
            return !!acquired && ownsTabLock();
        } catch {
            return false;
        }
    }

    function canMutateActiveGiveaway() {
        return !giveawayMutationQuarantined && (!giveawayData || ownsTabLock());
    }

    // Release the localStorage lock only when this document really leaves.
    // This makes a normal reload recover immediately instead of leaving the new
    // document blocked behind the previous document's fresh heartbeat.
    function handleGiveawayPageHide() {
        if (!giveawayData) {
            // start/restore may still be awaiting the Web Lock before giveawayData
            // is assigned. Quarantine that document now so a queued callback
            // cannot complete successfully after BFCache handoff.
            if (tabWebLockAcquirePromise || tabWebLockRelease) {
                giveawayMutationQuarantined = true;
            }
            return;
        }

        const lock = readTabLock();
        if (!lock || lock.tabId !== TAB_ID) {
            giveawayMutationQuarantined = true;
            return; // never overwrite another tab's snapshot
        }

        try {
            flushStatsNow();
            if (!giveawayData.__ending) snapshotGiveaway();
            else if (giveawayData.settlement?.committed) snapshotGiveaway({ force: true });
        } catch {}

        // From this point until a persisted pageshow proves ownership again, every
        // async continuation from this document must be read-only.
        giveawayMutationQuarantined = true;
        releaseTabLock();
    }

    // BFCache can restore the exact same JS document after pagehide. Because
    // ownership was released, another tab may have restored and persisted newer
    // giveaway state in the meantime. Never resume this document's stale memory:
    // quarantine synchronously and reload from the authoritative persisted state.
    function handleGiveawayPageShow(event) {
        if (!event || !event.persisted) return;
        if (!giveawayData && !tabWebLockAcquirePromise && !tabWebLockRelease) return;

        giveawayMutationQuarantined = true;
        window.onbeforeunload = null;
        window.location.reload();
    }

    window.addEventListener("pagehide", handleGiveawayPageHide);
    window.addEventListener("pageshow", handleGiveawayPageShow);

    /**
     * Serialize the active giveaway state to localStorage.
     * Called at key mutation points (new entry, start, addbon, sponsor, time adjust).
     */
    function snapshotGiveaway({ force = false, verifyWrite = false } = {}) {
        if (!giveawayData || !canMutateActiveGiveaway() || (giveawayData.__ending && !force)) return false;
        try {
            const snapshot = {
                giveawayData: {
                    rehearsalMode: giveawayData.rehearsalMode === true,
                    host: giveawayData.host,
                    amount: giveawayData.amount,
                    startNum: giveawayData.startNum,
                    endNum: giveawayData.endNum,
                    totalEntries: giveawayData.totalEntries,
                    winningNumber: giveawayData.winningNumber,
                    totalSeconds: giveawayData.totalSeconds,
                    endTs: giveawayData.endTs,
                    winnersNum: giveawayData.winnersNum,
                    baseWinnersAtStart: giveawayData.baseWinnersAtStart,
                    effectiveWinnersNum: giveawayData.effectiveWinnersNum,
                    scaleWinnersWithSponsors: giveawayData.scaleWinnersWithSponsors,
                    hostMaxScaledWinners: giveawayData.hostMaxScaledWinners,
                    scaleBonPerWinner: giveawayData.scaleBonPerWinner,
                    customMessage: giveawayData.customMessage,
                    donationPercent: giveawayData.donationPercent,
                    hostAdded: giveawayData.hostAdded,
                    hostWalletAtStart: giveawayData.hostWalletAtStart,
                    initialPotVerifiedAtStart: giveawayData.initialPotVerifiedAtStart,
                    reminderSchedule: giveawayData.reminderSchedule,
                    reminderNum: giveawayData.reminderNum,
                    reminderFreqSec: giveawayData.reminderFreqSec,
                    nextReminderSec: giveawayData.nextReminderSec,
                    sponsorContribs: giveawayData.sponsorContribs,
                    sponsors: giveawayData.sponsors,
                    sponsorGiftMessages: Array.isArray(giveawayData.sponsorGiftMessages)
                        ? giveawayData.sponsorGiftMessages
                        : [],
                    closingIntent: giveawayData.__closingIntent === true,
                    closingNoticeSent: giveawayData.__closingNoticeSent === true,
                    closingNoticeProgress:
                        giveawayData.__closingNoticeProgress &&
                        typeof giveawayData.__closingNoticeProgress === "object"
                            ? { ...giveawayData.__closingNoticeProgress }
                            : null,
                    lastAnnouncedWinners: giveawayData.lastAnnouncedWinners,
                    settlement: giveawayData.settlement && typeof giveawayData.settlement === "object"
                        ? { ...giveawayData.settlement }
                        : null
                },
                entries: Array.from(numberEntries.entries()),
                takenBy: Array.from(numberTakenBy.entries()),
                fancyNameEntries: Array.from(fancyNames.entries()),
                liveStats: {
                    entered: Array.from(liveEnteredThisGiveaway),
                    sponsorSeen: Array.from(liveSponsorSeenThisGiveaway),
                    sponsorTotals: Array.from(liveSponsorTotalThisGiveaway.entries())
                },
                sponsorTracker: window.__activeTracker ? {
                    lastMsgId: Math.max(0, Math.floor(Number(window.__activeTracker.lastMsgId) || 0)),
                    cursorInitialized: !!window.__activeTracker.cursorInitialized,
                    giftHistoryClockOffsetMs: optionalFiniteNumber(window.__activeTracker.giftHistoryClockOffsetMs),
                    giftHistoryInitialized: !!window.__activeTracker.giftHistoryInitialized,
                    giftHistorySeenKeys: Array.from(window.__activeTracker.giftHistorySeenKeys || []).slice(-250),
                    historyFallbackActive: !!window.__activeTracker.historyFallbackActive,
                    maxAcceptedCreatedAtTs: optionalFiniteNumber(window.__activeTracker.maxAcceptedCreatedAtTs)
                } : null,
                riggedMode: riggedMode,
                startTime: giveawayStartTime ? giveawayStartTime.getTime() : null,
                savedAt: Date.now()
            };
            const storageKey = getActiveGiveawayStorageKey(giveawayData.host);
            if (!storageKey) throw new Error("Cannot persist giveaway without an authenticated host namespace.");
            const serializedSnapshot = JSON.stringify(snapshot);
            localStorage.setItem(storageKey, serializedSnapshot);

            if (verifyWrite) {
                const persistedSnapshot = localStorage.getItem(storageKey);
                if (persistedSnapshot !== serializedSnapshot) {
                    throw new Error("Active giveaway snapshot read-back verification failed.");
                }
            }

            // Remove only a matching legacy snapshot after the namespaced write
            // succeeds. Never delete another account's retained recovery state.
            try {
                const legacyRaw = REHEARSAL_MODE
                    ? null
                    : localStorage.getItem(LS_ACTIVE_GIVEAWAY_LEGACY);
                if (legacyRaw) {
                    const legacy = JSON.parse(legacyRaw);
                    if (normalizeUserKey(legacy?.giveawayData?.host) === normalizeUserKey(giveawayData.host)) {
                        localStorage.removeItem(LS_ACTIVE_GIVEAWAY_LEGACY);
                    }
                }
            } catch {}
            return true;
        } catch (e) {
            console.warn("Giveaway snapshot failed:", e);
            return false;
        }
    }

    /** Clear only the persisted giveaway state that belongs to this host. */
    function clearGiveawaySnapshot(hostName = "") {
        const resolvedHost = hostName || giveawayData?.host || getLoggedInUsername();
        const hostKey = normalizeUserKey(resolvedHost);
        const storageKey = getActiveGiveawayStorageKey(hostKey);

        try {
            if (storageKey) localStorage.removeItem(storageKey);

            // Backwards-compatible cleanup: remove the old hostname-wide key only
            // when it belongs to the same host. A foreign account's recovery state
            // must survive logout/login switches. Rehearsal cleanup never touches
            // the production legacy recovery key.
            const legacyRaw = REHEARSAL_MODE
                ? null
                : localStorage.getItem(LS_ACTIVE_GIVEAWAY_LEGACY);
            if (legacyRaw) {
                const legacy = JSON.parse(legacyRaw);
                if (hostKey && normalizeUserKey(legacy?.giveawayData?.host) === hostKey) {
                    localStorage.removeItem(LS_ACTIVE_GIVEAWAY_LEGACY);
                }
            }
        } catch {}
    }

    /** Load a saved giveaway. Recently-expired snapshots are restored and settled. */
    function loadGiveawaySnapshot() {
        try {
            const loggedInHostKey = normalizeUserKey(getLoggedInUsername());
            if (!loggedInHostKey) return null;

            const stored = readActiveGiveawayRawForHost(loggedInHostKey, { migrateLegacy: true });
            if (!stored.raw) return null;
            const snap = JSON.parse(stored.raw);
            if (!snap || !snap.giveawayData) return null;

            const savedRehearsalMode = snap.giveawayData.rehearsalMode === true;
            if (savedRehearsalMode !== REHEARSAL_MODE) {
                console.warn("[BON Giveaway] Refusing restore across live/rehearsal modes.");
                return null;
            }

            const savedHostKey = normalizeUserKey(snap.giveawayData.host);
            if (!savedHostKey || savedHostKey !== loggedInHostKey) {
                console.warn(
                    "[BON Giveaway] Refusing restore: the saved giveaway belongs to a different authenticated host namespace."
                );
                return null;
            }

            const endTs = Number(snap.giveawayData.endTs);
            if (!Number.isFinite(endTs) || endTs <= 0) {
                clearGiveawaySnapshot();
                return null;
            }

            const overdueMs = Date.now() - endTs;
            const committedSettlement = snap.giveawayData?.settlement?.committed === true;
            const closingSettlementLatched =
                snap.giveawayData?.closingIntent === true ||
                snap.giveawayData?.closingNoticeSent === true ||
                snap.giveawayData?.settlement?.phase === "settling";

            if (
                overdueMs > EXPIRED_SNAPSHOT_SETTLEMENT_GRACE_MS &&
                !committedSettlement &&
                !closingSettlementLatched
            ) {
                console.warn("[BON Giveaway] Discarding stale expired active snapshot; automatic settlement grace exceeded.");
                clearGiveawaySnapshot();
                return null;
            }

            // Once settlement is committed OR the closing latch has been persisted,
            // retain it until terminal cleanup. A pre-commit sponsor-sync pause is
            // still settlement state and must survive beyond the normal one-hour
            // active-giveaway grace window.
            snap.__expiredAtLoad = overdueMs >= 0 || closingSettlementLatched;
            return snap;
        } catch {
            clearGiveawaySnapshot();
            return null;
        }
    }

    /**
     * Restore a giveaway from a snapshot. Re-establishes entries, timers, observer, and sponsor tracker.
     * Called during injectMenu() if a valid snapshot exists.
     */
    function clearSponsorAccountingRecoveryTimer() {
        if (sponsorRecoveryInterval) {
            clearInterval(sponsorRecoveryInterval);
            sponsorRecoveryInterval = null;
        }
    }

    function setSponsorAccountingVerificationState(verified, details = "") {
        if (!giveawayData) return;
        giveawayData.__sponsorAccountingVerified = verified === true;

        if (verified === true) {
            clearHostSafetyBanner("accounting");
        } else {
            setHostSafetyBanner(
                "accounting",
                "ACCOUNTING NOT VERIFIED: entries and time controls remain active, but sponsor pot changes and settlement are paused until persistent Gift History reconciliation succeeds.",
                "danger"
            );
        }

        if (details) logEvent(verified ? "Sponsor accounting verified" : "Sponsor accounting blocked", details);
        updateHostPanelUI();
    }

    function scheduleSponsorAccountingRecovery(tracker, { expiredOnRestore = false } = {}) {
        clearSponsorAccountingRecoveryTimer();
        if (!tracker) return;

        let inFlight = false;
        const retry = async () => {
            if (inFlight || !giveawayData || window.__activeTracker !== tracker) return;
            if (!canMutateActiveGiveaway()) return;
            inFlight = true;

            try {
                const result = await tracker.reconcileCanonicalSponsorAccounting({
                    repairStats: false
                });
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    throw new Error("Canonical sponsor reconciliation could not be persisted safely.");
                }

                setSponsorAccountingVerificationState(
                    true,
                    result?.repaired
                        ? `Recovered canonical pot: ${fmtBONCurrency(result.previousPot)} -> ${fmtBONCurrency(result.canonicalPot)} BON.`
                        : "Persistent Gift History reconciliation succeeded."
                );
                clearSponsorAccountingRecoveryTimer();

                coinHeader.innerHTML = `${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON`;
                coinHeader.prepend(goldCoins.cloneNode(false));

                const expiredNow =
                    expiredOnRestore ||
                    getGiveawayRemainingMs(giveawayData) <= 0 ||
                    giveawayData.__closingIntent === true;

                if (expiredNow) {
                    setTimeout(() => {
                        if (giveawayData && !giveawayData.__ending) endGiveaway();
                    }, 0);
                    return;
                }

                if (!sponsorsInterval) {
                    tracker.poll().catch(console.error);
                    sponsorsInterval = setInterval(
                        () => tracker.poll(),
                        SPONSOR_GIFT_HISTORY_POLL_MS
                    );
                }
            } catch (e) {
                console.warn(
                    "[BON Giveaway] Sponsor accounting recovery still unavailable:",
                    e
                );
            } finally {
                inFlight = false;
            }
        };

        sponsorRecoveryInterval = setInterval(retry, SPONSOR_GIFT_HISTORY_POLL_MS);
    }

    async function restoreGiveawayFromSnapshot(snap) {
        if (!snap || !snap.giveawayData) return false;

        // Validate the live DarkPeers identity/Main Chat context BEFORE claiming
        // ownership or touching the recoverable snapshot. A transient/wrong chat
        // context must never destroy or mutate persisted giveaway state.
        cacheChatContext();
        const restoreHost = getLoggedInUsername();
        const restoreExpectedHost = String(snap.giveawayData.host || "").trim();
        const restoreUserId = Math.floor(Number(OT_USER_ID));
        const restorePublicRoom = Math.floor(Number(OT_CHATROOM_ID));
        const restoreExpectedRoom = Math.floor(Number(DARKPEERS_MAIN_CHATROOM_ID));
        const restoreContextOk =
            !!restoreHost &&
            !!restoreExpectedHost &&
            normalizeUserKey(restoreHost) === normalizeUserKey(restoreExpectedHost) &&
            Number.isFinite(restoreUserId) &&
            restoreUserId > 0 &&
            Number.isFinite(restorePublicRoom) &&
            restorePublicRoom === restoreExpectedRoom &&
            !!OT_CSRF_TOKEN;

        if (!restoreContextOk) {
            console.warn(
                "[BON Giveaway] Restore deferred: DarkPeers identity/Main Chat context is not trustworthy.",
                {
                    restoreHost,
                    expectedHost: restoreExpectedHost,
                    userId: restoreUserId,
                    publicRoom: restorePublicRoom,
                    expectedRoom: restoreExpectedRoom,
                    csrf: !!OT_CSRF_TOKEN
                }
            );
            try {
                window.alert(
                    "BONanza recovery is preserved, but cannot be resumed because the authenticated DarkPeers/Main Chat context was not verified. " +
                    "Reload DarkPeers on Main Chat and try again."
                );
            } catch {}
            return false;
        }

        // Re-check and claim ownership before touching any in-memory state. The
        // caller already checks, but another tab can race us between those steps.
        if (!await acquireTabLock()) {
            console.info("[BON Giveaway] Restore cancelled: another tab owns the active giveaway lock.");
            return false;
        }

        try {
            // 1) Restore giveaway data
            giveawayData = snap.giveawayData;

            // Restore starts fail-closed for sponsor accounting. Entries and time
            // may resume, but BON mutation and settlement stay blocked until the
            // canonical Gift History reconciliation succeeds and is persisted.
            giveawayData.__sponsorAccountingVerified = false;

            giveawayData.__closingIntent =
                giveawayData.closingIntent === true ||
                giveawayData.closingNoticeSent === true ||
                giveawayData?.settlement?.committed === true ||
                giveawayData?.settlement?.phase === "settling";
            giveawayData.__closingNoticeSent = giveawayData.closingNoticeSent === true;
            giveawayData.__closingNoticeProgress =
                giveawayData.closingNoticeProgress &&
                typeof giveawayData.closingNoticeProgress === "object"
                    ? { ...giveawayData.closingNoticeProgress }
                    : null;
            giveawayData.sponsorGiftMessages = Array.isArray(giveawayData.sponsorGiftMessages)
                ? giveawayData.sponsorGiftMessages
                : [];
            const restoredHostWalletAtStart = Number(giveawayData.hostWalletAtStart);
            giveawayData.hostWalletAtStart = (
                Number.isFinite(restoredHostWalletAtStart) && restoredHostWalletAtStart >= 0
            ) ? Math.floor(restoredHostWalletAtStart) : null;
            // Old active snapshots must not expose a start-time draw. A committed
            // settlement must keep its exact draw so crash/reload recovery cannot
            // select a different winner.
            const committedSettlement = giveawayData.settlement &&
                giveawayData.settlement.committed === true;
            if (!committedSettlement) {
                giveawayData.winningNumber = null;
            } else if (Number.isFinite(Number(giveawayData.settlement.winningNumber))) {
                giveawayData.winningNumber = Number(giveawayData.settlement.winningNumber);
            }
            giveawayData.donationPercent = normalizeDonationPercent(giveawayData.donationPercent);
            if (donationPercentInput) donationPercentInput.value = String(giveawayData.donationPercent);
            updateDonationHint();

            // Recalculate timeLeft from the stored endTs. If it already expired
            // within the recovery grace, rebuild state first and settle immediately.
            giveawayData.timeLeft = Math.max(Math.ceil((giveawayData.endTs - Date.now()) / 1000), 0);
            // A committed settlement is permanently closed even when it came
            // from an early/manual !end before the original scheduled endTs.
            // Never reopen entries/timers after a crash in that state.
            const expiredOnRestore =
                committedSettlement ||
                giveawayData.__closingIntent === true ||
                giveawayData.__closingNoticeSent === true ||
                giveawayData.timeLeft <= 0 ||
                snap.__expiredAtLoad === true;

            // 2) Restore entries
            numberEntries.clear();
            numberTakenBy.clear();
            fancyNames.clear();
            if (Array.isArray(snap.entries)) {
                for (const [author, num] of snap.entries) {
                    numberEntries.set(author, num);
                }
            }
            if (Array.isArray(snap.takenBy)) {
                for (const [num, author] of snap.takenBy) {
                    numberTakenBy.set(num, author);
                }
            }
            if (Array.isArray(snap.fancyNameEntries)) {
                for (const [author, html] of snap.fancyNameEntries) {
                    fancyNames.set(author, html);
                }
            }

            // Restore the live-stat bookkeeping too. Without this, a reload would
            // make recordGiveawayStats() believe entries/sponsors had never been
            // counted and could increment them again at payout time.
            liveEnteredThisGiveaway.clear();
            liveSponsorSeenThisGiveaway.clear();
            liveSponsorTotalThisGiveaway.clear();

            if (snap.liveStats && typeof snap.liveStats === "object") {
                for (const key of (Array.isArray(snap.liveStats.entered) ? snap.liveStats.entered : [])) {
                    const normalized = normalizeUserKey(key);
                    if (normalized) liveEnteredThisGiveaway.add(normalized);
                }
                for (const key of (Array.isArray(snap.liveStats.sponsorSeen) ? snap.liveStats.sponsorSeen : [])) {
                    const normalized = normalizeUserKey(key);
                    if (normalized) liveSponsorSeenThisGiveaway.add(normalized);
                }
                for (const pair of (Array.isArray(snap.liveStats.sponsorTotals) ? snap.liveStats.sponsorTotals : [])) {
                    if (!Array.isArray(pair) || pair.length < 2) continue;
                    const key = normalizeUserKey(pair[0]);
                    const amount = Math.max(0, Math.floor(Number(pair[1]) || 0));
                    if (key && amount > 0) liveSponsorTotalThisGiveaway.set(key, amount);
                }
            } else {
                // Back-compat for a pre-1.2.1 snapshot. The old script flushed live
                // stats on unload, so seed the bookkeeping from the restored state to
                // avoid the much worse failure mode: double-counting everything.
                for (const author of numberEntries.keys()) {
                    const key = normalizeUserKey(author);
                    if (key) liveEnteredThisGiveaway.add(key);
                }
                if (giveawayData.sponsorContribs && typeof giveawayData.sponsorContribs === "object") {
                    for (const [name, rawAmount] of Object.entries(giveawayData.sponsorContribs)) {
                        const key = normalizeUserKey(name);
                        const amount = Math.max(0, Math.floor(Number(rawAmount) || 0));
                        if (!key || !amount) continue;
                        liveSponsorSeenThisGiveaway.add(key);
                        liveSponsorTotalThisGiveaway.set(key, (liveSponsorTotalThisGiveaway.get(key) || 0) + amount);
                    }
                }
            }

            // 3) Restore rigged mode
            riggedMode = !!snap.riggedMode;
            if (riggedMode) {
                if (rigBadge) { rigBadge.hidden = false; rigBadge.classList.add('rigged-pulse'); }
                if (bonanzaGiveawayFrame) bonanzaGiveawayFrame.classList.add('rigged');
            }
            updateRigToggleUI();

            // 4) Restore start time
            giveawayStartTime = snap.startTime ? new Date(snap.startTime) : new Date();

            lastKnownGiveawayHostKey = normUserKey(giveawayData.host) || lastKnownGiveawayHostKey;

            // 5) Lock form fields
            startButton.disabled = false;
            coinInput.disabled = true;
            startInput.disabled = true;
            endInput.disabled = true;
            timerInput.disabled = true;
            customMessageInput.disabled = true;
            if (donationPercentInput) donationPercentInput.disabled = true;
            winnersInput.disabled = true;
            if (scaleWinnersToggleInput) scaleWinnersToggleInput.disabled = true;
            if (maxScaledWinnersInput) maxScaledWinnersInput.disabled = true;
            if (scaleBonPerWinnerInput) scaleBonPerWinnerInput.disabled = true;
            remNumInput.disabled = true;
            reminderEvery.disabled = true;
            entriesWrapper.hidden = false;

            // 6) Update UI
            coinHeader.innerHTML = `${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON`;
            coinHeader.prepend(goldCoins.cloneNode(false));
            updateEntries();

            // 7) Re-establish chatbox reference
            if (chatbox == null) {
                chatbox = document.querySelector(`#${chatboxId}`);
            }
            cacheChatContext();

            // 8) Keep the Main Chat observer alive even after entries close.
            // Attach it before asking the API for a replay boundary. Messages that
            // arrive while that request is in flight are queued, then classified
            // once the server boundary is known.
            if (observer) { observer.disconnect(); observer = null; }
            beginChatReplayBoundaryCapture();
            addObserver(giveawayData);
            const localReplayCaptureStartedAt = Date.now();

            const replayBoundary = await getLatestMainChatReplayBoundary();
            if (replayBoundary && Number.isFinite(replayBoundary.ts)) {
                const resolutionMs = Math.max(1, Number(replayBoundary.resolutionMs) || 1);

                // Entries keep one source timestamp bucket fail-open. Replaying an
                // entry is recoverable; silently losing a fresh entry is worse.
                chatReplayIgnoreBeforeTs = replayBoundary.ts - resolutionMs;

                // Commands use the strict server boundary. A fresh command in the
                // same timestamp bucket may need to be re-sent, but a historical
                // !end / !addbon / time mutation must never be replayed.
                chatReplayCommandIgnoreBeforeTs = replayBoundary.ts;
            } else {
                // Preserve every entry that arrived while the API request was in
                // flight. Privileged commands still fail closed through the end of
                // the failed lookup and can simply be re-sent by host/staff.
                chatReplayIgnoreBeforeTs = localReplayCaptureStartedAt - 2000;
                chatReplayCommandIgnoreBeforeTs = Date.now();
            }
            finishChatReplayBoundaryCapture();

            setSponsorAccountingVerificationState(
                false,
                "Restored giveaway sponsor accounting is pending canonical Gift History reconciliation."
            );

            // 9) Re-start sponsor tracker
            if (sponsorsInterval) { clearInterval(sponsorsInterval); sponsorsInterval = null; }
            if (window.__activeTracker) window.__activeTracker = null;
            const savedTracker = (snap.sponsorTracker && typeof snap.sponsorTracker === "object") ? snap.sponsorTracker : null;
            const tracker = new SponsorTracker({
                chatroomId,
                giveawayStartTime,
                giveawayData,
                lastMsgId: savedTracker ? savedTracker.lastMsgId : 0,
                cursorInitialized: savedTracker ? !!savedTracker.cursorInitialized : false,
                giftHistoryClockOffsetMs: savedTracker
                    ? optionalFiniteNumber(savedTracker.giftHistoryClockOffsetMs)
                    : null,
                giftHistoryInitialized: savedTracker ? !!savedTracker.giftHistoryInitialized : false,
                giftHistorySeenKeys: savedTracker && Array.isArray(savedTracker.giftHistorySeenKeys)
                    ? savedTracker.giftHistorySeenKeys
                    : [],
                historyFallbackActive: savedTracker
                    ? (!!savedTracker.historyFallbackActive || !savedTracker.giftHistoryInitialized)
                    : true,
                maxAcceptedCreatedAtTs:
                    optionalFiniteNumber(giveawayData?.settlement?.cutoffTs) ??
                    (savedTracker ? optionalFiniteNumber(savedTracker.maxAcceptedCreatedAtTs) : null)
            });
            window.__activeTracker = tracker;

            // Rebuild sponsor accounting from persistent Gift History. If the
            // service is temporarily unavailable, keep entries/time alive but freeze
            // every pot mutation and settlement operation until canonical recovery.
            let sponsorAccountingReady = false;
            let sponsorReconciliation = null;
            try {
                sponsorReconciliation = await tracker.reconcileCanonicalSponsorAccounting({
                    repairStats: false
                });
                if (!snapshotGiveaway({ force: true, verifyWrite: true })) {
                    throw new Error("Canonical sponsor reconciliation could not be persisted safely.");
                }
                sponsorAccountingReady = true;
                setSponsorAccountingVerificationState(
                    true,
                    sponsorReconciliation.repaired
                        ? `Canonical pot repaired: ${fmtBONCurrency(sponsorReconciliation.previousPot)} -> ${fmtBONCurrency(sponsorReconciliation.canonicalPot)} BON.`
                        : "Persistent Gift History reconciliation succeeded."
                );

                if (sponsorReconciliation.repaired) {
                    coinHeader.innerHTML = `${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON`;
                    coinHeader.prepend(goldCoins.cloneNode(false));
                    try {
                        window.alert(
                            "BONanza repaired the active giveaway from persistent DarkPeers Gift History before resuming. " +
                            `Pot: ${fmtBONCurrency(sponsorReconciliation.previousPot)} -> ${fmtBONCurrency(sponsorReconciliation.canonicalPot)} BON.`
                        );
                    } catch {}
                }
            } catch (e) {
                sponsorAccountingReady = false;
                setSponsorAccountingVerificationState(
                    false,
                    `Persistent Gift History reconciliation unavailable: ${String(e?.message || e)}`
                );
                snapshotGiveaway({ force: true });
                scheduleSponsorAccountingRecovery(tracker, { expiredOnRestore });
            }

            let expiredLegacyBootstrap = Promise.resolve();
            if (sponsorAccountingReady) {
                if (savedTracker) {
                    // Current snapshots have a persisted cursor. For an expired restore,
                    // endGiveaway() performs the authoritative final poll itself.
                    if (!expiredOnRestore) tracker.poll().catch(console.error);
                } else {
                    // Legacy snapshots had no cursor. Bootstrap without replaying old
                    // gifts; this favors under-count + manual verification over duplicates.
                    const p = tracker.bootstrapCursor().catch(console.error);
                    if (expiredOnRestore) expiredLegacyBootstrap = p;
                }
                if (!expiredOnRestore) {
                    sponsorsInterval = setInterval(() => tracker.poll(), SPONSOR_GIFT_HISTORY_POLL_MS);
                }
            }

            // 10) Re-start countdown timer only for a still-active giveaway.
            if (!expiredOnRestore) {
                giveawayData.countdownTimerID = countdownTimer(countdownHeader, giveawayData);
            } else {
                giveawayData.countdownTimerID = null;
                countdownHeader.hidden = false;
                countdownHeader.textContent = "00:00";
            }

            // 11) Re-start pot updater only while active.
            if (!expiredOnRestore) {
                giveawayData.potUpdater = setInterval(() => {
                    coinHeader.innerHTML = `${fmtBONCurrency(cleanPotString(giveawayData.amount))} BON`;
                    coinHeader.prepend(goldCoins.cloneNode(false));
                }, 5000);
            } else {
                giveawayData.potUpdater = null;
            }

            // 12) Set up beforeunload guard
            window.onbeforeunload = function (e) {
                try {
                    flushStatsNow();
                    if (giveawayData && !giveawayData.__ending) snapshotGiveaway();
                } catch {}
                e.preventDefault();
                e.returnValue = "";
                return "";
            };

            // 13) Wire stop button
            startButton.textContent = "Stop";
            startButton.style.backgroundColor = "#b32525";
            startButton.title = "This will end the giveaway and send gifts to the winners";
            startButton.onclick = () => {
                logEvent("Giveaway stop requested", "Requested from UI Stop button.");
                endGiveaway();
            };

            logEvent(
                expiredOnRestore ? "Expired giveaway restored for settlement" : "Giveaway restored",
                `Recovered ${numberEntries.size} entries after page reload. Time left: ${parseTime(getGiveawayRemainingMs(giveawayData)) || "expired"}`
            );
            updateHostPanelUI();

            if (expiredOnRestore && sponsorAccountingReady) {
                Promise.resolve(expiredLegacyBootstrap).finally(() => {
                    setTimeout(() => {
                        if (giveawayData && !giveawayData.__ending) endGiveaway();
                    }, 0);
                });
            }

            return true;
        } catch (e) {
            console.error("Giveaway restore failed:", e);
            // Fail closed for every active snapshot, not just committed payouts.
            // A transient DOM/API/parse problem during reload must never erase the
            // only copy of entries, sponsor accounting or settlement checkpoints.
            console.warn(
                "[BON Giveaway] Active snapshot retained after restore failure for a later recovery attempt."
            );
            releaseTabLock();
            return false;
        }
    }







    function formatLogTimestamp(date = new Date()) {
        const pad = (n) => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function renderGiveawayLogPanel() {
        if (!giveawayLogContent) return;
        if (giveawayLogPanel) {
            giveawayLogPanel.style.display = GENERAL_SETTINGS.show_giveaway_log ? "block" : "none";
        }
        giveawayLogContent.textContent = giveawayLog.length ? giveawayLog.join("\n") : "No events yet.";
        giveawayLogContent.scrollTop = giveawayLogContent.scrollHeight;
    }

    function clearGiveawayLog() {
        giveawayLog.length = 0;
        renderGiveawayLogPanel();
    }

    async function copyGiveawayLogToClipboard() {
        const text = giveawayLog.join("\n");
        if (!text) return;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
        } catch {}

        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        ta.remove();
    }

    function logEvent(type, details = "") {
        const t = String(type || "Event").trim();
        const d = String(details || "").trim();
        const msg = d ? `${t}: ${d}` : t;
        giveawayLog.push(`[${formatLogTimestamp()}] ${msg}`);
        if (giveawayLog.length > 500) giveawayLog.splice(0, giveawayLog.length - 500);
        renderGiveawayLogPanel();
    }


    // ───────────────────────────────────────────────────────────
