'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const { reportPayload } = require('../test-support/browser-fixtures');

let AnalysisApiClient;

before(async () => {
  ({ AnalysisApiClient } = await import('../public/analyzer-app.mjs'));
});

describe('AnalysisApiClient', () => {
  test('requests an encoded report with the supplied cancellation signal', async () => {
    const calls = [];
    const signal = new AbortController().signal;
    const payload = reportPayload();
    const client = new AnalysisApiClient({
      endpoint: '/custom/analyze',
      fetchImpl: async (...args) => {
        calls.push(args);
        return { ok: true, status: 200, json: async () => payload };
      }
    });

    assert.equal(await client.fetchReport('https://example.com/a b', signal), payload);
    assert.equal(calls[0][0], '/custom/analyze?url=https%3A%2F%2Fexample.com%2Fa%20b');
    assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
    assert.equal(calls[0][1].signal, signal);
  });

  test('normalizes unreadable, explicit, and fallback API failures', async () => {
    const unreadable = new AnalysisApiClient({
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => Promise.reject(new Error('bad'))
      })
    });
    await assert.rejects(() => unreadable.fetchReport('example.com'), /unreadable response/);

    const forbidden = new AnalysisApiClient({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Blocked target' } })
      })
    });
    await assert.rejects(
      () => forbidden.fetchReport('example.com'),
      (error) => error.message === 'Blocked target' && error.invalidInput === true
    );

    const stringError = new AnalysisApiClient({
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Try later' })
      })
    });
    await assert.rejects(() => stringError.fetchReport('example.com'), /Try later/);

    const fallback = new AnalysisApiClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] })
    });
    await assert.rejects(() => fallback.fetchReport('example.com'), /Analysis failed/);
  });
});
