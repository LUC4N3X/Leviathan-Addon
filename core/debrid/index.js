'use strict';

module.exports = {
  RealDebridClient: require('./rd/clients/realdebrid_client'),
  TorboxClient: require('./tb/clients/torbox_client'),
  RealDebridProbe: require('./rd/probe/realdebrid_probe'),
  TorboxAvailabilityCache: require('./tb/availability/torbox_availability_cache'),
  TorboxCacheState: require('./tb/availability/torbox_cache_state'),
  TorboxFileMatch: require('./tb/matching/tb_file_match'),
  createDebridAvailabilityTools: require('./availability/debrid_availability').createDebridAvailabilityTools,
  SavedCloud: require('./saved_cloud/debrid_saved_cloud'),
  CacheOracle: require('./rd/state/cache_oracle'),
  RdStatusGuard: require('./rd/guards/rd_status_guard'),
  ResolutionOrderingGuard: require('./guards/resolution_ordering_guard'),
  Audit: require('./rd/audit/realdebrid_auditor'),
  bootRealDebridAuditor: require('./rd/audit/rd_auditor_boot').bootRealDebridAuditor,
  RateLimiter: require('./rd/utils/rd_rate_limiter'),
  MagnetLock: require('./rd/utils/rd_magnet_lock'),
  Backoff: require('./utils/backoff'),
  CircuitBreaker: require('./utils/circuit_breaker')
};
