// Shared browser boundary helpers normalize API data and create DOM content safely.

/** Returns a required descendant or fails immediately when the static document contract changes. */
export function getRequiredElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Required UI element is missing: ${selector}`);
  }
  return element;
}

/** Returns whether a value is a non-null, non-array object. */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Narrows unknown input to a record-shaped value with an empty fallback. */
export function asRecord(value) {
  return isRecord(value) ? value : {};
}

/** Narrows unknown input to an array with an empty fallback. */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Distinguishes displayable zero/false values from missing values. */
export function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

/** Formats an unknown scalar for text-only presentation. */
export function displayText(value, fallback = 'Not available') {
  return hasValue(value) ? String(value) : fallback;
}

/** Formats finite numeric input while preserving a consistent missing-value fallback. */
export function displayNumber(value, suffix = '', formatter = new Intl.NumberFormat()) {
  if (!hasValue(value)) {
    return 'Not available';
  }

  const number = Number(value);
  return Number.isFinite(number) ? `${formatter.format(number)}${suffix}` : 'Not available';
}

/** Clamps untrusted report scores to the visual dial's supported 0-100 range. */
export function clampScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

/** Maps a normalized score to the design system's semantic tone. */
export function getScoreTone(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warning';
  return 'critical';
}

/** Returns guidance calibrated to the same thresholds as the score presentation. */
export function getScoreMessage(score) {
  if (score >= 90) {
    return 'Most configured checks passed. Review the evidence before making changes.';
  }
  if (score >= 80) return 'A few configured checks need review.';
  if (score >= 60) return 'Several configured checks need review.';
  return 'Many configured checks need review. Start with the highest-weight findings.';
}

/** Restricts a server-provided status to known CSS modifier names. */
export function normalizeCheckStatus(value) {
  const status = String(value || '').toLowerCase();
  return ['pass', 'warn', 'fail'].includes(status) ? status : 'unknown';
}

/** Returns the human-readable label for a normalized check status. */
export function getStatusLabel(status) {
  return {
    pass: 'Passed',
    warn: 'Review',
    fail: 'Failed',
    unknown: 'Unknown'
  }[status];
}

/** Returns an HTTP(S) URL safe for an anchor href, or null for every other scheme/value. */
export function getSafeHttpUrl(value, URLConstructor = URL) {
  try {
    const parsedUrl = new URLConstructor(String(value));
    return ['http:', 'https:'].includes(parsedUrl.protocol) ? parsedUrl.href : null;
  } catch (_error) {
    return null;
  }
}

/** Creates report nodes through DOM APIs so page-derived values are never parsed as HTML. */
export class ElementFactory {
  constructor(document) {
    this.document = document;
  }

  /**
   * Creates an element from a small set of caller-selected presentation options.
   * Text uses textContent and attributes are assigned as values, not interpolated markup.
   */
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

  /** Returns a fragment for batching DOM insertion. */
  fragment() {
    return this.document.createDocumentFragment();
  }
}
