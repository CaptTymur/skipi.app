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
  // '*' = the SIGNED CATALOG decides (owner 24.11.2026: Apps is a store — a new plugin must
  // not need an app release). Every entry is still verified: signature by the pinned key,
  // compatibility, the policy below, and the pack checksum.
  remoteSlugs: '*',
  // Seafarer ships no bundled plugins (owner 24.11.2026): there is no bundled baseline.
  bundledVersions: {},

  // Host identity for compatibility checks.
  host: { id: 'seafarer', version: '0.4.203' },

  // First-party policy (v2). Plugins exceeding this are rejected.
  // Network (owner 24.11.2026): a plugin may use the network ONLY through the host
  // (hostApi.net.fetch — the sandbox itself stays connect-src 'none'), ONLY with the
  // `network` permission, and ONLY to https prefixes listed in its signed entry
  // (capabilities.network.allow), each of which must sit on one of networkOrigins.
  policy: {
    // Motion sensors and keep-awake (owner 25.11.2026, the Clinometer): served by the host
    // (hostApi.motion / hostApi.screen, runtime 1.2) — the sandbox itself gets no sensor access.
    // Camera, microphone, location, speech, vibration (owner 25.11.2026: the set is widened ahead of
    // the plugins, so a new plugin needs no new app build). All host-mediated (runtime 1.3); the
    // user is asked before a plugin first uses the camera, the microphone or the location.
    maxPermissions: ['local_storage', 'audio_alert', 'network', 'motion', 'keep_awake', 'camera', 'microphone', 'location', 'speech', 'vibrate'],
    requireCapabilities: { documents: 'none', account: 'none', analytics: 'none', server_upload: false },
    networkOrigins: ['https://api.skipi.app']
  },

  // Trusted production first-party signing key (public material only — safe to ship).
  // Production builds must not trust staging keys. Dev/staging builds that need
  // QA catalogs must inject their own non-production config.
  pinnedPublicKeys: {
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
