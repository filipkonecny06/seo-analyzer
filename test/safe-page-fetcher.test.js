'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, describe, it } = require('node:test');
const { SafePageFetcher, requestPinned } = require('../src/network/safe-page-fetcher');
const { UrlSafetyPolicy } = require('../src/network/url-safety-policy');

function htmlResponse(body, headers = {}) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: Buffer.from(body)
  };
}

function redirectResponse(location, statusCode = 302) {
  return { statusCode, headers: { location }, body: Buffer.alloc(0) };
}

describe('SafePageFetcher redirect policy', () => {
  const publicRecord = [{ address: '93.184.216.34', family: 4 }];

  it('re-authorizes and DNS-pins every redirect hop', async () => {
    const resolvedHosts = [];
    const requestedUrls = [];
    const policy = new UrlSafetyPolicy({
      resolver: async (hostname) => {
        resolvedHosts.push(hostname);
        return publicRecord;
      }
    });
    const fetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async (options) => {
        requestedUrls.push({ href: options.url.href, selected: options.selectedAddress.address });
        return options.url.hostname === 'first.example'
          ? redirectResponse('https://second.example/final')
          : htmlResponse('<html><title>Final</title></html>', { 'x-robots-tag': 'index' });
      }
    });

    const page = await fetcher.fetch('https://first.example/start');

    assert.deepEqual(resolvedHosts, ['first.example', 'second.example']);
    assert.deepEqual(requestedUrls, [
      { href: 'https://first.example/start', selected: '93.184.216.34' },
      { href: 'https://second.example/final', selected: '93.184.216.34' }
    ]);
    assert.equal(page.finalUrl, 'https://second.example/final');
    assert.equal(page.redirectCount, 1);
    assert.equal(page.responseHeaders['x-robots-tag'], 'index');
  });

  it('blocks a redirect to a private DNS result before the second request', async () => {
    let requestCount = 0;
    const policy = new UrlSafetyPolicy({
      resolver: async (hostname) =>
        hostname === 'private.example' ? [{ address: '127.0.0.1', family: 4 }] : publicRecord
    });
    const fetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async () => {
        requestCount += 1;
        return redirectResponse('http://private.example/admin');
      }
    });

    await assert.rejects(fetcher.fetch('https://public.example'), { code: 'NON_PUBLIC_ADDRESS' });
    assert.equal(requestCount, 1);
  });

  it('detects loops, missing locations, and redirect limits', async () => {
    const policy = new UrlSafetyPolicy({ resolver: async () => publicRecord });
    const loopFetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async () => redirectResponse('https://loop.example')
    });
    await assert.rejects(loopFetcher.fetch('https://loop.example'), { code: 'REDIRECT_LOOP' });

    const missingLocationFetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async () => ({ statusCode: 302, headers: {}, body: Buffer.alloc(0) })
    });
    await assert.rejects(missingLocationFetcher.fetch('https://public.example'), {
      code: 'INVALID_REDIRECT'
    });

    const limitedFetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      maxRedirects: 0,
      request: async () => redirectResponse('/next')
    });
    await assert.rejects(limitedFetcher.fetch('https://public.example'), {
      code: 'TOO_MANY_REDIRECTS'
    });
  });

  it('rejects non-success statuses and non-HTML content', async () => {
    const policy = new UrlSafetyPolicy({ resolver: async () => publicRecord });
    const errorFetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async () => ({ statusCode: 503, headers: {}, body: Buffer.alloc(0) })
    });
    await assert.rejects(errorFetcher.fetch('https://public.example'), {
      code: 'REMOTE_HTTP_ERROR'
    });

    const jsonFetcher = new SafePageFetcher({
      urlSafetyPolicy: policy,
      request: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}')
      })
    });
    await assert.rejects(jsonFetcher.fetch('https://public.example'), { code: 'NOT_HTML' });
  });
});

describe('requestPinned transport limits', () => {
  let origin;
  let server;
  const lookup = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  };

  before(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('x'.repeat(200));
        return;
      }
      if (request.url === '/declared-large') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': '9999' });
        response.end('small');
        return;
      }
      if (request.url === '/encoded') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        response.end('not really gzip');
        return;
      }
      if (request.url === '/slow') {
        setTimeout(() => {
          if (!response.destroyed) response.end('<html>late</html>');
        }, 80);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>ok</html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://safe.test:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function request(pathname, overrides = {}) {
    return requestPinned({
      url: new URL(pathname, origin),
      selectedAddress: { address: '127.0.0.1', family: 4 },
      lookup,
      headers: { accept: 'text/html', 'accept-encoding': 'identity' },
      timeoutMs: 500,
      maxResponseBytes: 100,
      ...overrides
    });
  }

  it('uses the pinned lookup and reads a bounded successful response', async () => {
    const response = await request('/ok');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString(), '<html>ok</html>');
  });

  it('enforces declared and streaming response-size limits', async () => {
    await assert.rejects(request('/large'), { code: 'RESPONSE_TOO_LARGE' });
    await assert.rejects(request('/declared-large'), { code: 'RESPONSE_TOO_LARGE' });
  });

  it('rejects encoded responses when identity was requested', async () => {
    await assert.rejects(request('/encoded'), { code: 'UNSUPPORTED_CONTENT_ENCODING' });
  });

  it('enforces a total request deadline', async () => {
    await assert.rejects(request('/slow', { timeoutMs: 20 }), { code: 'FETCH_TIMEOUT' });
  });
});
