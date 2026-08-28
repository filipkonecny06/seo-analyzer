'use strict';

// Fetches public HTML through an authorized, pinned address with strict resource bounds.

const http = require('node:http');
const https = require('node:https');
const { PageFetchError } = require('../errors');
const { DEFAULT_USER_AGENT } = require('../version');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** @typedef {{statusCode: number, headers: import('node:http').IncomingHttpHeaders, headerValues: Record<string, string[]>, body: Buffer}} PinnedResponse */

/** @param {string|string[]|undefined} value */
function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Preserves repeated response-header fields when Node exposes either joined or distinct values.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {Record<string, string|string[]|undefined>|undefined} headerValues
 * @param {string} name
 * @returns {string[]}
 */
function distinctHeaderValues(headers, headerValues, name) {
  const distinct = headerValues?.[name];
  const values = Array.isArray(distinct)
    ? distinct
    : distinct === undefined
      ? Array.isArray(headers?.[name])
        ? headers[name]
        : [headers?.[name]]
      : [distinct];
  return values.filter((value) => value !== undefined).map(String);
}

/** @param {AbortSignal|undefined} signal */
function abortError(signal) {
  if (signal?.reason instanceof PageFetchError) return signal.reason;
  return new PageFetchError('The page fetch was cancelled.', {
    code: 'FETCH_ABORTED',
    statusCode: 499,
    cause: signal?.reason instanceof Error ? signal.reason : undefined
  });
}

/**
 * @param {AbortSignal|undefined} externalSignal
 * @param {number} timeoutMs
 * @param {{setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout}} timers
 */
function createFetchSignal(externalSignal, timeoutMs, timers) {
  // One internal signal gives timeout and caller cancellation the same cleanup path.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });

  const timeout = controller.signal.aborted
    ? null
    : timers.setTimeout(() => {
        controller.abort(
          new PageFetchError(`The page fetch exceeded ${timeoutMs} ms.`, {
            code: 'FETCH_TIMEOUT',
            statusCode: 504
          })
        );
      }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout !== null) timers.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  };
}

/** @param {AbortSignal|undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

/** @param {number} maxResponseBytes */
function responseTooLargeError(maxResponseBytes) {
  return new PageFetchError(`The page exceeds the ${maxResponseBytes}-byte response limit.`, {
    code: 'RESPONSE_TOO_LARGE',
    statusCode: 413
  });
}

/**
 * Reads a successful response while enforcing the streamed byte limit.
 *
 * @param {import('node:http').IncomingMessage} response
 * @param {import('node:http').ClientRequest} request
 * @param {number} maxResponseBytes
 * @param {(error: Error|null, value?: PinnedResponse) => void} finish
 * @param {Omit<PinnedResponse, 'body'>} metadata
 */
function readResponseBody(response, request, maxResponseBytes, finish, metadata) {
  /** @type {Buffer[]} */
  const chunks = [];
  let receivedBytes = 0;

  response.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxResponseBytes) {
      finish(responseTooLargeError(maxResponseBytes));
      response.destroy();
      request.destroy();
      return;
    }
    chunks.push(buffer);
  });
  response.on('end', () => {
    finish(null, { ...metadata, body: Buffer.concat(chunks, receivedBytes) });
  });
  response.on('aborted', () => {
    finish(
      new PageFetchError('The remote server closed the response early.', {
        code: 'REMOTE_RESPONSE_ABORTED'
      })
    );
  });
  response.on('error', (error) => {
    finish(
      error instanceof PageFetchError
        ? error
        : new PageFetchError('The remote response could not be read.', {
            code: 'REMOTE_RESPONSE_ERROR',
            cause: error
          })
    );
  });
}

/**
 * Validates response metadata before handing a successful body to the bounded reader.
 *
 * @param {import('node:http').IncomingMessage} response
 * @param {import('node:http').ClientRequest} request
 * @param {number} maxResponseBytes
 * @param {(error: Error|null, value?: PinnedResponse) => void} finish
 */
function handlePinnedResponse(response, request, maxResponseBytes, finish) {
  const statusCode = Number(response.statusCode || 0);
  const headers = response.headers;
  const metadata = {
    statusCode,
    headers,
    headerValues: {
      'x-robots-tag': distinctHeaderValues(headers, response.headersDistinct, 'x-robots-tag')
    }
  };

  if (REDIRECT_STATUSES.has(statusCode) || statusCode < 200 || statusCode >= 300) {
    finish(null, { ...metadata, body: Buffer.alloc(0) });
    response.destroy();
    return;
  }

  // Identity encoding makes the byte cap apply to the payload and avoids decompression bombs.
  const contentEncoding = String(firstHeaderValue(headers['content-encoding']) || 'identity')
    .trim()
    .toLowerCase();
  if (contentEncoding !== 'identity') {
    finish(
      new PageFetchError('The remote server ignored the identity encoding request.', {
        code: 'UNSUPPORTED_CONTENT_ENCODING'
      })
    );
    response.destroy();
    return;
  }

  // Content-Length is optional and untrusted, so the body reader independently caps streamed bytes.
  const declaredLength = Number(firstHeaderValue(headers['content-length']));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    finish(responseTooLargeError(maxResponseBytes));
    response.destroy();
    return;
  }

  readResponseBody(response, request, maxResponseBytes, finish, metadata);
}

/** @param {AbortSignal|undefined} externalSignal @param {number|undefined} timeoutMs */
function createRequestSignal(externalSignal, timeoutMs) {
  if (externalSignal || !Number.isFinite(timeoutMs)) {
    return { signal: externalSignal, cleanup() {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new PageFetchError(`The remote request exceeded ${timeoutMs} ms.`, {
        code: 'FETCH_TIMEOUT',
        statusCode: 504
      })
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
    }
  };
}

/**
 * Performs one HTTP request using the address selected by UrlSafetyPolicy.
 * Response, abort, timeout, and socket events share one completion path.
 *
 * @param {{url: URL, selectedAddress: {address: string, family: 4|6}, lookup?: import('node:net').LookupFunction, headers?: import('node:http').OutgoingHttpHeaders, timeoutMs?: number, maxResponseBytes: number, signal?: AbortSignal}} options
 * @returns {Promise<PinnedResponse>}
 */
function requestPinned(options) {
  const transport = options.url.protocol === 'https:' ? https : http;
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:http').ClientRequest|undefined} */
    let request;
    /** @type {import('node:http').IncomingMessage|undefined} */
    let responseStream;

    /** @param {Error|null} error @param {PinnedResponse} [value] */
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      requestSignal.cleanup();
      requestSignal.signal?.removeEventListener('abort', abortHandler);
      if (error) reject(error);
      else resolve(/** @type {PinnedResponse} */ (value));
    };
    const abortHandler = () => {
      finish(abortError(requestSignal.signal));
      responseStream?.destroy();
      request?.destroy();
    };

    if (requestSignal.signal?.aborted) {
      finish(abortError(requestSignal.signal));
      return;
    }

    request = transport.request(options.url, {
      method: 'GET',
      // A one-off agent prevents connection reuse from bypassing this request's pinned lookup.
      agent: false,
      headers: options.headers,
      lookup:
        options.lookup ||
        ((_hostname, _lookupOptions, callback) =>
          callback(null, options.selectedAddress.address, options.selectedAddress.family))
    });

    requestSignal.signal?.addEventListener('abort', abortHandler, { once: true });
    if (requestSignal.signal?.aborted) {
      abortHandler();
      return;
    }

    request.on('response', (response) => {
      responseStream = response;
      if (settled) {
        response.destroy();
        return;
      }
      handlePinnedResponse(response, request, options.maxResponseBytes, finish);
    });
    request.on('error', (error) => {
      finish(
        requestSignal.signal?.aborted
          ? abortError(requestSignal.signal)
          : error instanceof PageFetchError
            ? error
            : new PageFetchError('The target page could not be reached.', {
                code: 'REMOTE_CONNECTION_FAILED',
                cause: error
              })
      );
    });
    request.end();
  });
}

/** Coordinates URL authorization, redirect policy, response validation, and bounded body reads. */
class SafePageFetcher {
  /**
   * @param {{urlSafetyPolicy: import('../contracts').UrlSafetyPolicyContract, request?: typeof requestPinned, timeoutMs?: number, maxResponseBytes?: number, maxRedirects?: number, userAgent?: string, timers?: {setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout}}} options
   */
  constructor(options) {
    if (!options || !options.urlSafetyPolicy) {
      throw new TypeError('SafePageFetcher requires a UrlSafetyPolicy instance.');
    }
    this.urlSafetyPolicy = options.urlSafetyPolicy;
    this.request = options.request || requestPinned;
    this.timeoutMs = options.timeoutMs || 10_000;
    this.maxResponseBytes = options.maxResponseBytes || 2_000_000;
    this.maxRedirects = options.maxRedirects ?? 4;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.timers = options.timers || { setTimeout, clearTimeout };
  }

  /**
   * Fetches one HTML document while enforcing a single timeout across every redirect hop.
   *
   * @param {string|URL} input
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<import('../contracts').PageFetchResult>}
   * @throws {PageFetchError|import('../errors').UrlPolicyError}
   */
  async fetch(input, options = {}) {
    const fetchSignal = createFetchSignal(options.signal, this.timeoutMs, this.timers);

    try {
      throwIfAborted(fetchSignal.signal);
      let currentUrl = this.urlSafetyPolicy.normalize(input);
      const visited = new Set();

      for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
        throwIfAborted(fetchSignal.signal);
        if (visited.has(currentUrl.href)) {
          throw new PageFetchError('The target entered a redirect loop.', {
            code: 'REDIRECT_LOOP'
          });
        }
        visited.add(currentUrl.href);

        // Every hop is normalized, resolved, and pinned independently; redirects are untrusted input.
        const authorized = await this.urlSafetyPolicy.authorize(currentUrl, {
          signal: fetchSignal.signal
        });
        const response = await this.request({
          url: authorized.url,
          selectedAddress: authorized.selectedAddress,
          lookup: this.urlSafetyPolicy.createPinnedLookup(authorized.selectedAddress),
          signal: fetchSignal.signal,
          maxResponseBytes: this.maxResponseBytes,
          headers: {
            accept: 'text/html,application/xhtml+xml;q=0.9',
            'accept-encoding': 'identity',
            'user-agent': this.userAgent
          }
        });

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          const location = firstHeaderValue(response.headers.location);
          if (!location) {
            throw new PageFetchError('The remote server returned a redirect without a location.', {
              code: 'INVALID_REDIRECT'
            });
          }
          if (redirectCount >= this.maxRedirects) {
            throw new PageFetchError(`The page exceeded the ${this.maxRedirects}-redirect limit.`, {
              code: 'TOO_MANY_REDIRECTS'
            });
          }
          try {
            currentUrl = this.urlSafetyPolicy.normalize(new URL(location, currentUrl));
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code) throw error;
            throw new PageFetchError('The remote server returned an invalid redirect URL.', {
              code: 'INVALID_REDIRECT',
              cause: error instanceof Error ? error : undefined
            });
          }
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new PageFetchError(
            `The remote server responded with HTTP ${response.statusCode}.`,
            {
              code: 'REMOTE_HTTP_ERROR'
            }
          );
        }

        const contentType = String(
          firstHeaderValue(response.headers['content-type']) || ''
        ).toLowerCase();
        const mediaType = contentType.split(';', 1)[0].trim();
        if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
          throw new PageFetchError(
            `The target returned ${contentType || 'an unknown content type'}, not HTML.`,
            { code: 'NOT_HTML' }
          );
        }

        return {
          html: response.body,
          finalUrl: authorized.url.href,
          responseHeaders: {
            'content-type': contentType,
            'x-robots-tag': distinctHeaderValues(
              response.headers,
              response.headerValues,
              'x-robots-tag'
            )
          },
          redirectCount
        };
      }

      throw new PageFetchError('The redirect limit was exceeded.', {
        code: 'TOO_MANY_REDIRECTS'
      });
    } catch (error) {
      if (fetchSignal.signal.aborted) throw abortError(fetchSignal.signal);
      throw error;
    } finally {
      fetchSignal.cleanup();
    }
  }
}

module.exports = {
  REDIRECT_STATUSES,
  SafePageFetcher,
  distinctHeaderValues,
  requestPinned
};
