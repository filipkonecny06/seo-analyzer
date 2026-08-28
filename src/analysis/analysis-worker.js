'use strict';

// Worker-thread entry point that converts serialized page input into one analysis report.

const { parentPort, workerData } = require('node:worker_threads');
const { SeoAnalyzer } = require('./seo-analyzer');

/**
 * Runs the pure analysis operation for worker input or direct unit-test input.
 *
 * @param {{pageUrl: string, html: string|Buffer|Uint8Array, responseHeaders?: Record<string, string|string[]>}} [input]
 * @returns {import('../contracts').AnalysisReport}
 */
function runAnalysis(input = workerData) {
  const analyzer = new SeoAnalyzer();
  return analyzer.analyze(input.pageUrl, Buffer.from(input.html), {
    responseHeaders: input.responseHeaders
  });
}

if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, report: runAnalysis() });
  } catch (error) {
    // Only serializable error fields cross the worker boundary; response data and stacks do not.
    parentPort.postMessage({
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Unknown analysis error'
      }
    });
  }
}

module.exports = {
  runAnalysis
};
