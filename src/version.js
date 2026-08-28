'use strict';

// Centralizes application and methodology versions for reports, health checks, and outbound identity.

const { version: APPLICATION_VERSION } = require('../package.json');

const METHODOLOGY_VERSION = '2.0';
const DEFAULT_USER_AGENT = `OnPageSEOAnalyzer/${APPLICATION_VERSION}`;

module.exports = {
  APPLICATION_VERSION,
  DEFAULT_USER_AGENT,
  METHODOLOGY_VERSION
};
