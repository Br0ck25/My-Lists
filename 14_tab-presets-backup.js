<div class="tab-panel" data-tab-panel="settings" hidden>
  <!-- Settings Top Submenu Pills -->
  <div class="subnav-pills-bar" id="settingsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="account" onclick="switchSettingsSubmenu('account', this)"><span class="check-icon">&#x2713;</span> Account &amp; Sync</button>
    <button type="button" class="subnav-pill" data-sub="external" onclick="switchSettingsSubmenu('external', this)">External Accounts &amp; API Keys</button>
    <button type="button" class="subnav-pill" data-sub="backup" onclick="switchSettingsSubmenu('backup', this)">Presets &amp; Backup</button>
    <button type="button" class="subnav-pill" data-sub="feedback" onclick="switchSettingsSubmenu('feedback', this)">Feedback and Support</button>
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
        <button type="button" class="secondary lc-btn" onclick="saveCurrentAsPreset()">Save preset</button>
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
      <div class="backup-actions-grid" style="margin-top:8px;">
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
          <button type="button" class="secondary lc-btn" onclick="importFromLink()">Import link</button>
        </div>
      </div>
    </div>

    <!-- Export Lists & History (Universal CSV / Trakt / Letterboxd / MDBList / Simkl) -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Export Lists &amp; History</h2>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem;">Export your Watch History, Continue Watching, and Custom Lists in standard CSV or JSON format for easy import into Trakt, Letterboxd, MDBList, Simkl, or IMDb.</p>
      
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:700; font-size:0.92rem; color:var(--text);">Watch History</div>
            <div style="font-size:0.8rem; color:var(--muted);">All watched movies, shows, and episodes with timestamps</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" onclick="exportDataToCsv('watch-history', 'trakt')">CSV (Trakt / Simkl)</button>
            <button type="button" class="secondary lc-btn" onclick="exportDataToCsv('watch-history', 'letterboxd')">CSV (Letterboxd)</button>
            <button type="button" class="secondary lc-btn" onclick="exportDataToCsv('watch-history', 'standard')">Universal CSV</button>
          </div>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:700; font-size:0.92rem; color:var(--text);">All Custom Lists &amp; Watchlist</div>
            <div style="font-size:0.8rem; color:var(--muted);">Export all created lists, watchlist, and continue watching items</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" onclick="exportDataToCsv('all-custom-lists', 'standard')">Export All (CSV)</button>
            <button type="button" class="secondary lc-btn" onclick="exportDataToJson('full-library')">Full Library (JSON)</button>
          </div>
        </div>
      </div>
    </div>
  </div>
