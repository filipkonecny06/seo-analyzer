'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  UrlSafetyPolicy,
  assertPublicAddress,
  normalizeAddress
} = require('../src/network/url-safety-policy');

function dnsError(code) {
  return Object.assign(new Error(`DNS ${code}`), { code });
}

function staticResolverFactory(options = {}) {
  return () => ({
    async resolve4() {
      if (options.ipv4Error) throw options.ipv4Error;
      return options.ipv4 || [];
    },
    async resolve6() {
      if (options.ipv6Error) throw options.ipv6Error;
      return options.ipv6 || [];
    },
    cancel() {
      options.onCancel?.();
    }
  });
}

function createPendingResolverHarness() {
  let activeQueries = 0;
  let cancelCalls = 0;
  const pending = new Map();
  let markBothStarted;
  const bothStarted = new Promise((resolve) => {
    markBothStarted = resolve;
  });

  const start = (family) =>
    new Promise((resolve, reject) => {
      activeQueries += 1;
      pending.set(family, { resolve, reject });
      if (pending.size === 2) markBothStarted();
    });
  const finish = (family, callback) => {
    const query = pending.get(family);
    if (!query) return;
    pending.delete(family);
    activeQueries -= 1;
    callback(query);
  };

  return {
    resolver: {
      resolve4: () => start(4),
      resolve6: () => start(6),
      cancel() {
        cancelCalls += 1;
        for (const family of [...pending.keys()]) {
          finish(family, ({ reject }) => reject(dnsError('ECANCELLED')));
        }
      }
    },
    bothStarted,
    resolve4(records) {
      finish(4, ({ resolve }) => resolve(records));
    },
    resolve6(records) {
      finish(6, ({ resolve }) => resolve(records));
    },
    get activeQueries() {
      return activeQueries;
    },
    get cancelCalls() {
      return cancelCalls;
    }
  };
}

describe('UrlSafetyPolicy', () => {
  it('normalizes safe public URLs and strips fragments', async () => {
    const policy = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4: ['93.184.216.34'],
        ipv6: ['2606:2800:220:1:248:1893:25c8:1946']
      })
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
      resolverFactory: staticResolverFactory({ ipv4: ['93.184.216.34', '10.0.0.4'] })
    });
    await assert.rejects(policy.authorize('https://mixed.example'), { code: 'NON_PUBLIC_ADDRESS' });
  });

  it('deduplicates DNS answers and reports lookup failures safely', async () => {
    const duplicatePolicy = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4: ['93.184.216.34', '93.184.216.34']
      })
    });
    assert.equal((await duplicatePolicy.authorize('https://example.com')).addresses.length, 1);

    const emptyPolicy = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4Error: dnsError('ENODATA'),
        ipv6Error: dnsError('ENOTFOUND')
      })
    });
    await assert.rejects(emptyPolicy.authorize('https://empty.example'), {
      code: 'DNS_NO_RESULTS'
    });

    let cancelCalls = 0;
    const failedPolicy = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4Error: dnsError('ESERVFAIL'),
        onCancel: () => {
          cancelCalls += 1;
        }
      })
    });
    await assert.rejects(failedPolicy.authorize('https://failed.example'), {
      code: 'DNS_LOOKUP_FAILED'
    });
    assert.equal(cancelCalls, 1);
  });

  it('accepts either address family when the other has no records', async () => {
    const ipv4Only = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4: ['93.184.216.34'],
        ipv6Error: dnsError('ENODATA')
      })
    });
    const ipv6Only = new UrlSafetyPolicy({
      resolverFactory: staticResolverFactory({
        ipv4Error: dnsError('ENOTFOUND'),
        ipv6: ['2606:2800:220:1:248:1893:25c8:1946']
      })
    });

    assert.deepEqual((await ipv4Only.authorize('https://ipv4.example')).selectedAddress, {
      address: '93.184.216.34',
      family: 4,
      range: 'unicast'
    });
    assert.deepEqual((await ipv6Only.authorize('https://ipv6.example')).selectedAddress, {
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
      range: 'unicast'
    });
  });

  it('cancels both DNS queries when the DNS deadline expires', async () => {
    const harness = createPendingResolverHarness();
    let deadlineCallback;
    let clearedDeadline;
    const policy = new UrlSafetyPolicy({
      dnsTimeoutMs: 1000,
      resolverFactory: () => harness.resolver,
      timers: {
        setTimeout(callback) {
          deadlineCallback = callback;
          return 'dns-deadline';
        },
        clearTimeout(timer) {
          clearedDeadline = timer;
        }
      }
    });
    const pendingAuthorization = policy.authorize('https://slow.example');

    await harness.bothStarted;
    assert.equal(harness.activeQueries, 2);
    deadlineCallback();

    await assert.rejects(pendingAuthorization, { code: 'DNS_TIMEOUT' });
    assert.equal(harness.cancelCalls, 1);
    assert.equal(harness.activeQueries, 0);
    assert.equal(clearedDeadline, 'dns-deadline');
  });

  it('cancels both DNS queries when the caller disconnects', { timeout: 2000 }, async () => {
    const harness = createPendingResolverHarness();
    const policy = new UrlSafetyPolicy({
      resolverFactory: () => harness.resolver
    });
    const controller = new AbortController();
    const pendingAuthorization = policy.authorize('https://cancelled.example', {
      signal: controller.signal
    });

    await harness.bothStarted;
    controller.abort();

    await assert.rejects(pendingAuthorization, { name: 'AbortError' });
    assert.equal(harness.cancelCalls, 1);
    assert.equal(harness.activeQueries, 0);
  });

  it('uses an independent resolver for each authorization', async () => {
    const harnesses = [];
    const policy = new UrlSafetyPolicy({
      resolverFactory: () => {
        const harness = createPendingResolverHarness();
        harnesses.push(harness);
        return harness.resolver;
      }
    });
    const firstController = new AbortController();
    const firstAuthorization = policy.authorize('https://first.example', {
      signal: firstController.signal
    });
    const secondAuthorization = policy.authorize('https://second.example');

    await Promise.all(harnesses.map((harness) => harness.bothStarted));
    firstController.abort();
    harnesses[1].resolve4(['93.184.216.34']);
    harnesses[1].resolve6([]);

    await assert.rejects(firstAuthorization, { name: 'AbortError' });
    assert.equal((await secondAuthorization).selectedAddress.address, '93.184.216.34');
    assert.equal(harnesses[0].cancelCalls, 1);
    assert.equal(harnesses[1].cancelCalls, 0);
    assert.equal(harnesses[0].activeQueries, 0);
    assert.equal(harnesses[1].activeQueries, 0);
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
