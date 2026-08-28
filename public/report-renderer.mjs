// Converts the server report into accessible DOM nodes without interpolating untrusted HTML.

import {
  ElementFactory,
  asArray,
  asRecord,
  clampScore,
  displayNumber,
  displayText,
  getRequiredElement,
  getSafeHttpUrl,
  getScoreMessage,
  getScoreTone,
  getStatusLabel,
  hasValue,
  isRecord,
  normalizeCheckStatus
} from './ui-utils.mjs';

/** Renders one analyzer response into the existing report shell. */
export class ReportRenderer {
  /**
   * @param {Element} root
   * @param {object} [options] DOM and localization collaborators used by tests.
   */
  constructor(root, options = {}) {
    this.root = root;
    this.document = options.document || root.ownerDocument;
    this.window = options.window || this.document.defaultView;
    this.elementFactory = options.elementFactory || new ElementFactory(this.document);
    this.numberFormatter =
      options.numberFormatter || new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    this.dateFormatter =
      options.dateFormatter ||
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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

  /** Restores the hidden report shell to its empty state. */
  clear() {
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.elements.analyzedUrl.textContent = '';
    this.elements.analyzedUrl.removeAttribute('href');
    this.elements.analyzedUrl.removeAttribute('aria-label');
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

  /**
   * Renders a defensively normalized response payload.
   * Missing or malformed optional fields become safe fallbacks rather than DOM exceptions.
   *
   * @param {object} payload
   */
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
      : `Completed ${this.dateFormatter.format(date)}`;
  }

  renderScore(rawScore, rawGrade) {
    const score = clampScore(rawScore);
    const formattedScore = this.numberFormatter.format(score);
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
      : ['The configured rules did not produce any recommendations for this page.'];
    const fragment = this.elementFactory.fragment();

    // ElementFactory assigns textContent, so page-derived recommendations cannot inject markup.
    items.forEach((recommendation) => {
      const item = this.elementFactory.create('li', {
        className: 'recommendation-list__item'
      });
      const copy = this.elementFactory.create('span', {
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
      ['Title length', displayNumber(metadata.titleLength, ' characters', this.numberFormatter)],
      [
        'Description',
        displayNumber(metadata.descriptionLength, ' characters', this.numberFormatter)
      ],
      ['Word count', displayNumber(words.count, '', this.numberFormatter)],
      ['H1 headings', displayNumber(headingCounts.h1, '', this.numberFormatter)],
      ['Images missing alt', displayNumber(images.missingAlt, '', this.numberFormatter)],
      ['Internal links', displayNumber(links.internal, '', this.numberFormatter)],
      ['External links', displayNumber(links.external, '', this.numberFormatter)],
      [
        'Structured data',
        displayNumber(content.structuredDataCount, ' blocks', this.numberFormatter)
      ],
      ['Page language', displayText(metadata.lang, 'Missing')]
    ];
    const fragment = this.elementFactory.fragment();

    metrics.forEach(([label, value]) => {
      const item = this.elementFactory.create('div', { className: 'metric' });
      const term = this.elementFactory.create('dt', {
        className: 'metric__label',
        text: label
      });
      const description = this.elementFactory.create('dd', {
        className: 'metric__value',
        text: value
      });
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
      const emptyState = this.elementFactory.create('p', {
        className: 'empty-state',
        text: 'No meaningful keyword pattern was detected on this page.'
      });
      this.elements.keywords.replaceChildren(emptyState);
      return;
    }

    const fragment = this.elementFactory.fragment();
    keywords.forEach((entry) => {
      const term = displayText(entry.term);
      const count = displayNumber(entry.count, '', this.numberFormatter);
      const chip = this.elementFactory.create('span', {
        className: 'keyword-chip',
        attributes: { 'aria-label': `${term}: ${count} occurrences` }
      });
      const termElement = this.elementFactory.create('span', {
        className: 'keyword-chip__term',
        text: term,
        attributes: { 'aria-hidden': 'true' }
      });
      const countElement = this.elementFactory.create('span', {
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
    const fragment = this.elementFactory.fragment();
    let passedChecks = 0;

    if (!checks.length) {
      const row = this.elementFactory.create('tr');
      const cell = this.elementFactory.create('td', {
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

      const row = this.elementFactory.create('tr');
      const label = this.elementFactory.create('th', {
        className: 'checks-table__label',
        text: displayText(check.label),
        attributes: { scope: 'row' }
      });
      const statusCell = this.elementFactory.create('td');
      const statusPill = this.elementFactory.create('span', {
        className: `status-pill status-pill--${status}`,
        text: getStatusLabel(status)
      });
      const points = this.elementFactory.create('td', {
        className: 'checks-table__points',
        text: `${displayNumber(check.points, '', this.numberFormatter)} / ${displayNumber(
          check.maxPoints,
          '',
          this.numberFormatter
        )}`
      });
      const detail = this.elementFactory.create('td', {
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

  /** Moves focus to the report and respects the user's reduced-motion preference while scrolling. */
  focus() {
    this.elements.title.focus({ preventScroll: true });
    const reduceMotion = this.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.root.scrollIntoView?.({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start'
    });
  }
}
