/* Remote plugin delivery — host config (Seafarer).
   FEATURE FLAG IS OFF BY DEFAULT. When false, plugin-remote-boot.js does nothing:
   no runtime, no catalog fetch, no UI change — Seafarer behaves exactly as today.

   STAGING ONLY. TEST KEY ONLY. No production catalog. No production key. */

window.FEATURE_REMOTE_PLUGIN_DELIVERY = false;   // <-- default OFF (kill switch)
try {
  // QA/staging override only. This does not enable production delivery for normal users.
  window.FEATURE_REMOTE_PLUGIN_DELIVERY = localStorage.getItem('skipi.remotePluginDelivery') === 'staging';
} catch (e) {}

window.SKIPI_REMOTE_CONFIG = {
  // Staging catalog only (production plugins.skipi.app is NOT used here).
  catalogUrl: 'https://api.skipi.app/seafarer/releases/plugins/staging/v1/catalog.json',

  // Which catalog plugins are routed through the isolated remote runtime when ON.
  remoteSlugs: ['bnwas-time-anchor'],

  // Host identity for compatibility checks.
  host: { id: 'seafarer', version: '0.4.163' },

  // First-party utility policy (v1). Plugins exceeding this are rejected.
  // The new permissions back the «Моё судно» host-mediated capability skeleton
  // (vessel/crew context, media pick, workflow submit). DEFAULT-DENIED: a
  // permission only applies if the plugin DECLARES it AND it is on this
  // allowlist — and even then every call is host-mediated + audited. The plugin
  // still gets NO raw network (capabilities.network stays 'none') and NO raw
  // files; upload is host-mediated only and currently a not-connected stub.
  policy: {
    maxPermissions: ['local_storage', 'audio_alert', 'vessel.context.read', 'crew.membership.read', 'media.pick', 'workflow.submit'],
    requireCapabilities: { network: 'none', documents: 'none', account: 'none', analytics: 'none', server_upload: false }
  },

  // Pinned STAGING/TEST public key (public material only — safe to ship).
  // Production verification key is generated offline in an HSM and is NOT here.
  pinnedPublicKey: {
    kty: 'EC',
    crv: 'P-256',
    x: 'ycMaqzJTGpiFx_yGg6xub99ZnEqn_ARvHZVW_zKMkUU',
    y: 'gC9j0u6GQL9Lh53rFbA3H5nSh85ttZJbb29fpkkjJak',
    kid: 'skipi-firstparty-staging-v1'
  }
};
