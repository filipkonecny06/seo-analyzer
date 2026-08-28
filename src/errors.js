'use strict';

// Application error types carry stable HTTP and machine-readable contracts across layers.

/** Base error for failures that may need translation at the HTTP boundary. */
class AppError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: Error, code?: string, statusCode?: number, expose?: boolean}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code || 'INTERNAL_ERROR';
    this.statusCode = options.statusCode || 500;
    this.expose = Boolean(options.expose);
  }
}

/** Expected rejection of a URL, hostname, port, or resolved network address. */
class UrlPolicyError extends AppError {
  /** @param {string} message @param {{cause?: Error, code?: string, statusCode?: number, expose?: boolean}} [options] */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'URL_NOT_ALLOWED',
      statusCode: options.statusCode || 403,
      expose: true
    });
  }
}

/** Expected failure while retrieving a remote page within the fetch policy. */
class PageFetchError extends AppError {
  /** @param {string} message @param {{cause?: Error, code?: string, statusCode?: number, expose?: boolean}} [options] */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'PAGE_FETCH_FAILED',
      statusCode: options.statusCode || 502,
      expose: true
    });
  }
}

/** Failure to start, complete, or safely stop an isolated analysis. */
class AnalysisExecutionError extends AppError {
  /** @param {string} message @param {{cause?: Error, code?: string, statusCode?: number, expose?: boolean}} [options] */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'ANALYSIS_FAILED',
      statusCode: options.statusCode || 500,
      expose: Boolean(options.expose)
    });
  }
}

module.exports = {
  AnalysisExecutionError,
  AppError,
  PageFetchError,
  UrlPolicyError
};
