'use strict';

// Stable programmatic facade for consumers that analyze supplied HTML without running the server.

const { SeoAnalyzer } = require('./analysis/seo-analyzer');
const { PageSnapshot } = require('./analysis/page-snapshot');
const rules = require('./analysis/rules');
const { UrlSafetyPolicy } = require('./network/url-safety-policy');

const defaultAnalyzer = new SeoAnalyzer();
const normalizationPolicy = new UrlSafetyPolicy();

/**
 * Analyzes already-fetched HTML with the default scoring methodology.
 * Network safety remains the caller's responsibility because this function performs no fetch.
 *
 * @param {string} pageUrl
 * @param {string|Buffer} html
 * @param {{responseHeaders?: Record<string, string|string[]>}} [options]
 * @returns {import('./contracts').AnalysisReport}
 */
function analyzeHtml(pageUrl, html, options) {
  return defaultAnalyzer.analyze(pageUrl, html, options);
}

/**
 * Applies the analyzer's URL syntax and protocol policy without performing DNS authorization.
 *
 * @param {string|URL} input
 * @returns {string}
 */
function normalizeUrl(input) {
  return normalizationPolicy.normalize(input).href;
}

module.exports = {
  PageSnapshot,
  SeoAnalyzer,
  analyzeHtml,
  normalizeUrl,
  rules
};
