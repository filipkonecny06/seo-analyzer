'use strict';

// Parses untrusted HTML once into the immutable evidence consumed by every scoring rule.

const cheerio = require('cheerio');

const ENGLISH_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'been',
  'before',
  'between',
  'both',
  'but',
  'can',
  'for',
  'from',
  'had',
  'has',
  'have',
  'here',
  'how',
  'into',
  'its',
  'just',
  'more',
  'most',
  'not',
  'now',
  'one',
  'only',
  'other',
  'our',
  'out',
  'over',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'too',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your'
]);

/**
 * Collapses HTML-style whitespace for stable metadata and text comparisons.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** @param {string} left @param {string} right */
function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** @param {string|Buffer} input @returns {import('cheerio').CheerioAPI} */
function loadHtml(input) {
  if (Buffer.isBuffer(input) && typeof cheerio.loadBuffer === 'function') {
    return cheerio.loadBuffer(input);
  }
  return cheerio.load(Buffer.isBuffer(input) ? input.toString('utf8') : String(input || ''));
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} attributeName
 * @param {string} expectedValue
 */
function findMetaValues($, attributeName, expectedValue) {
  /** @type {string[]} */
  const values = [];
  $('meta').each((_index, element) => {
    const key = String($(element).attr(attributeName) || '').toLowerCase();
    if (key === expectedValue) {
      const content = normalizeWhitespace($(element).attr('content'));
      if (content) values.push(content);
    }
  });
  return values;
}

/** @param {string|string[]|undefined} value */
function normalizeHeaderValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeWhitespace).filter(Boolean);
}

/** @param {import('cheerio').CheerioAPI} $ @param {string} pageUrl */
function findCanonical($, pageUrl) {
  let raw = '';
  $('link').each((_index, element) => {
    if (raw) return;
    const rel = String($(element).attr('rel') || '')
      .toLowerCase()
      .split(/\s+/u);
    if (rel.includes('canonical')) raw = normalizeWhitespace($(element).attr('href'));
  });

  if (!raw) return { raw: '', resolved: '', valid: false };
  try {
    const resolved = new URL(raw, pageUrl);
    const valid = resolved.protocol === 'http:' || resolved.protocol === 'https:';
    return { raw, resolved: valid ? resolved.href : '', valid };
  } catch (_error) {
    return { raw, resolved: '', valid: false };
  }
}

/** @param {unknown} value @param {Set<string>} [types] */
function collectStructuredDataTypes(value, types = new Set()) {
  // JSON-LD entities may be nested or stored in @graph, so inspect the complete object tree.
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStructuredDataTypes(entry, types));
    return types;
  }
  if (!value || typeof value !== 'object') return types;

  const record = /** @type {Record<string, unknown>} */ (value);
  const rawType = record['@type'];
  /** @param {unknown} type */
  const addType = (type) => {
    if (typeof type === 'string' && type.trim()) types.add(type.trim());
  };
  if (Array.isArray(rawType)) rawType.forEach(addType);
  else addType(rawType);

  Object.entries(record).forEach(([key, nestedValue]) => {
    if (key !== '@type' && key !== '@context') {
      collectStructuredDataTypes(nestedValue, types);
    }
  });
  return types;
}

/** @param {import('cheerio').CheerioAPI} $ */
function extractStructuredData($) {
  /** @type {import('../contracts').StructuredDataEvidence} */
  const result = { total: 0, parseable: 0, typed: 0, untyped: 0, invalid: 0, types: [] };
  const types = new Set();

  $('script').each((_index, element) => {
    const type = String($(element).attr('type') || '')
      .trim()
      .toLowerCase();
    if (type !== 'application/ld+json') return;

    result.total += 1;
    try {
      const value = JSON.parse($(element).text());
      if (value === null || typeof value !== 'object') throw new TypeError('Expected an object.');
      result.parseable += 1;
      const blockTypes = collectStructuredDataTypes(value);
      if (blockTypes.size) {
        result.typed += 1;
        blockTypes.forEach((structuredDataType) => types.add(structuredDataType));
      } else {
        result.untyped += 1;
      }
    } catch (_error) {
      result.invalid += 1;
    }
  });

  result.types = [...types].sort(compareText);
  return result;
}

/**
 * Converts visible text into Unicode-aware word tokens.
 * NFKC normalization makes compatibility forms comparable without restricting non-Latin scripts.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []
  );
}

/**
 * Returns the ten most frequent meaningful terms with deterministic alphabetical tie-breaking.
 * Short CJK and Hangul tokens are retained because length heuristics designed for Latin words would
 * otherwise remove useful terms from those writing systems.
 *
 * @param {string[]} tokens
 * @returns {Array<{term: string, count: number}>}
 */
function extractTopKeywords(tokens) {
  const frequency = new Map();
  for (const token of tokens) {
    const supportsShortKeyword =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token);
    if ([...token].length < (supportsShortKeyword ? 2 : 3) || ENGLISH_STOP_WORDS.has(token))
      continue;
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }
  return [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, 10)
    .map(([term, count]) => ({ term, count }));
}

/** @param {import('cheerio').CheerioAPI} $ */
function extractVisibleText($) {
  // Exclude script, style, and template containers from the primary body-text word count.
  if ($('body').length) {
    const body = $('body').clone();
    body.find('script, style, noscript, template, svg').remove();
    return normalizeWhitespace(body.text());
  }
  const document = $.root().clone();
  document.find('script, style, noscript, template, svg').remove();
  return normalizeWhitespace(document.text());
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(/** @type {Record<string, unknown>} */ (value)).forEach(deepFreeze);
  return /** @type {T} */ (Object.freeze(value));
}

/**
 * Immutable, presentation-independent representation of the SEO signals in one HTML document.
 * Construction performs parsing only; it has no network, database, or DOM side effects.
 */
class PageSnapshot {
  /**
   * @param {string} pageUrl
   * @param {string|Buffer} html
   * @param {{responseHeaders?: Record<string, string|string[]>}} [options]
   */
  constructor(pageUrl, html, options = {}) {
    this.pageUrl = new URL(pageUrl).href;
    const $ = loadHtml(html);

    const title = normalizeWhitespace($('title').first().text());
    const descriptions = findMetaValues($, 'name', 'description');
    const robotsValues = findMetaValues($, 'name', 'robots');
    const googlebotValues = findMetaValues($, 'name', 'googlebot');
    const viewportValues = findMetaValues($, 'name', 'viewport');
    const canonical = findCanonical($, this.pageUrl);
    const xRobotsTags = normalizeHeaderValues(options.responseHeaders?.['x-robots-tag']);

    /** @type {import('../contracts').HeadingCounts} */
    const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    /** @type {number[]} */
    const headingLevels = [];
    /** @type {string[]} */
    const h1Texts = [];
    $('h1, h2, h3, h4, h5, h6').each((_index, element) => {
      const level = Number(element.tagName.slice(1));
      const headingKey = /** @type {keyof import('../contracts').HeadingCounts} */ (`h${level}`);
      headingCounts[headingKey] += 1;
      headingLevels.push(level);
      if (level === 1) h1Texts.push(normalizeWhitespace($(element).text()));
    });
    const skipsHeadingLevel = headingLevels.some(
      (level, index) => index > 0 && level - headingLevels[index - 1] > 1
    );

    const images = { total: 0, withAlt: 0, emptyAlt: 0, missingAlt: 0 };
    $('img').each((_index, element) => {
      images.total += 1;
      const alt = $(element).attr('alt');
      if (alt === undefined) images.missingAlt += 1;
      else if (normalizeWhitespace(alt)) images.withAlt += 1;
      else images.emptyAlt += 1;
    });

    const parsedPageUrl = new URL(this.pageUrl);
    const links = { total: 0, internal: 0, external: 0 };
    $('a[href]').each((_index, element) => {
      const href = normalizeWhitespace($(element).attr('href'));
      if (!href || href.startsWith('#') || /^(?:mailto|tel|javascript|data):/i.test(href)) return;
      try {
        const target = new URL(href, this.pageUrl);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
        links.total += 1;
        if (target.hostname === parsedPageUrl.hostname) links.internal += 1;
        else links.external += 1;
      } catch (_error) {
        // Malformed links do not make the source document unanalyzable.
      }
    });

    const visibleText = extractVisibleText($);
    const tokens = tokenize(visibleText);
    const structuredData = extractStructuredData($);

    /** @type {import('../contracts').AnalysisMetadata} */
    this.metadata = deepFreeze({
      title,
      titleLength: [...title].length,
      description: descriptions[0] || '',
      descriptionLength: [...(descriptions[0] || '')].length,
      canonical: canonical.resolved || canonical.raw,
      canonicalRaw: canonical.raw,
      canonicalValid: canonical.valid,
      robots: robotsValues.join(', '),
      googlebot: googlebotValues.join(', '),
      xRobotsTag: xRobotsTags.join(', '),
      xRobotsTags,
      viewport: viewportValues[0] || '',
      lang: normalizeWhitespace($('html').first().attr('lang')),
      og: {
        title: findMetaValues($, 'property', 'og:title')[0] || '',
        description: findMetaValues($, 'property', 'og:description')[0] || '',
        image: findMetaValues($, 'property', 'og:image')[0] || ''
      }
    });
    /** @type {import('../contracts').AnalysisContent} */
    this.content = deepFreeze({
      words: { count: tokens.length, topKeywords: extractTopKeywords(tokens) },
      headings: { counts: headingCounts, h1Texts, skipsHeadingLevel },
      images,
      links,
      structuredData,
      structuredDataCount: structuredData.total
    });

    // Rules can safely share this object because no evaluation is allowed to alter later evidence.
    deepFreeze(this);
  }
}

module.exports = {
  PageSnapshot,
  extractTopKeywords,
  normalizeWhitespace,
  tokenize
};
