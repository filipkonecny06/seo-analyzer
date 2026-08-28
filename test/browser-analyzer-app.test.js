'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const {
  buildAppDocument,
  createRendererSpy,
  deferred,
  reportPayload,
  submitEvent
} = require('../test-support/browser-fixtures');

let AnalysisRequestError;
let AnalyzerApp;

before(async () => {
  ({ AnalysisRequestError, AnalyzerApp } = await import('../public/analyzer-app.mjs'));
});

describe('AnalyzerApp', () => {
  function createApp(apiClient, options = {}) {
    const fixture = buildAppDocument();
    const renderer = options.renderer || createRendererSpy();
    const scheduled = [];
    const app = new AnalyzerApp(fixture.document, {
      apiClient,
      renderer,
      schedule: options.schedule || ((callback) => scheduled.push(callback))
    });
    return { ...fixture, app, renderer, scheduled };
  }

  test('validates supported URLs without sending a request', async () => {
    const apiClient = { fetchReport: async () => assert.fail('unexpected request') };
    const { app, input, error, renderer, status } = createApp(apiClient);

    assert.equal(app.validateUrl('example.com/path'), '');
    assert.equal(app.validateUrl('example.com:443/path'), '');
    assert.equal(app.validateUrl('https://example.com'), '');
    assert.match(app.validateUrl(''), /Enter a page URL/);
    assert.match(app.validateUrl('ftp://example.com'), /HTTP or HTTPS/);
    assert.match(app.validateUrl('https://'), /such as example.com/);

    input.value = 'ftp://example.com';
    await app.handleSubmit(submitEvent());
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.focused, true);
    assert.equal(error.hidden, false);
    assert.equal(status.textContent, '');
    assert.equal(renderer.clearCalls, 1);
  });

  test('manages a successful request from loading state through report focus', async () => {
    const request = deferred();
    let receivedSignal;
    const apiClient = {
      fetchReport(_url, signal) {
        receivedSignal = signal;
        return request.promise;
      }
    };
    const { app, input, button, panel, status, renderer, scheduled } = createApp(apiClient);
    input.value = 'example.com';

    const submission = app.handleSubmit(submitEvent());
    assert.equal(button.disabled, true);
    assert.match(button.className, /is-loading/);
    assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.match(status.textContent, /Fetching/);
    assert.equal(receivedSignal.aborted, false);

    const payload = reportPayload();
    request.resolve(payload);
    await submission;
    assert.deepEqual(renderer.rendered, [payload]);
    assert.equal(button.disabled, false);
    assert.equal(panel.getAttribute('aria-busy'), 'false');
    assert.match(status.textContent, /88 out of 100/);
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    assert.equal(renderer.focusCalls, 1);
  });

  test('aborts superseded work and ignores a late stale result', async () => {
    const requests = [];
    const apiClient = {
      fetchReport(url, signal) {
        const pending = deferred();
        requests.push({ url, signal, pending });
        return pending.promise;
      }
    };
    const { app, input, renderer } = createApp(apiClient);
    input.value = 'first.example';
    const firstSubmission = app.handleSubmit(submitEvent());
    input.value = 'second.example';
    const secondSubmission = app.handleSubmit(submitEvent());

    assert.equal(requests[0].signal.aborted, true);
    requests[0].pending.resolve(reportPayload({ score: 10 }));
    const secondPayload = reportPayload({ score: 90 });
    requests[1].pending.resolve(secondPayload);
    await Promise.all([firstSubmission, secondSubmission]);
    assert.deepEqual(renderer.rendered, [secondPayload]);
  });

  test('aborts active work on unload and when invalid input replaces it', async () => {
    const requests = [];
    const apiClient = {
      fetchReport(_url, signal) {
        const pending = deferred();
        requests.push({ signal, pending });
        return pending.promise;
      }
    };
    const { app, input, renderer } = createApp(apiClient);
    input.value = 'example.com';
    const firstSubmission = app.handleSubmit(submitEvent());
    app.handleBeforeUnload();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].pending.resolve(reportPayload());
    await firstSubmission;
    assert.equal(renderer.rendered.length, 0);

    input.value = 'example.com';
    const secondSubmission = app.handleSubmit(submitEvent());
    input.value = '';
    await app.handleSubmit(submitEvent());
    assert.equal(requests[1].signal.aborted, true);
    requests[1].pending.resolve(reportPayload());
    await secondSubmission;
    assert.equal(renderer.rendered.length, 0);
  });

  test('shows normalized request and incomplete-response errors', async () => {
    const errors = [
      new AnalysisRequestError('URL is blocked', true),
      new Error('Network unavailable'),
      null
    ];
    const apiClient = {
      async fetchReport() {
        const error = errors.shift();
        if (error) throw error;
        return { ok: true };
      }
    };
    const { app, input, error, status, renderer, scheduled } = createApp(apiClient);
    input.value = 'example.com';

    await app.handleSubmit(submitEvent());
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(error.textContent, 'URL is blocked');
    assert.equal(status.textContent, '');
    scheduled.shift()();
    assert.equal(error.focused, true);

    app.handleInput();
    assert.equal(error.hidden, true);
    assert.equal(input.hasAttribute('aria-invalid'), false);

    await app.handleSubmit(submitEvent());
    assert.equal(error.textContent, 'Network unavailable');
    await app.handleSubmit(submitEvent());
    assert.match(error.textContent, /incomplete analysis/);
    assert.equal(renderer.rendered.length, 0);
  });

  test('initializes once and destroy removes listeners and cancels work', async () => {
    const pending = deferred();
    let signal;
    const apiClient = {
      fetchReport(_url, requestSignal) {
        signal = requestSignal;
        return pending.promise;
      }
    };
    const { app, document, form, input } = createApp(apiClient);
    assert.equal(app.init(), app);
    assert.equal(app.init(), app);
    assert.equal(form.listeners.get('submit').size, 1);
    input.value = 'example.com';
    const submission = app.handleSubmit(submitEvent());
    app.destroy();
    assert.equal(signal.aborted, true);
    assert.equal(form.listeners.get('submit').size, 0);
    assert.equal(document.defaultView.listeners.get('beforeunload').size, 0);
    app.destroy();
    pending.resolve(reportPayload());
    await submission;
  });
});
