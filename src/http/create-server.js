'use strict';

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

/**
 * @typedef {{analyze(pageUrl: string, html: string|Buffer, options?: {responseHeaders?: Record<string, string|string[]>, signal?: AbortSignal}): Promise<import('../contracts').AnalysisReport>}} AnalysisRunner
 * @typedef {{fetch(target: string, options?: {signal?: AbortSignal}): Promise<import('../contracts').PageFetchResult>}} PageFetcher
 * @typedef {{consume(key: string): {allowed: boolean, remaining: number, retryAfterSeconds: number}}} RateLimiter
 * @typedef {{tryAcquire(): null|(() => void)}} AnalysisGate
 * @typedef {{analysisRunner: AnalysisRunner, fetcher: PageFetcher, rateLimiter: RateLimiter, concurrencyGate: AnalysisGate}} ServerDependencies
 * @typedef {{info?: (fields: Record<string, unknown>) => void, error?: (fields: {requestId: string, code: string, error: Error}) => void}} ServerLogger
 * @typedef {object} ServerOptions
 * @property {import('../contracts').RuntimeConfig} [config]
 * @property {string} [publicDirectory]
 * @property {ServerLogger} [logger]
 * @property {() => Date} [clock]
 * @property {import('../contracts').UrlSafetyPolicyContract} [urlSafetyPolicy]
 * @property {AnalysisRunner} [analysisRunner]
 * @property {{analyze(pageUrl: string, html: string|Buffer, options?: object): import('../contracts').AnalysisReport}} [analyzer]
 * @property {PageFetcher} [fetcher]
 * @property {RateLimiter} [rateLimiter]
 * @property {AnalysisGate} [concurrencyGate]
 */

/** @param {import('node:http').ServerResponse} response @param {string} requestId */
function setCommonHeaders(response, requestId) {
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-request-id', requestId);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {Buffer} body
 * @param {string} contentType
 * @param {Record<string, string>} [extraHeaders]
 */
function sendBuffer(request, response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {object} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(request, response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  sendBuffer(request, response, statusCode, body, 'application/json; charset=utf-8', {
    'cache-control': 'no-store',
    ...extraHeaders
  });
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string[]} allowedMethods
 */
function methodNotAllowed(request, response, allowedMethods) {
  sendJson(
    request,
    response,
    405,
    { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } },
    { allow: allowedMethods.join(', ') }
  );
}

/**
 * Resolves a URL path inside the public directory after rejecting ambiguous path encodings.
 *
 * @param {string} publicDirectory
 * @param {string} pathname
 * @returns {string}
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
      cause: error instanceof Error ? error : undefined
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
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} trustProxy
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

/**
 * @param {import('../contracts').RuntimeConfig} config
 * @param {ServerOptions} overrides
 * @returns {ServerDependencies}
 */
function createDependencies(config, overrides) {
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

/** @param {import('node:http').IncomingMessage} request */
function parseRequestUrl(request) {
  try {
    return new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  } catch (error) {
    throw new AppError('The request URL is invalid.', {
      code: 'INVALID_REQUEST_URL',
      statusCode: 400,
      expose: true,
      cause: error instanceof Error ? error : undefined
    });
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function handleHealthRequest(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    methodNotAllowed(request, response, ['GET', 'HEAD']);
    return;
  }
  sendJson(request, response, 200, { ok: true, status: 'up', version: APPLICATION_VERSION });
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {ServerDependencies} dependencies
 * @param {import('../contracts').RuntimeConfig} config
 */
function admitRateLimitedRequest(request, response, dependencies, config) {
  const rate = dependencies.rateLimiter.consume(getClientAddress(request, config.trustProxy));
  response.setHeader('ratelimit-limit', String(config.rateLimitMax));
  response.setHeader('ratelimit-remaining', String(rate.remaining));
  if (rate.allowed) return true;

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
  return false;
}

/**
 * Holds the concurrency permit until fetch, analysis, and worker termination have all completed.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} target
 * @param {ServerDependencies} dependencies
 * @param {() => void} release
 * @param {() => Date} clock
 */
async function executeAnalysisRequest(request, response, target, dependencies, release, clock) {
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
    /** @type {import('../contracts').AnalyzeSuccessResponse} */
    const payload = {
      ok: true,
      url: page.finalUrl,
      fetchedAt: clock().toISOString(),
      network: { redirectCount: page.redirectCount },
      report
    };
    sendJson(request, response, 200, payload);
  } finally {
    request.removeListener('aborted', abortClientRequest);
    response.removeListener('close', abortClosedResponse);
    release();
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} requestUrl
 * @param {ServerDependencies} dependencies
 * @param {import('../contracts').RuntimeConfig} config
 * @param {() => Date} clock
 */
async function handleAnalyzeRequest(request, response, requestUrl, dependencies, config, clock) {
  if (request.method !== 'GET') {
    methodNotAllowed(request, response, ['GET']);
    return;
  }
  // Consume allowance before validation so malformed requests cannot bypass admission controls.
  if (!admitRateLimitedRequest(request, response, dependencies, config)) return;

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
        error: { code: 'ANALYZER_BUSY', message: 'The analyzer is busy. Try again shortly.' }
      },
      { 'retry-after': '1' }
    );
    return;
  }

  await executeAnalysisRequest(request, response, target, dependencies, release, clock);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} requestUrl
 * @param {string} publicDirectory
 */
async function serveStaticRequest(request, response, requestUrl, publicDirectory) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    methodNotAllowed(request, response, ['GET', 'HEAD']);
    return;
  }

  const filePath = resolveStaticPath(publicDirectory, requestUrl.pathname);
  let body;
  try {
    body = await fs.readFile(filePath);
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (errorCode === 'ENOENT' || errorCode === 'EISDIR') {
      sendBuffer(request, response, 404, Buffer.from('Not Found'), 'text/plain; charset=utf-8', {
        'cache-control': 'no-store'
      });
      return;
    }
    throw error;
  }

  const contentType =
    /** @type {Record<string, string>} */ (MIME_TYPES)[path.extname(filePath).toLowerCase()] ||
    'application/octet-stream';
  sendBuffer(request, response, 200, body, contentType, { 'cache-control': 'no-cache' });
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {{config: import('../contracts').RuntimeConfig, dependencies: ServerDependencies, publicDirectory: string, clock: () => Date}} context
 */
async function routeRequest(request, response, context) {
  const requestUrl = parseRequestUrl(request);
  if (requestUrl.pathname === '/api/health') {
    handleHealthRequest(request, response);
    return;
  }
  if (requestUrl.pathname === '/api/analyze') {
    await handleAnalyzeRequest(
      request,
      response,
      requestUrl,
      context.dependencies,
      context.config,
      context.clock
    );
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    sendJson(request, response, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'API endpoint not found.' }
    });
    return;
  }
  await serveStaticRequest(request, response, requestUrl, context.publicDirectory);
}

/**
 * @param {unknown} error
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {ServerLogger} logger
 * @param {string} requestId
 */
function handleRequestError(error, request, response, logger, requestId) {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    response.destroy();
    return;
  }
  const appError = error instanceof Error ? error : new Error('Unknown server error');
  const statusCode = 'statusCode' in appError ? Number(appError.statusCode) || 500 : 500;
  const code =
    'code' in appError && typeof appError.code === 'string' ? appError.code : 'INTERNAL_ERROR';
  const expose = 'expose' in appError && appError.expose === true;
  const message = expose ? appError.message : 'An unexpected error occurred.';
  if (statusCode >= 500) logger.error?.({ requestId, code, error: appError });
  sendJson(request, response, statusCode, { ok: false, error: { code, message } });
}

/**
 * Creates the application server without listening so the process entry point owns ports/shutdown.
 *
 * @param {ServerOptions} [options]
 * @returns {import('node:http').Server}
 */
function createServer(options = {}) {
  const config = options.config || loadConfig();
  const context = {
    config,
    dependencies: createDependencies(config, options),
    publicDirectory: options.publicDirectory || path.resolve(__dirname, '../../public'),
    clock: options.clock || (() => new Date())
  };
  const logger = options.logger || console;

  const server = http.createServer((request, response) => {
    const requestId = crypto.randomUUID();
    setCommonHeaders(response, requestId);
    routeRequest(request, response, context).catch((error) => {
      handleRequestError(error, request, response, logger, requestId);
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
