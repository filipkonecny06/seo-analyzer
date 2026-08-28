'use strict';

class AppError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code || 'INTERNAL_ERROR';
    this.statusCode = options.statusCode || 500;
    this.expose = Boolean(options.expose);
  }
}

class UrlPolicyError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'URL_NOT_ALLOWED',
      statusCode: options.statusCode || 403,
      expose: true
    });
  }
}

class PageFetchError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'PAGE_FETCH_FAILED',
      statusCode: options.statusCode || 502,
      expose: true
    });
  }
}

module.exports = {
  AppError,
  PageFetchError,
  UrlPolicyError
};
