export function getRequiredElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Required UI element is missing: ${selector}`);
  }
  return element;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value) {
  return isRecord(value) ? value : {};
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

export function displayText(value, fallback = 'Not available') {
  return hasValue(value) ? String(value) : fallback;
}

export function displayNumber(value, suffix = '', formatter = new Intl.NumberFormat()) {
  if (!hasValue(value)) {
    return 'Not available';
  }

  const number = Number(value);
  return Number.isFinite(number) ? `${formatter.format(number)}${suffix}` : 'Not available';
}

export function clampScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

export function getScoreTone(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warning';
  return 'critical';
}

export function getScoreMessage(score) {
  if (score >= 90) {
    return 'Most configured checks passed. Review the evidence before making changes.';
  }
  if (score >= 80) return 'A few configured checks need review.';
  if (score >= 60) return 'Several configured checks need review.';
  return 'Many configured checks need review. Start with the highest-weight findings.';
}

export function normalizeCheckStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['pass', 'warn', 'fail'].includes(status) ? status : 'unknown';
}

export function getStatusLabel(status) {
  return {
    pass: 'Passed',
    warn: 'Review',
    fail: 'Failed',
    unknown: 'Unknown'
  }[status];
}

export function getSafeHttpUrl(value, URLConstructor = URL) {
  try {
    const parsedUrl = new URLConstructor(String(value));
    return ['http:', 'https:'].includes(parsedUrl.protocol) ? parsedUrl.href : null;
  } catch (_error) {
    return null;
  }
}

export class ElementFactory {
  constructor(document) {
    this.document = document;
  }

  create(tagName, options = {}) {
    const element = this.document.createElement(tagName);

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

  fragment() {
    return this.document.createDocumentFragment();
  }
}
