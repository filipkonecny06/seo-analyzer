'use strict';

// Validates outbound targets and resolves them without permitting access to private networks.

const dns = require('node:dns/promises');
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const { UrlPolicyError } = require('../errors');

const DEFAULT_ALLOWED_PORTS = Object.freeze([80, 443]);
const BLOCKED_HOST_SUFFIXES = Object.freeze(['.localhost', '.local', '.internal', '.home.arpa']);
const EMPTY_DNS_RESULT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Canonicalizes an IPv4 or IPv6 address for consistent policy checks and connection pinning.
 *
 * @param {string} address
 * @returns {{address: string, family: 4|6, range: string}}
 * @throws {UrlPolicyError} When the supplied address is invalid.
 */
function normalizeAddress(address) {
  try {
    const parsed = ipaddr.process(stripIpv6Brackets(String(address).trim()));
    return {
      address: parsed.toString(),
      family: parsed.kind() === 'ipv6' ? 6 : 4,
      range: parsed.range()
    };
  } catch (error) {
    throw new UrlPolicyError('The target host resolved to an invalid IP address.', {
      code: 'INVALID_RESOLVED_ADDRESS',
      cause: error
    });
  }
}

/**
 * Rejects loopback, private, link-local, multicast, and other non-unicast destinations.
 *
 * @param {string} address
 * @returns {{address: string, family: 4|6, range: string}}
 */
function assertPublicAddress(address) {
  const normalized = normalizeAddress(address);
  if (normalized.range !== 'unicast') {
    throw new UrlPolicyError('The target resolves to a non-public network address.', {
      code: 'NON_PUBLIC_ADDRESS'
    });
  }
  return normalized;
}

function signalReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('The operation was cancelled.');
}

function createDefaultResolver() {
  return new dns.Resolver();
}

async function resolveAddressFamily(resolver, method, hostname, family) {
  try {
    const records = await resolver[method](hostname);
    return records.map((record) => ({
      address: typeof record === 'string' ? record : record.address,
      family
    }));
  } catch (error) {
    if (EMPTY_DNS_RESULT_CODES.has(error?.code)) return [];
    throw error;
  }
}

/**
 * Enforces the URL and DNS portion of the server-side request-forgery boundary.
 * Authorization returns a concrete address that callers must pin to the outbound connection.
 */
class UrlSafetyPolicy {
  constructor(options = {}) {
    this.resolverFactory = options.resolverFactory || createDefaultResolver;
    this.dnsTimeoutMs = options.dnsTimeoutMs || 3000;
    this.maxUrlLength = options.maxUrlLength || 2048;
    this.allowedPorts = new Set(options.allowedPorts || DEFAULT_ALLOWED_PORTS);
    this.timers = options.timers || { setTimeout, clearTimeout };
  }

  /**
   * Normalizes a user target and enforces protocol, credential, port, and hostname rules.
   *
   * @param {string|URL} input
   * @returns {URL}
   * @throws {UrlPolicyError} When the target is syntactically invalid or disallowed.
   */
  normalize(input) {
    const raw = input instanceof URL ? input.toString() : String(input || '').trim();
    if (!raw) {
      throw new UrlPolicyError('URL cannot be empty.', {
        code: 'EMPTY_URL',
        statusCode: 400
      });
    }
    if (raw.length > this.maxUrlLength) {
      throw new UrlPolicyError(`URL must be at most ${this.maxUrlLength} characters.`, {
        code: 'URL_TOO_LONG',
        statusCode: 400
      });
    }

    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url;
    try {
      url = new URL(candidate);
    } catch (error) {
      throw new UrlPolicyError('Enter a valid HTTP or HTTPS URL.', {
        code: 'INVALID_URL',
        statusCode: 400,
        cause: error
      });
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UrlPolicyError('Only HTTP and HTTPS URLs are supported.', {
        code: 'UNSUPPORTED_PROTOCOL',
        statusCode: 400
      });
    }
    if (url.username || url.password) {
      throw new UrlPolicyError('URLs containing credentials are not allowed.', {
        code: 'URL_CREDENTIALS_NOT_ALLOWED',
        statusCode: 400
      });
    }

    const effectivePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!this.allowedPorts.has(effectivePort)) {
      throw new UrlPolicyError(`Port ${effectivePort} is not allowed.`, {
        code: 'PORT_NOT_ALLOWED'
      });
    }

    const hostname = stripIpv6Brackets(url.hostname).replace(/\.$/, '').toLowerCase();
    if (
      hostname === 'localhost' ||
      BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    ) {
      throw new UrlPolicyError('Local and private hostnames are not allowed.', {
        code: 'LOCAL_HOSTNAME_NOT_ALLOWED'
      });
    }

    url.hash = '';
    return url;
  }

  /**
   * Resolves a normalized target and verifies that every returned address is public.
   * Rejecting a mixed public/private answer prevents a resolver from hiding an internal target
   * among otherwise acceptable records.
   *
   * @param {string|URL} input
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{url: URL, addresses: object[], selectedAddress: object}>}
   */
  async authorize(input, options = {}) {
    if (options.signal?.aborted) throw signalReason(options.signal);
    const url = this.normalize(input);
    const hostname = stripIpv6Brackets(url.hostname);
    let resolved;

    if (net.isIP(hostname)) {
      resolved = [assertPublicAddress(hostname)];
    } else {
      const records = await this.resolveWithTimeout(hostname, options);
      if (!Array.isArray(records) || records.length === 0) {
        throw new UrlPolicyError('The target hostname did not resolve.', {
          code: 'DNS_NO_RESULTS',
          statusCode: 400
        });
      }
      resolved = records.map((record) => assertPublicAddress(record.address || record));
    }

    const unique = [
      ...new Map(resolved.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()
    ];
    // Prefer IPv4 for broad host compatibility while retaining an IPv6-only fallback.
    const selectedAddress = unique.find((entry) => entry.family === 4) || unique[0];
    return { url, addresses: unique, selectedAddress };
  }

  /**
   * Resolves both address families under one timeout and cancellation lifecycle.
   *
   * @param {string} hostname
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<Array<{address: string, family: 4|6}>>}
   */
  async resolveWithTimeout(hostname, options = {}) {
    if (options.signal?.aborted) throw signalReason(options.signal);

    let resolver;
    let timer;
    let abortHandler;
    try {
      resolver = this.resolverFactory();
      if (
        !resolver ||
        typeof resolver.resolve4 !== 'function' ||
        typeof resolver.resolve6 !== 'function' ||
        typeof resolver.cancel !== 'function'
      ) {
        throw new TypeError('The DNS resolver factory returned an invalid resolver.');
      }

      return await new Promise((resolve, reject) => {
        let settled = false;

        const resolveOnce = (records) => {
          if (settled) return;
          settled = true;
          resolve(records);
        };
        const rejectAndCancel = (error) => {
          if (settled) return;
          settled = true;
          try {
            resolver.cancel();
          } catch (_cancelError) {
            // Preserve the safe timeout, cancellation, or lookup error selected by the caller.
          }
          reject(error);
        };

        timer = this.timers.setTimeout(() => {
          rejectAndCancel(
            new UrlPolicyError('DNS lookup timed out.', {
              code: 'DNS_TIMEOUT',
              statusCode: 504
            })
          );
        }, this.dnsTimeoutMs);

        if (options.signal) {
          abortHandler = () => rejectAndCancel(signalReason(options.signal));
          options.signal.addEventListener('abort', abortHandler, { once: true });
          if (options.signal.aborted) abortHandler();
        }

        if (settled) return;
        // The families are independent; resolving them concurrently avoids doubling DNS latency.
        Promise.all([
          resolveAddressFamily(resolver, 'resolve4', hostname, 4),
          resolveAddressFamily(resolver, 'resolve6', hostname, 6)
        ]).then(
          ([ipv4, ipv6]) => resolveOnce([...ipv4, ...ipv6]),
          (error) => rejectAndCancel(error)
        );
      });
    } catch (error) {
      if (options.signal?.aborted) throw signalReason(options.signal);
      if (error instanceof UrlPolicyError) {
        throw error;
      }
      throw new UrlPolicyError('The target hostname could not be resolved.', {
        code: 'DNS_LOOKUP_FAILED',
        statusCode: 400,
        cause: error
      });
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Builds a Node-compatible lookup callback that always returns the authorized address.
   * Keeping the original URL hostname for HTTP Host/TLS SNI while pinning the socket address closes
   * the DNS-rebinding gap between policy validation and connection establishment.
   *
   * @param {{address: string, family: 4|6}} selectedAddress
   * @returns {Function}
   */
  createPinnedLookup(selectedAddress) {
    return (_hostname, options, callback) => {
      let lookupOptions = options;
      let done = callback;
      if (typeof options === 'function') {
        done = options;
        lookupOptions = {};
      }

      queueMicrotask(() => {
        if (lookupOptions && lookupOptions.all) {
          done(null, [{ address: selectedAddress.address, family: selectedAddress.family }]);
          return;
        }
        done(null, selectedAddress.address, selectedAddress.family);
      });
    };
  }
}

module.exports = {
  DEFAULT_ALLOWED_PORTS,
  UrlSafetyPolicy,
  assertPublicAddress,
  normalizeAddress
};
