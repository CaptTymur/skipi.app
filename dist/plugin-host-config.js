/* Remote plugin delivery — host config (Seafarer).
   FEATURE FLAG IS OFF BY DEFAULT. When false, plugin-remote-boot.js does nothing:
   no runtime, no catalog fetch, no UI change — Seafarer behaves exactly as today.

   REMOTE DELIVERY IS STILL OFF BY DEFAULT. Production catalog is not enabled here. */

window.FEATURE_REMOTE_PLUGIN_DELIVERY = false;   // <-- default OFF (kill switch)
try {
  // QA/staging override only. This does not enable production delivery for normal users.
  window.FEATURE_REMOTE_PLUGIN_DELIVERY = localStorage.getItem('skipi.remotePluginDelivery') === 'staging';
} catch (e) {}

window.SKIPI_REMOTE_CONFIG = {
  // Staging catalog only (production plugins.skipi.app is NOT used here).
  catalogUrl: 'https://api.skipi.app/seafarer/releases/plugins/staging/v1/catalog.json',

  // Which catalog plugins are routed through the isolated remote runtime when ON.
  remoteSlugs: ['bnwas-time-anchor', 'ship-photo-collection'],

  // Host identity for compatibility checks.
  host: { id: 'seafarer', version: '0.4.163' },

  // First-party utility policy (v1). Plugins exceeding this are rejected.
  policy: {
    maxPermissions: ['local_storage', 'audio_alert'],
    requireCapabilities: { network: 'none', documents: 'none', account: 'none', analytics: 'none', server_upload: false }
  },

  // Trusted first-party signing keys (public material only — safe to ship).
  // The loader selects by catalog.keyId. Staging stays for QA; prod is inert until
  // a production catalog URL + feature flag are enabled in a separate release.
  pinnedPublicKeys: {
    'skipi-firstparty-staging-v1': {
      kty: 'EC',
      crv: 'P-256',
      x: 'ycMaqzJTGpiFx_yGg6xub99ZnEqn_ARvHZVW_zKMkUU',
      y: 'gC9j0u6GQL9Lh53rFbA3H5nSh85ttZJbb29fpkkjJak',
      kid: 'skipi-firstparty-staging-v1'
    },
    'skipi-firstparty-prod-v1': {
      kty: 'EC',
      crv: 'P-256',
      x: 'ByRH-jQw8EE2XOD7BBatMFTRK5QuBkX7sfSfc8kKvMk',
      y: 'QGpxR4UEY72g2rGHigLXXlasRYBiieud9VM3m7wMF-4',
      kid: 'skipi-firstparty-prod-v1'
    }
  },

  // Legacy single-key alias for older boot code and local harnesses.
  pinnedPublicKey: {
    kty: 'EC',
    crv: 'P-256',
    x: 'ycMaqzJTGpiFx_yGg6xub99ZnEqn_ARvHZVW_zKMkUU',
    y: 'gC9j0u6GQL9Lh53rFbA3H5nSh85ttZJbb29fpkkjJak',
    kid: 'skipi-firstparty-staging-v1'
  }
};
