const { URL } = require('url');

const STOP_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'between',
  'both',
  'but',
  'by',
  'can',
  'do',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'more',
  'most',
  'my',
  'no',
  'not',
  'now',
  'of',
  'on',
  'one',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'she',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'too',
  'up',
  'us',
  'very',
  'was',
  'we',
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

const ENTITY_MAP = {
  '&amp;': '&',
  '&apos;': "'",
  '&#39;': "'",
  '&gt;': '>',
  '&lt;': '<',
  '&nbsp;': ' ',
  '&quot;': '"'
};

function decodeEntities(value) {
  return String(value || '').replace(/&(?:amp|apos|#39|gt|lt|nbsp|quot);/gi, (match) => {
    const key = match.toLowerCase();
    return ENTITY_MAP[key] || match;
  });
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function parseTagAttributes(tagText) {
  const attrs = {};
  const attrRegex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match = attrRegex.exec(tagText);
  while (match) {
    const key = String(match[1] || '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (key) {
      attrs[key] = value;
    }
    match = attrRegex.exec(tagText);
  }
  return attrs;
}

function findMetaContent(html, matcher) {
  const metaRegex = /<meta\b[^>]*>/gi;
  const matches = html.match(metaRegex) || [];
  for (const rawTag of matches) {
    const attrs = parseTagAttributes(rawTag);
    if (matcher(attrs)) {
      return normalizeWhitespace(decodeEntities(attrs.content || ''));
    }
  }
  return '';
}

function findCanonicalHref(html) {
  const linkRegex = /<link\b[^>]*>/gi;
  const matches = html.match(linkRegex) || [];
  for (const rawTag of matches) {
    const attrs = parseTagAttributes(rawTag);
    const rel = String(attrs.rel || '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) {
      return normalizeWhitespace(attrs.href || '');
    }
  }
  return '';
}

function extractText(html) {
  const withoutNonContent = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  return normalizeWhitespace(decodeEntities(stripTags(withoutNonContent)));
}

function extractTopKeywords(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || [];
  const freq = new Map();

  for (const token of tokens) {
    if (token.length < 3) {
      continue;
    }
    if (STOP_WORDS.has(token)) {
      continue;
    }
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([term, count]) => ({ term, count }));
}

function toGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw new Error('URL cannot be empty');
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(candidate);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported');
  }

  return parsed.toString();
}

function analyzeHtml(pageUrl, html) {
  const titleMatch = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = normalizeWhitespace(decodeEntities(stripTags(titleMatch ? titleMatch[1] : '')));

  const description = findMetaContent(html, (attrs) => String(attrs.name || '').toLowerCase() === 'description');
  const robots = findMetaContent(html, (attrs) => String(attrs.name || '').toLowerCase() === 'robots');
  const viewport = findMetaContent(html, (attrs) => String(attrs.name || '').toLowerCase() === 'viewport');

  const ogTitle = findMetaContent(html, (attrs) => String(attrs.property || '').toLowerCase() === 'og:title');
  const ogDescription = findMetaContent(
    html,
    (attrs) => String(attrs.property || '').toLowerCase() === 'og:description'
  );
  const ogImage = findMetaContent(html, (attrs) => String(attrs.property || '').toLowerCase() === 'og:image');

  const canonical = findCanonicalHref(html);

  const htmlTag = String(html || '').match(/<html\b[^>]*>/i);
  const lang = htmlTag ? parseTagAttributes(htmlTag[0]).lang || '' : '';

  const headingMatches = [...String(html || '').matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const h1Texts = [];
  const headingLevels = [];

  for (const match of headingMatches) {
    const level = Number(match[1]);
    const key = `h${level}`;
    headingCounts[key] += 1;
    headingLevels.push(level);

    if (level === 1) {
      h1Texts.push(normalizeWhitespace(decodeEntities(stripTags(match[2]))));
    }
  }

  let headingSkipsLevel = false;
  for (let index = 1; index < headingLevels.length; index += 1) {
    if (headingLevels[index] - headingLevels[index - 1] > 1) {
      headingSkipsLevel = true;
      break;
    }
  }

  const imageTags = [...String(html || '').matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  let imagesWithAlt = 0;
  let imagesMissingAlt = 0;

  for (const imageTag of imageTags) {
    const attrs = parseTagAttributes(imageTag);
    const alt = attrs.alt;
    if (typeof alt === 'string' && alt.trim().length > 0) {
      imagesWithAlt += 1;
    } else {
      imagesMissingAlt += 1;
    }
  }

  const parsedUrl = new URL(pageUrl);
  const linkTags = [...String(html || '').matchAll(/<a\b[^>]*>/gi)].map((match) => match[0]);
  let internalLinks = 0;
  let externalLinks = 0;

  for (const linkTag of linkTags) {
    const attrs = parseTagAttributes(linkTag);
    const href = normalizeWhitespace(attrs.href || '');
    if (!href || href.startsWith('#')) {
      continue;
    }
    if (/^(mailto:|tel:|javascript:)/i.test(href)) {
      continue;
    }

    try {
      const target = new URL(href, pageUrl);
      if (target.host === parsedUrl.host) {
        internalLinks += 1;
      } else {
        externalLinks += 1;
      }
    } catch (_error) {
      // Ignore malformed links.
    }
  }

  const text = extractText(html);
  const words = text.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/gi) || [];
  const wordCount = words.length;
  const topKeywords = extractTopKeywords(text);

  const structuredDataCount = (String(html || '').match(
    /<script\b[^>]*type\s*=\s*['"]application\/ld\+json['"][^>]*>/gi
  ) || []).length;

  const checks = [];
  const recommendations = [];

  function addCheck({ id, label, maxPoints, points, status, detail, recommendation }) {
    checks.push({ id, label, maxPoints, points, status, detail });
    if (recommendation) {
      recommendations.push(recommendation);
    }
  }
  const titleLength = title.length;
  if (!titleLength) {
    addCheck({
      id: 'title',
      label: 'Title Tag',
      maxPoints: 15,
      points: 0,
      status: 'fail',
      detail: 'No title tag found.',
      recommendation: 'Add a unique <title> tag between 50 and 60 characters.'
    });
  } else if (titleLength >= 50 && titleLength <= 60) {
    addCheck({
      id: 'title',
      label: 'Title Tag',
      maxPoints: 15,
      points: 15,
      status: 'pass',
      detail: `Title length is ${titleLength} characters.`
    });
  } else {
    addCheck({
      id: 'title',
      label: 'Title Tag',
      maxPoints: 15,
      points: titleLength >= 35 && titleLength <= 70 ? 8 : 4,
      status: 'warn',
      detail: `Title length is ${titleLength} characters.`,
      recommendation: 'Keep your title between 50 and 60 characters for better SERP display.'
    });
  }

  const descriptionLength = description.length;
  if (!descriptionLength) {
    addCheck({
      id: 'description',
      label: 'Meta Description',
      maxPoints: 15,
      points: 0,
      status: 'fail',
      detail: 'No meta description found.',
      recommendation: 'Add a compelling meta description between 120 and 160 characters.'
    });
  } else if (descriptionLength >= 120 && descriptionLength <= 160) {
    addCheck({
      id: 'description',
      label: 'Meta Description',
      maxPoints: 15,
      points: 15,
      status: 'pass',
      detail: `Meta description length is ${descriptionLength} characters.`
    });
  } else {
    addCheck({
      id: 'description',
      label: 'Meta Description',
      maxPoints: 15,
      points: descriptionLength >= 80 && descriptionLength <= 200 ? 8 : 4,
      status: 'warn',
      detail: `Meta description length is ${descriptionLength} characters.`,
      recommendation: 'Adjust your meta description to 120-160 characters.'
    });
  }

  const h1Count = headingCounts.h1;
  if (h1Count === 1) {
    addCheck({
      id: 'h1',
      label: 'H1 Usage',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: 'Exactly one H1 heading found.'
    });
  } else {
    addCheck({
      id: 'h1',
      label: 'H1 Usage',
      maxPoints: 10,
      points: h1Count === 2 ? 6 : 0,
      status: h1Count === 2 ? 'warn' : 'fail',
      detail: `Found ${h1Count} H1 headings.`,
      recommendation: 'Use exactly one clear H1 heading that matches the page intent.'
    });
  }

  if (headingSkipsLevel) {
    recommendations.push('Avoid skipping heading levels (for example, H2 directly to H4) to improve document structure.');
  }

  const totalImages = imageTags.length;
  const altCoverage = totalImages > 0 ? imagesWithAlt / totalImages : 1;
  if (totalImages === 0) {
    addCheck({
      id: 'images',
      label: 'Image Alt Attributes',
      maxPoints: 10,
      points: 8,
      status: 'warn',
      detail: 'No images were found on the page.'
    });
  } else if (altCoverage === 1) {
    addCheck({
      id: 'images',
      label: 'Image Alt Attributes',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: `All ${totalImages} images include non-empty alt text.`
    });
  } else {
    const points = altCoverage >= 0.8 ? 7 : altCoverage >= 0.5 ? 4 : 1;
    addCheck({
      id: 'images',
      label: 'Image Alt Attributes',
      maxPoints: 10,
      points,
      status: altCoverage >= 0.5 ? 'warn' : 'fail',
      detail: `${imagesMissingAlt} of ${totalImages} images are missing alt text.`,
      recommendation: 'Add descriptive alt attributes to important images.'
    });
  }

  if (canonical) {
    addCheck({
      id: 'canonical',
      label: 'Canonical URL',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: 'Canonical link tag is present.'
    });
  } else {
    addCheck({
      id: 'canonical',
      label: 'Canonical URL',
      maxPoints: 10,
      points: 0,
      status: 'fail',
      detail: 'No canonical link tag found.',
      recommendation: 'Add a canonical link element to prevent duplicate-content ambiguity.'
    });
  }

  const robotsDirectives = robots.toLowerCase();
  if (!robotsDirectives) {
    addCheck({
      id: 'robots',
      label: 'Robots Meta',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: 'No robots meta tag found. Default indexing behavior applies.'
    });
  } else if (robotsDirectives.includes('noindex')) {
    addCheck({
      id: 'robots',
      label: 'Robots Meta',
      maxPoints: 10,
      points: 0,
      status: 'fail',
      detail: `Robots directives are "${robots}".`,
      recommendation: 'Remove noindex if this page should appear in search results.'
    });
  } else if (robotsDirectives.includes('nofollow')) {
    addCheck({
      id: 'robots',
      label: 'Robots Meta',
      maxPoints: 10,
      points: 7,
      status: 'warn',
      detail: `Robots directives are "${robots}".`,
      recommendation: 'Review nofollow usage to ensure link equity can flow as intended.'
    });
  } else {
    addCheck({
      id: 'robots',
      label: 'Robots Meta',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: `Robots directives are "${robots}".`
    });
  }
  if (wordCount >= 300) {
    addCheck({
      id: 'content',
      label: 'Content Depth',
      maxPoints: 10,
      points: 10,
      status: 'pass',
      detail: `Detected approximately ${wordCount} words of visible content.`
    });
  } else if (wordCount >= 150) {
    addCheck({
      id: 'content',
      label: 'Content Depth',
      maxPoints: 10,
      points: 6,
      status: 'warn',
      detail: `Detected approximately ${wordCount} words of visible content.`,
      recommendation: 'Increase page copy depth to better cover the topic and search intent.'
    });
  } else {
    addCheck({
      id: 'content',
      label: 'Content Depth',
      maxPoints: 10,
      points: 2,
      status: 'fail',
      detail: `Detected approximately ${wordCount} words of visible content.`,
      recommendation: 'Add more useful content so the page can compete for relevant queries.'
    });
  }

  if (viewport) {
    addCheck({
      id: 'viewport',
      label: 'Mobile Viewport',
      maxPoints: 5,
      points: 5,
      status: 'pass',
      detail: 'Viewport meta tag is present.'
    });
  } else {
    addCheck({
      id: 'viewport',
      label: 'Mobile Viewport',
      maxPoints: 5,
      points: 0,
      status: 'fail',
      detail: 'No viewport meta tag found.',
      recommendation: 'Add a viewport meta tag for proper mobile rendering.'
    });
  }

  if (lang) {
    addCheck({
      id: 'lang',
      label: 'HTML Language',
      maxPoints: 5,
      points: 5,
      status: 'pass',
      detail: `HTML lang attribute is "${lang}".`
    });
  } else {
    addCheck({
      id: 'lang',
      label: 'HTML Language',
      maxPoints: 5,
      points: 0,
      status: 'warn',
      detail: 'HTML lang attribute is missing.',
      recommendation: 'Set a language on the <html> tag, for example lang="en".'
    });
  }

  const ogCount = [ogTitle, ogDescription].filter(Boolean).length;
  if (ogCount === 2) {
    addCheck({
      id: 'og',
      label: 'Open Graph Basics',
      maxPoints: 5,
      points: 5,
      status: 'pass',
      detail: 'Open Graph title and description are present.'
    });
  } else if (ogCount === 1) {
    addCheck({
      id: 'og',
      label: 'Open Graph Basics',
      maxPoints: 5,
      points: 3,
      status: 'warn',
      detail: 'Only one Open Graph field (title or description) is present.',
      recommendation: 'Add both og:title and og:description for better social previews.'
    });
  } else {
    addCheck({
      id: 'og',
      label: 'Open Graph Basics',
      maxPoints: 5,
      points: 0,
      status: 'fail',
      detail: 'No Open Graph title/description tags were found.',
      recommendation: 'Add og:title and og:description meta tags.'
    });
  }

  if (structuredDataCount > 0) {
    addCheck({
      id: 'schema',
      label: 'Structured Data',
      maxPoints: 5,
      points: 5,
      status: 'pass',
      detail: `Found ${structuredDataCount} JSON-LD script tag(s).`
    });
  } else {
    addCheck({
      id: 'schema',
      label: 'Structured Data',
      maxPoints: 5,
      points: 0,
      status: 'warn',
      detail: 'No JSON-LD structured data found.',
      recommendation: 'Add relevant schema.org JSON-LD markup where appropriate.'
    });
  }

  const score = checks.reduce((sum, check) => sum + check.points, 0);

  return {
    score,
    grade: toGrade(score),
    metadata: {
      title,
      titleLength,
      description,
      descriptionLength,
      canonical,
      robots,
      viewport,
      lang,
      og: {
        title: ogTitle,
        description: ogDescription,
        image: ogImage
      }
    },
    content: {
      words: {
        count: wordCount,
        topKeywords
      },
      headings: {
        counts: headingCounts,
        h1Texts,
        skipsHeadingLevel: headingSkipsLevel
      },
      images: {
        total: totalImages,
        withAlt: imagesWithAlt,
        missingAlt: imagesMissingAlt
      },
      links: {
        total: internalLinks + externalLinks,
        internal: internalLinks,
        external: externalLinks
      },
      structuredDataCount
    },
    checks,
    recommendations
  };
}

module.exports = {
  analyzeHtml,
  normalizeUrl
};
