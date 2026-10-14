    // SECTION 4: UI Template Definitions
    // ───────────────────────────────────────────────────────────
    const frameHTML = `
<section
  id="bonanzaGiveawayFrame"
  class="panelV2"
  style="width:450px;height:90%;position:fixed;z-index:9999;inset:50px 150px auto auto;overflow:auto;border:1px solid black;"
  hidden
>
  <!-- HEADER -->
  <header class="panel__heading">
    <div class="button-holder no-space giveaway-header-top-row">
      <div class="button-left">
        <h4 class="panel__heading">
          <i class="fa-solid fa-gifts" style="padding:5px;"></i>
          ${SCRIPT_NAME}
          <small style="color:#aaa;margin-left:8px;font-size:0.8em;">v${SCRIPT_VERSION}</small>
        </h4>
      </div>
      <div class="button-right giveaway-header-actions">
        <button id="minimizeButton" class="form__button form__button--text giveaway-btn" style="background-color:#4e595f;" title="Minimize panel">
          <i class="fa-solid fa-window-minimize"></i>
        </button>
        <button id="closeButton" class="form__button form__button--text giveaway-btn" style="background-color:#4e595f;">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
    <div class="giveaway-header-actions__menu-row no-drag" data-no-drag="1">
      <button id="resetButton" class="form__button form__button--text giveaway-btn no-drag" data-no-drag="1" style="background-color:#b32525;">
        <i class="fa-solid fa-rotate-right"></i> Reset
      </button>
      <button id="giveawaySettingsBtn" class="form__button form__button--text giveaway-btn no-drag" data-no-drag="1" style="background-color:#ff6400;">
        <i class="fa-solid fa-gear"></i> Settings
      </button>
      <button id="commandsButton" class="form__button form__button--text giveaway-btn no-drag" data-no-drag="1" style="background-color:#ff9600;">
        <i class="fa-solid fa-list"></i> Commands
      </button>
    </div>
  </header>

  <!-- MAIN BODY -->
  <div class="panel__body" id="giveaway_body" style="display:flex; flex-direction:column; gap:10px;">

    <!-- Presets -->
    <div class="giveaway-presets-row" style="display:flex; align-items:center; justify-content:center; gap:6px; flex-wrap:wrap; margin:0;">
      <select id="presetSelect" class="form__text" style="width:auto; min-width:120px; max-width:180px; padding:3px 6px; font-size:12px;">
        <option value="">Presets</option>
      </select>
      <button type="button" id="presetLoadBtn" class="form__button form__button--text giveaway-btn no-drag" style="background-color:#2a7acc; font-size:11px; padding:3px 8px;" title="Load selected preset">
        <i class="fa-solid fa-folder-open"></i> Load
      </button>
      <button type="button" id="presetSaveBtn" class="form__button form__button--text giveaway-btn no-drag" style="background-color:#02B008; font-size:11px; padding:3px 8px;" title="Save current form as a preset">
        <i class="fa-solid fa-floppy-disk"></i> Save
      </button>
      <button type="button" id="presetDeleteBtn" class="form__button form__button--text giveaway-btn no-drag" style="background-color:#b32525; font-size:11px; padding:3px 8px;" title="Delete selected preset">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>

    <h1 id="coinHeader" class="panel__heading--centered"></h1>

    <form class="form" id="giveawayForm" style="display:flex;flex-flow:column;align-items:center;">
      <p class="form__group" style="max-width:35%;">
<input
  class="form__text"
  required
  id="giveawayAmount"
  inputmode="numeric"
  type="text"
>

        <label class="form__label form__label--floating" for="giveawayAmount">
          Giveaway Amount
        </label>
      </p>

      <div class="panel__body flex-row" style="justify-content:center; gap:20px;">
        ${
    [
        ['startNum', '1'],
        ['endNum', '50']
    ]
    .map(
        ([id, val]) => `
              <p class="form__group" style="width:20%;">
                <input
                  class="form__text"
                  required
                  id="${id}"
                  pattern="-?\\d+"
                  value="${val}"
                  inputmode="numeric"
                  type="text"
                  maxlength="9"
                >
                <label class="form__label form__label--floating" for="${id}">
                  ${id === 'startNum' ? 'Start #' : 'End #'}
                </label>
              </p>`
    )
    .join('')
    }
      </div>

      <!-- Giveaway length / reminders / winners row -->
      <div class="panel__body flex-row" style="justify-content:center; flex-wrap:wrap; gap:20px;">
        <!-- giveaway length -->
        <p class="form__group" style="width:28%;">
          <input
            class="form__text"
            required
            id="timerNum"
            type="number"
            inputmode="numeric"
            min="1"
            step="1"
            value="5"
            autocomplete="off"
          >
          <label class="form__label form__label--floating" for="timerNum">Time&nbsp;(min)</label>
        </p>

        <!-- reminders -->
        <p class="form__group" style="width:28%;">
          <input class="form__text" id="reminderNum" type="number" min="0" step="1" value="0" autocomplete="off">
          <label class="form__label form__label--floating"># Reminders</label>
        </p>

        <!-- cadence label -->
        <p class="form__group" style="width:28%;">
          <input class="form__text" id="reminderEvery" readonly tabindex="-1" style="cursor:default;">
          <label class="form__label form__label--floating">Every (min)</label>
        </p>
      </div>

      <!-- winners + max winners row -->
      <div class="panel__body flex-row giveaway-number-row giveaway-winners-row">
        <p class="form__group giveaway-number-col">
          <input
            class="form__text"
            type="number"
            id="winnersNum"
            min="1"
            max="${MAX_WINNERS}"
            step="1"
            value="1"
          >
          <label class="form__label form__label--floating" for="winnersNum"># Winners</label>
        </p>
        <p class="form__group giveaway-number-col" id="maxScaledWinnersGroup" style="display:none;">
          <input
            class="form__text"
            type="number"
            id="maxScaledWinnersNum"
            title="Hard cap: ${MAX_WINNERS}. Scaling can’t exceed this."
            min="1"
            max="${MAX_WINNERS}"
            step="1"
            value="1"
            disabled
          >
          <label class="form__label form__label--floating" for="maxScaledWinnersNum" title="Hard cap: ${MAX_WINNERS}. Scaling can’t exceed this.">Max Winners</label>
          <small id="maxScaledWinnersError" class="giveaway-inline-error" aria-live="polite"></small>
        </p>
        <p class="form__group giveaway-number-col" id="scaleBonPerWinnerGroup" style="display:none;">
          <input
            class="form__text"
            type="number"
            id="scaleBonPerWinnerNum"
            title="Additional BON required to unlock each extra winner. Leave empty to auto-calculate from the starting pot."
            min="1"
            step="1"
            placeholder="auto"
            disabled
          >
          <label class="form__label form__label--floating" for="scaleBonPerWinnerNum" title="Additional BON required to unlock each extra winner.">BON/+Winner</label>
        </p>
      </div>

      <div class="panel__body giveaway-custom-message-row" style="display:flex;justify-content:center;gap:20px;width:100%;">
        <p class="form__group" style="width:100%;">
          <input
            class="form__text"
            id="customMessage"
            type="text"
            maxlength="100"
            placeholder="Max 100 chars"
            value="${DEFAULT_CUSTOM_MESSAGE}"
          >
          <label class="form__label form__label--floating" for="customMessage">
            Custom Message
          </label>
        </p>
      </div>

      <!-- BON Pool contribution row -->
      <div class="panel__body giveaway-donation-row" style="display:flex;justify-content:center;align-items:center;gap:14px;width:100%;flex-wrap:wrap;">
        <p class="form__group" style="width:38%;margin:0;">
          <select class="form__select" id="donationPercent" title="Share of the final pot (host + sponsors) donated to the ${BONANZA.FUND_NAME}. 0% runs a standard giveaway.">
            ${BONANZA.PERCENT_OPTIONS.map(p => `<option value="${p}">${p}%</option>`).join('')}
          </select>
          <label class="form__label form__label--floating" for="donationPercent">${BONANZA.FUND_NAME} donation</label>
        </p>
        <small id="donationHint" style="flex:1;min-width:180px;color:#bbb;font-size:12px;line-height:1.3;"></small>
      </div>

      <p class="form__group" style="text-align:center;">
  <button
    type="button"
    id="startButton"
    class="form__button form__button--filled"
    style="background-color:#02B008;"
  >
    Start
  </button>
</p>
    </form>

    <!-- Countdown timer below the form, full width -->
    <h2 id="countdownHeader" class="panel__heading--centered" hidden
        style="display:block; width:100%; margin-top:10px; margin-bottom:10px; text-align:center;">
    </h2>

<!-- Entries table below the countdown -->
    <div id="entriesWrapper" class="data-table-wrapper" hidden
         style="width:100%; overflow-x:auto; margin-top:10px;">
      <table id="entriesTable" class="data-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead><tr><th>User</th><th>Entry #</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Winners / payout status -->
    <div id="winnersWrapper" class="data-table-wrapper" hidden
         style="width:100%; overflow-x:auto; margin-top:6px;">
      <table id="winnersTable" class="data-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead>
          <tr>
            <th>Winner</th>
            <th>Prize BON</th>
            <th>Gift</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <div id="giveawayLogPanel" class="data-table-wrapper" style="width:100%; margin-top:10px; display:none;">
      <h3 style="margin:0 0 6px 0; color:#ddd; font-size:14px;">Giveaway Log</h3>
      <pre id="giveawayLogContent" style="margin:0; max-height:160px; overflow:auto; background:#1f1f1f; color:#cfcfcf; border:1px solid #444; border-radius:4px; padding:8px; white-space:pre-wrap; word-break:break-word;">No events yet.</pre>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button type="button" id="copyGiveawayLogButton" class="form__button form__button--filled">Copy log</button>
        <button type="button" id="clearGiveawayLogButton" class="form__button form__button--filled" style="background:#7d3333;">Clear log</button>
      </div>
    </div>
  </div>

    <!-- End-of-giveaway statements -->
    <div id="bonanzaStatementRow" class="data-table-wrapper" style="width:100%; margin-top:10px; display:none;">
      <h3 style="margin:0 0 6px 0; color:#ddd; font-size:14px;">Giveaway statements</h3>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <select id="bonanzaStatementSelect" class="form__select" style="flex:1; min-width:200px;" title="The last ${STATEMENTS_KEEP} giveaway statements are kept on this browser."></select>
        <button type="button" id="bonanzaSaveStatementBtn" class="form__button form__button--filled" title="Download the selected statement as a .txt file">Save .txt</button>
        <button type="button" id="bonanzaCopyStatementBtn" class="form__button form__button--filled" style="background:#4e595f;" title="Copy the selected statement to the clipboard">Copy</button>
      </div>
    </div>

  <!-- SETTINGS MENU -->
  <div id="giveaway_settings_menu" class="giveaway_settings_menu" style="display:none">
    <div class="settings-menu-content">
      <div class="settings-group" aria-label="Entry Modes" data-settings-group="entry-modes" data-toggle-ids="randomToggle,luckyToggle,freeToggle">
        <div class="settings-group__header">
          <p class="settings-group__title">Entry Modes</p>
          <button type="button" class="form__button form__button--filled settings-section-toggle" data-settings-toggle="entry-modes" title="Toggle all options in Entry Modes only.">Toggle all</button>
        </div>
        ${[
            { label: 'Random', id: 'randomToggle', tip: 'Enable !random (enter with a random free number).' },
            { label: 'Lucky', id: 'luckyToggle', tip: 'Enable !lucky (show lucky #) and !luckye (enter with lucky #).' },
            { label: 'Free', id: 'freeToggle', tip: 'Enable !free (show some available numbers).' }
        ].map(({ label, id, tip }) => `
          <label class="settings-row" title="${tip}" for="${id}">
            <span class="settings-row__label">${label}</span>
            <input
              type="checkbox"
              id="${id}"
              title="${tip}"
              class="settings-row__toggle"
              checked
            >
          </label>`).join('')}
      </div>

      <div class="settings-group" aria-label="Chat and Replies" data-settings-group="chat-replies" data-toggle-ids="entryrepliesToggle,silentmodeToggle">
        <div class="settings-group__header">
          <p class="settings-group__title">Chat & Replies</p>
          <button type="button" class="form__button form__button--filled settings-section-toggle" data-settings-toggle="chat-replies" title="Toggle all options in Chat & Replies only.">Toggle all</button>
        </div>
        ${[
            { label: 'Entry Replies', id: 'entryrepliesToggle', tip: 'When enabled, the bot replies when an entry is logged. Disable to reduce chat spam.' },
            { label: 'Silent Mode', id: 'silentmodeToggle', tip: 'When enabled, command replies are sent privately via /msg instead of public chat.' }
        ].map(({ label, id, tip }) => `
          <label class="settings-row" title="${tip}" for="${id}">
            <span class="settings-row__label">${label}</span>
            <input
              type="checkbox"
              id="${id}"
              title="${tip}"
              class="settings-row__toggle"
              checked
            >
          </label>`).join('')}
      </div>

      <div class="settings-group" aria-label="Scaling and Rules" data-settings-group="scaling-rules" data-toggle-ids="scaleWinnersToggle,rigModeToggle,showgiveawaylogToggle">
        <div class="settings-group__header">
          <p class="settings-group__title">Scaling & Rules</p>
          <button type="button" class="form__button form__button--filled settings-section-toggle" data-settings-toggle="scaling-rules" title="Toggle all options in Scaling & Rules only.">Toggle all</button>
        </div>
        ${[
            { label: 'Scale Winners', id: 'scaleWinnersToggle', tip: 'When enabled, winners may increase based on sponsorship BON (up to the max set in the giveaway form).' },
            { label: 'Rigged mode (visual only)', id: 'rigModeToggle', tip: 'Rigged mode is purely cosmetic… allegedly.' },
            { label: 'Show Giveaway Log', id: 'showgiveawaylogToggle', tip: 'Only controls Giveaway Log panel visibility. Logging still continues in the background.' }
        ].map(({ label, id, tip }) => `
          <label class="settings-row" title="${tip}" for="${id}">
            <span class="settings-row__label">${label}</span>
            <input
              type="checkbox"
              id="${id}"
              title="${tip}"
              class="settings-row__toggle"
              checked
            >
          </label>`).join('')}
      </div>

      <div class="settings-group" aria-label="Safety and Testing" data-settings-group="safety-testing">
        <div class="settings-group__header">
          <p class="settings-group__title">Safety & Testing</p>
        </div>
        <label class="settings-row" title="Rehearsal/debug mode sends userscript output privately to the host and simulates all BON-moving actions. Changing it reloads the page." for="rehearsalModeToggle">
          <span class="settings-row__label">Rehearsal / Debug mode</span>
          <input
            type="checkbox"
            id="rehearsalModeToggle"
            title="Userscript output is sent privately to the host; no BON is transferred. Changing this setting reloads the page."
            class="settings-row__toggle"
          >
        </label>
      </div>
    </div>
  </div>

  <!-- COMMANDS MENU -->
  <div id="giveaway_commands_menu" class="commands-menu" style="display:none">
    <ul class="commands-list">
      <li class="section-label">General&nbsp;Commands</li>
      <li><code>!time&nbsp;</code>        <span class="desc">Show remaining time</span></li>
      <li><code>!entries&nbsp;</code>     <span class="desc">List all entries</span></li>
      <li><code>!free&nbsp;</code>        <span class="desc">Show free numbers</span></li>
      <li><code>!number&nbsp;</code>      <span class="desc">Show your entry</span></li>
      <li><code>!random&nbsp;</code>      <span class="desc">Enter with a random #</span></li>
      <li><code>!lucky&nbsp;</code>       <span class="desc">Show lucky number</span></li>
      <li><code>!luckye&nbsp;</code>      <span class="desc">Enter with lucky #</span></li>
      <li><code>!bon&nbsp;</code>         <span class="desc">Show pot amount</span></li>
      <li><code>!range&nbsp;</code>       <span class="desc">Show valid range</span></li>
      <li><code>!scale&nbsp;</code>      <span class="desc">Show scaling progress</span></li>
      <li><code>!help&nbsp;</code>        <span class="desc">Show this list in chat</span></li>
      <li><code>!stats&nbsp;[user]</code>   <span class="desc">Show saved stats</span></li>
      <li><code>!top&nbsp;[N]</code>       <span class="desc">Top winners (by wins)</span></li>
      <li><code>!most&nbsp;[N]</code>      <span class="desc">Most BON won (total)</span></li>
      <li><code>!sponsors&nbsp;[N]</code>  <span class="desc">Top sponsors</span></li>
      <li><code>!unlucky&nbsp;[N]</code>   <span class="desc">Most losses</span></li>

      <li class="section-label">Host or Staff Emergency Commands</li>
      <li class="full-span">
          <code>!time add&nbsp;N&nbsp;/&nbsp;remove&nbsp;N&nbsp;</code>
          <span class="desc">Adjust remaining minutes</span>
      </li>
      <li><code>!rig/!unrig&nbsp;</code>  <span class="desc">Toggle rigging (visual only)</span></li>
      <li><code>!end&nbsp;[host]</code>   <span class="desc">Host: !end. Staff: !end &lt;host&gt;</span></li>
      <li><code>!naughty&nbsp;</code>       <span class="desc">list/add/remove a user</span></li>
      <li class="naughty-alert">
        ⚠⚠ !naughty excludes users from the giveaway entirely ⚠⚠ ************************USE RESPONSIBLY************************
      </li>

      <li class="section-label">Host-Only&nbsp;Commands</li>
      <li><code>!reminder&nbsp;</code>    <span class="desc">Send reminder msg</span></li>
      <li><code>!addbon&nbsp;</code>      <span class="desc">Add BON to pot</span></li>
      <li><code>!winners&nbsp;N</code>    <span class="desc">Set number of winners</span></li>
      <li><code>!maxwinners&nbsp;N</code> <span class="desc">Set max scaled winners</span></li>
    </ul>
  </div>


  <!-- RIGGED WATERMARK (only visible in rigged mode) -->
  <div class="rigged-watermark">RIGGED</div>
</section>
`;

    const hostPanelHTML = `
<aside id="hostCommandPanel" class="host-command-panel" aria-hidden="true">
  <div id="hostCommandPanelHandle" class="host-command-panel__handle" title="Drag to move Host Panel">
    <span class="host-command-panel__handle-title">Host Panel</span>
    <button id="hostPanelCloseBtn" type="button" class="form__button form__button--text host-command-panel__close" title="Close Host Panel" aria-label="Close Host Panel">×</button>
  </div>
  <div id="hostCommandPanelBody" class="host-command-panel__body"></div>
</aside>
`;

    const baseMenuStyle = `
  background-color: #2C2C2C;
  color: #CCC;
  border-radius: 5px;
  position: absolute;
  top: 100px;
  right: 10px;
  z-index: 10020;
  padding: 15px;
  overflow: auto;
  flex-direction: column;
  justify-content: center;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
`;

    // Settings menu CSS styles
    const settingsMenuStyle = `
.giveaway_settings_menu {
  ${baseMenuStyle}
  width: 280px;
  height: auto;
  max-height: 72vh;
}
.giveaway_settings_menu > div {
  margin: 0;
}
.giveaway_settings_menu .settings-menu-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.giveaway_settings_menu .settings-group {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 7px;
}
.giveaway_settings_menu .settings-group:last-of-type {
  border-bottom: 0;
  padding-bottom: 0;
}
.giveaway_settings_menu .settings-group__title {
  margin: 0 0 4px;
  font-size: 12px;
  color: #ffa200;
  font-weight: 700;
}
.giveaway_settings_menu .settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 3px 0;
}
.giveaway_settings_menu .settings-row__label {
  color: #d7d7d7;
  font-size: 13px;
  line-height: 1.3;
}
.giveaway_settings_menu .settings-row__toggle {
  width: 15px;
  height: 15px;
  cursor: pointer;
  flex-shrink: 0;
}
.giveaway_settings_menu .settings-group__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.giveaway_settings_menu .settings-section-toggle {
  padding: 2px 8px;
  min-height: 24px;
  font-size: 11px;
  line-height: 1;
}`;

    // Commands menu CSS styles – shrink-wrap width, 2-column grid, section labels
    const commandsMenuStyle = `
.commands-menu{
  ${baseMenuStyle}
  width:max-content;
  max-width:425px;
  max-height:70vh;
}

/* ── compact two-column grid ───────────────────────────── */
.commands-menu .commands-list{
  list-style:none;
  padding:0;
  margin:0;
  display:grid;
  grid-template-columns:max-content 1fr;   /* code | description */
  column-gap:5px;
  row-gap:4px;
}

.commands-menu .full-span{
  grid-column: 1 / -1;      /* occupy the whole row */
 }

/* left column (command keyword) */
.commands-menu code{
  font-family:inherit;
  font-weight:600;
  color:#ffb84d;
  font-size:14px;
  white-space:nowrap;
}

/* right column (description) */
.commands-menu .desc{
  color:#d0d0d0;       /* dimmer grey */
  font-size:13px;
}

/* orange section headers that span both columns */
.commands-menu .section-label{
  grid-column:1 / -1;
  margin:6px 0 2px;
  font-size:14px;
  font-weight:700;
  color:#ffa200;
  border-bottom:1px solid #555;
}

/* full-width red banner for Naughty */
.commands-menu .naughty-alert{
  grid-column:1 / -1;    /* span both columns */
  background:#dc3d1d;
  color:#fff;
  font-size:13px;
  font-weight:600;
  padding:2px 6px;
  border-radius:4px;
  margin-top:2px;
}`;

    const hostPanelStyle = `
body.host-panel-dragging,
body.host-panel-dragging * {
  user-select: none !important;
}
.host-command-panel {
  box-sizing: border-box;
  position: fixed;
  top: 50px;
  right: auto;
  left: calc(100vw - clamp(320px, 26vw, 440px) - 16px);
  width: clamp(320px, 26vw, 440px);
  max-width: calc(100vw - 16px);
  height: calc(100vh - 66px);
  max-height: calc(100vh - 66px);
  border: 1px solid #000;
  border-radius: 6px;
  background-color: #2C2C2C;
  color: #CCC;
  z-index: 10030;
  overflow: hidden;
  display: none;
  pointer-events: auto;
}
.host-command-panel.open {
  display: block;
}
.host-command-panel,
.host-command-panel * {
  box-sizing: border-box;
}
.host-command-panel__handle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.18);
  background: rgba(0, 0, 0, 0.18);
  cursor: grab;
}
.host-command-panel.dragging .host-command-panel__handle {
  cursor: grabbing;
}
.host-command-panel__handle-title {
  font-size: 12px;
  color: #ffa200;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.host-command-panel__close {
  margin: 0;
  padding: 0 8px;
  min-width: 28px;
  min-height: 24px;
  line-height: 1;
  font-size: 18px;
  color: #fff;
}
.host-command-panel__body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  overflow-x: hidden;
  max-height: calc(100% - 40px);
  height: calc(100% - 40px);
  min-width: 0;
}
.host-command-panel__section {
  border-bottom: 1px solid rgba(255,255,255,0.09);
  padding-bottom: 8px;
  margin-bottom: 4px;
  min-width: 0;
}
.host-command-panel__section:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.host-command-panel__section-title {
  margin: 0 0 6px;
  font-size: 12px;
  color: #ffa200;
  font-weight: 700;
  white-space: normal;
  word-break: break-word;
}
.host-command-panel__virtual-bon {
  border: 1px solid rgba(255, 192, 10, 0.38);
  border-radius: 6px;
  background: rgba(255, 192, 10, 0.07);
  padding: 9px 10px;
  min-width: 0;
}
.host-command-panel__virtual-bon-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.host-command-panel__virtual-bon-label {
  color: #ffa200;
  font-size: 12px;
  font-weight: 700;
}
.host-command-panel__virtual-bon-value {
  color: #ffc00a;
  font-size: 15px;
  font-weight: 800;
  text-align: right;
}
.host-command-panel__virtual-bon-detail {
  display: block;
  margin-top: 3px;
  color: #aaa;
  font-size: 10px;
  line-height: 1.3;
}

.host-command-panel .host-command-panel__row {
  margin-bottom: 6px;
  min-width: 0;
}
.host-command-panel .hp-row {
  display:flex;
  flex-direction:column;
  min-width:0;
}
.host-command-panel .hp-row-main {
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  column-gap:12px;
  row-gap:4px;
  min-width:0;
}
.host-command-panel .hp-row-right {
  display:flex;
  flex-direction:column;
  min-width:0;
  flex:1 1 auto;
}
.host-command-panel .hp-row-fields {
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:6px;
  min-width:0;
}
.host-command-panel .host-command-panel__button-wrap {
  flex: 0 0 auto;
  min-width: 120px;
  width: 120px;
}
.host-command-panel .host-command-panel__arg-wrap {
  min-width: 0;
  flex: 0 1 auto;
}
.host-command-panel .host-command-panel__arg-wrap .command-input {
  width: clamp(90px, 11vw, 140px);
  min-width: 80px;
  max-width: 100%;
  min-height: 28px;
  box-sizing: border-box;
}
.host-command-panel .host-command-panel__arg-wrap .command-input.command-input--long {
  width: clamp(140px, 16vw, 220px);
  min-width: 120px;
  max-width: 100%;
  box-sizing: border-box;
}
.host-command-panel .hp-row-error {
  font-size: 11px;
  color: #ff6f6f;
  line-height: 1.15;
  min-width: 0;
  min-height: 13px;
  visibility: hidden;
  margin-top: 3px;
}
.host-command-panel .hp-row-error.visible {
  visibility: visible;
}
.host-command-panel .host-command-panel__button-wrap .form__button {
  width: 100%;
  max-width: 100%;
  min-height: 28px;
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 0 auto;
}
.host-command-panel .disabled-wrap {
  display: inline-flex;
  min-width: 0;
}`;



    // ───────────────────────────────────────────────────────────
