'use strict';

module.exports = {
  RealDebridClient: require('./clients/realdebrid_client'),
  TorboxClient: require('./clients/torbox_client'),
  RealDebridProbe: require('./probe/realdebrid_probe'),
  TorboxAvailabilityCache: require('./availability/torbox_availability_cache'),
  createDebridAvailabilityTools: require('./availability/debrid_availability').createDebridAvailabilityTools,
  SavedCloud: require('./saved_cloud/debrid_saved_cloud'),
  CacheOracle: require('./state/cache_oracle'),
  RdStatusGuard: require('./guards/rd_status_guard'),
  ResolutionOrderingGuard: require('./guards/resolution_ordering_guard'),
  Audit: require('./audit/realdebrid_auditor'),
  bootRealDebridAuditor: require('./audit/rd_auditor_boot').bootRealDebridAuditor,
  RateLimiter: require('./utils/rd_rate_limiter'),
  MagnetLock: require('./utils/rd_magnet_lock')
};
