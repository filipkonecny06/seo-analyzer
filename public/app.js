'use strict';

const NUMBER_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
});

function getRequiredElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Required UI element is missing: ${selector}`);
  }
  return element;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function displayText(value, fallback = 'Not available') {
  return hasValue(value) ? String(value) : fallback;
}

function displayNumber(value, suffix = '') {
  if (!hasValue(value)) {
    return 'Not available';
  }

  const number = Number(value);
  return Number.isFinite(number) ? `${NUMBER_FORMATTER.format(number)}${suffix}` : 'Not available';
}

function clampScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = String(options.text);
  }
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => {
      element.setAttribute(name, String(value));
    });
  }

  return element;
}

function getScoreTone(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warning';
  return 'critical';
}

function getScoreMessage(score) {
  if (score >= 90) return 'Excellent on-page foundation. Keep monitoring as the page evolves.';
  if (score >= 80) return 'Strong foundation with a few opportunities to fine-tune.';
  if (score >= 60) return 'A workable start. Address the priority actions to build momentum.';
  return 'Several core signals need attention. Start with the highest-impact actions.';
}

function normalizeCheckStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['pass', 'warn', 'fail'].includes(status) ? status : 'unknown';
}

function getStatusLabel(status) {
  return {
    pass: 'Passed',
    warn: 'Review',
    fail: 'Failed',
    unknown: 'Unknown'
  }[status];
}

function getSafeHttpUrl(value) {
  try {
    const parsedUrl = new URL(String(value));
    return ['http:', 'https:'].includes(parsedUrl.protocol) ? parsedUrl.href : null;
  } catch (_error) {
    return null;
  }
}

class ReportRenderer {
  constructor(root) {
    this.root = root;
    this.elements = {
      title: getRequiredElement(root, '#report-title'),
      analyzedUrl: getRequiredElement(root, '#analyzed-url'),
      fetchedAt: getRequiredElement(root, '#fetched-at'),
      scoreDial: getRequiredElement(root, '#score-dial'),
      scoreValue: getRequiredElement(root, '#score-value'),
      scoreGrade: getRequiredElement(root, '#score-grade'),
      scoreMessage: getRequiredElement(root, '#score-message'),
      recommendations: getRequiredElement(root, '#recommendations'),
      metrics: getRequiredElement(root, '#metrics'),
      keywords: getRequiredElement(root, '#keywords'),
      checksSummary: getRequiredElement(root, '#checks-summary'),
      checksBody: getRequiredElement(root, '#checks-body')
    };
  }

  clear() {
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.elements.analyzedUrl.textContent = '';
    this.elements.analyzedUrl.removeAttribute('href');
    this.elements.fetchedAt.textContent = '';
    this.elements.scoreValue.textContent = '0';
    this.elements.scoreGrade.textContent = '';
    this.elements.scoreMessage.textContent = '';
    this.elements.scoreDial.className = 'score-dial';
    this.elements.scoreDial.style.removeProperty('--score');
    this.elements.scoreDial.removeAttribute('aria-label');
    this.elements.recommendations.replaceChildren();
    this.elements.metrics.replaceChildren();
    this.elements.keywords.replaceChildren();
    this.elements.checksBody.replaceChildren();
    this.elements.checksSummary.textContent = 'A rule-by-rule breakdown of this page.';
  }

  render(payload) {
    const report = asRecord(payload.report);
    const metadata = asRecord(report.metadata);
    const content = asRecord(report.content);

    this.renderSource(payload.url, payload.fetchedAt);
    this.renderScore(report.score, report.grade);
    this.renderRecommendations(report.recommendations);
    this.renderMetrics(metadata, content);
    this.renderKeywords(asRecord(content.words).topKeywords);
    this.renderChecks(report.checks);

    this.root.hidden = false;
    this.root.setAttribute('aria-busy', 'false');
  }

  renderSource(url, fetchedAt) {
    const urlText = displayText(url);
    const safeUrl = getSafeHttpUrl(url);

    this.elements.analyzedUrl.textContent = urlText;
    if (safeUrl) {
      this.elements.analyzedUrl.href = safeUrl;
      this.elements.analyzedUrl.setAttribute('aria-label', `Open analyzed page: ${urlText}`);
    } else {
      this.elements.analyzedUrl.removeAttribute('href');
      this.elements.analyzedUrl.removeAttribute('aria-label');
    }

    const date = new Date(fetchedAt);
    this.elements.fetchedAt.textContent = Number.isNaN(date.getTime())
      ? 'Analysis completed just now'
      : `Completed ${DATE_FORMATTER.format(date)}`;
  }

  renderScore(rawScore, rawGrade) {
    const score = clampScore(rawScore);
    const formattedScore = NUMBER_FORMATTER.format(score);
    const grade = displayText(rawGrade, '—');
    const tone = getScoreTone(score);

    this.elements.scoreValue.textContent = formattedScore;
    this.elements.scoreGrade.textContent = `Grade ${grade}`;
    this.elements.scoreMessage.textContent = getScoreMessage(score);
    this.elements.scoreDial.className = `score-dial score-dial--${tone}`;
    this.elements.scoreDial.style.setProperty('--score', String(score));
    this.elements.scoreDial.setAttribute(
      'aria-label',
      `SEO score: ${formattedScore} out of 100, grade ${grade}`
    );
    this.elements.scoreGrade.className = `grade-badge grade-badge--${tone}`;
  }

  renderRecommendations(rawRecommendations) {
    const recommendations = asArray(rawRecommendations).filter(
      (item) => typeof item === 'string' && item.trim()
    );
    const items = recommendations.length
      ? recommendations
      : ['No critical issues detected. Keep improving content quality and authority over time.'];
    const fragment = document.createDocumentFragment();

    items.forEach((recommendation) => {
      const item = createElement('li', { className: 'recommendation-list__item' });
      const copy = createElement('span', {
        className: 'recommendation-list__copy',
        text: recommendation
      });
      item.append(copy);
      fragment.append(item);
    });

    this.elements.recommendations.replaceChildren(fragment);
  }

  renderMetrics(metadata, content) {
    const words = asRecord(content.words);
    const headings = asRecord(content.headings);
    const headingCounts = asRecord(headings.counts);
    const images = asRecord(content.images);
    const links = asRecord(content.links);
    const metrics = [
      ['Title length', displayNumber(metadata.titleLength, ' characters')],
      ['Description', displayNumber(metadata.descriptionLength, ' characters')],
      ['Word count', displayNumber(words.count)],
      ['H1 headings', displayNumber(headingCounts.h1)],
      ['Images missing alt', displayNumber(images.missingAlt)],
      ['Internal links', displayNumber(links.internal)],
      ['External links', displayNumber(links.external)],
      ['Structured data', displayNumber(content.structuredDataCount, ' blocks')],
      ['Page language', displayText(metadata.lang, 'Missing')]
    ];
    const fragment = document.createDocumentFragment();

    metrics.forEach(([label, value]) => {
      const item = createElement('div', { className: 'metric' });
      const term = createElement('dt', { className: 'metric__label', text: label });
      const description = createElement('dd', { className: 'metric__value', text: value });
      item.append(term, description);
      fragment.append(item);
    });

    this.elements.metrics.replaceChildren(fragment);
  }

  renderKeywords(rawKeywords) {
    const keywords = asArray(rawKeywords).filter(
      (entry) => isRecord(entry) && hasValue(entry.term)
    );

    if (!keywords.length) {
      const emptyState = createElement('p', {
        className: 'empty-state',
        text: 'No meaningful keyword pattern was detected on this page.'
      });
      this.elements.keywords.replaceChildren(emptyState);
      return;
    }

    const fragment = document.createDocumentFragment();
    keywords.forEach((entry) => {
      const term = displayText(entry.term);
      const count = displayNumber(entry.count);
      const chip = createElement('span', {
        className: 'keyword-chip',
        attributes: { 'aria-label': `${term}: ${count} occurrences` }
      });
      const termElement = createElement('span', {
        className: 'keyword-chip__term',
        text: term,
        attributes: { 'aria-hidden': 'true' }
      });
      const countElement = createElement('span', {
        className: 'keyword-chip__count',
        text: `×${count}`,
        attributes: { 'aria-hidden': 'true' }
      });
      chip.append(termElement, countElement);
      fragment.append(chip);
    });

    this.elements.keywords.replaceChildren(fragment);
  }

  renderChecks(rawChecks) {
    const checks = asArray(rawChecks).filter(isRecord);
    const fragment = document.createDocumentFragment();
    let passedChecks = 0;

    if (!checks.length) {
      const row = createElement('tr');
      const cell = createElement('td', {
        className: 'checks-table__empty',
        text: 'No detailed checks were returned for this page.',
        attributes: { colspan: '4' }
      });
      row.append(cell);
      fragment.append(row);
    }

    checks.forEach((check) => {
      const status = normalizeCheckStatus(check.status);
      if (status === 'pass') passedChecks += 1;

      const row = createElement('tr');
      const label = createElement('th', {
        className: 'checks-table__label',
        text: displayText(check.label),
        attributes: { scope: 'row' }
      });
      const statusCell = createElement('td');
      const statusPill = createElement('span', {
        className: `status-pill status-pill--${status}`,
        text: getStatusLabel(status)
      });
      const points = createElement('td', {
        className: 'checks-table__points',
        text: `${displayNumber(check.points)} / ${displayNumber(check.maxPoints)}`
      });
      const detail = createElement('td', {
        className: 'checks-table__detail',
        text: displayText(check.detail)
      });

      statusCell.append(statusPill);
      row.append(label, statusCell, points, detail);
      fragment.append(row);
    });

    this.elements.checksBody.replaceChildren(fragment);
    this.elements.checksSummary.textContent = checks.length
      ? `${checks.length} checks: ${passedChecks} passed, ${checks.length - passedChecks} need attention.`
      : 'No rule-by-rule checks were returned.';
  }

  focus() {
    this.elements.title.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
}

class AnalysisRequestError extends Error {
  constructor(message, invalidInput = false) {
    super(message);
    this.name = 'AnalysisRequestError';
    this.invalidInput = invalidInput;
  }
}

class AnalyzerApp {
  constructor(rootDocument) {
    this.form = getRequiredElement(rootDocument, '#analyzer-form');
    this.input = getRequiredElement(rootDocument, '#url-input');
    this.button = getRequiredElement(rootDocument, '#analyze-button');
    this.buttonLabel = getRequiredElement(this.button, '.button__label');
    this.panel = getRequiredElement(rootDocument, '#analyzer-panel');
    this.status = getRequiredElement(rootDocument, '#status');
    this.error = getRequiredElement(rootDocument, '#error-message');
    this.renderer = new ReportRenderer(getRequiredElement(rootDocument, '#report'));
    this.activeRequest = null;
    this.requestSequence = 0;
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  init() {
    this.form.addEventListener('submit', this.handleSubmit);
    this.input.addEventListener('input', () => {
      this.input.removeAttribute('aria-invalid');
      if (!this.error.hidden) this.hideError();
    });
    window.addEventListener('beforeunload', () => this.abortActiveRequest());
  }

  async handleSubmit(event) {
    event.preventDefault();

    const rawUrl = this.input.value.trim();
    const validationMessage = this.validateUrl(rawUrl);
    if (validationMessage) {
      this.abortActiveRequest();
      this.renderer.clear();
      this.setLoading(false);
      this.input.setAttribute('aria-invalid', 'true');
      this.showError(validationMessage, false);
      this.input.focus();
      return;
    }

    this.abortActiveRequest();
    const requestId = ++this.requestSequence;
    const controller = new AbortController();
    this.activeRequest = { id: requestId, controller };

    this.renderer.clear();
    this.hideError();
    this.input.removeAttribute('aria-invalid');
    this.setLoading(true);
    this.setStatus('Fetching the page and running SEO checks…');

    try {
      const payload = await this.fetchReport(rawUrl, controller.signal);
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
      window.requestAnimationFrame(() => {
        if (this.isCurrentRequest(requestId)) this.renderer.focus();
      });
    } catch (error) {
      if (error.name === 'AbortError' || !this.isCurrentRequest(requestId)) return;

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
      const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      const parsedUrl = new URL(candidate);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
        return 'Enter a valid HTTP or HTTPS page URL.';
      }
    } catch (_error) {
      return 'Enter a valid page URL, such as example.com/article.';
    }

    return '';
  }

  async fetchReport(rawUrl, signal) {
    const response = await fetch(`/api/analyze?url=${encodeURIComponent(rawUrl)}`, {
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
      window.requestAnimationFrame(() => this.error.focus());
    }
  }
}

new AnalyzerApp(document).init();
