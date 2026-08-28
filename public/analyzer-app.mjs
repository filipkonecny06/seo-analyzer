import { ReportRenderer } from './report-renderer.mjs';
import { displayNumber, getRequiredElement, isRecord } from './ui-utils.mjs';

export class AnalysisRequestError extends Error {
  constructor(message, invalidInput = false) {
    super(message);
    this.name = 'AnalysisRequestError';
    this.invalidInput = invalidInput;
  }
}

export class AnalysisApiClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.endpoint = options.endpoint || '/api/analyze';

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('AnalysisApiClient requires a fetch implementation.');
    }
  }

  async fetchReport(rawUrl, signal) {
    const response = await this.fetchImpl(`${this.endpoint}?url=${encodeURIComponent(rawUrl)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal
    });

    let payload;
    try {
      payload = await response.json();
    } catch (_error) {
      throw new AnalysisRequestError(
        'The analyzer returned an unreadable response. Please try again.'
      );
    }

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      const responseError = isRecord(payload) ? payload.error : null;
      const serverMessage =
        typeof responseError === 'string'
          ? responseError
          : isRecord(responseError) && typeof responseError.message === 'string'
            ? responseError.message
            : 'Analysis failed. Please verify the URL and try again.';
      throw new AnalysisRequestError(
        serverMessage,
        response.status === 400 || response.status === 403
      );
    }

    return payload;
  }
}

export class AnalyzerApp {
  constructor(rootDocument, options = {}) {
    this.document = rootDocument;
    this.window = options.window || rootDocument.defaultView;
    this.URLConstructor = options.URLConstructor || URL;
    this.createAbortController = options.createAbortController || (() => new AbortController());
    this.schedule = options.schedule || ((callback) => this.window.requestAnimationFrame(callback));
    this.form = getRequiredElement(rootDocument, '#analyzer-form');
    this.input = getRequiredElement(rootDocument, '#url-input');
    this.button = getRequiredElement(rootDocument, '#analyze-button');
    this.buttonLabel = getRequiredElement(this.button, '.button__label');
    this.panel = getRequiredElement(rootDocument, '#analyzer-panel');
    this.status = getRequiredElement(rootDocument, '#status');
    this.error = getRequiredElement(rootDocument, '#error-message');
    this.renderer =
      options.renderer || new ReportRenderer(getRequiredElement(rootDocument, '#report'));
    this.apiClient = options.apiClient || new AnalysisApiClient();
    this.activeRequest = null;
    this.requestSequence = 0;
    this.initialized = false;
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
  }

  init() {
    if (this.initialized) return this;

    this.form.addEventListener('submit', this.handleSubmit);
    this.input.addEventListener('input', this.handleInput);
    this.window.addEventListener('beforeunload', this.handleBeforeUnload);
    this.initialized = true;
    return this;
  }

  destroy() {
    if (!this.initialized) return;

    this.form.removeEventListener('submit', this.handleSubmit);
    this.input.removeEventListener('input', this.handleInput);
    this.window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.requestSequence += 1;
    this.abortActiveRequest();
    this.initialized = false;
  }

  handleInput() {
    this.input.removeAttribute('aria-invalid');
    if (!this.error.hidden) this.hideError();
  }

  handleBeforeUnload() {
    this.requestSequence += 1;
    this.abortActiveRequest();
  }

  async handleSubmit(event) {
    event.preventDefault();

    const rawUrl = this.input.value.trim();
    const validationMessage = this.validateUrl(rawUrl);
    if (validationMessage) {
      this.requestSequence += 1;
      this.abortActiveRequest();
      this.renderer.clear();
      this.setLoading(false);
      this.setStatus('');
      this.input.setAttribute('aria-invalid', 'true');
      this.showError(validationMessage, false);
      this.input.focus();
      return;
    }

    this.abortActiveRequest();
    const requestId = ++this.requestSequence;
    const controller = this.createAbortController();
    this.activeRequest = { id: requestId, controller };

    this.renderer.clear();
    this.hideError();
    this.input.removeAttribute('aria-invalid');
    this.setLoading(true);
    this.setStatus('Fetching the page and running SEO checks…');

    try {
      const payload = await this.apiClient.fetchReport(rawUrl, controller.signal);
      if (!this.isCurrentRequest(requestId)) return;

      if (!isRecord(payload.report)) {
        throw new AnalysisRequestError(
          'The server returned an incomplete analysis. Please try again.'
        );
      }

      this.renderer.render(payload);
      this.setStatus(
        `Analysis complete. SEO score: ${displayNumber(payload.report.score)} out of 100.`
      );
      this.schedule(() => {
        if (this.requestSequence === requestId) this.renderer.focus();
      });
    } catch (error) {
      if (error?.name === 'AbortError' || !this.isCurrentRequest(requestId)) return;

      const message = error instanceof Error ? error.message : 'Unable to analyze this URL.';
      const invalidInput = error instanceof AnalysisRequestError && error.invalidInput;
      if (invalidInput) this.input.setAttribute('aria-invalid', 'true');
      this.setStatus('');
      this.showError(message, true);
    } finally {
      if (this.isCurrentRequest(requestId)) {
        this.setLoading(false);
        this.activeRequest = null;
      }
    }
  }

  validateUrl(rawUrl) {
    if (!rawUrl) return 'Enter a page URL to begin the analysis.';

    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl);
      const candidate = hasScheme ? rawUrl : `https://${rawUrl}`;
      const parsedUrl = new this.URLConstructor(candidate);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
        return 'Enter a valid HTTP or HTTPS page URL.';
      }
    } catch (_error) {
      return 'Enter a valid page URL, such as example.com/article.';
    }

    return '';
  }

  abortActiveRequest() {
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = null;
    }
  }

  isCurrentRequest(requestId) {
    return this.activeRequest !== null && this.activeRequest.id === requestId;
  }

  setLoading(isLoading) {
    this.button.disabled = isLoading;
    this.button.classList.toggle('is-loading', isLoading);
    this.buttonLabel.textContent = isLoading ? 'Analyzing…' : 'Analyze page';
    this.panel.setAttribute('aria-busy', String(isLoading));
  }

  setStatus(message) {
    this.status.textContent = message;
  }

  hideError() {
    this.error.hidden = true;
    this.error.textContent = '';
  }

  showError(message, moveFocus) {
    this.error.textContent = message;
    this.error.hidden = false;
    if (moveFocus) {
      this.schedule(() => {
        if (!this.error.hidden) this.error.focus();
      });
    }
  }
}
