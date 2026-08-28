'use strict';

const { DEFAULT_ALLOWED_PORTS } = require('./network/url-safety-policy');
const { DEFAULT_USER_AGENT } = require('./version');

// String values match process.env and are also verified against the example file and README.
const ENV_DEFAULTS = Object.freeze({
  HOST: '0.0.0.0',
  PORT: '3000',
  REQUEST_TIMEOUT_MS: '15000',
  TRUST_PROXY: 'false',
  OUTBOUND_USER_AGENT: DEFAULT_USER_AGENT,
  ALLOWED_TARGET_PORTS: DEFAULT_ALLOWED_PORTS.join(','),
  DNS_TIMEOUT_MS: '3000',
  FETCH_TIMEOUT_MS: '10000',
  MAX_RESPONSE_BYTES: '2000000',
  MAX_REDIRECTS: '4',
  MAX_URL_LENGTH: '2048',
  RATE_LIMIT_MAX: '10',
  RATE_LIMIT_WINDOW_MS: '60000',
  MAX_CONCURRENT_ANALYSES: '4',
  ANALYSIS_TIMEOUT_MS: '5000',
  ANALYSIS_MAX_OLD_SPACE_MB: '128',
  ANALYSIS_MAX_YOUNG_SPACE_MB: '16',
  ANALYSIS_STACK_SIZE_MB: '4'
});

/**
 * Reads an integer and rejects non-integral or out-of-range values.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @param {{minimum?: number, maximum?: number}} [limits]
 * @returns {number}
 * @throws {TypeError} When the supplied value is not an integer inside the configured bounds.
 */
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

/**
 * Reads an explicit true/false environment flag.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 * @throws {TypeError} When a non-empty value is neither "true" nor "false".
 */
function parseBoolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TypeError(`${name} must be either true or false.`);
}

/**
 * Parses and deduplicates the outbound port allowlist used by the URL safety policy.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number[]}
 * @throws {TypeError} When any configured port is invalid.
 */
function parseAllowedPorts(env) {
  if (!env.ALLOWED_TARGET_PORTS) return [...DEFAULT_ALLOWED_PORTS];
  const ports = env.ALLOWED_TARGET_PORTS.split(',').map((value) => Number(value.trim()));
  if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TypeError('ALLOWED_TARGET_PORTS must be a comma-separated list of valid ports.');
  }
  return [...new Set(ports)];
}

/**
 * Validates the outbound User-Agent before it reaches Node's HTTP header handling.
 * Control characters are rejected to prevent header injection through configuration.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function parseUserAgent(env) {
  const value = String(env.OUTBOUND_USER_AGENT || ENV_DEFAULTS.OUTBOUND_USER_AGENT);
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (containsControlCharacter) {
    throw new TypeError('OUTBOUND_USER_AGENT must not contain control characters.');
  }
  return value;
}

/**
 * Validates configuration at startup so invalid limits fail before the server accepts traffic.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<import('./contracts').RuntimeConfig>}
 * @throws {TypeError} When any supported environment variable is invalid.
 */
function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || ENV_DEFAULTS.HOST,
    port: parseInteger(env, 'PORT', Number(ENV_DEFAULTS.PORT), { maximum: 65535 }),
    fetchTimeoutMs: parseInteger(env, 'FETCH_TIMEOUT_MS', Number(ENV_DEFAULTS.FETCH_TIMEOUT_MS), {
      minimum: 100,
      maximum: 60_000
    }),
    dnsTimeoutMs: parseInteger(env, 'DNS_TIMEOUT_MS', Number(ENV_DEFAULTS.DNS_TIMEOUT_MS), {
      minimum: 100,
      maximum: 30_000
    }),
    maxResponseBytes: parseInteger(
      env,
      'MAX_RESPONSE_BYTES',
      Number(ENV_DEFAULTS.MAX_RESPONSE_BYTES),
      {
        minimum: 1024,
        maximum: 10_000_000
      }
    ),
    maxRedirects: parseInteger(env, 'MAX_REDIRECTS', Number(ENV_DEFAULTS.MAX_REDIRECTS), {
      maximum: 10
    }),
    maxUrlLength: parseInteger(env, 'MAX_URL_LENGTH', Number(ENV_DEFAULTS.MAX_URL_LENGTH), {
      minimum: 100,
      maximum: 8192
    }),
    allowedTargetPorts: parseAllowedPorts(env),
    rateLimitMax: parseInteger(env, 'RATE_LIMIT_MAX', Number(ENV_DEFAULTS.RATE_LIMIT_MAX), {
      minimum: 1,
      maximum: 1000
    }),
    rateLimitWindowMs: parseInteger(
      env,
      'RATE_LIMIT_WINDOW_MS',
      Number(ENV_DEFAULTS.RATE_LIMIT_WINDOW_MS),
      { minimum: 1000, maximum: 3_600_000 }
    ),
    maxConcurrentAnalyses: parseInteger(
      env,
      'MAX_CONCURRENT_ANALYSES',
      Number(ENV_DEFAULTS.MAX_CONCURRENT_ANALYSES),
      { minimum: 1, maximum: 100 }
    ),
    analysisTimeoutMs: parseInteger(
      env,
      'ANALYSIS_TIMEOUT_MS',
      Number(ENV_DEFAULTS.ANALYSIS_TIMEOUT_MS),
      { minimum: 100, maximum: 60_000 }
    ),
    analysisMaxOldSpaceMb: parseInteger(
      env,
      'ANALYSIS_MAX_OLD_SPACE_MB',
      Number(ENV_DEFAULTS.ANALYSIS_MAX_OLD_SPACE_MB),
      { minimum: 16, maximum: 512 }
    ),
    analysisMaxYoungSpaceMb: parseInteger(
      env,
      'ANALYSIS_MAX_YOUNG_SPACE_MB',
      Number(ENV_DEFAULTS.ANALYSIS_MAX_YOUNG_SPACE_MB),
      { minimum: 4, maximum: 128 }
    ),
    analysisStackSizeMb: parseInteger(
      env,
      'ANALYSIS_STACK_SIZE_MB',
      Number(ENV_DEFAULTS.ANALYSIS_STACK_SIZE_MB),
      {
        minimum: 1,
        maximum: 16
      }
    ),
    trustProxy: parseBoolean(env, 'TRUST_PROXY', parseBoolean(ENV_DEFAULTS, 'TRUST_PROXY', false)),
    userAgent: parseUserAgent(env),
    requestTimeoutMs: parseInteger(
      env,
      'REQUEST_TIMEOUT_MS',
      Number(ENV_DEFAULTS.REQUEST_TIMEOUT_MS),
      {
        minimum: 1000,
        maximum: 120_000
      }
    )
  };
  return Object.freeze(config);
}

module.exports = {
  ENV_DEFAULTS,
  loadConfig,
  parseAllowedPorts,
  parseBoolean,
  parseInteger,
  parseUserAgent
};
