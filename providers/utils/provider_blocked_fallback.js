'use strict';

const {
  createBlockedFallbackGuard,
  shouldUseCloudflareBypass,
  isBlockedStatus,
  isBlockedBody,
  isBlockedError,
  isSameSiteUrl,
  isHtmlLikeUrl,
  toAxiosLikeResponse
} = require('./cloudflare_bypass');

function safeText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
}

module.exports = {
  createBlockedFallbackGuard,
  shouldUseShield: shouldUseCloudflareBypass,
  isBlockedStatus,
  isBlockedBody,
  isBlockedError,
  isSameSiteUrl,
  isHtmlLikeUrl,
  toAxiosLikeResponse,
  safeText
};
