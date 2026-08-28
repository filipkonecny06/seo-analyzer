'use strict';

const { DEFAULT_ALLOWED_PORTS } = require('./network/url-safety-policy');
const { DEFAULT_USER_AGENT } = require('./version');

function parseInteger(env, name, fallback, limits = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const minimum = limits.minimum ?? 0;
  const maximum = limits.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseBoolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TypeError(`${name} must be either true or false.`);
}

function parseAllowedPorts(env) {
  if (!env.ALLOWED_TARGET_PORTS) return [...DEFAULT_ALLOWED_PORTS];
  const ports = env.ALLOWED_TARGET_PORTS.split(',').map((value) => Number(value.trim()));
  if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TypeError('ALLOWED_TARGET_PORTS must be a comma-separated list of valid ports.');
  }
  return [...new Set(ports)];
}

function parseUserAgent(env) {
  const value = String(env.OUTBOUND_USER_AGENT || DEFAULT_USER_AGENT);
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  if (containsControlCharacter) {
    throw new TypeError('OUTBOUND_USER_AGENT must not contain control characters.');
  }
  return value;
}

function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || '0.0.0.0',
    port: parseInteger(env, 'PORT', 3000, { maximum: 65535 }),
    fetchTimeoutMs: parseInteger(env, 'FETCH_TIMEOUT_MS', 10_000, {
      minimum: 100,
      maximum: 60_000
    }),
    dnsTimeoutMs: parseInteger(env, 'DNS_TIMEOUT_MS', 3000, {
      minimum: 100,
      maximum: 30_000
    }),
    maxResponseBytes: parseInteger(env, 'MAX_RESPONSE_BYTES', 2_000_000, {
      minimum: 1024,
      maximum: 10_000_000
    }),
    maxRedirects: parseInteger(env, 'MAX_REDIRECTS', 4, { maximum: 10 }),
    maxUrlLength: parseInteger(env, 'MAX_URL_LENGTH', 2048, {
      minimum: 100,
      maximum: 8192
    }),
    allowedTargetPorts: parseAllowedPorts(env),
    rateLimitMax: parseInteger(env, 'RATE_LIMIT_MAX', 10, { minimum: 1, maximum: 1000 }),
    rateLimitWindowMs: parseInteger(env, 'RATE_LIMIT_WINDOW_MS', 60_000, {
      minimum: 1000,
      maximum: 3_600_000
    }),
    maxConcurrentAnalyses: parseInteger(env, 'MAX_CONCURRENT_ANALYSES', 4, {
      minimum: 1,
      maximum: 100
    }),
    analysisTimeoutMs: parseInteger(env, 'ANALYSIS_TIMEOUT_MS', 5000, {
      minimum: 100,
      maximum: 60_000
    }),
    analysisMaxOldSpaceMb: parseInteger(env, 'ANALYSIS_MAX_OLD_SPACE_MB', 128, {
      minimum: 16,
      maximum: 512
    }),
    analysisMaxYoungSpaceMb: parseInteger(env, 'ANALYSIS_MAX_YOUNG_SPACE_MB', 16, {
      minimum: 4,
      maximum: 128
    }),
    analysisStackSizeMb: parseInteger(env, 'ANALYSIS_STACK_SIZE_MB', 4, {
      minimum: 1,
      maximum: 16
    }),
    trustProxy: parseBoolean(env, 'TRUST_PROXY', false),
    userAgent: parseUserAgent(env),
    requestTimeoutMs: parseInteger(env, 'REQUEST_TIMEOUT_MS', 15_000, {
      minimum: 1000,
      maximum: 120_000
    })
  };
  return Object.freeze(config);
}

module.exports = {
  loadConfig,
  parseAllowedPorts,
  parseBoolean,
  parseInteger,
  parseUserAgent
};
