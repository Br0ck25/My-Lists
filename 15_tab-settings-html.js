  <!-- Submenu 1: Account & Sync -->
  <div class="settings-subpanel" id="settingsSubAccount">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Auto-Track Playback</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Automatically marks episodes and movies as watched the moment you start playing them in Stremio or wako &mdash; from any addon, not just this one. Works by declaring a subtitles resource that Stremio/wako call whenever any video starts playing; this addon returns no real subtitles, it just uses that request as a "just started playing" signal.</p>
      <div id="trackPlaybackSection"></div>
    </div>
  </div>

  <!-- Submenu 2: External Accounts & API Keys -->
  <div class="settings-subpanel" id="settingsSubExternal" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">External Accounts &amp; API Keys</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Connect your external service accounts and API keys. When signed in to your Creator Profile, your connected accounts stay synchronized across devices and logouts.</p>

      <!-- TMDB Section -->
      <div id="tmdbSection" style="padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">The Movie Database (TMDB)</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your TMDB account to import your personal lists, watchlist, and favorites, or use a custom API key / Token.</p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button type="button" class="secondary" id="tmdbConnectBtn" onclick="startTmdbConnect()">Connect TMDB Account</button>
          <button type="button" class="secondary" id="tmdbDisconnectBtn" style="display:none;" onclick="disconnectTmdb()">Disconnect</button>
        </div>
        <p id="tmdbConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom TMDB API Key / Token</summary>
          <div style="margin-top:8px;">
            <input type="text" id="tmdbKeyInput" placeholder="Optional: TMDB API Key (v3) or Read Access Token (v4)" value="${initialTmdbKey}" oninput="saveState(); onTmdbKeyInputChanged();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            <p style="margin-top:4px;"><small>Get a free TMDB API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:var(--accent-2);">themoviedb.org/settings/api</a>.</small></p>
          </div>
        </details>
      </div>

      <!-- Trakt Section -->
      <div id="traktSection" style="padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">Trakt</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your Trakt account to import your personal lists, watchlist, and collection, or use a custom Client ID.</p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button type="button" class="secondary" id="traktConnectBtn" onclick="startTraktConnect()">Connect Trakt Account</button>
          <button type="button" class="secondary" id="traktDisconnectBtn" style="display:none;" onclick="disconnectTrakt()">Disconnect</button>
        </div>
        <p id="traktConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom Trakt Client ID & Username</summary>
          <div style="margin-top:8px;">
            <div class="row">
              <input type="text" id="traktKeyInput" placeholder="Optional: Trakt Client ID" value="${initialTraktKey}" oninput="saveState(); scheduleMyTraktListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            </div>
            <div class="row" style="margin-top:8px;">
              <input type="text" id="traktUsernameInput" placeholder="Optional: Trakt username" value="${initialTraktUsername}" oninput="saveState(); scheduleMyTraktListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            </div>
            <p style="margin-top:4px;"><small>Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" style="color:var(--accent-2);">trakt.tv/oauth/applications</a>.</small></p>
          </div>
        </details>
      </div>

      <!-- MDBList Section -->
      <div id="mdblistSection" style="padding-bottom:14px; margin-bottom:14px;">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">MDBList</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your MDBList account to import your personal lists, watchlist, and watch history, or use a custom API key.</p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button type="button" class="secondary" id="mdblistConnectBtn" onclick="startMdblistConnect()">Connect MDBList Account</button>
          <button type="button" class="secondary" id="mdblistDisconnectBtn" style="display:none;" onclick="disconnectMdblist()">Disconnect</button>
        </div>
        <p id="mdblistConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom MDBList API Key</summary>
          <div style="margin-top:8px;">
            <input type="text" id="mdblistKeyInput" placeholder="Optional: MDBList API key" value="${initialMdblistKey}" oninput="saveState(); scheduleMyMdblistListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            <p style="margin-top:4px;"><small>Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" style="color:var(--accent-2);">mdblist.com/preferences</a>.</small></p>
          </div>
        </details>
      </div>
    </div>

    <!-- Unified Import List Panel -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Import List</h2>
      <p style="margin:0 0 8px; color:var(--text); font-size:0.9rem;">Use the form below to import a file and have the items automatically imported to one of your account lists.</p>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.83rem;">We support CSV and JSON imports from sites like IMDb, Letterboxd, MovieLens, Trakt, Simkl and TMDB. You can also upload multiple files at once.</p>

      <div style="margin-bottom:12px;">
        <label for="importListSourceSelect" style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:6px; color:var(--text);">Source (optional)</label>
        <select id="importListSourceSelect" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:0.95rem;">
          <option value="auto">Auto-detect</option>
          <option value="imdb">IMDb</option>
          <option value="letterboxd">Letterboxd</option>
          <option value="movielens">MovieLens</option>
          <option value="trakt">Trakt</option>
          <option value="simkl">Simkl</option>
          <option value="tmdb">TMDB</option>
        </select>
      </div>

      <div style="margin-bottom:12px;">
        <label for="importTargetListSelect" style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:6px; color:var(--text);">Import to which list?</label>
        <select id="importTargetListSelect" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:0.95rem;" onchange="onImportTargetListChange()">
          <!-- Populated dynamically -->
        </select>
      </div>

      <div id="importNewListInputWrap" style="display:none; margin-bottom:12px;">
        <label for="importNewListNameInput" style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:6px; color:var(--text);">New List Name</label>
        <input type="text" id="importNewListNameInput" placeholder="e.g. My Favorite Movies" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-size:0.95rem;">
      </div>

      <div style="margin-bottom:14px;">
        <label style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:6px; color:var(--text);">Select file(s)</label>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <button type="button" class="secondary lc-btn" onclick="document.getElementById('unifiedImportFileInput').click()" style="padding:8px 16px;">Select files&hellip;</button>
          <input type="file" id="unifiedImportFileInput" multiple accept=".csv,.json,.zip,.txt" style="display:none;" onchange="onUnifiedImportFilesSelected(this)">
          <span id="unifiedImportSelectedCount" style="font-size:0.85rem; color:var(--muted);">No files selected</span>
        </div>
      </div>

      <div style="margin-bottom:14px; display:flex; flex-direction:column; gap:6px;">
        <label style="font-size:0.85rem; display:flex; align-items:center; gap:6px; color:var(--text); cursor:pointer;">
          <input type="checkbox" id="importAlsoMarkWatchedCheck">
          Also add watched items to Watch History (marks them watched)
        </label>
      </div>

      <div class="actions" style="margin-top:6px;">
        <button type="button" class="primary lc-btn" id="btnUnifiedImport" style="padding:10px 24px; font-size:0.95rem;" onclick="runUnifiedListImport()">Import</button>
      </div>

      <div id="unifiedImportResult" style="margin-top:12px;"></div>
    </div>
  </div>

  <!-- Submenu 3: Feedback -->
  <div class="settings-subpanel" id="settingsSubFeedback" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">Send Feedback</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Found a bug, have an idea, or want to see something improved? This goes straight to the developer.</p>
      <div class="row">
        <select id="feedbackCategorySelect">
          <option value="bug">Bug</option>
          <option value="improvement">Improvement</option>
          <option value="idea">Idea</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="row" style="margin-top:8px;">
        <textarea id="feedbackMessageInput" rows="5" style="width:100%;" placeholder="What's on your mind?"></textarea>
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="feedbackContactInput" placeholder="Contact info (optional) — email, Discord, etc., if you want a reply">
      </div>
      <div class="actions" style="margin-top:10px;">
        <button type="button" class="primary" id="feedbackSubmitBtn" onclick="submitFeedback()">Send feedback</button>
      </div>
      <p id="feedbackStatus" style="margin-top:8px;"></p>
    </div>
  </div>
</div>
</div>

