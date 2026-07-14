/* @skipi/plugin-host-ui
   Shared Apps/plugin-host UI layer extracted from Seafarer.
   Runtime isolation, pack verification and remote delivery live outside this module. */
(function(){
  'use strict';

  var DEFAULT_CATEGORIES = [
    { key:'safety', label:'Safety / Watchkeeping' },
    { key:'utils', label:'Utils' },
    { key:'education', label:'Education' },
    { key:'reports', label:'Reports' }
  ];
  var REMOTE_PLUGIN_STATE_KEY = 'skipi_remote_plugins_state';
  var LOCAL_PLUGIN_STATE_KEY = 'skipi_plugins_state';

  function create(deps){
    deps = deps || {};
    var esc = deps.esc || function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
    var escAttr = deps.escAttr || esc;
    var jsString = deps.jsString || function(s){ return String(s == null ? '' : s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,''); };
    var showToast = deps.showToast || function(){};
    var show = deps.show || function(id){ var el = (typeof document !== 'undefined') ? document.getElementById(id) : null; if(el) el.style.display = ''; };
    var updateTabs = deps.updateTabs || function(){};
    var shouldUseMobileShell = deps.shouldUseMobileShell || function(){ return false; };
    var plugins = Array.isArray(deps.plugins) ? deps.plugins : [];
    var categories = Array.isArray(deps.categories) ? deps.categories : DEFAULT_CATEGORIES;
    var homeName = deps.homeName || 'Skipi';
    var homeShortName = deps.homeShortName || 'Skipi';
    var homeId = deps.homeId || 'host';
    var pluginHostState = deps.pluginHostState || { selectedId:null, openId:null, surface:'launcher', openedFrom:null, search:'' };
    var __remoteCatalogCache = null;
    var __remoteCatalogFetchedAt = 0;
    var REMOTE_CATALOG_REFRESH_MS = 20000;

    function getUiLang(){
      if(typeof deps.getUiLang === 'function') return deps.getUiLang();
      try{ if(typeof window.getUiLang === 'function') return window.getUiLang(); }catch(e){}
      return 'en';
    }
    function mobileMainHtml(html){
      if(typeof deps.mobileMainHtml === 'function') return deps.mobileMainHtml(html);
      var main = (typeof document !== 'undefined') ? document.getElementById('mobile-main') : null;
      if(main) main.innerHTML = html || '';
    }
    function remoteConfig(){
      if(deps.remoteConfig && typeof deps.remoteConfig === 'object') return deps.remoteConfig;
      try{ if(window.SKIPI_REMOTE_CONFIG && typeof window.SKIPI_REMOTE_CONFIG === 'object') return window.SKIPI_REMOTE_CONFIG; }catch(e){}
      return { remoteSlugs:[] };
    }
    function pluginCategories(){
      return categories;
    }
    function bundledPluginById(id){
      return plugins.find(function(p){ return p && p.id === id; }) || null;
    }
    function remoteRegistryAll(){
      try{ return JSON.parse(localStorage.getItem(REMOTE_PLUGIN_STATE_KEY) || '{}') || {}; }catch(e){ return {}; }
    }
    function remoteStateSaveAll(s){
      try{ localStorage.setItem(REMOTE_PLUGIN_STATE_KEY, JSON.stringify(s || {})); }catch(e){}
    }
    function remoteInstalledMeta(id){
      var r = remoteRegistryAll()[id];
      return r && r.installed ? r : null;
    }
    function remotePermissionsFor(entry){
      var perms = (entry && entry.permissions) || [];
      return {
        server_access:false,
        documents_access:false,
        account_required:false,
        analytics:false,
        audio_alert:perms.indexOf('audio_alert') >= 0,
        local_only:true
      };
    }
    function remoteInstalledEntryFor(id){
      var rec = remoteInstalledMeta(id); if(!rec) return null;
      var entry = rec.entry || {};
      return {
        id:id,
        remote:true,
        firstParty:true,
        category:'utils',
        icon:'▦',
        name:rec.name || rec.title || entry.name || entry.title || id,
        short:'Installed remote first-party plugin · works offline after install',
        description:'Signed first-party plugin installed from the production catalog and cached locally for offline use.',
        safety_note:'Runs inside Skipi sandbox. Catalog signature, policy, compatibility and pack checksum are verified before install and before offline launch.',
        permissions:remotePermissionsFor(entry),
        version:rec.version || entry.version,
        toolCount:entry.toolCount || entry.tool_count || rec.toolCount || rec.tool_count
      };
    }
    function pluginById(id){
      return bundledPluginById(id) || remoteInstalledEntryFor(id) || null;
    }
    function pluginCatLabel(key){
      var c = pluginCategories().find(function(x){ return x.key === key; });
      return c ? c.label : key;
    }
    function pluginVersionValue(p){
      return p && p.version ? String(p.version) : '';
    }
    function pluginVersionLabel(p){
      var v = pluginVersionValue(p);
      return v ? 'v' + v : '';
    }
    function pluginToolCount(p){
      var n = p && (p.toolCount || p.tool_count);
      n = parseInt(n, 10);
      return isNaN(n) || n <= 0 ? 0 : n;
    }
    function pluginToolsLabel(p){
      var n = pluginToolCount(p);
      return n ? (n + ' ' + (n === 1 ? 'tool' : 'tools')) : '';
    }
    function pluginMetaParts(p){
      var out = [], v = pluginVersionLabel(p), t = pluginToolsLabel(p);
      if(v) out.push(v);
      if(t) out.push(t);
      return out;
    }
    function pluginMetaLine(p){
      return pluginMetaParts(p).join(' · ');
    }
    function pluginNameMetaLine(p){
      var meta = pluginMetaLine(p);
      return (p && p.name ? p.name : 'Plugin') + (meta ? ' · ' + meta : '');
    }
    function pluginSubLine(p){
      var a = [];
      if(p && p.short) a.push(p.short);
      var meta = pluginMetaLine(p);
      if(meta) a.push(meta);
      return a.join(' · ');
    }
    function semverParts(v){
      return String(v || '').split(/[.+-]/).slice(0,3).map(function(x){ var n = parseInt(x,10); return isNaN(n) ? 0 : n; });
    }
    function semverGt(a,b){
      var x = semverParts(a), y = semverParts(b);
      for(var i=0;i<3;i++){ if((x[i]||0) > (y[i]||0)) return true; if((x[i]||0) < (y[i]||0)) return false; }
      return false;
    }
    function pluginNowIso(){
      try{ return new Date().toISOString(); }catch(e){ return ''; }
    }
    function pluginStateAll(){
      try{ return JSON.parse(localStorage.getItem(LOCAL_PLUGIN_STATE_KEY) || '{}'); }catch(e){ return {}; }
    }
    function pluginStateSaveAll(s){
      try{ localStorage.setItem(LOCAL_PLUGIN_STATE_KEY, JSON.stringify(s)); }catch(e){}
    }
    function pluginSetState(id, patch){
      var all = pluginStateAll();
      all[id] = Object.assign({}, all[id] || {}, patch);
      pluginStateSaveAll(all);
    }
    function pluginGetState(id){
      var s = pluginStateAll()[id] || {};
      if(bundledPluginById(id)) return { installed:s.installed !== false, enabled:s.enabled !== false };
      var r = remoteInstalledMeta(id);
      if(r) return { installed:true, enabled:r.enabled !== false };
      return { installed:!!s.installed, enabled:s.enabled !== false };
    }
    function pluginStatus(id){
      var st = pluginGetState(id);
      if(!st.installed) return 'available';
      return st.enabled ? 'installed' : 'disabled';
    }
    function remoteStagingOn(){
      if(Object.prototype.hasOwnProperty.call(deps, 'featureRemoteDelivery')) return !!deps.featureRemoteDelivery;
      try{ return !!window.FEATURE_REMOTE_PLUGIN_DELIVERY; }catch(e){ return false; }
    }
    function remoteStagingSlugs(){
      if(!remoteStagingOn()) return [];
      var cfg = remoteConfig(), slugs = cfg.remoteSlugs || [];
      return slugs.filter(function(s){ return !bundledPluginById(s); });
    }
    function remoteConfiguredSlug(slug){
      var cfg = remoteConfig();
      return ((cfg && cfg.remoteSlugs) || []).indexOf(slug) >= 0;
    }
    function remoteCatalogName(slug){
      if(__remoteCatalogCache){
        var e = __remoteCatalogCache.find(function(p){ return p.slug === slug; });
        if(e && (e.name || e.title)) return e.name || e.title;
      }
      return null;
    }
    function remoteCatalogEntry(slug){
      if(__remoteCatalogCache) return __remoteCatalogCache.find(function(p){ return p.slug === slug; }) || null;
      return null;
    }
    function remoteCatalogVersion(slug){
      var e = remoteCatalogEntry(slug) || {};
      return e.version || '';
    }
    function remoteUpdateAvailable(slug){
      if(!remoteStagingOn()) return false;
      if(!remoteConfiguredSlug(slug)) return false;
      var installed = remoteInstalledEntryFor(slug);
      var bundled = bundledPluginById(slug);
      var baseline = installed ? installed.version : '';
      if(bundled && bundled.version && (!baseline || semverGt(bundled.version, baseline))) baseline = bundled.version;
      if(!baseline) return false;
      var latest = remoteCatalogVersion(slug);
      return !!latest && semverGt(latest, baseline);
    }
    function remoteUpdateActionHtml(slug){
      if(!remoteUpdateAvailable(slug)) return '';
      var ru = getUiLang() === 'ru';
      return ' <button class="btn btn-accent btn-sm" type="button" data-qa="remote-plugin-update-'+escAttr(slug)+'" onclick="pluginRemoteUpdate(\''+jsString(slug)+'\')">'+esc(ru?'Обновить':'Update')+'</button>';
    }
    function pluginRemoteUpdate(slug){
      var ru = getUiLang() === 'ru';
      var bundled = bundledPluginById(slug), hadRemote = !!remoteInstalledMeta(slug);
      if(!remoteUpdateAvailable(slug)){
        showToast(ru ? 'Обновлений нет.' : 'No update available.','info');
        return;
      }
      if(typeof window.SkipiRemoteInstall !== 'function'){
        showToast(ru ? 'Доставка обновлений недоступна.' : 'Remote update delivery is unavailable.','error');
        return;
      }
      showToast(ru ? 'Проверяем и устанавливаем обновление…' : 'Verifying and installing update…','info');
      if(pluginHostState.openId === slug) pluginClose();
      window.SkipiRemoteInstall(slug,{ allowNetwork:true }).then(function(res){
        if(res && res.ok){
          remoteCatalogInvalidate();
          showToast((bundled ? bundled.name : slug)+' updated to v'+((res.entry && res.entry.version) || '')+'.','success');
          if(bundled && !hadRemote){
            pluginHostState.selectedId = null;
            pluginHostState.openedFrom = 'manage';
            pluginHostState.openId = slug;
          }
          pluginRerender();
        } else {
          showToast('Could not update '+(bundled ? bundled.name : slug)+': '+((res && res.reason) || 'verification failed'),'error');
          pluginRerender();
        }
      }, function(e){
        showToast('Could not update '+(bundled ? bundled.name : slug)+': '+((e && e.message) || e),'error');
        pluginRerender();
      });
    }
    function remoteEntryFor(slug){
      var installed = remoteInstalledEntryFor(slug); if(installed) return installed;
      var entry = remoteCatalogEntry(slug) || {};
      return {
        id:slug,
        remote:true,
        firstParty:true,
        category:'utils',
        icon:'▦',
        name:remoteCatalogName(slug) || slug,
        short:'Signed first-party plugin · install once, use offline',
        description:'Signed first-party plugin from the production catalog. Install caches a verified pack for offline use.',
        safety_note:'Runs inside Skipi sandbox. Signature, policy, compatibility and checksum are verified before install.',
        permissions:remotePermissionsFor(entry),
        version:entry.version,
        toolCount:entry.toolCount || entry.tool_count
      };
    }
    function remoteLoadCatalogOnce(cb){
      if(__remoteCatalogCache){ if(cb) cb(); return; }
      remoteRefreshCatalog(cb);
    }
    function remoteCatalogInvalidate(){
      __remoteCatalogCache = null;
      __remoteCatalogFetchedAt = 0;
    }
    function remoteRefreshCatalog(cb){
      if(typeof window.SkipiRemoteList !== 'function'){ if(!__remoteCatalogCache) __remoteCatalogCache = []; if(cb) cb(); return; }
      window.SkipiRemoteList().then(function(list){ __remoteCatalogCache = list || []; __remoteCatalogFetchedAt = Date.now(); if(cb) cb(); },
                                    function(){ if(!__remoteCatalogCache) __remoteCatalogCache = []; if(cb) cb(); });
    }
    function remoteRefreshCatalogIfStale(onRefreshed){
      if(!remoteStagingOn()) return;
      if(__remoteCatalogFetchedAt && (Date.now() - __remoteCatalogFetchedAt) < REMOTE_CATALOG_REFRESH_MS) return;
      remoteRefreshCatalog(onRefreshed);
    }
    function pluginInstall(id){
      var p = pluginById(id) || remoteEntryFor(id); if(!p || p.comingSoon) return;
      if(p.remote){
        if(typeof window.SkipiRemoteInstall !== 'function'){ showToast('Remote install is unavailable.','error'); return; }
        showToast('Installing '+p.name+'…','info');
        window.SkipiRemoteInstall(id).then(function(res){
          if(res && res.ok){ remoteCatalogInvalidate(); showToast(p.name+' installed for offline use.','success'); }
          else showToast('Could not install '+p.name+': '+((res && res.reason) || 'verification failed'),'error');
          pluginRerender();
        }, function(e){ showToast('Could not install '+p.name+': '+((e && e.message) || e),'error'); pluginRerender(); });
        return;
      }
      pluginSetState(id,{ installed:true, enabled:true, installed_at:pluginNowIso() });
      showToast(p.name+' installed.','success');
      pluginRerender();
    }
    function pluginUninstall(id){
      if(pluginHostState.openId === id) pluginClose();
      if(bundledPluginById(id)){
        pluginSetState(id,{ installed:false, enabled:false });
        if(remoteInstalledMeta(id)){ var brs = remoteRegistryAll(); delete brs[id]; remoteStateSaveAll(brs); }
        showToast((pluginById(id) || {name:id}).name+' removed.','info');
        pluginHostState.selectedId = null;
        pluginRerender();
        return;
      }
      if(remoteInstalledMeta(id)){
        if(typeof window.SkipiRemoteUninstall === 'function') window.SkipiRemoteUninstall(id);
        else { var rs = remoteRegistryAll(); delete rs[id]; remoteStateSaveAll(rs); }
        showToast((remoteInstalledEntryFor(id) || {name:id}).name+' removed.','info');
        pluginHostState.selectedId = null;
        pluginRerender();
        return;
      }
      pluginSetState(id,{ installed:false, enabled:false });
      showToast((pluginById(id) || {}).name+' removed.','info');
      pluginRerender();
    }
    function pluginDisable(id){
      if(pluginHostState.openId === id) pluginClose();
      if(bundledPluginById(id)){
        pluginSetState(id,{ enabled:false });
        showToast((pluginById(id) || {}).name+' disabled.','info');
        pluginRerender();
        return;
      }
      if(remoteInstalledMeta(id)){
        if(typeof window.SkipiRemoteSetEnabled === 'function') window.SkipiRemoteSetEnabled(id,false);
        else { var rd = remoteRegistryAll(); if(rd[id]){ rd[id].enabled = false; remoteStateSaveAll(rd); } }
        showToast((pluginById(id) || {name:id}).name+' disabled.','info');
        pluginRerender();
        return;
      }
      pluginSetState(id,{ enabled:false });
      showToast((pluginById(id) || {}).name+' disabled.','info');
      pluginRerender();
    }
    function pluginEnable(id){
      if(bundledPluginById(id)){
        pluginSetState(id,{ installed:true, enabled:true });
        showToast((pluginById(id) || {}).name+' enabled.','success');
        pluginRerender();
        return;
      }
      if(remoteInstalledMeta(id)){
        var rp = remoteInstalledEntryFor(id) || pluginById(id) || {name:id};
        if(typeof window.SkipiRemoteSetEnabled === 'function'){
          var rr = window.SkipiRemoteSetEnabled(id,true);
          if(rr && typeof rr.then === 'function'){
            showToast('Checking '+rp.name+' for updates…','info');
            rr.then(function(res){
              remoteCatalogInvalidate();
              showToast(rp.name+(res && res.updated ? ' updated and enabled.' : ' enabled.'),'success');
              pluginRerender();
            }, function(e){
              showToast('Could not enable '+rp.name+': '+((e && e.message) || e),'error');
              pluginRerender();
            });
            return;
          }
        } else {
          var re = remoteRegistryAll(); if(re[id]){ re[id].enabled = true; remoteStateSaveAll(re); }
        }
        showToast(rp.name+' enabled.','success'); pluginRerender(); return;
      }
      pluginSetState(id,{ enabled:true });
      showToast((pluginById(id) || {}).name+' enabled.','success');
      pluginRerender();
    }
    function pluginRerender(){
      if(shouldUseMobileShell()) renderMobileApps();
      else showApps();
    }
    function pluginSelect(id){ pluginHostState.selectedId = id; pluginHostState.openId = null; pluginHostState.surface = 'manage'; pluginRerender(); }
    function pluginBack(){
      if(pluginHostState.openId){ pluginClose(); }
      else { pluginHostState.selectedId = null; pluginRerender(); }
    }
    function pluginOpenManage(){ pluginHostState.surface = 'manage'; pluginHostState.selectedId = null; pluginHostState.openId = null; pluginRerender(); }
    function pluginBackToLauncher(){ pluginHostState.surface = 'launcher'; pluginHostState.selectedId = null; pluginHostState.openId = null; pluginHostState.search = ''; pluginRerender(); }
    function pluginLaunch(id){
      if(pluginStatus(id) !== 'installed') return;
      pluginHostState.openedFrom = 'launcher';
      pluginHostState.openId = id;
      pluginRerender();
    }
    function pluginOpen(id){
      var p = pluginById(id); if(!p || p.comingSoon) return;
      if(pluginStatus(id) === 'available'){ pluginInstall(id); return; }
      if(pluginStatus(id) === 'disabled'){
        if(bundledPluginById(id)) pluginSetState(id,{ installed:true, enabled:true });
        else if(remoteInstalledMeta(id)){
          if(typeof window.SkipiRemoteSetEnabled === 'function') window.SkipiRemoteSetEnabled(id,true);
          else { var ro = remoteRegistryAll(); if(ro[id]){ ro[id].enabled = true; remoteStateSaveAll(ro); } }
        } else pluginSetState(id,{ enabled:true });
      }
      pluginHostState.openedFrom = pluginHostState.selectedId === id ? 'detail' : 'manage';
      pluginHostState.openId = id;
      pluginRerender();
    }
    function pluginClose(){
      try{ if(window.SkipiPluginHost && typeof window.SkipiPluginHost.unmount === 'function') window.SkipiPluginHost.unmount(); }catch(e){}
      pluginHostState.openId = null;
      var from = pluginHostState.openedFrom; pluginHostState.openedFrom = null;
      if(from === 'launcher'){ pluginHostState.surface = 'launcher'; pluginHostState.selectedId = null; }
      else if(from === 'detail'){ pluginHostState.surface = 'manage'; }
      else if(from === 'manage'){ pluginHostState.surface = 'manage'; pluginHostState.selectedId = null; }
      pluginRerender();
    }
    function pluginPermsHtml(p){
      var perm = p && p.permissions; if(!perm) return '';
      var rows = [['Server access',perm.server_access], ['Documents access',perm.documents_access], ['Account required',perm.account_required], ['Analytics',perm.analytics]];
      var h = '<div class="apps-perm"><div class="apps-perm-title">Permissions &amp; privacy</div>';
      rows.forEach(function(r){
        var used = !!r[1];
        h += '<div class="apps-perm-row '+(used?'used':'clear')+'"><span class="apps-perm-dot">'+(used?'●':'✓')+'</span><span>'+(used?esc(r[0])+' used':'No '+esc(String(r[0]).toLowerCase()))+'</span></div>';
      });
      if(perm.audio_alert) h += '<div class="apps-perm-row used"><span class="apps-perm-dot">♪</span><span>Plays audio alerts</span></div>';
      if(perm.local_only) h += '<div class="apps-perm-row clear"><span class="apps-perm-dot">✓</span><span>Runs locally inside Skipi — no internet, no external app</span></div>';
      h += '</div>';
      return h;
    }
    function pluginReadyChip(){
      var label = getUiLang() === 'ru' ? 'готово' : 'ready';
      return '<span class="fam-chip tone-ready" data-qa="state-chip-ready">'+esc(label)+'</span>';
    }
    function showApps(){
      var content = document.getElementById('scr-content'); if(!content) return;
      if(pluginHostState.openId) content.innerHTML = pluginScreenHtml(pluginById(pluginHostState.openId));
      else if(pluginHostState.selectedId) content.innerHTML = pluginDetailHtml(pluginById(pluginHostState.selectedId));
      else if(pluginHostState.surface === 'manage') content.innerHTML = pluginManageHtml();
      else content.innerHTML = pluginLauncherHtml();
      show('scr-content'); updateTabs('Apps');
      if(pluginHostState.openId) setTimeout(function(){ pluginMountInto(pluginHostState.openId); },0);
      if(!pluginHostState.openId && !pluginHostState.selectedId){
        remoteRefreshCatalogIfStale(function(){
          if(pluginHostState.openId || pluginHostState.selectedId) return;
          if(pluginHostState.surface === 'manage'){
            var c = document.getElementById('scr-content'); if(c) c.innerHTML = pluginManageHtml();
          } else {
            var r = document.getElementById('apps-launcher-results'); if(r) r.innerHTML = pluginLauncherResultsHtml();
          }
        });
      }
    }
    function pluginInstalledList(){
      var seen = {}, items = [];
      function push(p){ if(!p || !p.id || seen[p.id]) return; seen[p.id] = true; items.push(p); }
      plugins.forEach(function(p){ if(!p.comingSoon && pluginStatus(p.id) === 'installed') push(p); });
      if(typeof shouldUseMobileShell === 'function' && shouldUseMobileShell()) return items;
      Object.keys(remoteRegistryAll()).forEach(function(id){
        if(bundledPluginById(id)) return;
        if(pluginStatus(id) === 'installed'){ var p = remoteInstalledEntryFor(id); if(p) push(p); }
      });
      return items;
    }
    function pluginLauncherFiltered(){
      var q = (pluginHostState.search || '').trim().toLowerCase();
      var items = pluginInstalledList();
      if(!q) return items;
      return items.filter(function(p){ return ((p.name||'')+' '+(p.short||'')).toLowerCase().indexOf(q) >= 0; });
    }
    function pluginLauncherSearch(v){
      pluginHostState.search = v;
      var box = document.getElementById('apps-launcher-results');
      if(box) box.innerHTML = pluginLauncherResultsHtml();
    }
    function pluginIconTileHtml(p){
      return '<div class="apps-icon-tile" data-qa="plugin-tile-'+escAttr(p.id)+'">'
        + '<button type="button" data-qa="plugin-open-'+escAttr(p.id)+'" onclick="pluginLaunch(\''+jsString(p.id)+'\')" title="'+escAttr(pluginNameMetaLine(p))+'">'
        + '<span class="apps-icon-tile-icon">'+(p.icon||'▢')+'</span>'
        + '<span class="apps-icon-tile-name">'+esc(p.name)+'</span>'
        + (pluginMetaLine(p)?'<span class="apps-icon-tile-meta">'+esc(pluginMetaLine(p))+'</span>':'')
        + (remoteUpdateAvailable(p.id)
            ? '<span class="apps-badge live" data-qa="plugin-update-available-'+escAttr(p.id)+'">Update available</span>'
            : pluginReadyChip())
        + '</button></div>';
    }
    function pluginLauncherResultsHtml(){
      var ru = getUiLang() === 'ru';
      var installed = pluginInstalledList();
      if(!installed.length){
        return '<div class="apps-empty fam-state-panel" data-qa="plugin-empty-state" data-qa2="state-empty-panel">'
          + '<div class="apps-empty-note fam-state-copy">'+esc(ru?'Установленных плагинов пока нет. Откройте настройки, чтобы проверить доступные модули.':'No installed plugins yet. Open plugin settings to see available modules.')+'</div>'
          + '<button class="fam-primary-action" type="button" onclick="pluginOpenManage()">'+esc(ru?'Настройки плагинов':'Plugin settings')+'</button>'
          + '</div>';
      }
      var items = pluginLauncherFiltered();
      if(!items.length){
        return '<div class="apps-empty fam-state-panel" data-qa="plugin-empty-state" data-context="search" data-qa2="state-empty-panel">'
          + '<div class="apps-empty-note fam-state-copy">'+esc(ru?'Ничего не найдено среди установленных плагинов.':'Nothing found among installed plugins.')+'</div>'
          + '</div>';
      }
      var h = '<div class="apps-cat-title">'+esc(ru?'Установленные плагины':'Installed plugins')+'</div><div class="apps-launcher-grid">';
      items.forEach(function(p){ h += pluginIconTileHtml(p); });
      h += '</div>';
      return h;
    }
    function pluginLauncherHtml(){
      var ru = getUiLang() === 'ru';
      var offline = false; try{ offline = (navigator.onLine === false); }catch(e){}
      var h = '<div class="apps-screen apps-launcher" data-qa="'+homeId+'-module-apps">';
      h += '<div class="apps-head apps-launcher-head"><div>'
        + '<div class="apps-head-title">Apps</div>'
        + '<div class="apps-head-sub">'+esc(ru?homeShortName:homeName)+'</div></div>'
        + '<button class="apps-gear-btn" type="button" data-qa="plugins-settings-open" onclick="pluginOpenManage()" title="'+escAttr(ru?'Настройки плагинов':'Plugin settings')+'" aria-label="'+escAttr(ru?'Настройки плагинов':'Plugin settings')+'">&#9881;</button></div>';
      if(offline) h += '<div class="apps-offline" data-qa="plugin-offline-state">'+esc(ru?'Оффлайн — установленные плагины продолжают работать.':'Offline — installed plugins keep working.')+'</div>';
      h += '<div class="apps-search"><label class="apps-search-label" for="apps-search-field">'+esc(ru?'Найти плагин':'Find a plugin')+'</label>'
        + '<input id="apps-search-field" type="text" data-qa="apps-search-input" value="'+escAttr(pluginHostState.search||'')+'" oninput="pluginLauncherSearch(this.value)" placeholder="'+escAttr(ru?'Название плагина':'Plugin name')+'"></div>';
      h += '<div id="apps-launcher-results">'+pluginLauncherResultsHtml()+'</div>';
      h += '<div class="apps-launcher-foot">'+esc(ru?'Только установленные плагины. Управление, политики и обновления — через ⚙.':'Installed plugins only. Management, policies and updates — via ⚙.')+'</div>';
      h += '</div>';
      return h;
    }
    function pluginManageHtml(){
      var ru = getUiLang() === 'ru';
      var h = '<div class="apps-screen apps-manage">';
      h += '<button class="apps-back" type="button" onclick="pluginBackToLauncher()">← Apps</button>';
      h += '<div class="apps-head"><div class="apps-head-title">'+esc(ru?'Управление плагинами':'Plugin management')+'</div>'
        + '<div class="apps-head-sub">'+esc(ru?'Каталог, установка, отключение и обновления. Bundled first-party плагины — не маркетплейс, без стороннего кода.':'Catalog, install, disable and updates. Bundled first-party plugins — not a marketplace and no third-party code.')+'</div></div>';
      pluginCategories().forEach(function(cat){
        var items = plugins.filter(function(p){ return p.category === cat.key; });
        if(!items.length) return;
        h += '<div class="apps-cat-title">'+esc(cat.label)+'</div><div class="apps-grid">';
        items.forEach(function(p){ h += pluginManageTileHtml(p); });
        h += '</div>';
      });
      h += remoteStagingSectionHtml();
      h += '</div>';
      return h;
    }
    function pluginManageTileHtml(p){
      var soon = !!p.comingSoon;
      return '<button class="apps-tile'+(soon?' soon':'')+'" type="button" data-qa="plugin-settings-'+escAttr(p.id)+'" onclick="pluginSelect(\''+jsString(p.id)+'\')">'
        + '<span class="apps-tile-icon">'+(p.icon||'▢')+'</span>'
        + '<span class="apps-tile-body"><span class="apps-tile-name">'+esc(p.name)+'</span>'
        + '<span class="apps-tile-sub">'+esc(pluginSubLine(p))+'</span>'+pluginBadge(p.id)+'</span></button>';
    }
    function pluginBadge(id){
      var p = pluginById(id);
      if(p && p.comingSoon) return '<span class="apps-badge soon">Coming soon</span>';
      if(remoteUpdateAvailable(id)) return '<span class="apps-badge live">Update available</span>';
      var s = pluginStatus(id);
      if(s === 'installed') return '<span class="apps-badge live">Installed</span>';
      if(s === 'disabled') return '<span class="apps-badge soon">Disabled</span>';
      return '<span class="apps-badge live">Available</span>';
    }
    function pluginTileHtml(p){
      var soon = !!p.comingSoon;
      return '<button class="apps-tile'+(soon?' soon':'')+'" type="button" onclick="pluginSelect(\''+jsString(p.id)+'\')">'
        + '<span class="apps-tile-icon">'+(p.icon||'▢')+'</span>'
        + '<span class="apps-tile-body"><span class="apps-tile-name">'+esc(p.name)+'</span>'
        + '<span class="apps-tile-sub">'+esc(pluginSubLine(p))+'</span>'+pluginBadge(p.id)+'</span></button>';
    }
    function pluginListHtml(){
      var h = '<div class="apps-screen"><div class="apps-head"><div class="apps-head-title">Apps</div>'
        + '<div class="apps-head-sub">Bundled first-party plugins inside your '+esc(homeName)+' home. Not a marketplace and no third-party code.</div></div>';
      pluginCategories().forEach(function(cat){
        var items = plugins.filter(function(p){ return p.category === cat.key; });
        if(!items.length) return;
        h += '<div class="apps-cat-title">'+esc(cat.label)+'</div><div class="apps-grid">';
        items.forEach(function(p){ h += pluginTileHtml(p); });
        h += '</div>';
      });
      h += remoteStagingSectionHtml();
      h += '</div>';
      return h;
    }
    function remoteTileHtml(slug){
      var e = remoteEntryFor(slug);
      var st = pluginStatus(slug);
      var actions = '';
      if(st === 'installed') actions = '<button class="btn btn-accent btn-sm" type="button" data-qa="remote-plugin-open-'+escAttr(slug)+'" onclick="pluginOpen(\''+jsString(slug)+'\')">Open</button>'
        + remoteUpdateActionHtml(slug)
        + ' <button class="btn btn-outline btn-sm" type="button" data-qa="remote-plugin-disable-'+escAttr(slug)+'" onclick="pluginDisable(\''+jsString(slug)+'\')">Disable</button>'
        + ' <button class="btn btn-outline btn-sm" type="button" data-qa="remote-plugin-uninstall-'+escAttr(slug)+'" onclick="pluginUninstall(\''+jsString(slug)+'\')">Remove</button>';
      else if(st === 'disabled') actions = '<button class="btn btn-accent btn-sm" type="button" data-qa="remote-plugin-enable-'+escAttr(slug)+'" onclick="pluginEnable(\''+jsString(slug)+'\')">Enable</button>'
        + remoteUpdateActionHtml(slug)
        + ' <button class="btn btn-outline btn-sm" type="button" data-qa="remote-plugin-uninstall-'+escAttr(slug)+'" onclick="pluginUninstall(\''+jsString(slug)+'\')">Remove</button>';
      else actions = '<button class="btn btn-accent btn-sm" type="button" data-qa="remote-plugin-install-'+escAttr(slug)+'" onclick="pluginInstall(\''+jsString(slug)+'\')">Install</button>';
      return '<div class="apps-tile" data-qa="remote-plugin-tile-'+escAttr(slug)+'">'
        + '<span class="apps-tile-icon">'+e.icon+'</span>'
        + '<span class="apps-tile-body"><span class="apps-tile-name">'+esc(e.name)+'</span>'
        + '<span class="apps-tile-sub">'+esc(pluginSubLine(e))+'</span><span class="apps-badge live">'+(st==='available'?'Remote · verified':(st==='disabled'?'Installed · disabled':'Installed · offline-ready'))+'</span>'
        + '<span class="apps-actions" style="margin-top:8px;">'+actions+'</span></span></div>';
    }
    function remoteStagingSectionHtml(){
      var slugs = remoteStagingSlugs(); if(!slugs.length) return '';
      var h = '<div class="apps-cat-title">Remote first-party plugins</div>'
        + '<div class="apps-head-sub" style="margin:-6px 0 8px;">Loaded from the signed production catalog via the verified, sandboxed plugin runtime.</div>'
        + '<div class="apps-grid">';
      slugs.forEach(function(s){ h += remoteTileHtml(s); });
      h += '</div>';
      return h;
    }
    function remotePluginScreenHtml(slug){
      var e = remoteEntryFor(slug);
      return '<div class="apps-screen plugin-screen">'
        + '<div class="plugin-host-bar"><button class="apps-back" type="button" onclick="remotePluginBack()">&larr; '+esc(pluginNameMetaLine(e))+'</button>'
        + '<span class="plugin-host-title" id="plugin-host-title"></span>'
        + '<span class="apps-badge live">Remote · verified</span></div>'
        + '<div class="apps-safety" style="margin:10px 0;"><b>Remote first-party plugin</b> — signed &amp; sandboxed; no access to your vault.</div>'
        + '<div class="plugin-host-container" id="plugin-host-container"><div class="plugin-host-loading">Loading…</div></div>'
        + '</div>';
    }
    function remotePluginOpen(slug){ pluginOpen(slug); }
    function remotePluginBack(){
      try{ if(window.SkipiPluginHost && typeof window.SkipiPluginHost.unmount === 'function') window.SkipiPluginHost.unmount(); }catch(e){}
      pluginHostState.openId = null; pluginHostState.selectedId = null;
      showApps();
    }
    function pluginDetailHtml(p){
      if(!p) return pluginListHtml();
      var st = pluginStatus(p.id);
      var h = '<div class="apps-screen apps-detail">';
      h += '<button class="apps-back" type="button" onclick="pluginBack()">← '+esc(getUiLang()==='ru'?'Управление плагинами':'Plugin management')+'</button>';
      h += '<div class="apps-detail-head"><span class="apps-tile-icon big">'+(p.icon||'▢')+'</span>'
        + '<div><div class="apps-detail-name">'+esc(p.name)+'</div>'
        + '<div class="apps-detail-cat">'+esc([pluginCatLabel(p.category)].concat(pluginMetaParts(p)).join(' · '))+(p.comingSoon?' · Coming soon':(p.firstParty?' · First-party plugin':''))+'</div></div></div>';
      if(p.description) h += '<p class="apps-detail-desc">'+esc(p.description)+'</p>';
      if(p.safety_note) h += '<div class="apps-safety"><b>Safety</b> — '+esc(p.safety_note)+'</div>';
      h += pluginPermsHtml(p);
      h += '<div class="apps-actions">';
      if(p.comingSoon){ h += '<button class="btn btn-outline" disabled>Coming soon</button>'; }
      else if(st === 'available'){ h += '<button class="btn btn-accent" onclick="pluginInstall(\''+jsString(p.id)+'\')">Install</button>'; }
      else if(st === 'installed'){
        h += '<button class="btn btn-accent" onclick="pluginOpen(\''+jsString(p.id)+'\')">Open</button>';
        h += remoteUpdateActionHtml(p.id);
        h += ' <button class="btn btn-outline" onclick="pluginDisable(\''+jsString(p.id)+'\')">Disable</button>';
        h += ' <button class="btn btn-outline" onclick="pluginUninstall(\''+jsString(p.id)+'\')">Remove</button>';
      } else {
        h += '<button class="btn btn-accent" onclick="pluginEnable(\''+jsString(p.id)+'\')">Enable</button>';
        h += remoteUpdateActionHtml(p.id);
        h += ' <button class="btn btn-outline" onclick="pluginUninstall(\''+jsString(p.id)+'\')">Remove</button>';
      }
      h += '</div></div>';
      return h;
    }
    function pluginScreenHtml(p){
      if(!p) return pluginListHtml();
      return '<div class="apps-screen plugin-screen">'
        + '<div class="plugin-host-bar"><button class="apps-back" type="button" onclick="pluginBack()">← '+esc(pluginNameMetaLine(p))+'</button>'
        + '<span class="plugin-host-title" id="plugin-host-title"></span>'
        + '<button class="btn btn-outline btn-sm" onclick="pluginDisable(\''+jsString(p.id)+'\')">Disable</button></div>'
        + '<div class="plugin-host-container" id="plugin-host-container"><div class="plugin-host-loading">Loading…</div></div>'
        + '</div>';
    }
    function pluginPlaceholderHtml(p, reason){
      var pending = (reason === 'not_bundled' || reason === 'no_bundle' || reason === 'no_register');
      var note = pending ? 'Plugin artifact is not bundled yet — it is being prepared in the Skipi plugin lab.' : 'This plugin could not be loaded ('+esc(reason||'unknown')+').';
      var h = '<div class="plugin-placeholder"'+(pending?'':' data-qa="plugin-error-state"')+'>';
      h += '<div class="plugin-placeholder-icon">'+(p && p.icon || '▢')+'</div>';
      h += '<div class="plugin-placeholder-title">Preparing in plugin lab</div>';
      h += '<div class="plugin-placeholder-note">'+note+'</div>';
      if(p && p.safety_note) h += '<div class="apps-safety" style="margin-top:14px;text-align:left;"><b>Safety</b> — '+esc(p.safety_note)+'</div>';
      if(p) h += pluginPermsHtml(p);
      h += '</div>';
      return h;
    }
    function pluginMountInto(id){
      var container = document.getElementById('plugin-host-container');
      if(!container) return;
      var host = window.SkipiPluginHost;
      if(!host || typeof host.mount !== 'function'){
        container.innerHTML = pluginPlaceholderHtml(pluginById(id), 'host_runtime_missing');
        return;
      }
      if(host.current && host.current.id === id) return;
      host.mount(id, container).then(function(res){
        if(res && res.ok) return;
        container.innerHTML = pluginPlaceholderHtml(pluginById(id), res && res.reason);
      });
    }
    function renderMobileApps(){
      if(pluginHostState.openId){
        mobileMainHtml(pluginMobileScreenHtml(pluginById(pluginHostState.openId)));
        setTimeout(function(){ pluginMountInto(pluginHostState.openId); },0);
        return;
      }
      if(pluginHostState.selectedId) return pluginMobileDetail(pluginById(pluginHostState.selectedId));
      if(pluginHostState.surface === 'manage') return renderMobileAppsManage();
      var ru = getUiLang() === 'ru';
      var offline = false; try{ offline = (navigator.onLine === false); }catch(e){}
      var h = '<div class="mobile-apps-launcher" data-qa="'+homeId+'-module-apps">';
      h += '<div class="mobile-apps-head"><span class="mobile-apps-icon">S</span>'
        + '<div class="mobile-apps-head-copy"><div class="mobile-apps-head-title">Apps</div>'
        + '<div class="mobile-apps-head-sub">'+esc(ru?homeShortName:homeName)+'</div></div>'
        + '<button class="apps-gear-btn" type="button" data-qa="plugins-settings-open" onclick="pluginOpenManage()" title="'+escAttr(ru?'Настройки плагинов':'Plugin settings')+'" aria-label="'+escAttr(ru?'Настройки плагинов':'Plugin settings')+'">&#9881;</button></div>';
      if(offline) h += '<div class="apps-offline" data-qa="plugin-offline-state">'+esc(ru?'Оффлайн — установленные плагины продолжают работать.':'Offline — installed plugins keep working.')+'</div>';
      h += '<div class="apps-search"><label class="apps-search-label" for="apps-search-field">'+esc(ru?'Найти плагин':'Find a plugin')+'</label>'
        + '<input id="apps-search-field" type="text" data-qa="apps-search-input" value="'+escAttr(pluginHostState.search||'')+'" oninput="pluginLauncherSearch(this.value)" placeholder="'+escAttr(ru?'Название плагина':'Plugin name')+'"></div>';
      h += '<div id="apps-launcher-results">'+pluginLauncherResultsHtml()+'</div>';
      h += '<div class="apps-launcher-foot">'+esc(ru?'Только установленные плагины. Управление, политики и обновления — через ⚙.':'Installed plugins only. Management, policies and updates — via ⚙.')+'</div>';
      h += '</div>';
      mobileMainHtml(h);
      remoteRefreshCatalogIfStale(function(){
        if(pluginHostState.openId || pluginHostState.selectedId || pluginHostState.surface === 'manage') return;
        var r = document.getElementById('apps-launcher-results'); if(r) r.innerHTML = pluginLauncherResultsHtml();
      });
    }
    function renderMobileAppsManage(){
      var ru = getUiLang() === 'ru';
      var h = '<button class="mobile-home-btn" type="button" onclick="pluginBackToLauncher()"><span class="mobile-home-btn-icon">←</span><span>Apps</span></button>';
      h += '<div class="mobile-section-title">'+esc(ru?'Управление плагинами':'Plugin management')+'</div>';
      h += '<div class="mobile-card-sub" style="margin:-4px 0 12px;">'+esc(ru?'Каталог, установка, отключение и обновления. Не маркетплейс, без стороннего кода.':'Catalog, install, disable and updates. Not a marketplace and no third-party code.')+'</div>';
      pluginCategories().forEach(function(cat){
        var items = plugins.filter(function(p){ return p.category === cat.key; });
        if(!items.length) return;
        h += '<div class="mobile-section-title">'+esc(cat.label)+'</div>';
        items.forEach(function(p){
          var soon = !!p.comingSoon, st = pluginStatus(p.id);
          var tag = soon ? ' <span class="apps-badge soon">soon</span>'
            : (remoteUpdateAvailable(p.id) ? ' <span class="apps-badge live">Update available</span>'
            : (st === 'installed' ? ' <span class="apps-badge live">installed</span>' : (st === 'disabled' ? ' <span class="apps-badge soon">disabled</span>' : '')));
          h += '<button class="mobile-primary-action" type="button" data-qa="plugin-settings-'+escAttr(p.id)+'" onclick="pluginSelect(\''+jsString(p.id)+'\')">'
            + '<span class="mobile-action-icon">'+(p.icon||'▢')+'</span>'
            + '<span class="mobile-action-copy"><span class="mobile-action-title">'+esc(p.name)+tag+'</span>'
            + '<span class="mobile-action-sub">'+esc(pluginSubLine(p))+'</span></span></button>';
        });
      });
      mobileMainHtml(h);
      remoteRefreshCatalogIfStale(function(){
        if(pluginHostState.openId || pluginHostState.selectedId) return;
        if(pluginHostState.surface === 'manage' && shouldUseMobileShell()) renderMobileAppsManage();
      });
    }
    function pluginMobileScreenHtml(p){
      if(!p) return '';
      var backLabel = pluginHostState.openedFrom === 'launcher' ? 'Apps' : (getUiLang() === 'ru' ? 'Назад' : 'Back');
      return '<div class="apps-screen plugin-screen">'
        + '<div class="plugin-host-bar"><button class="apps-back" type="button" onclick="pluginBack()">← '+esc(backLabel)+'</button>'
        + '<span class="plugin-host-title" id="plugin-host-title">'+esc(p.name||'')+'</span>'
        + '<button class="btn btn-outline btn-sm" onclick="pluginDisable(\''+jsString(p.id)+'\')">Disable</button></div>'
        + '<div class="plugin-host-container" id="plugin-host-container"><div class="plugin-host-loading">Loading…</div></div>'
        + '</div>';
    }
    function pluginMobileDetail(p){
      if(!p){ pluginHostState.selectedId = null; return renderMobileApps(); }
      var st = pluginStatus(p.id);
      var h = '<button class="mobile-home-btn" type="button" onclick="pluginBack()"><span class="mobile-home-btn-icon">←</span><span>'+esc(getUiLang()==='ru'?'Управление плагинами':'Plugin management')+'</span></button>';
      h += '<div class="mobile-primary-action" style="cursor:default;"><span class="mobile-action-icon">'+(p.icon||'▢')+'</span>'
        + '<span class="mobile-action-copy"><span class="mobile-action-title">'+esc(p.name)+'</span>'
        + '<span class="mobile-action-sub">'+esc([pluginCatLabel(p.category)].concat(pluginMetaParts(p)).join(' · '))+(p.comingSoon?' · Coming soon':(p.firstParty?' · First-party plugin':''))+'</span></span></div>';
      if(p.description) h += '<div class="mobile-card"><div class="mobile-card-sub">'+esc(p.description)+'</div></div>';
      if(p.safety_note) h += '<div class="apps-safety"><b>Safety</b> — '+esc(p.safety_note)+'</div>';
      h += pluginPermsHtml(p);
      h += '<div class="apps-actions">';
      if(p.comingSoon){ h += '<button class="btn btn-outline" style="width:100%;" disabled>Coming soon</button>'; }
      else if(st === 'available'){ h += '<button class="btn btn-accent" style="width:100%;" onclick="pluginInstall(\''+jsString(p.id)+'\')">Install</button>'; }
      else if(st === 'installed'){
        if(remoteUpdateAvailable(p.id)) h += '<button class="btn btn-accent" style="width:100%;" data-qa="remote-plugin-update-'+escAttr(p.id)+'" onclick="pluginRemoteUpdate(\''+jsString(p.id)+'\')">'+esc(getUiLang()==='ru'?'Обновить':'Update')+'</button>';
        h += '<button class="btn btn-accent" style="width:100%;'+(remoteUpdateAvailable(p.id)?'margin-top:8px;':'')+'" onclick="pluginOpen(\''+jsString(p.id)+'\')">Open</button>';
        h += '<button class="btn btn-outline" style="width:100%;margin-top:8px;" onclick="pluginDisable(\''+jsString(p.id)+'\')">Disable</button>';
        h += '<button class="btn btn-outline" style="width:100%;margin-top:8px;" onclick="pluginUninstall(\''+jsString(p.id)+'\')">Remove</button>';
      } else {
        h += '<button class="btn btn-accent" style="width:100%;" onclick="pluginEnable(\''+jsString(p.id)+'\')">Enable</button>';
        if(remoteUpdateAvailable(p.id)) h += '<button class="btn btn-accent" style="width:100%;margin-top:8px;" data-qa="remote-plugin-update-'+escAttr(p.id)+'" onclick="pluginRemoteUpdate(\''+jsString(p.id)+'\')">'+esc(getUiLang()==='ru'?'Обновить':'Update')+'</button>';
        h += '<button class="btn btn-outline" style="width:100%;margin-top:8px;" onclick="pluginUninstall(\''+jsString(p.id)+'\')">Remove</button>';
      }
      h += '</div>';
      mobileMainHtml(h);
    }

    var globals = {
      showApps:showApps,
      pluginInstalledList:pluginInstalledList,
      pluginLauncherFiltered:pluginLauncherFiltered,
      pluginLauncherSearch:pluginLauncherSearch,
      pluginLauncherResultsHtml:pluginLauncherResultsHtml,
      pluginLauncherHtml:pluginLauncherHtml,
      pluginManageHtml:pluginManageHtml,
      pluginManageTileHtml:pluginManageTileHtml,
      pluginDetailHtml:pluginDetailHtml,
      pluginScreenHtml:pluginScreenHtml,
      pluginMobileScreenHtml:pluginMobileScreenHtml,
      pluginMobileDetail:pluginMobileDetail,
      pluginIconTileHtml:pluginIconTileHtml,
      pluginInstall:pluginInstall,
      pluginUninstall:pluginUninstall,
      pluginEnable:pluginEnable,
      pluginDisable:pluginDisable,
      pluginSetState:pluginSetState,
      pluginGetState:pluginGetState,
      pluginStateAll:pluginStateAll,
      pluginStateSaveAll:pluginStateSaveAll,
      pluginStatus:pluginStatus,
      pluginById:pluginById,
      pluginMetaLine:pluginMetaLine,
      pluginMetaParts:pluginMetaParts,
      pluginVersionLabel:pluginVersionLabel,
      pluginVersionValue:pluginVersionValue,
      pluginToolsLabel:pluginToolsLabel,
      pluginToolCount:pluginToolCount,
      pluginMountInto:pluginMountInto,
      pluginLaunch:pluginLaunch,
      pluginOpen:pluginOpen,
      pluginClose:pluginClose,
      pluginOpenManage:pluginOpenManage,
      pluginBack:pluginBack,
      pluginBackToLauncher:pluginBackToLauncher,
      pluginSelect:pluginSelect,
      pluginRerender:pluginRerender,
      bundledPluginById:bundledPluginById,
      remoteRegistryAll:remoteRegistryAll,
      remoteInstalledMeta:remoteInstalledMeta,
      remoteInstalledEntryFor:remoteInstalledEntryFor,
      remoteCatalogVersion:remoteCatalogVersion,
      remoteUpdateAvailable:remoteUpdateAvailable,
      remoteUpdateActionHtml:remoteUpdateActionHtml,
      remoteStateSaveAll:remoteStateSaveAll,
      remoteLoadCatalogOnce:remoteLoadCatalogOnce,
      remoteRefreshCatalog:remoteRefreshCatalog,
      remoteRefreshCatalogIfStale:remoteRefreshCatalogIfStale,
      remoteCatalogInvalidate:remoteCatalogInvalidate,
      remoteConfiguredSlug:remoteConfiguredSlug,
      remoteStagingOn:remoteStagingOn,
      remoteStagingSlugs:remoteStagingSlugs,
      pluginRemoteUpdate:pluginRemoteUpdate,
      semverParts:semverParts,
      semverGt:semverGt
    };
    if(deps.attachGlobals !== false){
      Object.keys(globals).forEach(function(k){ window[k] = globals[k]; });
    }

    return { showApps:showApps, pluginRerender:pluginRerender, pluginLaunch:pluginLaunch };
  }

  window.SkipiPluginHostUI = { create:create };
})();
