'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const { UrlPolicyError } = require('../errors');

const DEFAULT_ALLOWED_PORTS = Object.freeze([80, 443]);
const BLOCKED_HOST_SUFFIXES = Object.freeze(['.localhost', '.local', '.internal', '.home.arpa']);

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

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

function assertPublicAddress(address) {
  const normalized = normalizeAddress(address);
  if (normalized.range !== 'unicast') {
    throw new UrlPolicyError('The target resolves to a non-public network address.', {
      code: 'NON_PUBLIC_ADDRESS'
    });
  }
  return normalized;
}

class UrlSafetyPolicy {
  constructor(options = {}) {
    this.resolver = options.resolver || dns.lookup;
    this.dnsTimeoutMs = options.dnsTimeoutMs || 3000;
    this.maxUrlLength = options.maxUrlLength || 2048;
    this.allowedPorts = new Set(options.allowedPorts || DEFAULT_ALLOWED_PORTS);
  }

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

  async authorize(input) {
    const url = this.normalize(input);
    const hostname = stripIpv6Brackets(url.hostname);
    let resolved;

    if (net.isIP(hostname)) {
      resolved = [assertPublicAddress(hostname)];
    } else {
      const records = await this.resolveWithTimeout(hostname);
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
    const selectedAddress = unique.find((entry) => entry.family === 4) || unique[0];
    return { url, addresses: unique, selectedAddress };
  }

  async resolveWithTimeout(hostname) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(this.resolver(hostname, { all: true, verbatim: true })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new UrlPolicyError('DNS lookup timed out.', {
                code: 'DNS_TIMEOUT',
                statusCode: 504
              })
            );
          }, this.dnsTimeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      if (error instanceof UrlPolicyError) {
        throw error;
      }
      throw new UrlPolicyError('The target hostname could not be resolved.', {
        code: 'DNS_LOOKUP_FAILED',
        statusCode: 400,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }

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
