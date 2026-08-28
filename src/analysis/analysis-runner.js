'use strict';

// Runs CPU- and parser-heavy analysis either inline for tests or in a bounded worker for production.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { AnalysisExecutionError } = require('../errors');

function abortError(signal) {
  return new AnalysisExecutionError('The page analysis was cancelled.', {
    code: 'ANALYSIS_ABORTED',
    statusCode: 499,
    cause: signal?.reason instanceof Error ? signal.reason : undefined
  });
}

/**
 * Adapts a synchronous analyzer to the async runner contract for deterministic unit tests.
 *
 * @param {{analyze(pageUrl: string, html: string|Buffer, options?: object): object}} analyzer
 * @returns {{analyze(pageUrl: string, html: string|Buffer, options?: object): Promise<object>}}
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
 * Isolates HTML parsing in a worker with memory, stack, time, and cancellation limits.
 * A fresh worker per report also prevents malformed pages from retaining state between requests.
 */
class WorkerAnalysisRunner {
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
   * Starts one isolated analysis and terminates its worker on every completion path.
   *
   * @param {string} pageUrl
   * @param {string|Buffer} html
   * @param {{responseHeaders?: object, signal?: AbortSignal}} [options]
   * @returns {Promise<object>}
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
          cause: error
        })
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;

      const cleanup = () => {
        if (timer !== undefined) this.timers.clearTimeout(timer);
        options.signal?.removeEventListener('abort', handleAbort);
        worker.removeListener('message', handleMessage);
        worker.removeListener('error', handleError);
        worker.removeListener('exit', handleExit);
      };

      // Wait for the termination attempt before settling so worker cleanup precedes the outcome.
      const settleAfterTermination = (error, report) => {
        if (settled) return;
        settled = true;
        cleanup();

        let termination;
        try {
          termination = worker.terminate();
        } catch (_terminationError) {
          termination = undefined;
        }
        // Worker termination errors cannot change the already selected analysis outcome.
        Promise.resolve(termination)
          .catch(() => undefined)
          .then(() => {
            if (error) reject(error);
            else resolve(report);
          });
      };

      const handleAbort = () => settleAfterTermination(abortError(options.signal));
      const handleMessage = (message) => {
        // Treat worker messages as a serialized boundary and require the expected envelope.
        if (message?.ok === true && message.report && typeof message.report === 'object') {
          settleAfterTermination(null, message.report);
          return;
        }
        settleAfterTermination(
          new AnalysisExecutionError('The page could not be analyzed.', {
            code: 'ANALYSIS_FAILED',
            cause: message?.error ? new Error(message.error.message) : undefined
          })
        );
      };
      const handleError = (error) => {
        const resourceLimit = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
        settleAfterTermination(
          new AnalysisExecutionError(
            resourceLimit
              ? 'The page is too complex to analyze within the configured memory limit.'
              : 'The page could not be analyzed.',
            {
              code: resourceLimit ? 'ANALYSIS_RESOURCE_LIMIT' : 'ANALYSIS_FAILED',
              statusCode: resourceLimit ? 422 : 500,
              expose: resourceLimit,
              cause: error
            }
          )
        );
      };
      const handleExit = (exitCode) => {
        if (exitCode === 0) {
          settleAfterTermination(
            new AnalysisExecutionError('The analysis worker returned no report.', {
              code: 'ANALYSIS_NO_RESULT'
            })
          );
          return;
        }
        settleAfterTermination(
          new AnalysisExecutionError('The page could not be analyzed.', {
            code: 'ANALYSIS_FAILED',
            cause: new Error(`Analysis worker exited with code ${exitCode}.`)
          })
        );
      };

      worker.once('message', handleMessage);
      worker.once('error', handleError);
      worker.once('exit', handleExit);
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      timer = this.timers.setTimeout(() => {
        settleAfterTermination(
          new AnalysisExecutionError(`The page analysis exceeded ${this.timeoutMs} ms.`, {
            code: 'ANALYSIS_TIMEOUT',
            statusCode: 504,
            expose: true
          })
        );
      }, this.timeoutMs);
    });
  }
}

module.exports = {
  WorkerAnalysisRunner,
  createInlineAnalysisRunner
};
