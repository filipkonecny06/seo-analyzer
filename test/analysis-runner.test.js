'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  WorkerAnalysisRunner,
  createInlineAnalysisRunner
} = require('../src/analysis/analysis-runner');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.termination = deferred();
    this.terminateCalls = 0;
  }

  terminate() {
    this.terminateCalls += 1;
    return this.termination.promise;
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('WorkerAnalysisRunner', () => {
  it('runs a real analysis worker and returns its report', { timeout: 4000 }, async () => {
    const runner = new WorkerAnalysisRunner({ timeoutMs: 2000 });
    const report = await runner.analyze(
      'https://example.com/',
      Buffer.from('<html lang="en"><head><title>Worker report</title></head><body></body></html>')
    );

    assert.equal(report.metadata.title, 'Worker report');
    assert.equal(report.maxScore, 100);
  });

  it('returns a safe failure when the real worker cannot analyze its input', async () => {
    const runner = new WorkerAnalysisRunner({ timeoutMs: 2000 });

    await assert.rejects(runner.analyze('not a URL', Buffer.from('<html></html>')), {
      code: 'ANALYSIS_FAILED',
      expose: false
    });
  });

  it('waits for worker termination before resolving a successful report', async () => {
    const worker = new FakeWorker();
    const runner = new WorkerAnalysisRunner({ workerFactory: () => worker });
    let resolved = false;
    const pending = runner
      .analyze('https://example.com/', Buffer.from('<html></html>'))
      .then((report) => {
        resolved = true;
        return report;
      });

    worker.emit('message', { ok: true, report: { score: 42 } });
    await nextTurn();
    assert.equal(worker.terminateCalls, 1);
    assert.equal(resolved, false);

    worker.termination.resolve(1);
    assert.deepEqual(await pending, { score: 42 });
  });

  it('terminates a hung worker at the deadline before rejecting', async () => {
    const worker = new FakeWorker();
    let deadline;
    let clearedTimer;
    const runner = new WorkerAnalysisRunner({
      timeoutMs: 750,
      workerFactory: () => worker,
      timers: {
        setTimeout(callback) {
          deadline = callback;
          return 'analysis-deadline';
        },
        clearTimeout(timer) {
          clearedTimer = timer;
        }
      }
    });
    let rejected = false;
    const pending = runner
      .analyze('https://example.com/', Buffer.from('<html></html>'))
      .catch((error) => {
        rejected = true;
        throw error;
      });

    deadline();
    await nextTurn();
    assert.equal(worker.terminateCalls, 1);
    assert.equal(clearedTimer, 'analysis-deadline');
    assert.equal(rejected, false);

    worker.termination.resolve(1);
    await assert.rejects(pending, {
      code: 'ANALYSIS_TIMEOUT',
      statusCode: 504,
      expose: true
    });
  });

  it('terminates a hung worker on caller abort before rejecting', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const runner = new WorkerAnalysisRunner({ workerFactory: () => worker });
    const pending = runner.analyze('https://example.com/', Buffer.from('<html></html>'), {
      signal: controller.signal
    });

    controller.abort(new Error('client disconnected'));
    await nextTurn();
    assert.equal(worker.terminateCalls, 1);

    worker.termination.resolve(1);
    await assert.rejects(pending, { code: 'ANALYSIS_ABORTED', statusCode: 499 });
  });

  it('maps worker memory failures and unexpected exits to stable errors', async () => {
    const memoryWorker = new FakeWorker();
    const memoryRunner = new WorkerAnalysisRunner({ workerFactory: () => memoryWorker });
    const memoryFailure = memoryRunner.analyze(
      'https://example.com/',
      Buffer.from('<html></html>')
    );
    memoryWorker.emit(
      'error',
      Object.assign(new Error('worker reached its memory limit'), {
        code: 'ERR_WORKER_OUT_OF_MEMORY'
      })
    );
    memoryWorker.termination.resolve(1);
    await assert.rejects(memoryFailure, {
      code: 'ANALYSIS_RESOURCE_LIMIT',
      statusCode: 422,
      expose: true
    });

    const exitedWorker = new FakeWorker();
    const exitedRunner = new WorkerAnalysisRunner({ workerFactory: () => exitedWorker });
    const exitFailure = exitedRunner.analyze('https://example.com/', Buffer.from('<html></html>'));
    exitedWorker.emit('exit', 2);
    exitedWorker.termination.resolve(2);
    await assert.rejects(exitFailure, { code: 'ANALYSIS_FAILED', expose: false });
  });

  it('rejects pre-aborted and unstartable work without creating a live worker', async () => {
    const controller = new AbortController();
    controller.abort();
    let factoryCalls = 0;
    const abortedRunner = new WorkerAnalysisRunner({
      workerFactory() {
        factoryCalls += 1;
      }
    });
    await assert.rejects(
      abortedRunner.analyze('https://example.com/', Buffer.from('<html></html>'), {
        signal: controller.signal
      }),
      { code: 'ANALYSIS_ABORTED' }
    );
    assert.equal(factoryCalls, 0);

    const failedRunner = new WorkerAnalysisRunner({
      workerFactory() {
        throw new Error('worker unavailable');
      }
    });
    await assert.rejects(failedRunner.analyze('https://example.com/', Buffer.alloc(0)), {
      code: 'ANALYSIS_START_FAILED',
      expose: false
    });
  });
});

describe('createInlineAnalysisRunner', () => {
  it('keeps injected analyzers available as an asynchronous test boundary', async () => {
    const analyzer = {
      analyze(pageUrl, html, options) {
        return { pageUrl, bytes: html.length, marker: options.marker };
      }
    };
    const runner = createInlineAnalysisRunner(analyzer);
    assert.deepEqual(
      await runner.analyze('https://example.com/', Buffer.from('page'), { marker: 'test' }),
      { pageUrl: 'https://example.com/', bytes: 4, marker: 'test' }
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runner.analyze('https://example.com/', Buffer.alloc(0), { signal: controller.signal }),
      { code: 'ANALYSIS_ABORTED' }
    );
  });
});
