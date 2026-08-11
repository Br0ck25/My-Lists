<div class="tab-panel" data-tab-panel="settings" hidden>
  <!-- Settings Top Submenu Pills -->
  <div class="subnav-pills-bar" id="settingsSubnavBar">
    <button type="button" class="subnav-pill active" onclick="switchSettingsSubmenu('keys', this)"><span class="check-icon">&#x2713;</span> Keys &amp; Account</button>
    <button type="button" class="subnav-pill" onclick="switchSettingsSubmenu('backup', this)">&#x1F4BE; Presets &amp; Backup</button>
  </div>

  <!-- Submenu 2: Presets & Backup -->
  <div class="settings-subpanel" id="settingsSubBackup" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">My Presets <span class="badge" id="presetsCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Save your current setup as a named preset to reuse or download as a file.</p>
      <div class="row">
        <input type="text" id="presetNameInput" placeholder="Preset name (e.g. Home Cinema)">
        <button type="button" class="secondary" onclick="saveCurrentAsPreset()">Save preset</button>
      </div>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="document.getElementById('presetFileInput').click()">Upload preset file</button>
        <input type="file" id="presetFileInput" accept="application/json,.json" style="display:none;" onchange="uploadPresetFile(this)">
      </div>
      <div id="presetsList" style="margin-top:10px;"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Backup &amp; Restore</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Export your complete setup as JSON or import an existing configuration.</p>
      <textarea id="configJsonBox" rows="5" style="width:100%;font-family:monospace;font-size:14px;" placeholder="Paste config JSON here to restore..."></textarea>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" onclick="exportConfigJson()">Export current</button>
        <button type="button" class="secondary lc-btn" onclick="importConfigJson()">Import JSON</button>
        <button type="button" class="secondary lc-btn" onclick="downloadConfigJson()">Download file</button>
        <button type="button" class="secondary lc-btn" onclick="document.getElementById('configFileInput').click()">Upload file</button>
        <input type="file" id="configFileInput" accept="application/json,.json" style="display:none;" onchange="uploadConfigFile(this)">
      </div>

      <div style="margin-top:16px; border-top:1px solid var(--border); padding-top:12px;">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.88rem;">Import from Install / Configure Link:</p>
        <div class="row">
          <input type="text" id="importLinkInput" placeholder="Paste an install or configure link here">
          <button type="button" class="secondary" onclick="importFromLink()">Import link</button>
        </div>
      </div>
    </div>
  </div>