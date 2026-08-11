  <!-- Submenu 1: Keys & Account -->
  <div class="settings-subpanel" id="settingsSubKeys">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Auto-Track Playback</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Automatically marks episodes and movies as watched the moment you start playing them in Stremio or wako &mdash; from any addon, not just this one. Works by declaring a subtitles resource that Stremio/wako call whenever any video starts playing; this addon returns no real subtitles, it just uses that request as a "just started playing" signal.</p>
      <div id="trackPlaybackSection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Your API Keys (Optional)</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">These are yours alone &mdash; they're baked into your install link, not stored on any server.</p>

      <div class="row">
        <input type="text" id="mdblistKeyInput" placeholder="MDBList API key — needed for private lists / your watchlist" value="${initialMdblistKey}" oninput="saveState(); scheduleMyMdblistListsRefresh();">
      </div>
      <p><small>Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" style="color:var(--accent-2);">mdblist.com/preferences</a>.</small></p>

      <div class="row" style="margin-top:14px;">
        <input type="text" id="traktKeyInput" placeholder="Trakt Client ID — for searching Trakt and importing your lists" value="${initialTraktKey}" oninput="saveState(); scheduleMyTraktListsRefresh();">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="traktUsernameInput" placeholder="Trakt username — to show your personal lists" value="${initialTraktUsername}" oninput="saveState(); scheduleMyTraktListsRefresh();">
      </div>
      <p><small>Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" style="color:var(--accent-2);">trakt.tv/oauth/applications</a>.</small></p>

      <div id="traktConnectSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Private Trakt Lists</p>
        <p><small>Connect your Trakt account to pull in private watchlists and lists. Only asks for read access.</small></p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap;">
          <button type="button" class="secondary" id="traktConnectBtn" onclick="startTraktConnect()">Connect Trakt</button>
          <button type="button" class="secondary" id="traktDisconnectBtn" style="display:none;" onclick="disconnectTrakt()">Disconnect</button>
        </div>
        <p id="traktConnectStatus" style="margin-top:8px;"></p>
      </div>

      <div id="traktExportImportSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Import from Trakt VIP Export</p>
        <p><small>Upload your Trakt VIP .zip export (history, watchlist, ratings) to convert into a Custom List locally in your browser.</small></p>
        <div class="row" style="margin-top:8px;">
          <input type="file" id="traktExportFileInput" accept=".zip">
        </div>
        <div id="traktExportImportResult"></div>
      </div>

      <div id="letterboxdExportImportSection" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
        <p style="margin:0 0 8px; font-weight:700; font-size:0.9rem;">Import from Letterboxd Export</p>
        <p><small>Upload your Letterboxd .zip export (watched, watchlist, diary, ratings). The addon will resolve them via TMDB to create a Custom List.</small></p>
        <div class="row" style="margin-top:8px;">
          <input type="file" id="letterboxdExportFileInput" accept=".zip">
        </div>
        <div id="letterboxdExportImportResult"></div>
      </div>
    </div>
  </div>
</div>
</div>
