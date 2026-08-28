'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AnalysisExecutionError } = require('../errors');

/** @param {AbortSignal|undefined} signal */
function abortError(signal) {
  return new AnalysisExecutionError('The page analysis was cancelled.', {
    code: 'ANALYSIS_ABORTED',
    statusCode: 499,
    cause: signal?.reason instanceof Error ? signal.reason : undefined
  });
}

/** @param {unknown} message */
function invalidWorkerMessageError(message) {
  const serializedError =
    message && typeof message === 'object' && 'error' in message ? message.error : undefined;
  const cause =
    serializedError &&
    typeof serializedError === 'object' &&
    'message' in serializedError &&
    typeof serializedError.message === 'string'
      ? new Error(serializedError.message)
      : undefined;
  return new AnalysisExecutionError('The page could not be analyzed.', {
    code: 'ANALYSIS_FAILED',
    cause
  });
}

/** @param {Error & {code?: string}} error */
function workerRuntimeError(error) {
  const resourceLimit = error.code === 'ERR_WORKER_OUT_OF_MEMORY';
  return new AnalysisExecutionError(
    resourceLimit
      ? 'The page is too complex to analyze within the configured memory limit.'
      : 'The page could not be analyzed.',
    {
      code: resourceLimit ? 'ANALYSIS_RESOURCE_LIMIT' : 'ANALYSIS_FAILED',
      statusCode: resourceLimit ? 422 : 500,
      expose: resourceLimit,
      cause: error
    }
  );
}

/** @param {number} exitCode */
function workerExitError(exitCode) {
  if (exitCode === 0) {
    return new AnalysisExecutionError('The analysis worker returned no report.', {
      code: 'ANALYSIS_NO_RESULT'
    });
  }
  return new AnalysisExecutionError('The page could not be analyzed.', {
    code: 'ANALYSIS_FAILED',
    cause: new Error(`Analysis worker exited with code ${exitCode}.`)
  });
}

/** @param {Worker} worker */
async function terminateWorker(worker) {
  try {
    await worker.terminate();
  } catch (_terminationError) {
    // Termination cannot change the analysis outcome already selected by message, timeout, or abort.
  }
}

/**
 * Owns one worker's event, timeout, cancellation, and termination lifecycle.
 *
 * @param {Worker} worker
 * @param {{timeoutMs: number, signal?: AbortSignal, timers: {setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout}}} options
 * @returns {Promise<import('../contracts').AnalysisReport>}
 */
function waitForWorkerReport(worker, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;

    const cleanup = () => {
      if (timer !== undefined) options.timers.clearTimeout(timer);
      options.signal?.removeEventListener('abort', handleAbort);
      worker.removeListener('message', handleMessage);
      worker.removeListener('error', handleError);
      worker.removeListener('exit', handleExit);
    };

    /** @param {Error|null} error @param {import('../contracts').AnalysisReport} [report] */
    const settle = (error, report) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateWorker(worker).then(() => {
        if (error) reject(error);
        else resolve(/** @type {import('../contracts').AnalysisReport} */ (report));
      });
    };

    const handleAbort = () => settle(abortError(options.signal));
    /** @param {unknown} message */
    const handleMessage = (message) => {
      if (
        message &&
        typeof message === 'object' &&
        'ok' in message &&
        message.ok === true &&
        'report' in message &&
        message.report &&
        typeof message.report === 'object'
      ) {
        settle(null, /** @type {import('../contracts').AnalysisReport} */ (message.report));
        return;
      }
      settle(invalidWorkerMessageError(message));
    };
    /** @param {Error & {code?: string}} error */
    const handleError = (error) => settle(workerRuntimeError(error));
    /** @param {number} exitCode */
    const handleExit = (exitCode) => settle(workerExitError(exitCode));

    worker.once('message', handleMessage);
    worker.once('error', handleError);
    worker.once('exit', handleExit);
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }

    timer = options.timers.setTimeout(() => {
      settle(
        new AnalysisExecutionError(`The page analysis exceeded ${options.timeoutMs} ms.`, {
          code: 'ANALYSIS_TIMEOUT',
          statusCode: 504,
          expose: true
        })
      );
    }, options.timeoutMs);
  });
}

/**
 * @param {{analyze(pageUrl: string, html: string|Buffer, options?: object): import('../contracts').AnalysisReport}} analyzer
 * @returns {{analyze(pageUrl: string, html: string|Buffer, options?: {responseHeaders?: Record<string, string|string[]>, signal?: AbortSignal}): Promise<import('../contracts').AnalysisReport>}}
 */
function createInlineAnalysisRunner(analyzer) {
  return {
    async analyze(pageUrl, html, options = {}) {
      if (options.signal?.aborted) throw abortError(options.signal);
      return analyzer.analyze(pageUrl, html, options);
    }
  };
}

/**
 * Isolates parsing with memory, stack, time, and cancellation limits.
 * A fresh worker also prevents malformed pages from retaining state between requests.
 */
class WorkerAnalysisRunner {
  /**
   * @param {{timeoutMs?: number, maxOldGenerationSizeMb?: number, maxYoungGenerationSizeMb?: number, stackSizeMb?: number, workerPath?: string, workerFactory?: (workerData: object) => Worker, timers?: {setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout}}} [options]
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 5000;
    this.resourceLimits = Object.freeze({
      maxOldGenerationSizeMb: options.maxOldGenerationSizeMb || 128,
      maxYoungGenerationSizeMb: options.maxYoungGenerationSizeMb || 16,
      stackSizeMb: options.stackSizeMb || 4
    });
    this.workerPath = options.workerPath || path.join(__dirname, 'analysis-worker.js');
    this.workerFactory =
      options.workerFactory ||
      ((workerData) =>
        new Worker(this.workerPath, {
          resourceLimits: this.resourceLimits,
          workerData
        }));
    this.timers = options.timers || { setTimeout, clearTimeout };
  }

  /**
   * @param {string} pageUrl
   * @param {string|Buffer} html
   * @param {{responseHeaders?: Record<string, string|string[]>, signal?: AbortSignal}} [options]
   * @returns {Promise<import('../contracts').AnalysisReport>}
   */
  analyze(pageUrl, html, options = {}) {
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

    let worker;
    try {
      worker = this.workerFactory({
        pageUrl,
        html: Buffer.from(html),
        responseHeaders: options.responseHeaders || {}
      });
    } catch (error) {
      return Promise.reject(
        new AnalysisExecutionError('The page analysis could not be started.', {
          code: 'ANALYSIS_START_FAILED',
          cause: error instanceof Error ? error : undefined
        })
      );
    }

    return waitForWorkerReport(worker, {
      timeoutMs: this.timeoutMs,
      timers: this.timers,
      signal: options.signal
    });
  }
}

module.exports = {
  WorkerAnalysisRunner,
  createInlineAnalysisRunner
};
