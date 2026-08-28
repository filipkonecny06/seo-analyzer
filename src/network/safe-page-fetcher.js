'use strict';

const http = require('node:http');
const https = require('node:https');
const { PageFetchError } = require('../errors');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestPinned(options) {
  const { url, selectedAddress, lookup, headers, timeoutMs, maxResponseBytes } = options;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    request = transport.request(url, {
      method: 'GET',
      agent: false,
      headers,
      lookup:
        lookup ||
        ((_hostname, _options, callback) =>
          callback(null, selectedAddress.address, selectedAddress.family))
    });

    timer = setTimeout(() => {
      request.destroy(
        new PageFetchError(`The remote request exceeded ${timeoutMs} ms.`, {
          code: 'FETCH_TIMEOUT',
          statusCode: 504
        })
      );
    }, timeoutMs);

    request.on('response', (response) => {
      const statusCode = Number(response.statusCode || 0);
      const responseHeaders = response.headers;

      if (REDIRECT_STATUSES.has(statusCode) || statusCode < 200 || statusCode >= 300) {
        response.resume();
        finish(null, { statusCode, headers: responseHeaders, body: Buffer.alloc(0) });
        return;
      }

      const contentEncoding = String(
        firstHeaderValue(responseHeaders['content-encoding']) || 'identity'
      )
        .trim()
        .toLowerCase();
      if (contentEncoding !== 'identity') {
        const error = new PageFetchError(
          'The remote server ignored the identity encoding request.',
          {
            code: 'UNSUPPORTED_CONTENT_ENCODING'
          }
        );
        finish(error);
        response.destroy();
        return;
      }

      const declaredLength = Number(firstHeaderValue(responseHeaders['content-length']));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        const error = new PageFetchError(
          `The page exceeds the ${maxResponseBytes}-byte response limit.`,
          {
            code: 'RESPONSE_TOO_LARGE',
            statusCode: 413
          }
        );
        finish(error);
        response.destroy();
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxResponseBytes) {
          const error = new PageFetchError(
            `The page exceeds the ${maxResponseBytes}-byte response limit.`,
            {
              code: 'RESPONSE_TOO_LARGE',
              statusCode: 413
            }
          );
          finish(error);
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        finish(null, {
          statusCode,
          headers: responseHeaders,
          body: Buffer.concat(chunks, receivedBytes)
        });
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
    });

    request.on('error', (error) => {
      finish(
        error instanceof PageFetchError
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

class SafePageFetcher {
  constructor(options) {
    if (!options || !options.urlSafetyPolicy) {
      throw new TypeError('SafePageFetcher requires a UrlSafetyPolicy instance.');
    }
    this.urlSafetyPolicy = options.urlSafetyPolicy;
    this.request = options.request || requestPinned;
    this.timeoutMs = options.timeoutMs || 10_000;
    this.maxResponseBytes = options.maxResponseBytes || 2_000_000;
    this.maxRedirects = options.maxRedirects ?? 4;
    this.userAgent = options.userAgent || 'PortfolioSEOAnalyzer/2.0';
  }

  async fetch(input) {
    let currentUrl = this.urlSafetyPolicy.normalize(input);
    const visited = new Set();

    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      if (visited.has(currentUrl.href)) {
        throw new PageFetchError('The target entered a redirect loop.', {
          code: 'REDIRECT_LOOP'
        });
      }
      visited.add(currentUrl.href);

      const authorized = await this.urlSafetyPolicy.authorize(currentUrl);
      const response = await this.request({
        url: authorized.url,
        selectedAddress: authorized.selectedAddress,
        lookup: this.urlSafetyPolicy.createPinnedLookup(authorized.selectedAddress),
        timeoutMs: this.timeoutMs,
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
          if (error.code) throw error;
          throw new PageFetchError('The remote server returned an invalid redirect URL.', {
            code: 'INVALID_REDIRECT',
            cause: error
          });
        }
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new PageFetchError(`The remote server responded with HTTP ${response.statusCode}.`, {
          code: 'REMOTE_HTTP_ERROR'
        });
      }

      const contentType = String(
        firstHeaderValue(response.headers['content-type']) || ''
      ).toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
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
          'x-robots-tag': firstHeaderValue(response.headers['x-robots-tag']) || ''
        },
        redirectCount
      };
    }

    throw new PageFetchError('The redirect limit was exceeded.', {
      code: 'TOO_MANY_REDIRECTS'
    });
  }
}

module.exports = {
  REDIRECT_STATUSES,
  SafePageFetcher,
  requestPinned
};
