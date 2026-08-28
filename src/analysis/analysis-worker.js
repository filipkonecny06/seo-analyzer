'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { SeoAnalyzer } = require('./seo-analyzer');

function runAnalysis(input = workerData) {
  const analyzer = new SeoAnalyzer();
  return analyzer.analyze(input.pageUrl, Buffer.from(input.html), {
    responseHeaders: input.responseHeaders
  });
}

try {
  parentPort.postMessage({ ok: true, report: runAnalysis() });
} catch (error) {
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
