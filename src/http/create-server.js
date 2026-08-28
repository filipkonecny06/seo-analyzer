'use strict';

// HTTP composition root: routes requests, serves static assets, and wires security dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { WorkerAnalysisRunner, createInlineAnalysisRunner } = require('../analysis/analysis-runner');
const { loadConfig } = require('../config');
const { AppError } = require('../errors');
const { SafePageFetcher } = require('../network/safe-page-fetcher');
const { UrlSafetyPolicy } = require('../network/url-safety-policy');
const { APPLICATION_VERSION } = require('../version');
const { ConcurrencyGate, InMemoryRateLimiter } = require('./limits');

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
});

// The browser UI is self-contained, so a restrictive policy needs no third-party exceptions.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'"
].join('; ');

function setCommonHeaders(response, requestId) {
  // These headers establish the baseline for every response, including errors and static files.
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-request-id', requestId);
}

function sendBuffer(request, response, statusCode, body, contentType, extraHeaders = {}) {
  const isHead = request.method === 'HEAD';
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders
  });
  response.end(isHead ? undefined : body);
}

function sendJson(request, response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  sendBuffer(request, response, statusCode, body, 'application/json; charset=utf-8', {
    'cache-control': 'no-store',
    ...extraHeaders
  });
}

function methodNotAllowed(request, response, allowedMethods) {
  sendJson(
    request,
    response,
    405,
    { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } },
    {
      allow: allowedMethods.join(', ')
    }
  );
}

/**
 * Resolves a URL path inside the public directory after rejecting ambiguous path encodings.
 *
 * @param {string} publicDirectory
 * @param {string} pathname
 * @returns {string}
 * @throws {AppError} When the path is malformed or escapes the public directory.
 */
function resolveStaticPath(publicDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    throw new AppError('The request path contains invalid encoding.', {
      code: 'INVALID_PATH_ENCODING',
      statusCode: 400,
      expose: true,
      cause: error
    });
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new AppError('The request path is not allowed.', {
      code: 'INVALID_PATH',
      statusCode: 400,
      expose: true
    });
  }

  const relativeName = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(publicDirectory, relativeName);
  const relativePath = path.relative(publicDirectory, filePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new AppError('The request path is outside the public directory.', {
      code: 'FORBIDDEN_PATH',
      statusCode: 403,
      expose: true
    });
  }
  return filePath;
}

/**
 * Selects the rate-limit identity for a request.
 * Forwarded addresses are trusted only when the operator explicitly enables proxy trust.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} trustProxy
 * @returns {string}
 */
function getClientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}

function createDependencies(config, overrides) {
  // Constructor overrides keep unit tests deterministic without changing production composition.
  const urlSafetyPolicy =
    overrides.urlSafetyPolicy ||
    new UrlSafetyPolicy({
      allowedPorts: config.allowedTargetPorts,
      dnsTimeoutMs: config.dnsTimeoutMs,
      maxUrlLength: config.maxUrlLength
    });
  return {
    analysisRunner:
      overrides.analysisRunner ||
      (overrides.analyzer
        ? createInlineAnalysisRunner(overrides.analyzer)
        : new WorkerAnalysisRunner({
            timeoutMs: config.analysisTimeoutMs,
            maxOldGenerationSizeMb: config.analysisMaxOldSpaceMb,
            maxYoungGenerationSizeMb: config.analysisMaxYoungSpaceMb,
            stackSizeMb: config.analysisStackSizeMb
          })),
    fetcher:
      overrides.fetcher ||
      new SafePageFetcher({
        urlSafetyPolicy,
        timeoutMs: config.fetchTimeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        maxRedirects: config.maxRedirects,
        userAgent: config.userAgent
      }),
    rateLimiter:
      overrides.rateLimiter ||
      new InMemoryRateLimiter({ limit: config.rateLimitMax, windowMs: config.rateLimitWindowMs }),
    concurrencyGate: overrides.concurrencyGate || new ConcurrencyGate(config.maxConcurrentAnalyses)
  };
}

/**
 * Creates the application server without listening, allowing the process entry point to own ports
 * and shutdown while tests can bind ephemeral ports.
 *
 * @param {object} [options] Validated config and optional dependency overrides.
 * @returns {import('node:http').Server}
 */
function createServer(options = {}) {
  const config = options.config || loadConfig();
  const publicDirectory = options.publicDirectory || path.resolve(__dirname, '../../public');
  const logger = options.logger || console;
  const clock = options.clock || (() => new Date());
  const dependencies = createDependencies(config, options);

  const server = http.createServer((request, response) => {
    const requestId = crypto.randomUUID();
    setCommonHeaders(response, requestId);

    // Start one promise chain per request so async routing failures reach the central handler.
    Promise.resolve()
      .then(async () => {
        let requestUrl;
        try {
          requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        } catch (error) {
          throw new AppError('The request URL is invalid.', {
            code: 'INVALID_REQUEST_URL',
            statusCode: 400,
            expose: true,
            cause: error
          });
        }

        if (requestUrl.pathname === '/api/health') {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            methodNotAllowed(request, response, ['GET', 'HEAD']);
            return;
          }
          sendJson(request, response, 200, {
            ok: true,
            status: 'up',
            version: APPLICATION_VERSION
          });
          return;
        }

        if (requestUrl.pathname === '/api/analyze') {
          if (request.method !== 'GET') {
            methodNotAllowed(request, response, ['GET']);
            return;
          }

          // Rate limiting precedes validation so malformed requests still consume client allowance.
          const rate = dependencies.rateLimiter.consume(
            getClientAddress(request, config.trustProxy)
          );
          response.setHeader('ratelimit-limit', String(config.rateLimitMax));
          response.setHeader('ratelimit-remaining', String(rate.remaining));
          if (!rate.allowed) {
            sendJson(
              request,
              response,
              429,
              {
                ok: false,
                error: { code: 'RATE_LIMITED', message: 'Too many analyses. Try again shortly.' }
              },
              { 'retry-after': String(rate.retryAfterSeconds) }
            );
            return;
          }

          const target = requestUrl.searchParams.get('url');
          if (!target) {
            sendJson(request, response, 400, {
              ok: false,
              error: { code: 'MISSING_URL', message: 'The url query parameter is required.' }
            });
            return;
          }

          // Reject at capacity instead of retaining incoming requests in an unbounded queue.
          const release = dependencies.concurrencyGate.tryAcquire();
          if (!release) {
            sendJson(
              request,
              response,
              503,
              {
                ok: false,
                error: {
                  code: 'ANALYZER_BUSY',
                  message: 'The analyzer is busy. Try again shortly.'
                }
              },
              { 'retry-after': '1' }
            );
            return;
          }

          // A disconnected client no longer needs network or worker resources, so cancel both layers.
          const clientAbortController = new AbortController();
          const abortClientRequest = () => {
            if (!clientAbortController.signal.aborted) clientAbortController.abort();
          };
          const abortClosedResponse = () => {
            if (!response.writableEnded) abortClientRequest();
          };
          request.once('aborted', abortClientRequest);
          response.once('close', abortClosedResponse);
          if (request.aborted || response.destroyed) abortClientRequest();

          try {
            const page = await dependencies.fetcher.fetch(target, {
              signal: clientAbortController.signal
            });
            const report = await dependencies.analysisRunner.analyze(page.finalUrl, page.html, {
              responseHeaders: page.responseHeaders,
              signal: clientAbortController.signal
            });
            sendJson(request, response, 200, {
              ok: true,
              url: page.finalUrl,
              fetchedAt: clock().toISOString(),
              network: { redirectCount: page.redirectCount },
              report
            });
          } finally {
            // The slot and listeners must be released on success, failure, and cancellation alike.
            request.removeListener('aborted', abortClientRequest);
            response.removeListener('close', abortClosedResponse);
            release();
          }
          return;
        }

        if (requestUrl.pathname.startsWith('/api/')) {
          sendJson(request, response, 404, {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'API endpoint not found.' }
          });
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          methodNotAllowed(request, response, ['GET', 'HEAD']);
          return;
        }

        const filePath = resolveStaticPath(publicDirectory, requestUrl.pathname);
        let body;
        try {
          body = await fs.readFile(filePath);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'EISDIR') {
            sendBuffer(
              request,
              response,
              404,
              Buffer.from('Not Found'),
              'text/plain; charset=utf-8',
              {
                'cache-control': 'no-store'
              }
            );
            return;
          }
          throw error;
        }
        const contentType =
          MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        sendBuffer(request, response, 200, body, contentType, { 'cache-control': 'no-cache' });
      })
      .catch((error) => {
        // Once bytes have been sent, destroying the stream is safer than attempting a second reply.
        if (response.headersSent || response.destroyed || response.writableEnded) {
          response.destroy();
          return;
        }
        const statusCode = Number(error.statusCode) || 500;
        const code = error.code || 'INTERNAL_ERROR';
        const message = error.expose ? error.message : 'An unexpected error occurred.';
        if (statusCode >= 500) {
          logger.error?.({ requestId, code, error });
        }
        sendJson(request, response, statusCode, { ok: false, error: { code, message } });
      });
  });

  // Bound header and request lifetimes independently to reduce slow-client resource retention.
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);
  server.keepAliveTimeout = 5000;
  return server;
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  createServer,
  getClientAddress,
  resolveStaticPath
};
