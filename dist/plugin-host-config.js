/* Remote plugin delivery — host config (Seafarer).
   FEATURE FLAG IS ON FOR PRODUCTION DELIVERY. When false, plugin-remote-boot.js does nothing:
   no runtime, no catalog fetch, no UI change — Seafarer behaves exactly as today.

   The only local override is an emergency/QA kill shape: localStorage
   skipi.remotePluginDelivery='off' disables production remote delivery on this client. */

window.FEATURE_REMOTE_PLUGIN_DELIVERY = true;
try {
  // QA/local emergency override only. This is not a central production kill switch.
  if (localStorage.getItem('skipi.remotePluginDelivery') === 'off') {
    window.FEATURE_REMOTE_PLUGIN_DELIVERY = false;
  }
} catch (e) {}

window.SKIPI_REMOTE_CONFIG = {
  // Production first-party plugin catalog.
  catalogUrl: 'https://api.skipi.app/seafarer/releases/plugins/v1/catalog.json',

  // Which catalog plugins are routed through the isolated remote runtime.
  remoteSlugs: ['bnwas-time-anchor', 'navigation-calculators'],

  // Host identity for compatibility checks.
  host: { id: 'seafarer', version: '0.4.165' },

  // First-party utility policy (v1). Plugins exceeding this are rejected.
  policy: {
    maxPermissions: ['local_storage', 'audio_alert'],
    requireCapabilities: { network: 'none', documents: 'none', account: 'none', analytics: 'none', server_upload: false }
  },

  // Trusted first-party signing keys (public material only — safe to ship).
  // The loader selects by catalog.keyId. Staging stays pinned for QA catalog
  // checks; production catalog entries must resolve to skipi-firstparty-prod-v1.
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
    x: 'ByRH-jQw8EE2XOD7BBatMFTRK5QuBkX7sfSfc8kKvMk',
    y: 'QGpxR4UEY72g2rGHigLXXlasRYBiieud9VM3m7wMF-4',
    kid: 'skipi-firstparty-prod-v1'
  }
};
