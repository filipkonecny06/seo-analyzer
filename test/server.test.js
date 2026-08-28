'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { afterEach, describe, it } = require('node:test');
const { version: applicationVersion } = require('../package.json');
const { WorkerAnalysisRunner } = require('../src/analysis/analysis-runner');
const { loadConfig } = require('../src/config');
const { UrlPolicyError } = require('../src/errors');
const { createServer } = require('../src/http/create-server');
const { ConcurrencyGate, InMemoryRateLimiter } = require('../src/http/limits');

const servers = new Set();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    )
  );
  servers.clear();
});

function testConfig(overrides = {}) {
  return {
    ...loadConfig({
      PORT: '0',
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_WINDOW_MS: '60000',
      MAX_CONCURRENT_ANALYSES: '2'
    }),
    ...overrides
  };
}

async function startServer(options = {}) {
  const fetcher = options.fetcher || {
    async fetch(target) {
      return {
        html: Buffer.from('<html lang="en"><body><h1>Test</h1></body></html>'),
        finalUrl: target.startsWith('http') ? target : `https://${target}/`,
        responseHeaders: {},
        redirectCount: 0
      };
    }
  };
  const analyzer = options.analyzer || {
    analyze(url) {
      return {
        score: 50,
        maxScore: 100,
        grade: 'F',
        metadata: { titleLength: 0, descriptionLength: 0, lang: 'en' },
        content: {
          words: { count: 1, topKeywords: [] },
          headings: { counts: { h1: 1 } },
          images: { missingAlt: 0 },
          links: { internal: 0, external: 0 },
          structuredDataCount: 0
        },
        checks: [],
        recommendations: [],
        analyzedBy: url
      };
    }
  };
  const logger = { error() {}, info() {} };
  const server = createServer({
    config: testConfig(options.config),
    fetcher,
    analyzer,
    analysisRunner: options.analysisRunner,
    rateLimiter: options.rateLimiter,
    concurrencyGate: options.concurrencyGate,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    logger
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function rawRequest(origin, path, method = 'GET') {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: url.hostname, port: url.port, method, path },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    request.on('error', reject);
    request.end();
  });
}

describe('HTTP server', () => {
  it('serves the frontend and health endpoint with hardened headers and HEAD support', async () => {
    const { origin } = await startServer();
    const home = await fetch(`${origin}/`);
    const browserModule = await fetch(`${origin}/analyzer-app.mjs`);
    const health = await fetch(`${origin}/api/health`);
    const healthHead = await fetch(`${origin}/api/health`, { method: 'HEAD' });

    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>On-Page SEO Analyzer<\/title>/);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(home.headers.get('x-request-id'));
    assert.equal(browserModule.status, 200);
    assert.match(browserModule.headers.get('content-type'), /^text\/javascript/);
    assert.match(await browserModule.text(), /export class AnalyzerApp/);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, status: 'up', version: applicationVersion });
    assert.equal(healthHead.status, 200);
    assert.equal(await healthHead.text(), '');
    assert.ok(Number(healthHead.headers.get('content-length')) > 0);
  });

  it('returns a stable analysis contract and passes response headers to the analyzer', async () => {
    let analyzerArguments;
    const analyzer = {
      analyze(...args) {
        analyzerArguments = args;
        return { score: 91, maxScore: 100, grade: 'A', checks: [], recommendations: [] };
      }
    };
    const fetcher = {
      async fetch() {
        return {
          html: Buffer.from('<html></html>'),
          finalUrl: 'https://example.com/final',
          responseHeaders: { 'x-robots-tag': 'index' },
          redirectCount: 2
        };
      }
    };
    const { origin } = await startServer({ analyzer, fetcher });
    const response = await fetch(`${origin}/api/analyze?url=example.com`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(payload.url, 'https://example.com/final');
    assert.equal(payload.fetchedAt, '2026-08-28T00:00:00.000Z');
    assert.deepEqual(payload.network, { redirectCount: 2 });
    assert.equal(payload.report.score, 91);
    assert.equal(analyzerArguments[0], 'https://example.com/final');
    assert.deepEqual(analyzerArguments[2].responseHeaders, { 'x-robots-tag': 'index' });
    assert.equal(analyzerArguments[2].signal.aborted, false);
  });

  it('returns structured 400, 404, and 405 errors', async () => {
    const { origin } = await startServer();
    const missing = await fetch(`${origin}/api/analyze`);
    const unknown = await fetch(`${origin}/api/unknown`);
    const method = await fetch(`${origin}/api/health`, { method: 'POST' });

    assert.deepEqual(await missing.json(), {
      ok: false,
      error: { code: 'MISSING_URL', message: 'The url query parameter is required.' }
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET, HEAD');
  });

  it('turns policy errors into safe public responses', async () => {
    const fetcher = {
      async fetch() {
        throw new UrlPolicyError('The target resolves to a non-public network address.', {
          code: 'NON_PUBLIC_ADDRESS'
        });
      }
    };
    const { origin } = await startServer({ fetcher });
    const response = await fetch(`${origin}/api/analyze?url=private.example`);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'NON_PUBLIC_ADDRESS',
        message: 'The target resolves to a non-public network address.'
      }
    });
  });

  it('does not crash on malformed encoding or traversal-shaped paths', async () => {
    const { origin } = await startServer();
    const malformed = await rawRequest(origin, '/%E0%A4%A');
    const traversal = await rawRequest(origin, '/..%5cserver.js');
    const health = await fetch(`${origin}/api/health`);

    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.text).error.code, 'INVALID_PATH_ENCODING');
    assert.equal(traversal.status, 400);
    assert.equal(JSON.parse(traversal.text).error.code, 'INVALID_PATH');
    assert.equal(health.status, 200);
  });

  it('applies per-client rate limits', async () => {
    const { origin } = await startServer({ config: { rateLimitMax: 1 } });
    const first = await fetch(`${origin}/api/analyze?url=example.com`);
    const second = await fetch(`${origin}/api/analyze?url=example.com`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, 'RATE_LIMITED');
    assert.ok(Number(second.headers.get('retry-after')) >= 1);
  });

  it('rejects excess concurrent analyses without leaking a permit', async () => {
    let releaseFetch;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    const fetcher = {
      fetch() {
        markFetchStarted();
        return new Promise((resolve) => {
          releaseFetch = () =>
            resolve({
              html: Buffer.from('<html></html>'),
              finalUrl: 'https://example.com/',
              responseHeaders: {},
              redirectCount: 0
            });
        });
      }
    };
    const { origin } = await startServer({
      fetcher,
      concurrencyGate: new ConcurrencyGate(1)
    });
    const firstPromise = fetch(`${origin}/api/analyze?url=example.com`);
    await fetchStarted;
    const busy = await fetch(`${origin}/api/analyze?url=second.example`);

    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, 'ANALYZER_BUSY');
    releaseFetch();
    assert.equal((await firstPromise).status, 200);
  });

  it(
    'cancels outbound work and releases its permit after a client disconnects',
    { timeout: 2000 },
    async () => {
      let markFetchStarted;
      let markFetchCancelled;
      let observedSignal;
      const fetchStarted = new Promise((resolve) => {
        markFetchStarted = resolve;
      });
      const fetchCancelled = new Promise((resolve) => {
        markFetchCancelled = resolve;
      });
      const gate = new ConcurrencyGate(1);
      const fetcher = {
        fetch(_target, { signal }) {
          observedSignal = signal;
          markFetchStarted();
          return new Promise((resolve, reject) => {
            const cancel = () => {
              reject(signal.reason);
              markFetchCancelled();
            };
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          });
        }
      };
      const { origin } = await startServer({ fetcher, concurrencyGate: gate });
      const target = new URL('/api/analyze?url=example.com', origin);
      const clientRequest = http.request(target);
      clientRequest.on('error', () => {});
      clientRequest.end();

      await fetchStarted;
      clientRequest.destroy();
      await fetchCancelled;
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(observedSignal.aborted, true);
      assert.equal(gate.active, 0);
    }
  );

  it(
    'holds the concurrency permit until an aborted analysis worker has terminated',
    { timeout: 2000 },
    async () => {
      const worker = new EventEmitter();
      let finishTermination;
      let markWorkerStarted;
      let markTerminationStarted;
      const workerStarted = new Promise((resolve) => {
        markWorkerStarted = resolve;
      });
      const terminationStarted = new Promise((resolve) => {
        markTerminationStarted = resolve;
      });
      const termination = new Promise((resolve) => {
        finishTermination = resolve;
      });
      worker.terminate = () => {
        markTerminationStarted();
        return termination;
      };
      const analysisRunner = new WorkerAnalysisRunner({
        workerFactory() {
          markWorkerStarted();
          return worker;
        }
      });
      const gate = new ConcurrencyGate(1);
      const { origin } = await startServer({ analysisRunner, concurrencyGate: gate });
      const clientRequest = http.request(new URL('/api/analyze?url=example.com', origin));
      clientRequest.on('error', () => {});
      clientRequest.end();

      await workerStarted;
      clientRequest.destroy();
      await terminationStarted;
      assert.equal(gate.active, 1);

      finishTermination(1);
      for (let turn = 0; turn < 10 && gate.active !== 0; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(gate.active, 0);
    }
  );

  it('serves 404s and rejects unsupported static methods', async () => {
    const { origin } = await startServer();
    const missing = await fetch(`${origin}/missing.txt`);
    const post = await fetch(`${origin}/`, { method: 'POST' });

    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Not Found');
    assert.equal(post.status, 405);
  });
});

describe('limit primitives', () => {
  it('resets rate-limit windows and bounds retained client entries', () => {
    let now = 1000;
    const limiter = new InMemoryRateLimiter({
      limit: 1,
      windowMs: 100,
      maxEntries: 1,
      clock: () => now
    });

    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
    limiter.consume('b');
    assert.equal(limiter.entries.size, 1);
    now = 1200;
    assert.equal(limiter.consume('b').allowed, true);
  });

  it('releases concurrency permits idempotently', () => {
    const gate = new ConcurrencyGate(1);
    const release = gate.tryAcquire();
    assert.equal(gate.tryAcquire(), null);
    release();
    release();
    assert.equal(gate.active, 0);
    assert.equal(typeof gate.tryAcquire(), 'function');
  });
});
