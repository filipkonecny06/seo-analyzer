// Coordinates form state, cancellable API requests, and accessible report presentation.

import { ReportRenderer } from './report-renderer.mjs';
import { displayNumber, getRequiredElement, isRecord } from './ui-utils.mjs';

export const APP_SELECTORS = Object.freeze({
  form: '#analyzer-form',
  input: '#url-input',
  button: '#analyze-button',
  buttonLabel: '.button__label',
  panel: '#analyzer-panel',
  status: '#status',
  error: '#error-message',
  report: '#report'
});

/** User-facing request failure with enough context to mark invalid input accessibly. */
export class AnalysisRequestError extends Error {
  /**
   * @param {string} message
   * @param {boolean} [invalidInput]
   */
  constructor(message, invalidInput = false) {
    super(message);
    this.name = 'AnalysisRequestError';
    this.invalidInput = invalidInput;
  }
}

/** Thin transport adapter for the analyzer's JSON endpoint. */
export class AnalysisApiClient {
  /** @param {{fetchImpl?: typeof fetch, endpoint?: string}} [options] */
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.endpoint = options.endpoint || '/api/analyze';

    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('AnalysisApiClient requires a fetch implementation.');
    }
  }

  /**
   * Requests and validates the server's response envelope.
   *
   * @param {string} rawUrl
   * @param {AbortSignal} signal
   * @returns {Promise<import('../src/contracts.js').AnalyzeSuccessResponse>}
   * @throws {AnalysisRequestError} For response-contract errors; network and abort errors propagate.
   */
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

    return /** @type {import('../src/contracts.js').AnalyzeSuccessResponse} */ (payload);
  }
}

/** Owns the analyzer form lifecycle and ensures only the newest request may update the page. */
export class AnalyzerApp {
  /**
   * @param {Document} rootDocument
   * @param {{window?: Window, URLConstructor?: typeof URL, createAbortController?: () => AbortController, schedule?: (callback: FrameRequestCallback) => unknown, renderer?: ReportRenderer, apiClient?: AnalysisApiClient}} [options]
   */
  constructor(rootDocument, options = {}) {
    this.document = rootDocument;
    const windowContext = options.window || rootDocument.defaultView;
    if (!windowContext) throw new TypeError('AnalyzerApp requires a browser window.');
    this.window = windowContext;
    this.URLConstructor = options.URLConstructor || URL;
    this.createAbortController = options.createAbortController || (() => new AbortController());
    this.schedule =
      options.schedule ||
      ((/** @type {FrameRequestCallback} */ callback) =>
        this.window.requestAnimationFrame(callback));
    this.form = /** @type {HTMLFormElement} */ (
      getRequiredElement(rootDocument, APP_SELECTORS.form)
    );
    this.input = /** @type {HTMLInputElement} */ (
      getRequiredElement(rootDocument, APP_SELECTORS.input)
    );
    this.button = /** @type {HTMLButtonElement} */ (
      getRequiredElement(rootDocument, APP_SELECTORS.button)
    );
    this.buttonLabel = /** @type {HTMLElement} */ (
      getRequiredElement(this.button, APP_SELECTORS.buttonLabel)
    );
    this.panel = /** @type {HTMLElement} */ (getRequiredElement(rootDocument, APP_SELECTORS.panel));
    this.status = /** @type {HTMLElement} */ (
      getRequiredElement(rootDocument, APP_SELECTORS.status)
    );
    this.error = /** @type {HTMLElement} */ (getRequiredElement(rootDocument, APP_SELECTORS.error));
    this.renderer =
      options.renderer ||
      new ReportRenderer(getRequiredElement(rootDocument, APP_SELECTORS.report));
    this.apiClient = options.apiClient || new AnalysisApiClient();
    /** @type {{id: number, controller: AbortController}|null} */
    this.activeRequest = null;
    this.requestSequence = 0;
    this.initialized = false;
    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleInput = this.handleInput.bind(this);
    this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
  }

  /** Attaches event listeners once and returns this application instance. */
  init() {
    if (this.initialized) return this;

    this.form.addEventListener('submit', this.handleSubmit);
    this.input.addEventListener('input', this.handleInput);
    this.window.addEventListener('beforeunload', this.handleBeforeUnload);
    this.initialized = true;
    return this;
  }

  /** Removes listeners and cancels work so a detached application cannot update the document. */
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

  /**
   * Validates input, runs one cancellable analysis, and renders its latest result.
   * @param {Event} event
   */
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
    // The sequence guards against stale completions even if a fetch implementation ignores abort.
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
      // Move focus after rendering so keyboard and screen-reader users land on the new report.
      this.schedule(() => {
        if (this.requestSequence === requestId) this.renderer.focus();
      });
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        !this.isCurrentRequest(requestId)
      )
        return;

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

  /**
   * Performs immediate syntax feedback; the server remains authoritative for network safety.
   *
   * @param {string} rawUrl
   * @returns {string} An empty string when valid, otherwise a user-facing validation message.
   */
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

  /** Cancels the current network request, if any, and clears its ownership marker. */
  abortActiveRequest() {
    if (this.activeRequest) {
      this.activeRequest.controller.abort();
      this.activeRequest = null;
    }
  }

  /** @param {number} requestId Returns whether completion belongs to the active submission. */
  isCurrentRequest(requestId) {
    return this.activeRequest !== null && this.activeRequest.id === requestId;
  }

  /** @param {boolean} isLoading */
  setLoading(isLoading) {
    this.button.disabled = isLoading;
    this.button.classList.toggle('is-loading', isLoading);
    this.buttonLabel.textContent = isLoading ? 'Analyzing…' : 'Analyze page';
    this.panel.setAttribute('aria-busy', String(isLoading));
  }

  /** @param {string} message */
  setStatus(message) {
    this.status.textContent = message;
  }

  hideError() {
    this.error.hidden = true;
    this.error.textContent = '';
  }

  /** @param {string} message @param {boolean} moveFocus */
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
