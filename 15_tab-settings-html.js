  <!-- Submenu 1: Account & Sync -->
  <div class="settings-subpanel" id="settingsSubAccount">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Watchlist Preferences</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Customize how watched movies and TV shows are managed in your personal Watchlist.</p>
      <div id="watchlistPreferencesSection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Hidden Lists</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Hide specific lists from My Lists, Airing Next, and Simkl Airing Next. A hidden list is still tracked and updated normally underneath -- only its display is suppressed, and it can be shown again here at any time.</p>
      <div id="hiddenListsSettingsSection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Region</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Used for streaming-availability catalogs (Netflix, Disney+, etc.), Stream Releases, and content ratings -- so what shows up actually matches what's available where you are.</p>
      <select id="regionSelect" onchange="localStorage.setItem('myListAddon:region', this.value); saveState();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
        ${buildRegionOptionsHtml(initialRegion)}
      </select>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Trending &amp; Popular Catalogs</h2>
      <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; font-size:0.92rem; user-select:none;">
        <input type="checkbox" id="hideNonDigitalReleasesCheckbox" ${initialHideNonDigitalReleases ? 'checked' : ''} onchange="localStorage.setItem('myListAddon:hideNonDigitalReleases', this.checked ? '1' : '0'); saveState()" style="margin-top:2px; cursor:pointer; width:16px; height:16px;">
        <div>
          <span style="font-weight:600;">Hide items with no digital release</span>
          <p style="margin:4px 0 0; color:var(--muted); font-size:0.82rem;">Removes movies with no known digital or physical release from TMDB Trending Movies and Popular Movies catalogs -- useful for skipping still-in-theaters titles you can't stream or buy yet. Shows aren't affected (no equivalent release-type data exists for TV). Requires Save/Update to take effect on an existing install link.</p>
        </div>
      </label>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Watch History</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Reset or clear all recorded movies and episodes from your personal Watch History.</p>
      <div id="watchHistorySettingsSection">
        <button type="button" class="secondary lc-btn" onclick="clearWatchHistoryAll()" style="color:var(--danger); border-color:rgba(255,59,48,0.3); font-weight:600; padding:8px 16px;">Clear Watch History</button>
      </div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Auto-Track &amp; Media Server Scrobbling</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:0.85rem;">Automatically scrobble and track watched movies and TV episodes across your streaming apps (Stremio, Nuvio, Wako, etc.) and home media servers (Plex, Jellyfin, Emby) into your personal Watch History and Continue Watching.</p>
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
            <input type="text" id="tmdbKeyInput" placeholder="Optional: TMDB API Key (v3) or Read Access Token (v4)" value="${initialTmdbKey}" oninput="if(this.value.trim()){try{localStorage.removeItem('myListAddon:tmdbDisconnected');}catch(e){}} saveState(); onTmdbKeyInputChanged();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            <p style="margin-top:4px;"><small>Get a free TMDB API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:var(--accent-2);">themoviedb.org/settings/api</a>.</small></p>
          </div>
        </details>
      </div>

      <!-- Trakt Section -->
      <div id="traktSection" style="padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">Trakt</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your Trakt account to import your personal lists, watchlist, and collection, or use a custom Client ID.</p>
        <div class="actions trakt-connect-actions">
          <button type="button" class="secondary" id="traktConnectBtn" onclick="startTraktConnect()">Connect Trakt Account</button>
          <button type="button" class="secondary" id="traktDeviceBtn" onclick="startTraktDeviceLogin()">Connect with PIN / Code</button>
          <button type="button" class="secondary" id="traktDisconnectBtn" style="display:none;" onclick="disconnectTrakt()">Disconnect</button>
        </div>
        <p id="traktConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <div id="traktSyncHistoryWrap" style="margin:10px 0; padding:10px 12px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid var(--border);">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0;">
            <input type="checkbox" id="syncTraktHistoryCheckbox" onchange="toggleProviderHistorySync('trakt', this.checked)" style="width:16px; height:16px; cursor:pointer;">
            <span style="font-weight:600;">Sync Watch History to Trakt</span>
          </label>
          <p style="margin:4px 0 8px 24px; color:var(--muted); font-size:0.78rem;">Automatically sync items marked as watched or played to your Trakt account history.</p>
          <div style="margin-left:24px;">
            <button type="button" class="secondary lc-btn" id="syncTraktHistoryNowBtn" onclick="syncWatchHistoryToProviderNow('trakt', this)" style="padding:4px 10px; font-size:0.8rem;">Sync Current Watch History Now</button>
          </div>
        </div>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom Trakt Client ID & Username</summary>
          <div style="margin-top:8px;">
            <div class="row">
              <input type="text" id="traktKeyInput" placeholder="Optional: Trakt Client ID" value="${initialTraktKey}" oninput="if(this.value.trim()){try{localStorage.removeItem('myListAddon:traktDisconnected');}catch(e){}} saveState(); scheduleMyTraktListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            </div>
            <div class="row" style="margin-top:8px;">
              <input type="text" id="traktUsernameInput" placeholder="Optional: Trakt username" value="${initialTraktUsername}" oninput="if(this.value.trim()){try{localStorage.removeItem('myListAddon:traktDisconnected');}catch(e){}} saveState(); scheduleMyTraktListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            </div>
            <p style="margin-top:4px;"><small>Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" style="color:var(--accent-2);">trakt.tv/oauth/applications</a>.</small></p>
          </div>
        </details>
      </div>

      <!-- MDBList Section -->
      <div id="mdblistSection" style="padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--border);">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">MDBList</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your MDBList account to import your personal lists, watchlist, and watch history, or use a custom API key.</p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button type="button" class="secondary" id="mdblistConnectBtn" onclick="startMdblistConnect()">Connect MDBList Account</button>
          <button type="button" class="secondary" id="mdblistDisconnectBtn" style="display:none;" onclick="disconnectMdblist()">Disconnect</button>
        </div>
        <p id="mdblistConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <div id="mdblistSyncHistoryWrap" style="margin:10px 0; padding:10px 12px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid var(--border);">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0;">
            <input type="checkbox" id="syncMdblistHistoryCheckbox" onchange="toggleProviderHistorySync('mdblist', this.checked)" style="width:16px; height:16px; cursor:pointer;">
            <span style="font-weight:600;">Sync Watch History to MDBList</span>
          </label>
          <p style="margin:4px 0 8px 24px; color:var(--muted); font-size:0.78rem;">Automatically sync items marked as watched or played to your MDBList account history.</p>
          <div style="margin-left:24px;">
            <button type="button" class="secondary lc-btn" id="syncMdblistHistoryNowBtn" onclick="syncWatchHistoryToProviderNow('mdblist', this)" style="padding:4px 10px; font-size:0.8rem;">Sync Current Watch History Now</button>
          </div>
        </div>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom MDBList API Key</summary>
          <div style="margin-top:8px;">
            <input type="text" id="mdblistKeyInput" placeholder="Optional: MDBList API key" value="${initialMdblistKey}" oninput="if(this.value.trim()){try{localStorage.removeItem('myListAddon:mdblistDisconnected');}catch(e){}} saveState(); scheduleMyMdblistListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            <p style="margin-top:4px;"><small>Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" style="color:var(--accent-2);">mdblist.com/preferences</a>.</small></p>
          </div>
        </details>
      </div>

      <!-- Simkl Section -->
      <div id="simklSection" style="padding-bottom:14px; margin-bottom:14px;">
        <p style="margin:0 0 6px; font-weight:700; font-size:0.92rem;">Simkl</p>
        <p style="margin:0 0 10px; color:var(--muted); font-size:0.83rem;">Connect your Simkl account to import your personal lists, watchlist, and history, or use a custom Client ID.</p>
        <div class="actions" style="flex-direction:row; width:auto; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button type="button" class="secondary" id="simklConnectBtn" onclick="startSimklConnect()">Connect Simkl Account</button>
          <button type="button" class="secondary" id="simklDisconnectBtn" style="display:none;" onclick="disconnectSimkl()">Disconnect</button>
        </div>
        <p id="simklConnectStatus" style="margin:0 0 10px; font-size:0.85rem;"></p>
        <div id="simklSyncHistoryWrap" style="margin:10px 0; padding:10px 12px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid var(--border);">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.86rem; user-select:none; margin:0;">
            <input type="checkbox" id="syncSimklHistoryCheckbox" onchange="toggleProviderHistorySync('simkl', this.checked)" style="width:16px; height:16px; cursor:pointer;">
            <span style="font-weight:600;">Sync Watch History to Simkl</span>
          </label>
          <p style="margin:4px 0 8px 24px; color:var(--muted); font-size:0.78rem;">Automatically sync items marked as watched or played to your Simkl account history.</p>
          <div style="margin-left:24px;">
            <button type="button" class="secondary lc-btn" id="syncSimklHistoryNowBtn" onclick="syncWatchHistoryToProviderNow('simkl', this)" style="padding:4px 10px; font-size:0.8rem;">Sync Current Watch History Now</button>
          </div>
        </div>
        <details style="font-size:0.85rem; color:var(--muted);">
          <summary style="cursor:pointer; color:var(--text);">Advanced: Custom Simkl Client ID</summary>
          <div style="margin-top:8px;">
            <input type="text" id="simklKeyInput" placeholder="Optional: Simkl Client ID" value="${initialSimklKey}" oninput="if(this.value.trim()){try{localStorage.removeItem('myListAddon:simklDisconnected');}catch(e){}} saveState(); scheduleMySimklListsRefresh();" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--text);">
            <p style="margin-top:4px;"><small>Create a free Simkl Client ID at <a href="https://simkl.com/settings/developer/" target="_blank" style="color:var(--accent-2);">simkl.com/settings/developer/</a>.</small></p>
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

  <!-- Submenu 3: Feedback & Support -->
  <div class="settings-subpanel" id="settingsSubFeedback" style="display:none;">
    <div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <div>
          <h2 class="panel-title" style="margin:0;">Support &amp; Developer Chat</h2>
          <p style="margin:4px 0 0; color:var(--muted); font-size:0.85rem;">Have a question, found a bug, or have a suggestion? Chat directly with the developer.</p>
        </div>
        <button type="button" class="secondary lc-btn" id="btnNewFeedbackTicket" onclick="toggleNewFeedbackForm(true)" style="padding:6px 14px; font-size:0.85rem;">+ New Message</button>
      </div>

      <!-- Active Threads Selector -->
      <div id="supportThreadsBar" class="support-threads-bar" style="display:none; margin-bottom:12px;"></div>

      <!-- Chat View -->
      <div id="supportChatView" style="display:none;">
        <div id="supportMessagesStream" class="support-messages-stream"></div>
        <div class="support-reply-composer" style="margin-top:10px;">
          <textarea id="supportReplyInput" placeholder="Type a reply to the developer..." onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendUserFeedbackReply();}"></textarea>
          <button type="button" class="primary lc-btn" id="supportReplySendBtn" onclick="sendUserFeedbackReply()" style="min-height:44px; padding:0 20px;">Send</button>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
          <span id="supportChatStatus" style="font-size:0.8rem; color:var(--muted);"></span>
          <button type="button" class="secondary lc-btn" onclick="refreshUserFeedbackThreads()" style="padding:2px 8px; font-size:0.75rem; border:none; background:none; color:var(--muted); cursor:pointer;">&#x21BB; Refresh</button>
        </div>
      </div>

      <!-- New Message / Initial Form -->
      <div id="newFeedbackFormWrap">
        <div class="row">
          <label style="font-size:0.85rem; font-weight:600; color:var(--text); margin-bottom:2px;">Category</label>
          <select id="feedbackCategorySelect">
            <option value="bug">Bug Report</option>
            <option value="improvement">Improvement / Feature Request</option>
            <option value="idea">Idea / Suggestion</option>
            <option value="other">General Question / Other</option>
          </select>
        </div>
        <div class="row" style="margin-top:8px;">
          <label style="font-size:0.85rem; font-weight:600; color:var(--text); margin-bottom:2px;">Message</label>
          <textarea id="feedbackMessageInput" rows="4" style="width:100%;" placeholder="What would you like help with or what did you find?"></textarea>
        </div>
        <div class="row" style="margin-top:8px;">
          <label style="font-size:0.85rem; font-weight:600; color:var(--text); margin-bottom:2px;">Contact Info (optional)</label>
          <input type="text" id="feedbackContactInput" placeholder="Email, Discord username, etc. (optional)">
        </div>
        <div class="actions" style="margin-top:10px; gap:8px; justify-content:flex-start;">
          <button type="button" class="primary lc-btn" id="feedbackSubmitBtn" onclick="submitFeedback()">Send Message</button>
          <button type="button" class="secondary lc-btn" id="feedbackCancelNewBtn" style="display:none;" onclick="toggleNewFeedbackForm(false)">Cancel</button>
        </div>
        <p id="feedbackStatus" style="margin-top:8px; font-size:0.85rem;"></p>
      </div>
    </div>

    <!-- Support & Recommended Debrid Section -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Support &amp; Recommended Debrid</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Support the continued development and hosting of My Lists Addon, or sign up for TorBox debrid using our referral link.</p>
      <div class="actions" style="flex-direction:row; width:auto; gap:10px; flex-wrap:wrap;">
        <a href="https://buymeacoffee.com/brock25" target="_blank" rel="noopener" class="lc-btn primary" style="display:inline-flex; align-items:center; gap:8px; text-decoration:none; padding:10px 20px; font-weight:700; font-size:0.92rem; border-radius:var(--radius-pill);">Buy me a coffee</a>
        <a href="https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1" target="_blank" rel="noopener" class="lc-btn secondary" style="display:inline-flex; align-items:center; gap:8px; text-decoration:none; padding:10px 20px; font-weight:700; font-size:0.92rem; border-radius:var(--radius-pill); border-color:rgba(0,122,255,0.4); color:#ffffff;">Try TorBox Debrid (Referral)</a>
      </div>
    </div>
  </div>
</div>
</div>


