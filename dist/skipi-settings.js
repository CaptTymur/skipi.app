/* @skipi/settings — generic settings shell. Classic browser script, no bundle runtime. */
(function (root) {
  'use strict';

  var VERSION = '0.3.0';
  var SKIPPED = {};
  var GENERIC_IDS = {
    profile: true,
    team: true,
    devices: true,
    application: true,
    modules: true,
    identity: true,
    storage: true,
    appearance: true,
    about: true
  };
  var SECTION_ALIASES = {
    identity: 'profile',
    modules: 'application',
    storage: 'application',
    appearance: 'application',
    about: 'application'
  };
  var GENERIC_ICONS = {
    profile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"></circle><path d="M5.5 20c.7-4 3-6 6.5-6s5.8 2 6.5 6"></path></svg>',
    team: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle><path d="M2.5 20c.5-4 2.3-6 5.5-6s5 2 5.5 6M14 15c3.8-.8 6 1 6.5 5"></path></svg>',
    application: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>',
    modules: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>',
    identity: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"></circle><path d="M5.5 20c.7-4 3-6 6.5-6s5.8 2 6.5 6"></path></svg>',
    storage: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"></ellipse><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"></path><path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"></path></svg>',
    devices: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"></rect><path d="M10 5h4M11 18.5h2"></path></svg>',
    appearance: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"></path></svg>',
    about: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.5v6M12 7.5h.01"></path></svg>'
  };
  var NAVIGATION_ICONS = {
    general: GENERIC_ICONS.about,
    notifications: '<svg viewBox="0 0 24 24"><path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 6 2.5 6 2.5 7.5H4C4 15 6.5 15 6.5 9Z"></path><path d="M9.5 19a3 3 0 0 0 5 0"></path></svg>',
    personalization: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-1.4-1.1-2.5-2.5-2.5H17a2 2 0 0 1-2-2V6a3 3 0 0 0-3-3Z"></path><circle cx="7.5" cy="11" r="1"></circle><circle cx="10" cy="7" r="1"></circle><circle cx="8.5" cy="15" r="1"></circle></svg>',
    apps: GENERIC_ICONS.modules,
    voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"></path></svg>',
    billing: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="M3 9h18M7 15h4"></path></svg>',
    usage: '<svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V4M16 19v-7M22 19v-4"></path></svg>',
    data: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path><circle cx="8" cy="6" r="2"></circle><circle cx="16" cy="12" r="2"></circle><circle cx="10" cy="18" r="2"></circle></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4-1.5A4.8 4.8 0 0 0 7 18Z"></path></svg>',
    storage: GENERIC_ICONS.storage,
    memory: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"></rect><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    protection: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.7 3 7.8 7.5 9.5 4.5-1.7 7.5-4.8 7.5-9.5V6L12 3Z"></path><path d="m8.5 12 2.2 2.2 4.8-5"></path></svg>',
    security: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path></svg>',
    parental: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="10" r="2.5"></circle><path d="M3.5 20c.5-4 2.3-6 5.5-6s5 2 5.5 6M14 15c3.8-.8 6 1 6.5 5"></path></svg>',
    contact: '<svg viewBox="0 0 24 24"><path d="M20.5 11.5c0 5-4.2 8.2-8.5 9.5-4.3-1.3-8.5-4.5-8.5-9.5V6L12 3l8.5 3v5.5Z"></path><path d="M8.5 12h7M12 8.5v7"></path></svg>',
    account: GENERIC_ICONS.identity,
    email: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m4 7 8 6 8-6"></path></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M8.2 3.5 5.5 5c-.9.5-1.1 1.4-.8 2.4 2.1 6.2 5.7 9.8 11.9 11.9 1 .3 1.9.1 2.4-.8l1.5-2.7-4.2-2-1.8 2c-2.8-1.3-5-3.5-6.3-6.3l2-1.8-2-4.2Z"></path></svg>',
    subscription: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"></path></svg>',
    restore: '<svg viewBox="0 0 24 24"><path d="M5 7v5h5"></path><path d="M6.5 17.5A8 8 0 1 0 5 8"></path></svg>',
    appearance: GENERIC_ICONS.appearance,
    accent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle><path d="M12 4a8 8 0 0 1 0 16Z"></path></svg>'
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function copyObject(value) {
    var out = {};
    var key;
    if (!value || typeof value !== 'object') return out;
    for (key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
    }
    return out;
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function canonicalSectionId(value) {
    value = String(value || '');
    return Object.prototype.hasOwnProperty.call(SECTION_ALIASES, value) ? SECTION_ALIASES[value] : value;
  }

  function scalarText(value, path, required) {
    if (value == null || value === '') {
      if (required) throw new TypeError('@skipi/settings: ' + path + ' is required');
      return '';
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError('@skipi/settings: ' + path + ' must be text');
    }
    return String(value);
  }

  function normalizeRole(value, path) {
    value = scalarText(value, path || 'team role', false).toLowerCase();
    if (!value) return '';
    if (value === 'owner' || value === 'admin' || value === 'administrator') return 'administrator';
    if (value === 'member') return 'member';
    throw new TypeError('@skipi/settings: ' + (path || 'team role') + ' must be owner, admin or member');
  }

  function validateProfile(value) {
    var user;
    var entity;
    var details = [];
    var i;
    var detail;
    if (!isObject(value)) throw new TypeError('@skipi/settings: getProfile must return an object');
    if (!isObject(value.user)) throw new TypeError('@skipi/settings: getProfile.user must be an object');
    if (!isObject(value.entity)) throw new TypeError('@skipi/settings: getProfile.entity must be an object');
    user = {
      id: scalarText(value.user.id, 'getProfile.user.id', true),
      email: scalarText(value.user.email, 'getProfile.user.email', false),
      phone: scalarText(value.user.phone, 'getProfile.user.phone', false)
    };
    entity = {
      type: scalarText(value.entity.type, 'getProfile.entity.type', true).toLowerCase(),
      name: scalarText(value.entity.name, 'getProfile.entity.name', false),
      jurisdiction: scalarText(value.entity.jurisdiction, 'getProfile.entity.jurisdiction', false),
      verifiedLevel: scalarText(value.entity.verifiedLevel, 'getProfile.entity.verifiedLevel', false),
      imo: scalarText(value.entity.imo, 'getProfile.entity.imo', false),
      details: details
    };
    if (entity.type !== 'person' && entity.type !== 'company' && entity.type !== 'vessel') {
      throw new TypeError('@skipi/settings: getProfile.entity.type must be person, company or vessel');
    }
    if (value.entity.details != null && !Array.isArray(value.entity.details)) {
      throw new TypeError('@skipi/settings: getProfile.entity.details must be an array');
    }
    for (i = 0; i < (value.entity.details || []).length; i += 1) {
      detail = value.entity.details[i];
      if (!isObject(detail)) throw new TypeError('@skipi/settings: getProfile.entity.details[' + i + '] must be an object');
      details.push({
        label: scalarText(detail.label, 'getProfile.entity.details[' + i + '].label', false),
        labelKey: scalarText(detail.labelKey, 'getProfile.entity.details[' + i + '].labelKey', false),
        value: scalarText(detail.value, 'getProfile.entity.details[' + i + '].value', true)
      });
      if (!details[i].label && !details[i].labelKey) {
        throw new TypeError('@skipi/settings: getProfile.entity.details[' + i + '] needs label or labelKey');
      }
    }
    return { user: user, entity: entity };
  }

  function validateTeamProfile(value) {
    if (!isObject(value)) throw new TypeError('@skipi/settings: host.team.getTeam must return an object');
    return {
      name: scalarText(value.name, 'host.team.getTeam.name', true),
      replyTo: scalarText(value.replyTo, 'host.team.getTeam.replyTo', false),
      serverStatus: scalarText(value.serverStatus, 'host.team.getTeam.serverStatus', false),
      role: normalizeRole(value.role, 'host.team.getTeam.role')
    };
  }

  function validateTeamMembers(value) {
    var members = [];
    var i;
    var item;
    if (!Array.isArray(value)) throw new TypeError('@skipi/settings: host.team.getMembers must return an array');
    for (i = 0; i < value.length; i += 1) {
      item = value[i];
      if (!isObject(item)) throw new TypeError('@skipi/settings: host.team.getMembers[' + i + '] must be an object');
      members.push({
        id: scalarText(item.id, 'host.team.getMembers[' + i + '].id', true),
        name: scalarText(item.name, 'host.team.getMembers[' + i + '].name', true),
        role: normalizeRole(item.role, 'host.team.getMembers[' + i + '].role'),
        status: scalarText(item.status, 'host.team.getMembers[' + i + '].status', false)
      });
    }
    return members;
  }

  function asPromise(work) {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error.message) return String(error.message);
    try { return JSON.stringify(error); } catch (ignored) { return String(error); }
  }

  function resolveElement(target) {
    if (target && target.nodeType === 1) return target;
    if (typeof target === 'string' && root.document) return root.document.querySelector(target);
    return null;
  }

  function closestWithAttribute(node, attribute, boundary) {
    while (node && node !== boundary) {
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute(attribute) != null) return node;
      node = node.parentNode;
    }
    if (boundary && boundary.getAttribute && boundary.getAttribute(attribute) != null) return boundary;
    return null;
  }

  function normalizeMode(value, target, breakpoint) {
    if (value === 'desktop' || value === 'mobile') return value;
    if (target && target.clientWidth && target.clientWidth <= breakpoint) return 'mobile';
    if (root.matchMedia && root.matchMedia('(max-width: ' + breakpoint + 'px)').matches) return 'mobile';
    return 'desktop';
  }

  function valueText(value, preferredKeys) {
    var i;
    if (value == null || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isObject(value)) {
      for (i = 0; i < preferredKeys.length; i += 1) {
        if (value[preferredKeys[i]] != null && value[preferredKeys[i]] !== '') return String(value[preferredKeys[i]]);
      }
      try { return JSON.stringify(value); } catch (ignored) { return String(value); }
    }
    return String(value);
  }

  function validateHost(host) {
    var required = ['getSettings', 'saveSettings', 'applyTheme', 'getUiLang', 'setUiLang', 't'];
    var i;
    if (!host || typeof host !== 'object') throw new TypeError('@skipi/settings: host object is required');
    for (i = 0; i < required.length; i += 1) {
      if (typeof host[required[i]] !== 'function') {
        throw new TypeError('@skipi/settings: host.' + required[i] + ' must be a function');
      }
    }
  }

  function create(host, defaultOptions) {
    validateHost(host);
    defaultOptions = copyObject(defaultOptions);

    var target = null;
    var mounted = false;
    var destroyed = false;
    var listenerAttached = false;
    var resizeAttached = false;
    var resizeObserver = null;
    var resizeTimer = null;
    var renderToken = 0;
    var mountGeneration = 0;
    var settingsRequest = 0;
    var supplementalRequest = 0;
    var saveQueue = Promise.resolve();
    var activeCleanup = null;
    var activeIntegrationMounted = false;
    var sections = [];
    var sectionById = Object.create(null);
    var desktopNavigation = null;
    var desktopNavigationById = Object.create(null);
    var mobileNavigation = null;
    var mobileNavigationById = Object.create(null);
    var navigationHandlers = Object.create(null);
    var options = {};
    var readyResolve;
    var readyReject;
    var ready = new Promise(function (resolve, reject) {
      readyResolve = resolve;
      readyReject = reject;
    });

    var state = {
      settings: {},
      accountSummary: null,
      profile: null,
      identityKey: null,
      trustStatus: null,
      storageInfo: null,
      devices: [],
      devicePairingCode: '',
      teamProfile: null,
      teamRole: '',
      teamMembers: [],
      teamDraft: { name: '', replyTo: '', serverStatus: '', invite: '', invitation: '' },
      theme: 'light',
      language: '',
      mode: 'desktop',
      activeId: null,
      desktopNavigationId: null,
      mobileNavigationId: null,
      mobileOrigin: null,
      mobileList: true,
      loading: true,
      fatal: null,
      optionalErrors: Object.create(null),
      busy: Object.create(null),
      notice: null,
      modulesError: null
    };

    function t(key) {
      var args = Array.prototype.slice.call(arguments, 1);
      var translated;
      try {
        translated = synchronousValue(host.t.apply(host, [key].concat(args)), '@skipi/settings: host.t must be synchronous');
        return translated == null || translated === '' ? key : String(translated);
      } catch (error) {
        return key;
      }
    }

    function notifyError(error, context) {
      if (typeof host.onError === 'function') {
        try { host.onError(error, context); } catch (ignored) {}
      }
    }

    function synchronousValue(value, message) {
      if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(function () {});
        throw new TypeError(message);
      }
      return value;
    }

    function markHandled(error) {
      var handled = error;
      if (!handled || (typeof handled !== 'object' && typeof handled !== 'function')) handled = new Error(errorText(error));
      try { handled.skipiSettingsHandled = true; } catch (ignored) {}
      return handled;
    }

    function cancelledError() {
      var error = new Error('@skipi/settings: instance was unmounted');
      error.skipiSettingsCancelled = true;
      return error;
    }

    function supersededError() {
      var error = new Error('@skipi/settings: request was superseded');
      error.skipiSettingsSuperseded = true;
      return error;
    }

    function assertLive(generation) {
      if (!mounted || destroyed || generation !== mountGeneration) throw cancelledError();
    }

    function setNotice(key, type) {
      state.notice = key ? { key: key, type: type || 'info' } : null;
      if (key && typeof host.notify === 'function') {
        try { host.notify(t(key), type || 'info'); } catch (ignored) {}
      }
    }

    function currentThemeFromSettings(settings) {
      var value = '';
      if (settings && isObject(settings.appearance)) value = settings.appearance.theme;
      if (!value && settings && isObject(settings.interface)) value = settings.interface.theme;
      if (!value && settings) value = settings.theme;
      value = String(value || 'light').toLowerCase();
      return value === 'dark' ? 'dark' : 'light';
    }

    function storageInfoFromSettings(settings) {
      var storage = settings && isObject(settings.storage) ? settings.storage : {};
      var path = storage.path;
      if (!path && settings) path = settings.vault_path || settings.vaultPath || settings.storagePath;
      return path ? { path: path } : null;
    }

    function deviceCapability() {
      return isObject(host.devices) && host.devices.enabled !== false ? host.devices : null;
    }

    function teamCapability() {
      return isObject(host.team) && host.team.enabled !== false ? host.team : null;
    }

    function recoveryCapability() {
      var capability = host.recovery && typeof host.recovery === 'object' ? host.recovery : {};
      return {
        bind: typeof capability.bind === 'function'
          ? function () { return capability.bind(); }
          : (typeof host.bindRecovery === 'function' ? function () { return host.bindRecovery(); } : null),
        recover: typeof capability.recover === 'function'
          ? function () { return capability.recover(); }
          : (typeof host.recoverIdentity === 'function' ? function () { return host.recoverIdentity(); } : null)
      };
    }

    function storageInfoLoader() {
      if (typeof host.getStorageInfo === 'function') return host.getStorageInfo;
      if (host.storage && typeof host.storage.getInfo === 'function') {
        return function () { return host.storage.getInfo(); };
      }
      return null;
    }

    function deviceListLoader() {
      var capability = deviceCapability();
      if (!capability) return null;
      if (typeof capability.getDevices === 'function') return function () { return capability.getDevices(); };
      if (typeof capability.list === 'function') return function () { return capability.list(); };
      return null;
    }

    function accountSummaryLoader() {
      if (typeof host.getAccountSummary === 'function') return host.getAccountSummary;
      return null;
    }

    function loadOptional(name, loader, assign, clear, generation, request) {
      if (typeof loader !== 'function') {
        if (generation != null && (generation !== mountGeneration || destroyed || request !== supplementalRequest)) return Promise.resolve();
        delete state.optionalErrors[name];
        if (typeof clear === 'function') clear();
        return Promise.resolve();
      }
      return asPromise(function () { return loader.call(host); }).then(function (value) {
        if (generation != null && (generation !== mountGeneration || destroyed || request !== supplementalRequest)) return;
        delete state.optionalErrors[name];
        assign(value);
      }, function (error) {
        if (generation != null && (generation !== mountGeneration || destroyed || request !== supplementalRequest)) return;
        state.optionalErrors[name] = error;
        if (typeof clear === 'function') clear();
        notifyError(error, name);
      });
    }

    function supplementalObsolete(generation, request) {
      return generation != null && (generation !== mountGeneration || destroyed || request !== supplementalRequest);
    }

    function loadProfile(generation, request) {
      if (typeof host.getProfile !== 'function') {
        if (!supplementalObsolete(generation, request)) {
          delete state.optionalErrors.profile;
          state.profile = null;
        }
        return Promise.resolve();
      }
      return asPromise(function () { return host.getProfile(); }).then(validateProfile).then(function (profile) {
        if (supplementalObsolete(generation, request)) return;
        delete state.optionalErrors.profile;
        state.profile = profile;
      }).catch(function (error) {
        if (supplementalObsolete(generation, request)) return;
        state.optionalErrors.profile = error;
        state.profile = null;
        notifyError(error, 'profile');
      });
    }

    function clearTeamState() {
      state.teamProfile = null;
      state.teamRole = '';
      state.teamMembers = [];
      state.teamDraft.name = '';
      state.teamDraft.replyTo = '';
      state.teamDraft.serverStatus = '';
    }

    function loadTeam(generation, request) {
      var capability = teamCapability();
      var loadedProfile;
      var loadedRole;
      if (!capability) {
        if (!supplementalObsolete(generation, request)) {
          delete state.optionalErrors.team;
          clearTeamState();
        }
        return Promise.resolve();
      }
      if (typeof capability.getTeam !== 'function') {
        return Promise.reject(new TypeError('@skipi/settings: host.team.getTeam must be a function')).catch(function (error) {
          if (supplementalObsolete(generation, request)) return;
          state.optionalErrors.team = error;
          clearTeamState();
          notifyError(error, 'team');
        });
      }
      return Promise.all([
        asPromise(function () { return capability.getTeam.call(capability); }),
        typeof capability.getRole === 'function'
          ? asPromise(function () { return capability.getRole.call(capability); })
          : Promise.resolve(null)
      ]).then(function (values) {
        loadedProfile = validateTeamProfile(values[0]);
        loadedRole = values[1] == null || values[1] === ''
          ? loadedProfile.role
          : normalizeRole(values[1], 'host.team.getRole result');
        if (loadedRole !== 'administrator') return [];
        if (typeof capability.getMembers !== 'function') {
          throw new TypeError('@skipi/settings: host.team.getMembers must be a function for an administrator');
        }
        return asPromise(function () { return capability.getMembers.call(capability); }).then(validateTeamMembers);
      }).then(function (members) {
        if (supplementalObsolete(generation, request)) return;
        delete state.optionalErrors.team;
        state.teamProfile = loadedProfile;
        state.teamRole = loadedRole;
        state.teamMembers = members;
        state.teamDraft.name = loadedProfile.name;
        state.teamDraft.replyTo = loadedProfile.replyTo;
        state.teamDraft.serverStatus = loadedProfile.serverStatus;
      }, function (error) {
        if (supplementalObsolete(generation, request)) return;
        state.optionalErrors.team = error;
        clearTeamState();
        notifyError(error, 'team');
      });
    }

    function loadSupplemental(generation) {
      var jobs = [];
      var request = supplementalRequest + 1;
      var getTheme = typeof host.getTheme === 'function' ? host.getTheme : null;
      var getAccountSummary = accountSummaryLoader();
      var listDevices = deviceListLoader();
      var getStorageInfo = storageInfoLoader();

      if (generation != null) assertLive(generation);
      supplementalRequest = request;
      jobs.push(loadProfile(generation, request));
      jobs.push(loadTeam(generation, request));
      jobs.push(loadOptional('accountSummary', getAccountSummary, function (value) {
        state.accountSummary = isObject(value) ? value : null;
      }, function () { state.accountSummary = null; }, generation, request));
      jobs.push(loadOptional('identityKey', host.getVaultIdentityKey, function (value) {
        state.identityKey = value;
      }, function () { state.identityKey = null; }, generation, request));
      jobs.push(loadOptional('trustStatus', host.getIdentityTrustStatus, function (value) {
        state.trustStatus = value;
      }, function () { state.trustStatus = null; }, generation, request));
      jobs.push(loadOptional('storageInfo', getStorageInfo, function (value) {
        state.storageInfo = value || storageInfoFromSettings(state.settings);
      }, function () { state.storageInfo = null; }, generation, request));
      jobs.push(loadOptional('devices', listDevices, function (value) {
        state.devices = Array.isArray(value) ? value.slice() : [];
      }, function () { state.devices = []; }, generation, request));
      jobs.push(loadOptional('theme', getTheme, function (value) {
        var normalized = String(value || '').toLowerCase();
        state.theme = normalized === 'dark' ? 'dark' : 'light';
      }, function () { state.theme = currentThemeFromSettings(state.settings); }, generation, request));

      try {
        state.language = String(synchronousValue(host.getUiLang(), '@skipi/settings: host.getUiLang must be synchronous') || '');
      } catch (languageError) {
        state.optionalErrors.language = languageError;
        notifyError(languageError, 'language');
      }
      if (!getTheme) state.theme = currentThemeFromSettings(state.settings);
      if (!getStorageInfo) state.storageInfo = storageInfoFromSettings(state.settings);
      if (!listDevices) {
        var capability = deviceCapability();
        state.devices = capability && Array.isArray(capability.items) ? capability.items.slice() : [];
      }
      return Promise.all(jobs).then(function () { return request === supplementalRequest; });
    }

    function sectionLabel(section) {
      if (section.labelKey) return t(section.labelKey);
      return section.label == null ? section.id : String(section.label);
    }

    function sectionDescription(section) {
      if (section.descriptionKey) return t(section.descriptionKey);
      return section.description == null ? '' : String(section.description);
    }

    function sectionBadge(section) {
      var badge = '';
      try {
        if (typeof section.badge === 'function') {
          badge = synchronousValue(section.badge(sectionContext(section)), '@skipi/settings: section badge must be synchronous');
        } else if (section.badgeKey) {
          badge = t(section.badgeKey);
        } else if (section.badge != null) {
          badge = section.badge;
        }
        badge = synchronousValue(badge, '@skipi/settings: section badge must be synchronous');
        return badge == null ? '' : String(badge);
      } catch (error) {
        notifyError(error, 'sectionBadge:' + section.id);
        return '';
      }
    }

    function sectionIconHtml(section) {
      if (section && !section.appSpecific && Object.prototype.hasOwnProperty.call(GENERIC_ICONS, section.id)) {
        return GENERIC_ICONS[section.id];
      }
      return escapeHtml(section && section.icon || '•');
    }

    function genericSections() {
      var list = [
        {
          id: 'profile', order: 100, icon: 'P', labelKey: 'settings.section.profile',
          descriptionKey: 'settings.section.profile.description', mobileGroupKey: 'settings.group.general', render: renderProfile,
          badge: function () { return valueText(state.trustStatus, ['label', 'status', 'state']); }
        }
      ];
      if (deviceCapability()) {
        list.push({
          id: 'devices', order: 200, icon: 'D', labelKey: 'settings.section.devices',
          descriptionKey: 'settings.section.devices.description', mobileGroupKey: 'settings.group.general', render: renderDevices,
          badge: function () { return state.devices.length ? String(state.devices.length) : ''; }
        });
      }
      list.push({
        id: 'application', order: 300, icon: 'A', labelKey: 'settings.section.application',
        descriptionKey: 'settings.section.application.description', mobileGroupKey: 'settings.group.general', render: renderApplication,
        badge: function () { return t('settings.theme.' + state.theme); }
      });
      if (teamCapability()) {
        list.push({
          id: 'team', order: 400, icon: 'T', labelKey: 'settings.section.team',
          descriptionKey: 'settings.section.team.description', mobileGroupKey: 'settings.group.team', render: renderTeam,
          badge: function () { return roleLabel(state.teamRole); }
        });
      }
      return list;
    }

    function normalizeAppSection(raw, index) {
      var id;
      if (!raw || typeof raw !== 'object') throw new TypeError('@skipi/settings: appSpecificSections[' + index + '] must be an object');
      id = String(raw.id || '');
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new TypeError('@skipi/settings: invalid section id ' + id);
      if (Object.prototype.hasOwnProperty.call(GENERIC_IDS, id)) throw new TypeError('@skipi/settings: reserved section id ' + id);
      if (typeof raw.renderHtml !== 'function') throw new TypeError('@skipi/settings: section ' + id + ' needs renderHtml(ctx)');
      if (raw.handlers != null && !isObject(raw.handlers)) throw new TypeError('@skipi/settings: section ' + id + ' handlers must be an object');
      return {
        id: id,
        order: isFinite(Number(raw.order)) ? Number(raw.order) : 450,
        icon: raw.icon == null ? '•' : String(raw.icon),
        label: raw.label,
        labelKey: raw.labelKey,
        description: raw.description,
        descriptionKey: raw.descriptionKey,
        mobileGroup: raw.mobileGroup,
        mobileGroupKey: raw.mobileGroupKey,
        badge: raw.badge,
        badgeKey: raw.badgeKey,
        renderHtml: raw.renderHtml,
        handlers: raw.handlers || {},
        raw: raw,
        appSpecific: true,
        index: index
      };
    }

    function navigationId(value, path) {
      value = String(value || '');
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
        throw new TypeError('@skipi/settings: invalid ' + path + ' id ' + value);
      }
      return value;
    }

    function navigationAction(value, path) {
      value = String(value || '');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
        throw new TypeError('@skipi/settings: invalid ' + path + ' token ' + value);
      }
      return value;
    }

    function navigationDisplayField(raw, field, path) {
      var value = raw[field];
      var key = raw[field + 'Key'];
      if (key != null && (typeof key !== 'string' && typeof key !== 'number')) {
        throw new TypeError('@skipi/settings: ' + path + '.' + field + 'Key must be text');
      }
      if (value != null && typeof value !== 'function'
          && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new TypeError('@skipi/settings: ' + path + '.' + field + ' must be text or a function');
      }
      return { value: value, key: key == null ? null : String(key) };
    }

    function normalizeNavigationItem(raw, path, surface) {
      var item;
      var sectionId;
      var type;
      var fields = {};
      var displayFields = ['label', 'description', 'value', 'detailLabel', 'detailDescription'];
      var i;
      if (!isObject(raw)) throw new TypeError('@skipi/settings: ' + path + ' must be an object');
      type = surface === 'desktop' ? 'section' : String(raw.type || (raw.sectionId ? 'section' : 'info'));
      if (type !== 'section' && type !== 'info' && type !== 'action') {
        throw new TypeError('@skipi/settings: ' + path + '.type must be section, info or action');
      }
      if (surface === 'desktop' && type !== 'section') {
        throw new TypeError('@skipi/settings: ' + path + ' desktop items must reference sections');
      }
      for (i = 0; i < displayFields.length; i += 1) {
        fields[displayFields[i]] = navigationDisplayField(raw, displayFields[i], path);
      }
      if (raw.when != null && typeof raw.when !== 'function' && typeof raw.when !== 'boolean') {
        throw new TypeError('@skipi/settings: ' + path + '.when must be a boolean or function');
      }
      if (raw.disabled != null && typeof raw.disabled !== 'function' && typeof raw.disabled !== 'boolean') {
        throw new TypeError('@skipi/settings: ' + path + '.disabled must be a boolean or function');
      }
      if (raw.iconKey != null && !/^[a-z][a-z0-9_-]{0,63}$/.test(String(raw.iconKey))) {
        throw new TypeError('@skipi/settings: ' + path + '.iconKey is invalid');
      }
      if (raw.icon != null && typeof raw.icon !== 'string' && typeof raw.icon !== 'number') {
        throw new TypeError('@skipi/settings: ' + path + '.icon must be text');
      }
      item = {
        id: navigationId(raw.id, path),
        type: type,
        iconKey: raw.iconKey == null ? '' : String(raw.iconKey),
        icon: raw.icon == null ? '' : String(raw.icon),
        label: fields.label.value,
        labelKey: fields.label.key,
        description: fields.description.value,
        descriptionKey: fields.description.key,
        value: fields.value.value,
        valueKey: fields.value.key,
        detailLabel: fields.detailLabel.value,
        detailLabelKey: fields.detailLabel.key,
        detailDescription: fields.detailDescription.value,
        detailDescriptionKey: fields.detailDescription.key,
        when: raw.when,
        disabled: raw.disabled,
        optional: raw.optional === true,
        successKey: raw.successKey == null ? '' : String(raw.successKey),
        surface: surface,
        raw: raw
      };
      if (type === 'section') {
        sectionId = canonicalSectionId(raw.sectionId);
        if (!sectionId) throw new TypeError('@skipi/settings: ' + path + '.sectionId is required');
        if (!sectionById[sectionId]) {
          if (item.optional) return null;
          throw new TypeError('@skipi/settings: ' + path + ' references unknown section ' + sectionId);
        }
        item.sectionId = sectionId;
      } else if (type === 'action') {
        item.action = navigationAction(raw.action, path + '.action');
        if (typeof navigationHandlers[item.action] !== 'function') {
          throw new TypeError('@skipi/settings: ' + path + ' references unknown handler ' + item.action);
        }
      }
      return item;
    }

    function buildNavigation() {
      var config = host.settingsNavigation;
      var seen;
      var groupSeen;
      var handlers;
      var i;
      var j;
      var item;
      var group;
      var label;
      desktopNavigation = null;
      desktopNavigationById = Object.create(null);
      mobileNavigation = null;
      mobileNavigationById = Object.create(null);
      navigationHandlers = Object.create(null);
      if (config == null) return;
      if (!isObject(config)) throw new TypeError('@skipi/settings: host.settingsNavigation must be an object');
      handlers = config.handlers == null ? {} : config.handlers;
      if (!isObject(handlers)) throw new TypeError('@skipi/settings: settingsNavigation.handlers must be an object');
      Object.keys(handlers).forEach(function (name) {
        navigationAction(name, 'settingsNavigation.handlers');
        if (typeof handlers[name] !== 'function') {
          throw new TypeError('@skipi/settings: settingsNavigation handler ' + name + ' must be a function');
        }
        navigationHandlers[name] = handlers[name];
      });
      if (Object.prototype.hasOwnProperty.call(config, 'desktop')) {
        if (!Array.isArray(config.desktop)) throw new TypeError('@skipi/settings: settingsNavigation.desktop must be an array');
        desktopNavigation = [];
        seen = Object.create(null);
        for (i = 0; i < config.desktop.length; i += 1) {
          item = normalizeNavigationItem(config.desktop[i], 'settingsNavigation.desktop[' + i + ']', 'desktop');
          if (!item) continue;
          if (seen[item.id]) throw new TypeError('@skipi/settings: duplicate desktop navigation id ' + item.id);
          seen[item.id] = true;
          desktopNavigationById[item.id] = item;
          desktopNavigation.push(item);
        }
      }
      if (Object.prototype.hasOwnProperty.call(config, 'mobile')) {
        if (!Array.isArray(config.mobile)) throw new TypeError('@skipi/settings: settingsNavigation.mobile must be an array');
        mobileNavigation = [];
        seen = Object.create(null);
        groupSeen = Object.create(null);
        for (i = 0; i < config.mobile.length; i += 1) {
          if (!isObject(config.mobile[i])) throw new TypeError('@skipi/settings: settingsNavigation.mobile[' + i + '] must be an object');
          group = {
            id: navigationId(config.mobile[i].id, 'settingsNavigation.mobile[' + i + ']'),
            label: config.mobile[i].label,
            labelKey: config.mobile[i].labelKey == null ? null : String(config.mobile[i].labelKey),
            items: []
          };
          label = navigationDisplayField(config.mobile[i], 'label', 'settingsNavigation.mobile[' + i + ']');
          group.label = label.value;
          group.labelKey = label.key;
          if (groupSeen[group.id]) throw new TypeError('@skipi/settings: duplicate mobile group id ' + group.id);
          groupSeen[group.id] = true;
          if (!Array.isArray(config.mobile[i].items)) {
            throw new TypeError('@skipi/settings: settingsNavigation.mobile[' + i + '].items must be an array');
          }
          for (j = 0; j < config.mobile[i].items.length; j += 1) {
            item = normalizeNavigationItem(config.mobile[i].items[j], 'settingsNavigation.mobile[' + i + '].items[' + j + ']', 'mobile');
            if (!item) continue;
            if (seen[item.id]) throw new TypeError('@skipi/settings: duplicate mobile navigation id ' + item.id);
            seen[item.id] = true;
            mobileNavigationById[item.id] = item;
            group.items.push(item);
          }
          mobileNavigation.push(group);
        }
      }
    }

    function buildSections() {
      var appSections;
      var combined;
      var seen;
      var i;
      var previousSections = sections;
      var previousSectionById = sectionById;
      var previousDesktopNavigation = desktopNavigation;
      var previousDesktopNavigationById = desktopNavigationById;
      var previousMobileNavigation = mobileNavigation;
      var previousMobileNavigationById = mobileNavigationById;
      var previousNavigationHandlers = navigationHandlers;
      try {
        if (host.languages != null && !Array.isArray(host.languages)) {
          throw new TypeError('@skipi/settings: host.languages must be an array');
        }
        if (host.appSpecificSections != null && !Array.isArray(host.appSpecificSections)) {
          throw new TypeError('@skipi/settings: host.appSpecificSections must be an array');
        }
        appSections = host.appSpecificSections || [];
        combined = genericSections();
        seen = Object.create(null);
        for (i = 0; i < appSections.length; i += 1) combined.push(normalizeAppSection(appSections[i], i));
        combined.sort(function (left, right) {
          if (left.order !== right.order) return left.order - right.order;
          if (!!left.appSpecific !== !!right.appSpecific) return left.appSpecific ? 1 : -1;
          return (left.index || 0) - (right.index || 0);
        });
        sectionById = Object.create(null);
        sections = [];
        for (i = 0; i < combined.length; i += 1) {
          if (seen[combined[i].id]) throw new TypeError('@skipi/settings: duplicate section id ' + combined[i].id);
          seen[combined[i].id] = true;
          sectionById[combined[i].id] = combined[i];
          sections.push(combined[i]);
        }
        buildNavigation();
      } catch (error) {
        sections = previousSections;
        sectionById = previousSectionById;
        desktopNavigation = previousDesktopNavigation;
        desktopNavigationById = previousDesktopNavigationById;
        mobileNavigation = previousMobileNavigation;
        mobileNavigationById = previousMobileNavigationById;
        navigationHandlers = previousNavigationHandlers;
        throw error;
      }
    }

    function sectionContext(section) {
      return {
        version: VERSION,
        mode: state.mode,
        sectionId: section ? section.id : state.activeId,
        settings: state.settings,
        accountSummary: state.accountSummary,
        theme: state.theme,
        language: state.language,
        host: host,
        t: t,
        escapeHtml: escapeHtml,
        escapeAttr: escapeAttr,
        refresh: refresh,
        open: open,
        showList: showList,
        saveSettings: saveSettingsFromSection,
        run: function (name, work, successKey) {
          return runBusy('app:' + (section ? section.id : 'unknown') + ':' + name, work, successKey).then(function (value) {
            return value === SKIPPED ? false : value;
          });
        }
      };
    }

    function navigationContext(item, surface) {
      var context = sectionContext(item && item.sectionId ? sectionById[item.sectionId] : null);
      context.surface = surface || (item && item.surface) || state.mode;
      context.menuItemId = item ? item.id : null;
      return context;
    }

    function resolveNavigationValue(item, field, surface, fallback) {
      var value;
      var key = item && item[field + 'Key'];
      if (!item) return fallback == null ? '' : String(fallback);
      if (key) return t(key);
      value = item[field];
      try {
        value = typeof value === 'function' ? value(navigationContext(item, surface)) : value;
        value = synchronousValue(value, '@skipi/settings: navigation ' + item.id + ' ' + field + ' resolver must be synchronous');
        return value == null ? (fallback == null ? '' : String(fallback)) : String(value);
      } catch (error) {
        notifyError(error, 'navigation:' + item.id + ':' + field);
        return fallback == null ? '' : String(fallback);
      }
    }

    function navigationVisible(item, surface) {
      var value;
      if (!item || item.when == null) return true;
      try {
        value = typeof item.when === 'function' ? item.when(navigationContext(item, surface)) : item.when;
        value = synchronousValue(value, '@skipi/settings: navigation ' + item.id + ' when resolver must be synchronous');
        return !!value;
      } catch (error) {
        notifyError(error, 'navigation:' + item.id + ':when');
        return false;
      }
    }

    function navigationDisabled(item, surface) {
      var value;
      if (!item || item.disabled == null) return false;
      try {
        value = typeof item.disabled === 'function' ? item.disabled(navigationContext(item, surface)) : item.disabled;
        value = synchronousValue(value, '@skipi/settings: navigation ' + item.id + ' disabled resolver must be synchronous');
        return !!value;
      } catch (error) {
        notifyError(error, 'navigation:' + item.id + ':disabled');
        return true;
      }
    }

    function navigationLabel(item, surface) {
      return resolveNavigationValue(item, 'label', surface, item ? item.id : '');
    }

    function navigationDetailLabel(item, section, surface) {
      if (item && (item.detailLabelKey || item.detailLabel != null)) {
        return resolveNavigationValue(item, 'detailLabel', surface, navigationLabel(item, surface));
      }
      return item ? navigationLabel(item, surface) : sectionLabel(section);
    }

    function navigationDetailDescription(item, section, surface) {
      if (item && (item.detailDescriptionKey || item.detailDescription != null)) {
        return resolveNavigationValue(item, 'detailDescription', surface, '');
      }
      return sectionDescription(section);
    }

    function navigationIconHtml(item) {
      var key = item && item.iconKey;
      if (key && Object.prototype.hasOwnProperty.call(NAVIGATION_ICONS, key)) return NAVIGATION_ICONS[key];
      if (item && item.icon) return escapeHtml(item.icon);
      if (item && item.sectionId && sectionById[item.sectionId]) return sectionIconHtml(sectionById[item.sectionId]);
      return escapeHtml('•');
    }

    function findNavigationForSection(list, sectionId, surface) {
      var i;
      if (!list || !sectionId) return null;
      for (i = 0; i < list.length; i += 1) {
        if (list[i].type === 'section' && list[i].sectionId === sectionId
            && navigationVisible(list[i], surface) && !navigationDisabled(list[i], surface)) return list[i];
      }
      return null;
    }

    function mobileNavigationItems() {
      var items = [];
      if (!mobileNavigation) return items;
      mobileNavigation.forEach(function (group) {
        group.items.forEach(function (item) { items.push(item); });
      });
      return items;
    }

    function firstNavigationSection(surface) {
      var list = surface === 'desktop' ? desktopNavigation : mobileNavigationItems();
      var i;
      if (!list) return null;
      for (i = 0; i < list.length; i += 1) {
        if (list[i].type === 'section' && navigationVisible(list[i], surface) && !navigationDisabled(list[i], surface)) return list[i];
      }
      return null;
    }

    function normalizeActiveNavigation(preserveUnrepresented) {
      var item;
      var first;
      if (desktopNavigation) {
        item = desktopNavigationById[state.desktopNavigationId];
        if (!item || item.sectionId !== state.activeId || !navigationVisible(item, 'desktop') || navigationDisabled(item, 'desktop')) {
          item = findNavigationForSection(desktopNavigation, state.activeId, 'desktop');
        }
        if (!item && state.mode === 'desktop' && !preserveUnrepresented) {
          first = firstNavigationSection('desktop');
          if (first) {
            state.activeId = first.sectionId;
            item = first;
          }
        }
        state.desktopNavigationId = item ? item.id : null;
      } else {
        state.desktopNavigationId = null;
      }
      if (mobileNavigation && state.mobileNavigationId) {
        item = mobileNavigationById[state.mobileNavigationId];
        if (!item || (item.type === 'section' && item.sectionId !== state.activeId)
            || !navigationVisible(item, 'mobile') || navigationDisabled(item, 'mobile')) {
          state.mobileNavigationId = null;
          if (state.mobileOrigin === 'menu') state.mobileOrigin = null;
          if (state.mode === 'mobile' && !state.mobileList) state.mobileList = true;
        }
      } else if (!mobileNavigation) {
        state.mobileNavigationId = null;
        state.mobileOrigin = null;
      }
    }

    function saveSettingsFromSection(nextSettings) {
      var generation = mountGeneration;
      var operation;
      var focusDescriptor = captureOwnedFocus();
      if (!isObject(nextSettings)) return Promise.reject(new TypeError('@skipi/settings: saveSettings expects an object'));
      if (!mounted || destroyed) return Promise.reject(cancelledError());
      settingsRequest += 1;
      operation = saveQueue.catch(function () {}).then(function () {
        assertLive(generation);
        return asPromise(function () { return host.saveSettings(nextSettings); });
      }).then(function (saved) {
        var wasMobileDetail = state.mode === 'mobile' && !state.mobileList;
        assertLive(generation);
        state.settings = isObject(saved) ? saved : nextSettings;
        return loadSupplemental(generation).then(function () {
          assertLive(generation);
          buildSections();
          if (!sectionById[state.activeId]) {
            var first = firstNavigationSection(state.mode);
            state.activeId = first ? first.sectionId : (sections.length ? sections[0].id : null);
          }
          normalizeActiveNavigation();
          setNotice('settings.notice.saved', 'success');
          draw();
          if (wasMobileDetail && state.mobileList) focusModeAnchor();
          restoreOwnedFocus(focusDescriptor);
          return state.settings;
        });
      }).catch(function (error) {
        if (!mounted || destroyed || generation !== mountGeneration) throw cancelledError();
        if (error && error.skipiSettingsCancelled) throw error;
        notifyError(error, 'saveSettings');
        setNotice('settings.error.action_failed', 'error');
        draw();
        restoreOwnedFocus(focusDescriptor);
        throw markHandled(error);
      });
      saveQueue = operation.then(function () {}, function () {});
      return operation;
    }

    function controlButton(action, labelKey, kind, value, disabled) {
      return '<button type="button" class="skipi-settings__button' + (kind ? ' skipi-settings__button--' + escapeAttr(kind) : '') + '"'
        + ' data-settings-action="' + escapeAttr(action) + '"'
        + (value == null ? '' : ' data-settings-value="' + escapeAttr(value) + '"')
        + (disabled ? ' disabled aria-disabled="true"' : '') + '>' + escapeHtml(t(labelKey)) + '</button>';
    }

    function statusBadge(value, kind) {
      if (value == null || value === '') return '';
      return '<span class="skipi-settings__badge' + (kind ? ' skipi-settings__badge--' + escapeAttr(kind) : '') + '">' + escapeHtml(value) + '</span>';
    }

    function canClose() {
      return typeof options.onClose === 'function' || typeof host.onClose === 'function';
    }

    function closeButtonHtml() {
      if (!canClose()) return '';
      return '<button type="button" class="skipi-settings__close" data-settings-action="close" aria-label="' + escapeAttr(t('settings.action.close')) + '"><span aria-hidden="true">×</span></button>';
    }

    function initials(value) {
      var words = String(value || '').replace(/^\s+|\s+$/g, '').split(/\s+/);
      var out = '';
      var i;
      for (i = 0; i < words.length && i < 2; i += 1) {
        if (words[i]) out += words[i].charAt(0).toUpperCase();
      }
      return out || 'S';
    }

    function mobileProfileHtml() {
      var summary = isObject(state.accountSummary) ? state.accountSummary : {};
      var name = valueText(summary, ['displayName', 'name', 'label']) || String(host.appName || t('settings.title'));
      var subtitle = valueText(summary, ['subtitle', 'email', 'description']);
      var avatarText = valueText(summary, ['avatarText', 'initials']) || initials(name);
      var avatarUrl = summary.avatarUrl == null ? '' : String(summary.avatarUrl);
      var sectionId = canonicalSectionId(summary.sectionId);
      var linkedSection = sectionById[sectionId];
      var avatar = avatarUrl
        ? '<img class="skipi-settings__mobile-avatar-image" src="' + escapeAttr(avatarUrl) + '" alt="" referrerpolicy="no-referrer">'
        : '<span aria-hidden="true">' + escapeHtml(avatarText) + '</span>';
      var avatarControl = linkedSection
        ? '<button type="button" class="skipi-settings__mobile-avatar-action" data-settings-action="profile-section" data-settings-value="' + escapeAttr(sectionId) + '" aria-label="' + escapeAttr(sectionLabel(linkedSection)) + '"><span class="skipi-settings__mobile-avatar">' + avatar + '</span><span class="skipi-settings__mobile-avatar-edit" aria-hidden="true">✎</span></button>'
        : '<div class="skipi-settings__mobile-avatar">' + avatar + '</div>';
      return '<div class="skipi-settings__mobile-profile">'
        + avatarControl
        + '<h1 class="skipi-settings__mobile-profile-name">' + escapeHtml(name) + '</h1>'
        + (subtitle ? '<p class="skipi-settings__mobile-profile-subtitle">' + escapeHtml(subtitle) + '</p>' : '')
        + '</div>';
    }

    function mobileGroupMeta(section) {
      return navigationBlockMeta(section);
    }

    function navigationBlockMeta(section) {
      var key;
      if (section && section.id === 'team') key = 'settings.group.team';
      else if (section && section.appSpecific) key = 'settings.group.home_settings';
      else key = 'settings.group.general';
      return { id: 'key:' + key, label: t(key), key: key };
    }

    function codeValue(value) {
      return '<code class="skipi-settings__code">' + escapeHtml(value || '—') + '</code>';
    }

    function row(labelKey, descriptionKey, control, qa) {
      return '<div class="skipi-settings__row"' + (qa ? ' data-qa="' + escapeAttr(qa) + '"' : '') + '>'
        + '<div class="skipi-settings__row-copy"><div class="skipi-settings__row-label">' + escapeHtml(t(labelKey)) + '</div>'
        + (descriptionKey ? '<div class="skipi-settings__row-description">' + escapeHtml(t(descriptionKey)) + '</div>' : '')
        + '</div><div class="skipi-settings__row-control">' + (control || '') + '</div></div>';
    }

    function valueRow(labelKey, descriptionKey, value, qa) {
      return row(labelKey, descriptionKey, codeValue(value), qa);
    }

    function group(titleKey, content, qa) {
      return '<section class="skipi-settings__section"' + (qa ? ' data-qa="' + escapeAttr(qa) + '"' : '') + '>'
        + '<h3 class="skipi-settings__section-title">' + escapeHtml(t(titleKey)) + '</h3>'
        + '<div class="skipi-settings__group">' + content + '</div></section>';
    }

    function emptyState(key) {
      return '<div class="skipi-settings__empty">' + escapeHtml(t(key)) + '</div>';
    }

    function capabilityErrorHtml() {
      return '<div class="skipi-settings__error" role="alert"><div class="skipi-settings__error-copy">'
        + escapeHtml(t('settings.error.capability_failed')) + '</div>'
        + controlButton('supplemental-refresh', 'settings.action.retry', 'secondary', null, !!state.busy['supplemental-refresh']) + '</div>';
    }

    function roleLabel(role) {
      if (role === 'administrator') return t('settings.team.role.administrator');
      if (role === 'member') return t('settings.team.role.member');
      return t('settings.value.unavailable');
    }

    function inputControl(change, value, type, placeholderKey, disabled) {
      return '<input class="skipi-settings__input" type="' + escapeAttr(type || 'text') + '" data-settings-change="' + escapeAttr(change) + '" value="' + escapeAttr(value || '') + '"'
        + (placeholderKey ? ' placeholder="' + escapeAttr(t(placeholderKey)) + '"' : '')
        + (disabled ? ' disabled aria-disabled="true"' : '') + '>';
    }

    function literalValueRow(label, value, qa) {
      return '<div class="skipi-settings__row"' + (qa ? ' data-qa="' + escapeAttr(qa) + '"' : '') + '>'
        + '<div class="skipi-settings__row-copy"><div class="skipi-settings__row-label">' + escapeHtml(label) + '</div></div>'
        + '<div class="skipi-settings__row-control">' + codeValue(value) + '</div></div>';
    }

    function renderProfile() {
      var profile = isObject(state.profile) ? state.profile : {};
      var user = isObject(profile.user) ? profile.user : {};
      var entity = isObject(profile.entity) ? profile.entity : {};
      var unavailable = t('settings.value.unavailable');
      var userRows = valueRow('settings.profile.user.id', 'settings.profile.user.id.description', user.id || unavailable, 'settings.profile.user.id')
        + valueRow('settings.profile.user.email', '', user.email || unavailable, 'settings.profile.user.email')
        + valueRow('settings.profile.user.phone', '', user.phone || unavailable, 'settings.profile.user.phone');
      var entityRows;
      var i;
      var detail;
      if (teamCapability()) {
        userRows += row('settings.profile.team_role', 'settings.profile.team_role.description',
          '<div class="skipi-settings__actions">' + codeValue(roleLabel(state.teamRole))
          + controlButton('profile-team', 'settings.action.open_team', 'secondary', null, !state.teamProfile) + '</div>',
          'settings.profile.team_role');
      }
      entityRows = valueRow('settings.profile.entity.type', '', entity.type
        ? t('settings.profile.entity.type.' + entity.type) : unavailable, 'settings.profile.entity.type');
      if (entity.type !== 'person') {
        entityRows += valueRow('settings.profile.entity.name', '', entity.name || unavailable, 'settings.profile.entity.name');
      }
      if (entity.type === 'company') {
        entityRows += valueRow('settings.profile.entity.jurisdiction', '', entity.jurisdiction || unavailable, 'settings.profile.entity.jurisdiction')
          + valueRow('settings.profile.entity.verified_level', '', entity.verifiedLevel || unavailable, 'settings.profile.entity.verified_level');
      }
      if (entity.type === 'vessel') {
        entityRows += valueRow('settings.profile.entity.imo', '', entity.imo || unavailable, 'settings.profile.entity.imo');
      }
      for (i = 0; i < (entity.details || []).length; i += 1) {
        detail = entity.details[i];
        entityRows += literalValueRow(detail.labelKey ? t(detail.labelKey) : detail.label, detail.value, 'settings.profile.entity.detail');
      }
      return (state.optionalErrors.profile ? capabilityErrorHtml() : '')
        + group('settings.profile.user.title', userRows, 'settings.profile.user')
        + group('settings.profile.entity.title', entityRows, 'settings.profile.entity')
        + renderIdentity();
    }

    function renderTeam() {
      var capability = teamCapability() || {};
      var profile = isObject(state.teamProfile) ? state.teamProfile : {};
      var administrator = state.teamRole === 'administrator';
      var profileRows;
      var memberRows = '';
      var i;
      var member;
      if (administrator) {
        profileRows = row('settings.team.name', '', inputControl('team-name', state.teamDraft.name, 'text', '', !!state.busy['team-save']), 'settings.team.name')
          + row('settings.team.reply_to', '', inputControl('team-reply-to', state.teamDraft.replyTo, 'email', '', !!state.busy['team-save']), 'settings.team.reply_to')
          + row('settings.team.server_status', '', inputControl('team-server-status', state.teamDraft.serverStatus, 'text', '', !!state.busy['team-save']), 'settings.team.server_status')
          + row('settings.team.save', 'settings.team.save.description',
            controlButton('team-save', 'settings.action.save', 'primary', null, typeof capability.updateTeam !== 'function' || !!state.busy['team-save']),
            'settings.team.save');
      } else {
        profileRows = valueRow('settings.team.name', '', profile.name || t('settings.value.unavailable'), 'settings.team.name')
          + valueRow('settings.team.reply_to', '', profile.replyTo || t('settings.value.unavailable'), 'settings.team.reply_to')
          + valueRow('settings.team.server_status', '', profile.serverStatus || t('settings.value.unavailable'), 'settings.team.server_status');
      }
      for (i = 0; administrator && i < state.teamMembers.length; i += 1) {
        member = state.teamMembers[i];
        memberRows += '<div class="skipi-settings__row" data-qa="settings.team.member">'
          + '<div class="skipi-settings__row-copy"><div class="skipi-settings__row-label">' + escapeHtml(member.name) + '</div>'
          + (member.status ? '<div class="skipi-settings__row-description">' + escapeHtml(member.status) + '</div>' : '') + '</div>'
          + '<div class="skipi-settings__row-control">' + statusBadge(roleLabel(member.role), '')
          + (typeof capability.remove === 'function'
            ? controlButton('team-remove', 'settings.action.remove', 'danger', member.id, !!state.busy['team-remove:' + member.id]) : '')
          + '</div></div>';
      }
      if (administrator && !memberRows) memberRows = emptyState('settings.team.members.empty');
      if (administrator) {
        memberRows += row('settings.team.invite', 'settings.team.invite.description',
          '<div class="skipi-settings__actions">' + inputControl('team-invite', state.teamDraft.invite, 'email', 'settings.team.invite.placeholder', !!state.busy['team-invite'])
          + controlButton('team-invite', 'settings.action.invite', 'primary', null, typeof capability.invite !== 'function' || !!state.busy['team-invite']) + '</div>',
          'settings.team.invite');
      }
      return (state.optionalErrors.team ? capabilityErrorHtml() : '')
        + group('settings.team.profile.title', profileRows, 'settings.team.profile')
        + group('settings.team.role.title',
          valueRow('settings.team.current_role', '', roleLabel(state.teamRole), 'settings.team.current_role'),
          'settings.team.role')
        + (administrator ? group('settings.team.members.title', memberRows, 'settings.team.members') : '')
        + (state.teamRole === 'member'
          ? group('settings.team.join.title',
            row('settings.team.join', 'settings.team.join.description',
              '<div class="skipi-settings__actions">' + inputControl('team-invitation', state.teamDraft.invitation, 'text', 'settings.team.join.placeholder', !!state.busy['team-join'])
              + controlButton('team-join', 'settings.action.join', 'primary', null, typeof capability.join !== 'function' || !!state.busy['team-join']) + '</div>',
              'settings.team.join'),
            'settings.team.join.root')
          : '');
    }

    function renderModules() {
      if (state.modulesError) {
        return group('settings.modules.title',
          '<div class="skipi-settings__state is-error"><div>' + escapeHtml(t('settings.modules.mount_error')) + '</div>'
          + controlButton('modules-retry', 'settings.action.retry', 'secondary', null, false) + '</div>',
          'settings.modules.root');
      }
      return group('settings.modules.title',
        '<div class="skipi-settings__row skipi-settings__row--stack"><div class="skipi-settings__row-copy">'
        + '<div class="skipi-settings__row-label">' + escapeHtml(t('settings.modules.mount_label')) + '</div>'
        + '<div class="skipi-settings__row-description">' + escapeHtml(t('settings.modules.mount_description')) + '</div></div>'
        + '<div class="skipi-settings__mount" data-settings-modules-mount data-qa="settings.modules.mount">'
        + (typeof host.modulesMount === 'function' ? emptyState('settings.loading') : emptyState('settings.modules.unavailable'))
        + '</div></div>', 'settings.modules.root');
    }

    function renderIdentity() {
      var key = valueText(state.identityKey, ['fingerprint', 'publicKey', 'key', 'id']);
      var trust = valueText(state.trustStatus, ['label', 'status', 'state']);
      var connection = '';
      var recovery = recoveryCapability();
      if (isObject(state.trustStatus) && typeof state.trustStatus.connected === 'boolean') {
        connection = t(state.trustStatus.connected ? 'settings.identity.connected' : 'settings.identity.not_connected');
      } else if (isObject(state.trustStatus) && state.trustStatus.connection != null) {
        connection = valueText(state.trustStatus.connection, ['label', 'status', 'state']);
      }
      var accessRows = valueRow('settings.identity.key', 'settings.identity.key.description', key || t('settings.value.unavailable'), 'settings.identity.key')
        + valueRow('settings.identity.trust', 'settings.identity.trust.description', trust || t('settings.value.unavailable'), 'settings.identity.trust')
        + valueRow('settings.identity.connection', 'settings.identity.connection.description', connection || t('settings.value.unavailable'), 'settings.identity.connection')
        + row('settings.identity.refresh', 'settings.identity.refresh.description',
          controlButton('identity-refresh', 'settings.action.refresh', 'secondary', null, !!state.busy['identity-refresh']), 'settings.identity.refresh');
      var recoveryRows = row('settings.identity.recovery.bind', 'settings.identity.recovery.bind.description',
          controlButton('recovery-bind', 'settings.action.bind', 'secondary', null, typeof recovery.bind !== 'function' || !!state.busy['recovery-bind']), 'settings.identity.recovery.bind')
        + row('settings.identity.recovery.recover', 'settings.identity.recovery.recover.description',
          controlButton('recovery-recover', 'settings.action.recover', 'secondary', null, typeof recovery.recover !== 'function' || !!state.busy['recovery-recover']), 'settings.identity.recovery.recover');
      return (state.optionalErrors.identityKey || state.optionalErrors.trustStatus ? capabilityErrorHtml() : '')
        + group('settings.identity.access_title', accessRows, 'settings.identity.root')
        + group('settings.identity.recovery_title', recoveryRows, 'settings.identity.recovery');
    }

    function renderStorage() {
      var info = isObject(state.storageInfo) ? state.storageInfo : {};
      var path = valueText(info.path || info.location || '', ['path', 'label']);
      var rows = valueRow('settings.storage.location', 'settings.storage.location.description', path || t('settings.value.unavailable'), 'settings.storage.location')
        + row('settings.storage.export', 'settings.storage.export.description',
          controlButton('storage-export', 'settings.action.export', 'secondary', null, typeof host.exportVaultBackup !== 'function' || !!state.busy['storage-export']), 'settings.storage.export')
        + row('settings.storage.import', 'settings.storage.import.description',
          controlButton('storage-import', 'settings.action.import', 'secondary', null, typeof host.importVaultBackup !== 'function' || !!state.busy['storage-import']), 'settings.storage.import');
      return (state.optionalErrors.storageInfo ? capabilityErrorHtml() : '')
        + group('settings.storage.vault_title', rows, 'settings.storage.root');
    }

    function renderDevices() {
      var capability = deviceCapability() || {};
      var rows = '';
      var i;
      var device;
      var id;
      var name;
      var status;
      for (i = 0; i < state.devices.length; i += 1) {
        device = state.devices[i] || {};
        id = valueText(device.id, ['id']);
        name = valueText(device.name || device.label, ['name', 'label']) || t('settings.devices.unnamed');
        status = valueText(device.status, ['label', 'status', 'state']);
        rows += '<div class="skipi-settings__row" data-qa="settings.devices.item">'
          + '<div class="skipi-settings__row-copy"><div class="skipi-settings__row-label">' + escapeHtml(name) + '</div>'
          + (status ? '<div class="skipi-settings__row-description">' + escapeHtml(status) + '</div>' : '') + '</div>'
          + '<div class="skipi-settings__row-control">'
          + (device.current ? statusBadge(t('settings.devices.current'), 'success') : '')
          + (!device.current && id && typeof capability.revoke === 'function'
            ? controlButton('device-revoke', 'settings.action.revoke', 'danger', id, !!state.busy['device-revoke:' + id]) : '')
          + '</div></div>';
      }
      if (!rows) rows = state.optionalErrors.devices ? capabilityErrorHtml() : emptyState('settings.devices.empty');
      if (state.devicePairingCode) {
        rows += valueRow('settings.devices.one_time_code', 'settings.devices.one_time_code.description',
          valueText(state.devicePairingCode, ['code', 'value']), 'settings.devices.one_time_code');
      }
      rows += row('settings.devices.add', 'settings.devices.add.description',
        '<div class="skipi-settings__actions">'
        + controlButton('device-pair', 'settings.action.pair', 'primary', null, typeof capability.pair !== 'function' || !!state.busy['device-pair'])
        + controlButton('device-scan', 'settings.action.scan', 'secondary', null, typeof capability.scan !== 'function' || !!state.busy['device-scan'])
        + controlButton('device-code', 'settings.action.create_code', 'secondary', null, typeof capability.createPairingCode !== 'function' || !!state.busy['device-code'])
        + '</div>', 'settings.devices.add');
      return group('settings.devices.title', rows, 'settings.devices.root');
    }

    function languageOptions() {
      var configured;
      var found = false;
      configured = host.languages ? host.languages.slice() : [
        { value: 'en', labelKey: 'settings.language.en' },
        { value: 'ru', labelKey: 'settings.language.ru' }
      ];
      configured = configured.filter(function (item) {
        if (!item || item.value == null) return false;
        if (String(item.value) === state.language) found = true;
        return true;
      });
      if (state.language && !found) configured.push({ value: state.language, label: state.language });
      return configured;
    }

    function renderAppearance() {
      var languages = languageOptions();
      var themeControl = '<div class="skipi-settings__segmented" role="group" aria-label="' + escapeAttr(t('settings.appearance.theme')) + '">'
        + '<button type="button" class="skipi-settings__segment' + (state.theme === 'light' ? ' is-active' : '') + '" data-settings-action="theme" data-settings-value="light" aria-pressed="' + (state.theme === 'light' ? 'true' : 'false') + '"' + (state.busy.theme ? ' disabled' : '') + '>' + escapeHtml(t('settings.theme.light')) + '</button>'
        + '<button type="button" class="skipi-settings__segment' + (state.theme === 'dark' ? ' is-active' : '') + '" data-settings-action="theme" data-settings-value="dark" aria-pressed="' + (state.theme === 'dark' ? 'true' : 'false') + '"' + (state.busy.theme ? ' disabled' : '') + '>' + escapeHtml(t('settings.theme.dark')) + '</button></div>';
      var select = '<select class="skipi-settings__select" data-settings-change="language" aria-label="' + escapeAttr(t('settings.appearance.language')) + '"' + (state.busy.language ? ' disabled' : '') + '>';
      languages.forEach(function (language) {
        var label = language.labelKey ? t(language.labelKey) : (language.label == null ? language.value : language.label);
        select += '<option value="' + escapeAttr(language.value) + '"' + (String(language.value) === state.language ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      });
      select += '</select>';
      return group('settings.appearance.title',
        row('settings.appearance.theme', 'settings.appearance.theme.description', themeControl, 'settings.appearance.theme')
        + row('settings.appearance.language', 'settings.appearance.language.description', select, 'settings.appearance.language'),
        'settings.appearance.root');
    }

    function renderAbout() {
      var about = host.about;
      var description = '';
      var extra = '';
      if (typeof about === 'string' || typeof about === 'number') description = String(about);
      if (isObject(about)) {
        description = valueText(about.description, ['description']);
        if (about.support) extra += valueRow('settings.about.support', '', String(about.support), 'settings.about.support');
        if (about.website) extra += valueRow('settings.about.website', '', String(about.website), 'settings.about.website');
        if (about.legal) extra += valueRow('settings.about.legal', '', String(about.legal), 'settings.about.legal');
      }
      return group('settings.about.title',
        valueRow('settings.about.app_name', '', host.appName || t('settings.value.unavailable'), 'settings.about.name')
        + valueRow('settings.about.version', '', host.appVersion || t('settings.value.unavailable'), 'settings.about.version')
        + (description ? '<div class="skipi-settings__row"><div class="skipi-settings__about-copy">' + escapeHtml(description) + '</div></div>' : '')
        + extra, 'settings.about.root');
    }

    function renderApplication() {
      return renderAppearance()
        + renderStorage()
        + (typeof host.modulesMount === 'function' ? renderModules() : '')
        + renderAbout();
    }

    function renderAppSpecific(section) {
      var html;
      try {
        html = section.renderHtml(sectionContext(section));
        html = synchronousValue(html, '@skipi/settings: renderHtml must return a string synchronously');
        return html == null ? '' : String(html);
      } catch (error) {
        notifyError(error, 'renderHtml:' + section.id);
        return '<div class="skipi-settings__state skipi-settings__state--error">' + escapeHtml(t('settings.error.section_failed')) + '</div>';
      }
    }

    function renderSectionContent(section) {
      if (!section) return emptyState('settings.error.section_missing');
      return section.appSpecific ? renderAppSpecific(section) : section.render(sectionContext(section));
    }

    function noticeHtml() {
      if (!state.notice) return '';
      return '<div class="skipi-settings__notice skipi-settings__notice--' + escapeAttr(state.notice.type) + '" role="status">'
        + escapeHtml(t(state.notice.key)) + '</div>';
    }

    function desktopHtml() {
      var section = sectionById[state.activeId] || sections[0];
      var activeNavigation = null;
      var nav = '';
      var navByBlock = {
        'settings.group.general': '',
        'settings.group.team': '',
        'settings.group.home_settings': ''
      };
      var blockOrder = ['settings.group.general', 'settings.group.team', 'settings.group.home_settings'];
      var detailLabel;
      var detailDescription;
      if (desktopNavigation) {
        activeNavigation = desktopNavigationById[state.desktopNavigationId];
        if (!activeNavigation || activeNavigation.sectionId !== (section && section.id) || !navigationVisible(activeNavigation, 'desktop')) {
          activeNavigation = findNavigationForSection(desktopNavigation, section && section.id, 'desktop');
        }
        state.desktopNavigationId = activeNavigation ? activeNavigation.id : null;
        desktopNavigation.forEach(function (item) {
          var active;
          var description;
          var disabled;
          if (!navigationVisible(item, 'desktop')) return;
          active = !!activeNavigation && item.id === activeNavigation.id;
          description = resolveNavigationValue(item, 'description', 'desktop', '');
          disabled = navigationDisabled(item, 'desktop');
          var itemHtml = '<button type="button" class="skipi-settings__nav-item skipi-settings__nav-item--configured' + (active ? ' is-active' : '') + '" data-settings-action="desktop-section" data-settings-value="' + escapeAttr(item.id) + '" data-settings-menu-id="' + escapeAttr(item.id) + '"'
            + ' aria-current="' + (active ? 'page' : 'false') + '"' + (disabled ? ' disabled aria-disabled="true"' : '') + ' data-qa="settings.nav.' + escapeAttr(item.id) + '">'
            + '<span class="skipi-settings__nav-icon" aria-hidden="true">' + navigationIconHtml(item) + '</span>'
            + '<span class="skipi-settings__nav-copy"><span class="skipi-settings__nav-label">' + escapeHtml(navigationLabel(item, 'desktop')) + '</span>'
            + (description ? '<span class="skipi-settings__nav-description">' + escapeHtml(description) + '</span>' : '') + '</span></button>';
          navByBlock[navigationBlockMeta(sectionById[item.sectionId]).key] += itemHtml;
        });
      } else {
        state.desktopNavigationId = null;
        sections.forEach(function (item) {
          var active = section && item.id === section.id;
          var badge = sectionBadge(item);
          var itemHtml = '<button type="button" class="skipi-settings__nav-item' + (active ? ' is-active' : '') + '" data-settings-action="section" data-settings-value="' + escapeAttr(item.id) + '"'
            + ' aria-current="' + (active ? 'page' : 'false') + '" data-qa="settings.nav.' + escapeAttr(item.id) + '">'
            + '<span class="skipi-settings__nav-icon" aria-hidden="true">' + sectionIconHtml(item) + '</span>'
            + '<span class="skipi-settings__nav-copy"><span class="skipi-settings__nav-label">' + escapeHtml(sectionLabel(item)) + '</span>'
            + '<span class="skipi-settings__nav-description">' + escapeHtml(sectionDescription(item)) + '</span></span>'
            + (badge ? statusBadge(badge, '') : '') + '</button>';
          navByBlock[navigationBlockMeta(item).key] += itemHtml;
        });
      }
      blockOrder.forEach(function (key) {
        if (!navByBlock[key]) return;
        nav += '<section class="skipi-settings__nav-section" data-settings-nav-block="' + escapeAttr(key) + '">'
          + '<h2 class="skipi-settings__nav-title">' + escapeHtml(t(key)) + '</h2>'
          + '<div class="skipi-settings__nav-group">' + navByBlock[key] + '</div></section>';
      });
      detailLabel = navigationDetailLabel(activeNavigation, section, 'desktop');
      detailDescription = navigationDetailDescription(activeNavigation, section, 'desktop');
      return '<div class="skipi-settings__shell skipi-settings__shell--desktop">'
        + '<aside class="skipi-settings__sidebar"><div class="skipi-settings__sidebar-toolbar">' + closeButtonHtml() + '<h1 class="skipi-settings__visually-hidden">' + escapeHtml(t('settings.title')) + '</h1></div>'
        + '<nav class="skipi-settings__nav" aria-label="' + escapeAttr(t('settings.title')) + '">' + nav + '</nav>'
        + '<div class="skipi-settings__sidebar-footer">' + escapeHtml(host.appName || '') + (host.appVersion ? ' · ' + escapeHtml(host.appVersion) : '') + '</div></aside>'
        + '<main class="skipi-settings__body" data-settings-detail tabindex="-1"><div class="skipi-settings__detail">'
        + '<header class="skipi-settings__detail-header"><div class="skipi-settings__detail-heading"><h2 class="skipi-settings__detail-title">' + escapeHtml(detailLabel) + '</h2>' + (detailDescription ? '<p class="skipi-settings__detail-description">' + escapeHtml(detailDescription) + '</p>' : '') + '</div>'
        + '</header>'
        + noticeHtml() + '<div data-qa="settings.' + escapeAttr(section.id) + '.body">' + renderSectionContent(section) + '</div></div></main></div>';
    }

    function mobileListHtml() {
      var groups = [];
      var groupById = Object.create(null);
      if (mobileNavigation) {
        mobileNavigation.forEach(function (group) {
          var items = '';
          var groupLabel;
          group.items.forEach(function (item) {
            var description;
            var value;
            var disabled;
            var action;
            var tag;
            var attributes;
            if (!navigationVisible(item, 'mobile')) return;
            description = resolveNavigationValue(item, 'description', 'mobile', '');
            value = resolveNavigationValue(item, 'value', 'mobile', '');
            disabled = navigationDisabled(item, 'mobile') || !!state.busy['menu:' + item.id];
            action = item.type === 'section' ? 'mobile-section' : (item.type === 'action' ? 'menu-action' : '');
            tag = item.type === 'info' ? 'div' : 'button';
            attributes = item.type === 'info'
              ? ''
              : ' type="button" data-settings-action="' + action + '" data-settings-value="' + escapeAttr(item.id) + '"' + (disabled ? ' disabled aria-disabled="true"' : '');
            items += '<li class="skipi-settings__mobile-listitem"><' + tag + ' class="skipi-settings__mobile-item skipi-settings__mobile-item--' + escapeAttr(item.type) + '" data-settings-menu-id="' + escapeAttr(item.id) + '" data-qa="settings.mobile.' + escapeAttr(item.id) + '"' + attributes + '>'
              + '<span class="skipi-settings__nav-icon" aria-hidden="true">' + navigationIconHtml(item) + '</span>'
              + '<span class="skipi-settings__nav-copy"><span class="skipi-settings__nav-label">' + escapeHtml(navigationLabel(item, 'mobile')) + '</span>'
              + (description ? '<span class="skipi-settings__nav-description">' + escapeHtml(description) + '</span>' : '') + '</span>'
              + (value ? '<span class="skipi-settings__mobile-value">' + escapeHtml(value) + '</span>' : '')
              + (item.type === 'section' ? '<span class="skipi-settings__mobile-chevron" aria-hidden="true">›</span>' : '')
              + '</' + tag + '></li>';
          });
          groupLabel = resolveNavigationValue(group, 'label', 'mobile', group.id);
          groups.push('<section class="skipi-settings__mobile-section" aria-label="' + escapeAttr(groupLabel) + '"><h2 class="skipi-settings__mobile-group-title">' + escapeHtml(groupLabel) + '</h2><ul class="skipi-settings__mobile-group" role="list">' + items + '</ul></section>');
        });
        return '<div class="skipi-settings__shell skipi-settings__shell--mobile"><div class="skipi-settings__mobile-topbar">' + closeButtonHtml() + '</div>'
          + mobileProfileHtml() + noticeHtml() + '<div class="skipi-settings__mobile-list skipi-settings__mobile-list--configured" role="region" aria-label="' + escapeAttr(t('settings.title')) + '" data-settings-list-focus tabindex="-1">'
          + groups.join('') + '</div></div>';
      }
      sections.forEach(function (section) {
        var meta = mobileGroupMeta(section);
        var badge = sectionBadge(section);
        var item = '<button type="button" class="skipi-settings__mobile-item" data-settings-action="section" data-settings-value="' + escapeAttr(section.id) + '" data-qa="settings.mobile.' + escapeAttr(section.id) + '">'
          + '<span class="skipi-settings__nav-icon" aria-hidden="true">' + sectionIconHtml(section) + '</span>'
          + '<span class="skipi-settings__nav-copy"><span class="skipi-settings__nav-label">' + escapeHtml(sectionLabel(section)) + '</span></span>'
          + (badge ? statusBadge(badge, '') : '') + '<span class="skipi-settings__mobile-chevron" aria-hidden="true">›</span></button>';
        if (!groupById[meta.id]) {
          groupById[meta.id] = { label: meta.label, items: '' };
          groups.push(groupById[meta.id]);
        }
        groupById[meta.id].items += item;
      });
      return '<div class="skipi-settings__shell skipi-settings__shell--mobile"><div class="skipi-settings__mobile-topbar">' + closeButtonHtml() + '</div>'
        + mobileProfileHtml() + noticeHtml() + '<nav class="skipi-settings__mobile-list" aria-label="' + escapeAttr(t('settings.title')) + '" data-settings-list-focus tabindex="-1">'
        + groups.map(function (group) {
          return '<section class="skipi-settings__mobile-section"><h2 class="skipi-settings__mobile-group-title">' + escapeHtml(group.label) + '</h2><div class="skipi-settings__mobile-group">' + group.items + '</div></section>';
        }).join('') + '</nav></div>';
    }

    function mobileDetailHtml() {
      var section = sectionById[state.activeId] || sections[0];
      var navigation = state.mobileNavigationId ? mobileNavigationById[state.mobileNavigationId] : null;
      var detailLabel;
      var detailDescription;
      if (!navigation || navigation.type !== 'section' || navigation.sectionId !== (section && section.id)) navigation = null;
      detailLabel = navigationDetailLabel(navigation, section, 'mobile');
      detailDescription = navigationDetailDescription(navigation, section, 'mobile');
      return '<div class="skipi-settings__shell skipi-settings__shell--mobile"><main class="skipi-settings__body is-active" data-settings-detail tabindex="-1"><div class="skipi-settings__detail">'
        + '<div class="skipi-settings__detail-toolbar"><button type="button" class="skipi-settings__back" data-settings-action="back"><span class="skipi-settings__back-icon" aria-hidden="true">‹</span>' + escapeHtml(t('settings.action.back')) + '</button>' + closeButtonHtml() + '</div>'
        + '<header class="skipi-settings__detail-header"><div class="skipi-settings__detail-heading"><h1 class="skipi-settings__detail-title">' + escapeHtml(detailLabel) + '</h1>' + (detailDescription ? '<p class="skipi-settings__detail-description">' + escapeHtml(detailDescription) + '</p>' : '') + '</div></header>'
        + noticeHtml() + '<div data-qa="settings.mobile.' + escapeAttr(section.id) + '.body">' + renderSectionContent(section) + '</div></div></main></div>';
    }

    function loadingHtml() {
      return '<div class="skipi-settings__state is-loading" role="status"><span class="skipi-settings__spinner" aria-hidden="true"></span>' + escapeHtml(t('settings.loading')) + '</div>';
    }

    function fatalHtml() {
      return '<div class="skipi-settings__state skipi-settings__state--error" role="alert"><div>' + escapeHtml(t('settings.error.load_failed')) + '</div>'
        + controlButton('load-retry', 'settings.action.retry', 'secondary', null, false) + '</div>';
    }

    function disposeIntegration(cleanup, fallback) {
      if (typeof cleanup === 'function') {
        try { cleanup(); } catch (error) { notifyError(error, 'cleanup'); }
      } else if (cleanup && typeof cleanup.unmount === 'function') {
        try { cleanup.unmount(); } catch (unmountError) { notifyError(unmountError, 'cleanup'); }
      } else if (fallback && typeof host.modulesUnmount === 'function') {
        try { host.modulesUnmount(); } catch (moduleError) { notifyError(moduleError, 'modulesUnmount'); }
      }
    }

    function cleanupActive() {
      var cleanup = activeCleanup;
      activeCleanup = null;
      if (!activeIntegrationMounted) return;
      activeIntegrationMounted = false;
      disposeIntegration(cleanup, true);
    }

    function mountActiveIntegration(token) {
      var section = sectionById[state.activeId];
      var mountPoint;
      var result;
      if (!mounted || destroyed || state.loading || state.fatal || state.mobileList || !section || section.id !== 'application') return;
      if (state.modulesError || typeof host.modulesMount !== 'function' || !target.querySelector) return;
      mountPoint = target.querySelector('[data-settings-modules-mount]');
      if (!mountPoint) return;
      try {
        activeIntegrationMounted = true;
        result = host.modulesMount(mountPoint, sectionContext(section));
        if (result && typeof result.then === 'function') {
          result.then(function (cleanup) {
            if (destroyed || token !== renderToken || state.activeId !== 'application') {
              disposeIntegration(cleanup, false);
              return;
            }
            activeCleanup = cleanup || null;
          }, function (error) {
            if (destroyed || token !== renderToken) return;
            state.modulesError = error;
            notifyError(error, 'modulesMount');
            draw();
          });
        } else {
          activeCleanup = result || null;
        }
      } catch (error) {
        state.modulesError = error;
        notifyError(error, 'modulesMount');
        draw();
      }
    }

    function reconcileNavigationForDraw() {
      var item;
      var summary;
      var profileSectionId;
      if (state.mode === 'desktop' && desktopNavigation && state.desktopNavigationId) {
        item = desktopNavigationById[state.desktopNavigationId];
        if (!item || item.sectionId !== state.activeId
            || !navigationVisible(item, 'desktop') || navigationDisabled(item, 'desktop')) {
          normalizeActiveNavigation();
        }
      }
      if (state.mode !== 'mobile' || state.mobileList) return;
      if (state.mobileOrigin === 'menu') {
        item = mobileNavigationById[state.mobileNavigationId];
        if (!item || item.type !== 'section' || item.sectionId !== state.activeId
            || !navigationVisible(item, 'mobile') || navigationDisabled(item, 'mobile')) {
          state.mobileNavigationId = null;
          state.mobileOrigin = null;
          state.mobileList = true;
        }
      } else if (state.mobileOrigin === 'profile') {
        summary = isObject(state.accountSummary) ? state.accountSummary : {};
        profileSectionId = canonicalSectionId(summary.sectionId);
        if (!profileSectionId || profileSectionId !== state.activeId || !sectionById[profileSectionId]) {
          state.mobileOrigin = null;
          state.mobileList = true;
        }
      }
    }

    function draw() {
      var html;
      var token;
      var wasMobileDetail;
      var forcedMobileList = false;
      if (!mounted || destroyed || !target) return;
      wasMobileDetail = state.mode === 'mobile' && !state.mobileList;
      if (!state.loading && !state.fatal) {
        reconcileNavigationForDraw();
        forcedMobileList = wasMobileDetail && state.mobileList;
      }
      cleanupActive();
      renderToken += 1;
      token = renderToken;
      if (state.loading) html = loadingHtml();
      else if (state.fatal) html = fatalHtml();
      else if (state.mode === 'mobile') html = state.mobileList ? mobileListHtml() : mobileDetailHtml();
      else html = desktopHtml();
      target.innerHTML = '<div class="skipi-settings skipi-settings--' + escapeAttr(state.mode) + (state.mode === 'mobile' && !state.mobileList ? ' is-detail-open' : '') + '" data-view="' + (state.mode === 'mobile' && !state.mobileList ? 'detail' : 'list') + '" data-theme="' + escapeAttr(state.theme) + '" data-skipi-settings-version="' + VERSION + '">' + html + '</div>';
      mountActiveIntegration(token);
      if (forcedMobileList) focusModeAnchor();
    }

    function reloadExtrasAndDraw(generation) {
      var wasMobileDetail = state.mode === 'mobile' && !state.mobileList;
      generation = generation == null ? mountGeneration : generation;
      return loadSupplemental(generation).then(function (current) {
        if (current && !destroyed && generation === mountGeneration) {
          buildSections();
          if (!sectionById[state.activeId]) {
            var first = firstNavigationSection(state.mode);
            state.activeId = first ? first.sectionId : (sections.length ? sections[0].id : null);
          }
          normalizeActiveNavigation();
          draw();
          if (wasMobileDetail && state.mobileList) focusModeAnchor();
        }
      });
    }

    function captureOwnedFocus() {
      var doc;
      var element;
      if (!target || typeof target.contains !== 'function') return null;
      doc = target.ownerDocument || root.document;
      element = doc && doc.activeElement;
      if (!element || !target.contains(element) || typeof element.getAttribute !== 'function') return null;
      return {
        action: element.getAttribute('data-settings-action'),
        change: element.getAttribute('data-settings-change'),
        value: element.getAttribute('data-settings-value'),
        menuId: element.getAttribute('data-settings-menu-id'),
        qa: element.getAttribute('data-qa')
      };
    }

    function focusMatchesDescriptor(element, descriptor) {
      if (!element || !descriptor || typeof element.getAttribute !== 'function') return false;
      if (descriptor.menuId != null && element.getAttribute('data-settings-menu-id') !== descriptor.menuId) return false;
      if (descriptor.action != null && element.getAttribute('data-settings-action') !== descriptor.action) return false;
      if (descriptor.change != null && element.getAttribute('data-settings-change') !== descriptor.change) return false;
      if (descriptor.value != null && element.getAttribute('data-settings-value') !== descriptor.value) return false;
      if (descriptor.qa != null && element.getAttribute('data-qa') !== descriptor.qa) return false;
      return descriptor.menuId != null || descriptor.action != null || descriptor.change != null || descriptor.qa != null;
    }

    function restoreOwnedFocus(descriptor) {
      var candidates;
      var i;
      if (!descriptor || !target || typeof target.querySelectorAll !== 'function') return false;
      candidates = target.querySelectorAll('[data-settings-action], [data-settings-change], [data-settings-menu-id], [data-qa]');
      for (i = 0; i < candidates.length; i += 1) {
        if (focusMatchesDescriptor(candidates[i], descriptor) && !candidates[i].disabled && typeof candidates[i].focus === 'function') {
          candidates[i].focus();
          return true;
        }
      }
      return false;
    }

    function focusBusySurface(descriptor) {
      var list;
      if (!descriptor || !target || !target.querySelector) return;
      if (target.querySelector('[data-settings-detail]')) {
        focusDetail();
        return;
      }
      list = target.querySelector('[data-settings-list-focus]');
      if (list && typeof list.focus === 'function') list.focus();
    }

    function runBusy(name, work, successKey, startBeforeDraw) {
      var generation = mountGeneration;
      var started;
      var focusDescriptor = captureOwnedFocus();
      if (!mounted || destroyed) return Promise.reject(cancelledError());
      if (state.busy[name]) return Promise.resolve(SKIPPED);
      state.busy[name] = true;
      setNotice(null);
      startBeforeDraw = startBeforeDraw !== false;
      if (startBeforeDraw) {
        try { started = work(); } catch (startError) { started = Promise.reject(startError); }
        draw();
      } else {
        draw();
      }
      focusBusySurface(focusDescriptor);
      return (startBeforeDraw ? Promise.resolve(started) : asPromise(work)).then(function (value) {
        assertLive(generation);
        delete state.busy[name];
        if (successKey) setNotice(successKey, 'success');
        draw();
        restoreOwnedFocus(focusDescriptor);
        return value;
      }, function (error) {
        delete state.busy[name];
        if (!mounted || destroyed || generation !== mountGeneration) throw cancelledError();
        if (error && (error.skipiSettingsCancelled || error.skipiSettingsSuperseded)) throw error;
        if (error && error.skipiSettingsHandled) {
          draw();
          restoreOwnedFocus(focusDescriptor);
          throw error;
        }
        notifyError(error, name);
        setNotice('settings.error.action_failed', 'error');
        draw();
        restoreOwnedFocus(focusDescriptor);
        throw markHandled(error);
      });
    }

    function runBusyAndReload(name, work, successKey) {
      var generation = mountGeneration;
      return runBusy(name, function () {
        return asPromise(work).then(function (value) {
          assertLive(generation);
          return reloadExtrasAndDraw(generation).then(function () { return value; });
        });
      }, successKey).catch(function () {});
    }

    function focusDetail() {
      var detail;
      if (!target || !target.querySelector) return;
      detail = target.querySelector('[data-settings-detail]');
      if (detail && typeof detail.focus === 'function') detail.focus();
    }

    function focusMobileOrigin() {
      var selector = '';
      var element;
      if (!target || !target.querySelector) return;
      if (state.mobileOrigin === 'menu' && state.mobileNavigationId) {
        selector = '[data-settings-menu-id="' + state.mobileNavigationId + '"]';
      } else if (state.mobileOrigin === 'profile') {
        selector = '[data-settings-action="profile-section"]';
      } else if (state.activeId) {
        selector = '[data-settings-action="section"][data-settings-value="' + state.activeId + '"]';
      }
      if (!selector) {
        focusModeAnchor();
        return;
      }
      element = target.querySelector(selector);
      if (element && typeof element.focus === 'function') element.focus();
      else focusModeAnchor();
    }

    function firstMobileFocusableItem() {
      var i;
      var j;
      var item;
      if (!mobileNavigation) return null;
      for (i = 0; i < mobileNavigation.length; i += 1) {
        for (j = 0; j < mobileNavigation[i].items.length; j += 1) {
          item = mobileNavigation[i].items[j];
          if (item.type !== 'info' && navigationVisible(item, 'mobile') && !navigationDisabled(item, 'mobile')) return item;
        }
      }
      return null;
    }

    function focusModeAnchor() {
      var selector = '';
      var item;
      var element;
      if (!target || !target.querySelector) return;
      if (state.mode === 'mobile' && !state.mobileList) {
        focusDetail();
        return;
      }
      if (state.mode === 'desktop') {
        if (state.desktopNavigationId) selector = '[data-settings-menu-id="' + state.desktopNavigationId + '"]';
        else if (state.activeId) selector = '[data-settings-action="section"][data-settings-value="' + state.activeId + '"]';
      } else if (state.mobileNavigationId) {
        selector = '[data-settings-menu-id="' + state.mobileNavigationId + '"]';
      } else {
        item = firstMobileFocusableItem();
        if (item) selector = '[data-settings-menu-id="' + item.id + '"]';
        else if (state.activeId && !mobileNavigation) selector = '[data-settings-action="section"][data-settings-value="' + state.activeId + '"]';
        else if (target.querySelector('[data-settings-action="profile-section"]')) selector = '[data-settings-action="profile-section"]';
        else selector = '[data-settings-action="close"]';
      }
      element = selector ? target.querySelector(selector) : null;
      if (element && !element.disabled && typeof element.focus === 'function') element.focus();
      else if (state.mode === 'desktop') focusDetail();
      else {
        element = target.querySelector('[data-settings-list-focus]');
        if (element && typeof element.focus === 'function') element.focus();
      }
    }

    function openNavigationItem(item, surface) {
      if (!item || item.type !== 'section' || !sectionById[item.sectionId]) return false;
      state.activeId = item.sectionId;
      state.notice = null;
      if (surface === 'mobile') {
        state.mobileNavigationId = item.id;
        state.mobileOrigin = 'menu';
        state.mobileList = false;
      } else {
        state.desktopNavigationId = item.id;
      }
      draw();
      focusDetail();
      return true;
    }

    function runMenuAction(item, event, element) {
      var name;
      var handler;
      if (!item || item.type !== 'action') return false;
      handler = navigationHandlers[item.action];
      if (typeof handler !== 'function') return false;
      name = 'menu:' + item.id;
      runBusy(name, function () {
        return handler.call(host, navigationContext(item, 'mobile'), event, element);
      }, item.successKey || null, true).then(function (result) {
        if (result !== SKIPPED && state.mode === 'mobile' && state.mobileList) {
          if (navigationVisible(item, 'mobile') && !navigationDisabled(item, 'mobile')) {
            state.mobileNavigationId = item.id;
            state.mobileOrigin = 'menu';
            focusMobileOrigin();
          } else {
            state.mobileNavigationId = null;
            state.mobileOrigin = null;
            focusModeAnchor();
          }
        }
      }, function () {
        if (state.mode === 'mobile' && state.mobileList) {
          if (navigationVisible(item, 'mobile') && !navigationDisabled(item, 'mobile')) {
            state.mobileNavigationId = item.id;
            state.mobileOrigin = 'menu';
            focusMobileOrigin();
          } else {
            state.mobileNavigationId = null;
            state.mobileOrigin = null;
            focusModeAnchor();
          }
        }
      });
      return true;
    }

    function handleGenericAction(action, value, event, element) {
      var recovery = recoveryCapability();
      var devices = deviceCapability() || {};
      var team = teamCapability() || {};
      if (action === 'section') { open(value); return true; }
      if (action === 'desktop-section') {
        return openNavigationItem(desktopNavigationById[value], 'desktop');
      }
      if (action === 'mobile-section') {
        return openNavigationItem(mobileNavigationById[value], 'mobile');
      }
      if (action === 'profile-section') {
        state.mobileNavigationId = null;
        state.mobileOrigin = 'profile';
        if (!open(value)) return false;
        state.mobileOrigin = 'profile';
        return true;
      }
      if (action === 'menu-action') {
        return runMenuAction(mobileNavigationById[value], event, element);
      }
      if (action === 'profile-team') { open('team'); return true; }
      if (action === 'back') { showList(); return true; }
      if (action === 'close') {
        if (typeof options.onClose === 'function') options.onClose();
        else if (typeof host.onClose === 'function') host.onClose();
        return true;
      }
      if (action === 'load-retry') { load().catch(function () {}); return true; }
      if (action === 'modules-retry') { state.modulesError = null; draw(); return true; }
      if (action === 'theme') {
        runBusy('theme', function () {
          return asPromise(function () { return host.applyTheme(value); }).then(function (result) {
            state.theme = value === 'dark' ? 'dark' : 'light';
            return result;
          });
        }, 'settings.notice.theme_applied').catch(function () {});
        return true;
      }
      if (action === 'identity-refresh') {
        runBusy('identity-refresh', function () { return reloadExtrasAndDraw(); }, null).catch(function () {});
        return true;
      }
      if (action === 'supplemental-refresh') {
        runBusy('supplemental-refresh', function () { return reloadExtrasAndDraw(); }, null).catch(function () {});
        return true;
      }
      if (action === 'storage-export') {
        runBusy('storage-export', function () { return host.exportVaultBackup(); }, 'settings.notice.exported').catch(function () {});
        return true;
      }
      if (action === 'storage-import') {
        runBusyAndReload('storage-import', function () { return host.importVaultBackup(); }, 'settings.notice.imported');
        return true;
      }
      if (action === 'recovery-bind') {
        runBusyAndReload('recovery-bind', function () { return recovery.bind(); }, 'settings.notice.recovery_bound');
        return true;
      }
      if (action === 'recovery-recover') {
        runBusyAndReload('recovery-recover', function () { return recovery.recover(); }, 'settings.notice.recovered');
        return true;
      }
      if (action === 'device-pair') {
        runBusyAndReload('device-pair', function () { return devices.pair(); }, 'settings.notice.device_paired');
        return true;
      }
      if (action === 'device-scan') {
        runBusyAndReload('device-scan', function () { return devices.scan(); }, 'settings.notice.device_scanned');
        return true;
      }
      if (action === 'device-code') {
        runBusy('device-code', function () {
          return asPromise(function () { return devices.createPairingCode(); }).then(function (result) {
            state.devicePairingCode = result;
            return result;
          });
        }, 'settings.notice.device_code_created').catch(function () {});
        return true;
      }
      if (action === 'device-revoke') {
        runBusyAndReload('device-revoke:' + value, function () { return devices.revoke(value); }, 'settings.notice.device_revoked');
        return true;
      }
      if (action === 'team-save') {
        runBusyAndReload('team-save', function () {
          return team.updateTeam({
            name: state.teamDraft.name,
            replyTo: state.teamDraft.replyTo,
            serverStatus: state.teamDraft.serverStatus
          });
        }, 'settings.notice.team_saved');
        return true;
      }
      if (action === 'team-invite') {
        if (!String(state.teamDraft.invite || '').replace(/^\s+|\s+$/g, '')) return true;
        runBusyAndReload('team-invite', function () {
          return asPromise(function () { return team.invite(state.teamDraft.invite); }).then(function (result) {
            state.teamDraft.invite = '';
            return result;
          });
        }, 'settings.notice.team_invited');
        return true;
      }
      if (action === 'team-remove') {
        runBusyAndReload('team-remove:' + value, function () { return team.remove(value); }, 'settings.notice.team_removed');
        return true;
      }
      if (action === 'team-join') {
        if (!String(state.teamDraft.invitation || '').replace(/^\s+|\s+$/g, '')) return true;
        runBusyAndReload('team-join', function () {
          return asPromise(function () { return team.join(state.teamDraft.invitation); }).then(function (result) {
            state.teamDraft.invitation = '';
            return result;
          });
        }, 'settings.notice.team_joined');
        return true;
      }
      return false;
    }

    function handleAppAction(action, event, element) {
      var section = sectionById[state.activeId];
      var handler;
      var result;
      if (!section || !section.appSpecific || !section.handlers) return false;
      handler = Object.prototype.hasOwnProperty.call(section.handlers, action) ? section.handlers[action] : null;
      if (typeof handler !== 'function') return false;
      try {
        result = handler(sectionContext(section), event, element);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(function (error) {
            if (!mounted || destroyed) return;
            if (error && (error.skipiSettingsHandled || error.skipiSettingsCancelled || error.skipiSettingsSuperseded)) return;
            notifyError(error, 'handler:' + section.id + ':' + action);
            setNotice('settings.error.action_failed', 'error');
            draw();
          });
        }
      } catch (error) {
        notifyError(error, 'handler:' + section.id + ':' + action);
        setNotice('settings.error.action_failed', 'error');
        draw();
      }
      return true;
    }

    function onClick(event) {
      var element = closestWithAttribute(event.target, 'data-settings-action', target);
      var action;
      var value;
      if (!element || (element.disabled === true)) return;
      action = element.getAttribute('data-settings-action');
      value = element.getAttribute('data-settings-value');
      if (handleGenericAction(action, value, event, element)) return;
      handleAppAction(action, event, element);
    }

    function onChange(event) {
      var element = closestWithAttribute(event.target, 'data-settings-change', target);
      var action;
      var value;
      if (!element || element.disabled === true) return;
      action = element.getAttribute('data-settings-change');
      value = element.value;
      if (action === 'language') {
        runBusy('language', function () {
          return asPromise(function () { return host.setUiLang(value); }).then(function () {
            state.language = String(value || '');
            return reloadExtrasAndDraw();
          });
        }, 'settings.notice.language_applied').catch(function () {});
        return;
      }
      if (action === 'team-name') { state.teamDraft.name = String(value || ''); return; }
      if (action === 'team-reply-to') { state.teamDraft.replyTo = String(value || ''); return; }
      if (action === 'team-server-status') { state.teamDraft.serverStatus = String(value || ''); return; }
      if (action === 'team-invite') { state.teamDraft.invite = String(value || ''); return; }
      if (action === 'team-invitation') { state.teamDraft.invitation = String(value || ''); return; }
      handleAppAction(action, event, element);
    }

    function onKeyDown(event) {
      var handled = false;
      if (event.key !== 'Escape') return;
      if (state.mode === 'mobile' && !state.mobileList) {
        showList();
        handled = true;
      } else if (typeof options.onClose === 'function') {
        options.onClose();
        handled = true;
      } else if (typeof host.onClose === 'function') {
        host.onClose();
        handled = true;
      }
      if (handled && typeof event.preventDefault === 'function') event.preventDefault();
      if (handled && typeof event.stopPropagation === 'function') event.stopPropagation();
    }

    function onResize() {
      var next;
      var schedule;
      if (options.mode !== 'auto') return;
      if (resizeTimer != null && root.clearTimeout) root.clearTimeout(resizeTimer);
      schedule = typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : function (work) { work(); return null; };
      resizeTimer = schedule(function () {
        resizeTimer = null;
        if (options.mode !== 'auto' || !target) return;
        next = normalizeMode('auto', target, options.breakpoint);
        if (next !== state.mode) {
          var restoreFocus = !!captureOwnedFocus();
          state.mode = next;
          state.mobileList = next === 'mobile';
          state.mobileOrigin = null;
          state.mobileNavigationId = null;
          normalizeActiveNavigation();
          draw();
          if (restoreFocus) focusModeAnchor();
        }
      }, 80);
    }

    function attachModeWatcher() {
      if (options.mode !== 'auto' || !target) return;
      if (root.addEventListener && !resizeAttached) {
        root.addEventListener('resize', onResize);
        resizeAttached = true;
      }
      if (typeof root.ResizeObserver === 'function' && !resizeObserver) {
        resizeObserver = new root.ResizeObserver(onResize);
        resizeObserver.observe(target);
      }
    }

    function detachModeWatcher() {
      if (resizeTimer != null && root.clearTimeout) root.clearTimeout(resizeTimer);
      resizeTimer = null;
      if (resizeAttached && root.removeEventListener) root.removeEventListener('resize', onResize);
      resizeAttached = false;
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch (error) { notifyError(error, 'resizeObserver'); }
        resizeObserver = null;
      }
    }

    function attachListeners() {
      if (!target || listenerAttached) return;
      target.addEventListener('click', onClick);
      target.addEventListener('change', onChange);
      target.addEventListener('keydown', onKeyDown);
      listenerAttached = true;
      attachModeWatcher();
    }

    function detachListeners() {
      if (target && listenerAttached) {
        target.removeEventListener('click', onClick);
        target.removeEventListener('change', onChange);
        target.removeEventListener('keydown', onKeyDown);
      }
      listenerAttached = false;
      detachModeWatcher();
    }

    function load() {
      var generation = mountGeneration;
      var request = settingsRequest + 1;
      settingsRequest = request;
      state.loading = true;
      state.fatal = null;
      state.notice = null;
      draw();
      return asPromise(function () { return host.getSettings(); }).then(function (settings) {
        assertLive(generation);
        if (request !== settingsRequest) throw supersededError();
        state.settings = isObject(settings) ? settings : {};
        state.theme = currentThemeFromSettings(state.settings);
        return loadSupplemental(generation);
      }).then(function () {
        var first;
        assertLive(generation);
        if (request !== settingsRequest) throw supersededError();
        buildSections();
        first = firstNavigationSection(state.mode);
        var initialSection = canonicalSectionId(options.initialSection);
        state.activeId = initialSection && sectionById[initialSection]
          ? initialSection
          : (state.activeId && sectionById[state.activeId] ? state.activeId : (first ? first.sectionId : (sections[0] ? sections[0].id : null)));
        normalizeActiveNavigation(!!(initialSection && sectionById[initialSection]));
        if (state.mode === 'mobile' && !state.mobileList && mobileNavigation) {
          first = findNavigationForSection(mobileNavigationItems(), state.activeId, 'mobile');
          state.mobileNavigationId = first ? first.id : null;
          state.mobileOrigin = first ? 'menu' : null;
        }
        state.loading = false;
        state.fatal = null;
        draw();
        return api;
      }).catch(function (error) {
        if (!mounted || destroyed || generation !== mountGeneration) throw cancelledError();
        if (error && (error.skipiSettingsCancelled || error.skipiSettingsSuperseded)) throw error;
        state.loading = false;
        state.fatal = error;
        notifyError(error, 'getSettings');
        draw();
        throw error;
      });
    }

    function mount(mountTarget, mountOptions) {
      var initial;
      if (mounted) throw new Error('@skipi/settings: instance is already mounted');
      if (destroyed) throw new Error('@skipi/settings: destroyed instance cannot be mounted again');
      target = resolveElement(mountTarget);
      if (!target) throw new TypeError('@skipi/settings: mount target was not found');
      options = copyObject(defaultOptions);
      mountOptions = copyObject(mountOptions);
      Object.keys(mountOptions).forEach(function (key) { options[key] = mountOptions[key]; });
      options.mode = options.mode === 'desktop' || options.mode === 'mobile' ? options.mode : 'auto';
      options.breakpoint = isFinite(Number(options.breakpoint)) ? Math.max(320, Number(options.breakpoint)) : 720;
      initial = options.mobileInitialView === 'section' ? false : true;
      state.mobileList = initial;
      state.mode = normalizeMode(options.mode, target, options.breakpoint);
      if (state.mode === 'desktop') state.mobileList = false;
      mountGeneration += 1;
      mounted = true;
      destroyed = false;
      attachListeners();
      load().then(function () { readyResolve(api); }, function (error) { readyReject(error); });
      return api;
    }

    function open(sectionId) {
      sectionId = canonicalSectionId(sectionId);
      if (!sectionById[sectionId]) return false;
      state.activeId = sectionId;
      state.desktopNavigationId = null;
      state.mobileNavigationId = null;
      state.mobileOrigin = null;
      state.mobileList = false;
      state.notice = null;
      draw();
      focusDetail();
      return true;
    }

    function showList() {
      if (state.mode !== 'mobile') return false;
      state.mobileList = true;
      state.notice = null;
      draw();
      focusMobileOrigin();
      return true;
    }

    function setMode(mode) {
      var restoreFocus = !!captureOwnedFocus();
      if (mode !== 'desktop' && mode !== 'mobile' && mode !== 'auto') throw new TypeError('@skipi/settings: mode must be desktop, mobile or auto');
      options.mode = mode;
      detachModeWatcher();
      state.mode = normalizeMode(mode, target, options.breakpoint || 720);
      state.mobileList = state.mode === 'mobile';
      state.mobileNavigationId = null;
      state.mobileOrigin = null;
      normalizeActiveNavigation();
      attachModeWatcher();
      draw();
      if (restoreFocus) focusModeAnchor();
      return state.mode;
    }

    function refresh() {
      var generation = mountGeneration;
      var request;
      var pendingSaves;
      if (!mounted || destroyed) return Promise.reject(new Error('@skipi/settings: instance is not mounted'));
      if (state.loading) return ready.then(function () { return refresh(); });
      request = settingsRequest + 1;
      settingsRequest = request;
      pendingSaves = saveQueue;
      return pendingSaves.catch(function () {}).then(function () {
        assertLive(generation);
        if (request !== settingsRequest) throw supersededError();
        return asPromise(function () { return host.getSettings(); });
      }).then(function (settings) {
        assertLive(generation);
        if (request !== settingsRequest) throw supersededError();
        state.settings = isObject(settings) ? settings : {};
        state.theme = currentThemeFromSettings(state.settings);
        return reloadExtrasAndDraw(generation);
      }).catch(function (error) {
        if (!mounted || destroyed || generation !== mountGeneration) throw cancelledError();
        if (request !== settingsRequest || (error && error.skipiSettingsSuperseded)) return api;
        if (error && error.skipiSettingsCancelled) throw error;
        notifyError(error, 'refresh');
        setNotice('settings.error.refresh_failed', 'error');
        draw();
        throw markHandled(error);
      });
    }

    function getState() {
      return {
        version: VERSION,
        mode: state.mode,
        activeSection: state.activeId,
        desktopNavigationItem: state.desktopNavigationId,
        mobileNavigationItem: state.mobileNavigationId,
        mobileList: state.mobileList,
        loading: state.loading,
        settings: state.settings,
        sections: sections.map(function (section) { return section.id; })
      };
    }

    function unmount() {
      if (!mounted) return;
      destroyed = true;
      mountGeneration += 1;
      renderToken += 1;
      cleanupActive();
      detachListeners();
      if (resizeTimer != null && root.clearTimeout) root.clearTimeout(resizeTimer);
      resizeTimer = null;
      if (target) target.innerHTML = '';
      mounted = false;
      target = null;
    }

    var api = {
      version: VERSION,
      ready: ready,
      mount: mount,
      open: open,
      showList: showList,
      setMode: setMode,
      refresh: refresh,
      getState: getState,
      unmount: unmount,
      destroy: unmount
    };
    return api;
  }

  function mount(target, host, options) {
    return create(host, options).mount(target);
  }

  root.SkipiSettings = {
    version: VERSION,
    create: create,
    mount: mount
  };
}(typeof window !== 'undefined' ? window : globalThis));
