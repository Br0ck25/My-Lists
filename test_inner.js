
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
    try {
      var metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', '#000000');
    } catch (e) {}
  }
  function toggleTheme() {
    var isDark = document.documentElement.classList.toggle('dark-theme');
    try {
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', isDark ? '#000000' : '#F2F2F7');
    } catch (e) {}
  }
  (function() {
    var p = location.pathname || '';
    var h = location.hash || '';
    var isDeep = (p.startsWith('/lists/') && p !== '/lists') || p.startsWith('/channels/') || h.startsWith('#/list?') || h.startsWith('#/item?');
    var tab = 'discover';
    if (isDeep) {
      tab = h.startsWith('#/item?') ? 'item-details' : 'list-details';
    } else {
      try {
        var s = localStorage.getItem('myListAddon:activeTab');
        if (s && s !== 'list-details' && s !== 'item-details') tab = s;
      } catch (e) {}
    }
    document.documentElement.setAttribute('data-initial-tab', tab);

    try {
      var catSub = localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
      document.documentElement.setAttribute('data-initial-catalogs-sub', catSub);
      var listSub = localStorage.getItem('myListAddon:listsSubmenu') || 'my-lists';
      document.documentElement.setAttribute('data-initial-lists-sub', listSub);
      var chSub = localStorage.getItem('myListAddon:channelsSubmenu') || 'my-channels';
      document.documentElement.setAttribute('data-initial-channels-sub', chSub);
      var setSub = localStorage.getItem('myListAddon:settingsSubmenu') || 'account';
      document.documentElement.setAttribute('data-initial-settings-sub', setSub);
      var discSub = localStorage.getItem('myListAddon:discoverSubmenu') || 'all';
      document.documentElement.setAttribute('data-initial-discover-sub', discSub);
    } catch (e) {}
  })();
