'use strict';

const { SeoAnalyzer } = require('./analysis/seo-analyzer');
const { PageSnapshot } = require('./analysis/page-snapshot');
const rules = require('./analysis/rules');
const { UrlSafetyPolicy } = require('./network/url-safety-policy');

const defaultAnalyzer = new SeoAnalyzer();
const normalizationPolicy = new UrlSafetyPolicy();

function analyzeHtml(pageUrl, html, options) {
  return defaultAnalyzer.analyze(pageUrl, html, options);
}

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
