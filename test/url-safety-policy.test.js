'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  UrlSafetyPolicy,
  assertPublicAddress,
  normalizeAddress
} = require('../src/network/url-safety-policy');

describe('UrlSafetyPolicy', () => {
  it('normalizes safe public URLs and strips fragments', async () => {
    const policy = new UrlSafetyPolicy({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
      ]
    });
    const authorized = await policy.authorize('example.com/docs#intro');

    assert.equal(authorized.url.href, 'https://example.com/docs');
    assert.equal(authorized.addresses.length, 2);
    assert.deepEqual(authorized.selectedAddress, {
      address: '93.184.216.34',
      family: 4,
      range: 'unicast'
    });
  });

  it('rejects malformed URLs, credentials, protocols, ports, and local names', () => {
    const policy = new UrlSafetyPolicy();

    assert.throws(() => policy.normalize(''), { code: 'EMPTY_URL' });
    assert.throws(() => policy.normalize('https://['), { code: 'INVALID_URL' });
    assert.throws(() => policy.normalize('file:///etc/passwd'), { code: 'UNSUPPORTED_PROTOCOL' });
    assert.throws(() => policy.normalize('https://user:secret@example.com'), {
      code: 'URL_CREDENTIALS_NOT_ALLOWED'
    });
    assert.throws(() => policy.normalize('https://example.com:8080'), { code: 'PORT_NOT_ALLOWED' });
    assert.throws(() => policy.normalize('https://localhost'), {
      code: 'LOCAL_HOSTNAME_NOT_ALLOWED'
    });
    assert.throws(() => policy.normalize('https://service.internal'), {
      code: 'LOCAL_HOSTNAME_NOT_ALLOWED'
    });
    const shortPolicy = new UrlSafetyPolicy({ maxUrlLength: 30 });
    assert.throws(() => shortPolicy.normalize(`https://example.com/${'a'.repeat(40)}`), {
      code: 'URL_TOO_LONG'
    });
  });

  it('blocks every tested non-global IPv4 and IPv6 range', async () => {
    const policy = new UrlSafetyPolicy();
    const blocked = [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '192.0.2.1',
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]'
    ];

    for (const host of blocked) {
      await assert.rejects(policy.authorize(`http://${host}`), { code: 'NON_PUBLIC_ADDRESS' });
    }
  });

  it('rejects a hostname when any DNS answer is non-public', async () => {
    const policy = new UrlSafetyPolicy({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.4', family: 4 }
      ]
    });
    await assert.rejects(policy.authorize('https://mixed.example'), { code: 'NON_PUBLIC_ADDRESS' });
  });

  it('deduplicates DNS answers and reports lookup failures safely', async () => {
    const duplicatePolicy = new UrlSafetyPolicy({
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.34', family: 4 }
      ]
    });
    assert.equal((await duplicatePolicy.authorize('https://example.com')).addresses.length, 1);

    const emptyPolicy = new UrlSafetyPolicy({ resolver: async () => [] });
    await assert.rejects(emptyPolicy.authorize('https://empty.example'), {
      code: 'DNS_NO_RESULTS'
    });

    const failedPolicy = new UrlSafetyPolicy({
      resolver: async () => {
        throw new Error('resolver detail must not escape');
      }
    });
    await assert.rejects(failedPolicy.authorize('https://failed.example'), {
      code: 'DNS_LOOKUP_FAILED'
    });
  });

  it('enforces a DNS deadline', async () => {
    const policy = new UrlSafetyPolicy({
      dnsTimeoutMs: 10,
      resolver: () => new Promise(() => {})
    });
    await assert.rejects(policy.authorize('https://slow.example'), { code: 'DNS_TIMEOUT' });
  });

  it('creates a DNS lookup callback pinned to the approved address', async () => {
    const policy = new UrlSafetyPolicy();
    const lookup = policy.createPinnedLookup({ address: '93.184.216.34', family: 4 });
    const one = await new Promise((resolve, reject) => {
      lookup('ignored.example', {}, (error, address, family) =>
        error ? reject(error) : resolve({ address, family })
      );
    });
    const all = await new Promise((resolve, reject) => {
      lookup('ignored.example', { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses)
      );
    });

    assert.deepEqual(one, { address: '93.184.216.34', family: 4 });
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('IP classification helpers', () => {
  it('normalizes IPv4-mapped IPv6 addresses before classification', () => {
    assert.deepEqual(normalizeAddress('::ffff:127.0.0.1'), {
      address: '127.0.0.1',
      family: 4,
      range: 'loopback'
    });
  });

  it('allows globally routable unicast and rejects invalid or reserved addresses', () => {
    assert.equal(assertPublicAddress('8.8.8.8').range, 'unicast');
    assert.throws(() => assertPublicAddress('bad address'), { code: 'INVALID_RESOLVED_ADDRESS' });
    assert.throws(() => assertPublicAddress('0.0.0.0'), { code: 'NON_PUBLIC_ADDRESS' });
  });
});
