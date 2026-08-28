'use strict';

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

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function loadHtml(input) {
  if (Buffer.isBuffer(input) && typeof cheerio.loadBuffer === 'function') {
    return cheerio.loadBuffer(input);
  }
  return cheerio.load(Buffer.isBuffer(input) ? input.toString('utf8') : String(input || ''));
}

function findMetaValues($, attributeName, expectedValue) {
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

function collectStructuredDataTypes(value, types = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStructuredDataTypes(entry, types));
    return types;
  }
  if (!value || typeof value !== 'object') return types;

  const rawType = value['@type'];
  if (Array.isArray(rawType)) rawType.forEach((type) => types.add(String(type)));
  else if (rawType) types.add(String(rawType));

  if (value['@graph']) collectStructuredDataTypes(value['@graph'], types);
  return types;
}

function extractStructuredData($) {
  const result = { total: 0, valid: 0, invalid: 0, types: [] };
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
      result.valid += 1;
      collectStructuredDataTypes(value, types);
    } catch (_error) {
      result.invalid += 1;
    }
  });

  result.types = [...types].sort((left, right) => left.localeCompare(right));
  return result;
}

function tokenize(text) {
  return (
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []
  );
}

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
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([term, count]) => ({ term, count }));
}

function extractVisibleText($) {
  const content = ($('body').length ? $('body') : $.root()).clone();
  content.find('script, style, noscript, template, svg').remove();
  return normalizeWhitespace(content.text());
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

class PageSnapshot {
  constructor(pageUrl, html, options = {}) {
    this.pageUrl = new URL(pageUrl).href;
    const $ = loadHtml(html);

    const title = normalizeWhitespace($('title').first().text());
    const descriptions = findMetaValues($, 'name', 'description');
    const robotsValues = findMetaValues($, 'name', 'robots');
    const viewportValues = findMetaValues($, 'name', 'viewport');
    const canonical = findCanonical($, this.pageUrl);
    const xRobotsTag = normalizeWhitespace(options.responseHeaders?.['x-robots-tag']);

    const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    const headingLevels = [];
    const h1Texts = [];
    $('h1, h2, h3, h4, h5, h6').each((_index, element) => {
      const level = Number(element.tagName.slice(1));
      headingCounts[`h${level}`] += 1;
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

    this.metadata = deepFreeze({
      title,
      titleLength: [...title].length,
      description: descriptions[0] || '',
      descriptionLength: [...(descriptions[0] || '')].length,
      canonical: canonical.resolved || canonical.raw,
      canonicalRaw: canonical.raw,
      canonicalValid: canonical.valid,
      robots: robotsValues.join(', '),
      xRobotsTag,
      viewport: viewportValues[0] || '',
      lang: normalizeWhitespace($('html').first().attr('lang')),
      og: {
        title: findMetaValues($, 'property', 'og:title')[0] || '',
        description: findMetaValues($, 'property', 'og:description')[0] || '',
        image: findMetaValues($, 'property', 'og:image')[0] || ''
      }
    });
    this.content = deepFreeze({
      words: { count: tokens.length, topKeywords: extractTopKeywords(tokens) },
      headings: { counts: headingCounts, h1Texts, skipsHeadingLevel },
      images,
      links,
      structuredData,
      structuredDataCount: structuredData.total
    });

    deepFreeze(this);
  }
}

module.exports = {
  PageSnapshot,
  extractTopKeywords,
  normalizeWhitespace,
  tokenize
};
