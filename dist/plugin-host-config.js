/* Remote plugin delivery — host config (Seafarer).
   FEATURE FLAG IS OFF BY DEFAULT. When false, plugin-remote-boot.js does nothing:
   no runtime, no catalog fetch, no UI change — Seafarer behaves exactly as today.

   STAGING ONLY. TEST KEY ONLY. No production catalog. No production key. */

window.FEATURE_REMOTE_PLUGIN_DELIVERY = false;   // <-- default OFF (kill switch)

window.SKIPI_REMOTE_CONFIG = {
  // Staging catalog only (production plugins.skipi.app is NOT used here).
  catalogUrl: 'https://api.skipi.app/seafarer/releases/plugins/staging/v1/catalog.json',

  // Which catalog plugins are routed through the isolated remote runtime when ON.
  remoteSlugs: ['bnwas-time-anchor'],

  // Host identity for compatibility checks.
  host: { id: 'seafarer', version: '0.4.163' },

  // First-party utility policy (v1). Plugins exceeding this are rejected.
  policy: {
    maxPermissions: ['local_storage', 'audio_alert'],
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
