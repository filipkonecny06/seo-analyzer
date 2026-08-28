'use strict';

// Worker-thread entry point that converts serialized page input into one analysis report.

const { parentPort, workerData } = require('node:worker_threads');
const { SeoAnalyzer } = require('./seo-analyzer');

/**
 * Runs the pure analysis operation for worker input or direct unit-test input.
 *
 * @param {{pageUrl: string, html: string|Buffer|Uint8Array, responseHeaders?: object}} [input]
 * @returns {object}
 */
function runAnalysis(input = workerData) {
  const analyzer = new SeoAnalyzer();
  return analyzer.analyze(input.pageUrl, Buffer.from(input.html), {
    responseHeaders: input.responseHeaders
  });
}

try {
  parentPort.postMessage({ ok: true, report: runAnalysis() });
} catch (error) {
  // Only the serializable error name and message cross the worker boundary; the stack is not sent.
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name || 'Error',
      message: error?.message || 'Unknown analysis error'
    }
  });
}

module.exports = {
  runAnalysis
};
