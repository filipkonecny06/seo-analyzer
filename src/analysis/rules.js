'use strict';

function result(rule, options) {
  const points = Math.max(0, Math.min(rule.maxPoints, Math.round(options.points)));
  return {
    id: rule.id,
    label: rule.label,
    maxPoints: rule.maxPoints,
    points,
    status: options.status,
    detail: options.detail,
    ...(options.recommendation ? { recommendation: options.recommendation } : {})
  };
}

class AnalysisRule {
  constructor({ id, label, maxPoints }) {
    this.id = id;
    this.label = label;
    this.maxPoints = maxPoints;
  }

  evaluate() {
    throw new Error(`${this.constructor.name} must implement evaluate().`);
  }
}

class TitleRule extends AnalysisRule {
  constructor() {
    super({ id: 'title', label: 'Title tag', maxPoints: 15 });
  }

  evaluate(snapshot) {
    const length = snapshot.metadata.titleLength;
    if (!length) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'No title tag was found.',
        recommendation: 'Add a concise, unique title that describes the page intent.'
      });
    }
    if (length >= 30 && length <= 60) {
      return result(this, {
        points: 15,
        status: 'pass',
        detail: `The title is ${length} characters long.`
      });
    }
    return result(this, {
      points: length >= 20 && length <= 70 ? 9 : 5,
      status: 'warn',
      detail: `The title is ${length} characters long.`,
      recommendation:
        'Review the title for clarity and likely search-result truncation (roughly 30–60 characters).'
    });
  }
}

class MetaDescriptionRule extends AnalysisRule {
  constructor() {
    super({ id: 'description', label: 'Meta description', maxPoints: 15 });
  }

  evaluate(snapshot) {
    const length = snapshot.metadata.descriptionLength;
    if (!length) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'No meta description was found.',
        recommendation: 'Add a useful, page-specific meta description.'
      });
    }
    if (length >= 110 && length <= 160) {
      return result(this, {
        points: 15,
        status: 'pass',
        detail: `The description is ${length} characters long.`
      });
    }
    return result(this, {
      points: length >= 70 && length <= 180 ? 9 : 5,
      status: 'warn',
      detail: `The description is ${length} characters long.`,
      recommendation:
        'Refine the description for relevance and likely snippet truncation (roughly 110–160 characters).'
    });
  }
}

class HeadingRule extends AnalysisRule {
  constructor() {
    super({ id: 'headings', label: 'Heading structure', maxPoints: 10 });
  }

  evaluate(snapshot) {
    const h1Count = snapshot.content.headings.counts.h1;
    const skips = snapshot.content.headings.skipsHeadingLevel;
    if (!h1Count) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'No H1 heading was found.',
        recommendation:
          'Add a clear primary heading and organize subheadings in a logical hierarchy.'
      });
    }
    if (h1Count === 1 && !skips) {
      return result(this, {
        points: 10,
        status: 'pass',
        detail: 'One H1 and a sequential heading structure were detected.'
      });
    }
    const concerns = [];
    if (h1Count > 1) concerns.push(`${h1Count} H1 headings`);
    if (skips) concerns.push('skipped heading levels');
    return result(this, {
      points: h1Count > 1 && skips ? 5 : 7,
      status: 'warn',
      detail: `Detected ${concerns.join(' and ')}.`,
      recommendation:
        'Review the heading outline so the main topic and section hierarchy are unambiguous.'
    });
  }
}

class ImageAltRule extends AnalysisRule {
  constructor() {
    super({ id: 'images', label: 'Image alternatives', maxPoints: 10 });
  }

  evaluate(snapshot) {
    const images = snapshot.content.images;
    if (!images.total) {
      return result(this, {
        points: 10,
        status: 'pass',
        detail: 'No images require alternative-text review.'
      });
    }
    if (!images.missingAlt) {
      return result(this, {
        points: 10,
        status: 'pass',
        detail: `All ${images.total} images declare alt attributes; ${images.emptyAlt} use empty alt text for decorative treatment.`
      });
    }
    const coverage = (images.total - images.missingAlt) / images.total;
    return result(this, {
      points: coverage * this.maxPoints,
      status: coverage >= 0.8 ? 'warn' : 'fail',
      detail: `${images.missingAlt} of ${images.total} images omit the alt attribute.`,
      recommendation:
        'Add meaningful alt text to informative images and alt="" to images that are purely decorative.'
    });
  }
}

class CanonicalRule extends AnalysisRule {
  constructor() {
    super({ id: 'canonical', label: 'Canonical URL', maxPoints: 10 });
  }

  evaluate(snapshot) {
    if (!snapshot.metadata.canonicalRaw) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'No canonical link was found.',
        recommendation: 'Declare the preferred HTTP(S) URL with a canonical link element.'
      });
    }
    if (!snapshot.metadata.canonicalValid) {
      return result(this, {
        points: 3,
        status: 'warn',
        detail: 'A canonical link is present but does not resolve to a valid HTTP(S) URL.',
        recommendation: 'Correct the canonical href so it resolves to the intended public page.'
      });
    }
    return result(this, {
      points: 10,
      status: 'pass',
      detail: `Canonical target: ${snapshot.metadata.canonical}`
    });
  }
}

function parseRobotsDirectives(snapshot) {
  const source = `${snapshot.metadata.robots},${snapshot.metadata.xRobotsTag}`.toLowerCase();
  const directives = new Set(source.match(/[a-z][a-z0-9_-]*/gu) || []);
  if (directives.has('none')) {
    directives.add('noindex');
    directives.add('nofollow');
  }
  return directives;
}

class RobotsRule extends AnalysisRule {
  constructor() {
    super({ id: 'robots', label: 'Indexing directives', maxPoints: 10 });
  }

  evaluate(snapshot) {
    const directives = parseRobotsDirectives(snapshot);
    if (directives.has('noindex')) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'A noindex directive is present in page metadata or HTTP headers.',
        recommendation: 'Remove noindex if this page is intended to appear in search results.'
      });
    }
    if (directives.has('nofollow')) {
      return result(this, {
        points: 6,
        status: 'warn',
        detail: 'A nofollow directive is present.',
        recommendation: 'Confirm that blocking link discovery is intentional for this page.'
      });
    }
    return result(this, {
      points: 10,
      status: 'pass',
      detail: directives.size
        ? 'No restrictive indexing directive was detected.'
        : 'Default index and follow behavior applies.'
    });
  }
}

class ContentDepthRule extends AnalysisRule {
  constructor() {
    super({ id: 'content', label: 'Content depth', maxPoints: 10 });
  }

  evaluate(snapshot) {
    const count = snapshot.content.words.count;
    if (count >= 300) {
      return result(this, {
        points: 10,
        status: 'pass',
        detail: `Approximately ${count} visible words were detected.`
      });
    }
    if (count >= 150) {
      return result(this, {
        points: 6,
        status: 'warn',
        detail: `Approximately ${count} visible words were detected.`,
        recommendation:
          'Confirm that the page covers its search intent with sufficient useful detail.'
      });
    }
    return result(this, {
      points: 2,
      status: 'fail',
      detail: `Approximately ${count} visible words were detected.`,
      recommendation:
        'Strengthen thin content where additional detail would genuinely help visitors.'
    });
  }
}

class ViewportRule extends AnalysisRule {
  constructor() {
    super({ id: 'viewport', label: 'Mobile viewport', maxPoints: 5 });
  }

  evaluate(snapshot) {
    const viewport = snapshot.metadata.viewport.toLowerCase();
    if (viewport.includes('width=device-width')) {
      return result(this, {
        points: 5,
        status: 'pass',
        detail: 'A device-width viewport is configured.'
      });
    }
    if (viewport) {
      return result(this, {
        points: 2,
        status: 'warn',
        detail: `Viewport content is “${snapshot.metadata.viewport}”.`,
        recommendation: 'Use width=device-width so the layout follows the device viewport.'
      });
    }
    return result(this, {
      points: 0,
      status: 'fail',
      detail: 'No viewport meta tag was found.',
      recommendation: 'Add a responsive viewport meta tag.'
    });
  }
}

class LanguageRule extends AnalysisRule {
  constructor() {
    super({ id: 'lang', label: 'Document language', maxPoints: 5 });
  }

  evaluate(snapshot) {
    const language = snapshot.metadata.lang;
    if (!language) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: 'The html element has no lang attribute.',
        recommendation: 'Declare the page language with a valid BCP 47 language tag.'
      });
    }
    const plausibleTag = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language);
    return result(
      this,
      plausibleTag
        ? { points: 5, status: 'pass', detail: `Document language: ${language}.` }
        : {
            points: 2,
            status: 'warn',
            detail: `“${language}” does not resemble a valid BCP 47 language tag.`,
            recommendation: 'Correct the html lang value, for example en or en-GB.'
          }
    );
  }
}

class OpenGraphRule extends AnalysisRule {
  constructor() {
    super({ id: 'open-graph', label: 'Open Graph metadata', maxPoints: 5 });
  }

  evaluate(snapshot) {
    const present = Object.values(snapshot.metadata.og).filter(Boolean).length;
    if (present === 3) {
      return result(this, {
        points: 5,
        status: 'pass',
        detail: 'Open Graph title, description, and image are present.'
      });
    }
    return result(this, {
      points: present ? Math.max(1, Math.round((present / 3) * 5)) : 0,
      status: present >= 2 ? 'warn' : 'fail',
      detail: `${present} of 3 baseline Open Graph fields are present.`,
      recommendation:
        'Provide og:title, og:description, and og:image for dependable social previews.'
    });
  }
}

class StructuredDataRule extends AnalysisRule {
  constructor() {
    super({ id: 'structured-data', label: 'Structured data', maxPoints: 5 });
  }

  evaluate(snapshot) {
    const data = snapshot.content.structuredData;
    if (!data.total) {
      return result(this, {
        points: 0,
        status: 'warn',
        detail: 'No JSON-LD blocks were found.',
        recommendation:
          'Add relevant schema.org JSON-LD only when it accurately describes visible content.'
      });
    }
    if (!data.valid) {
      return result(this, {
        points: 0,
        status: 'fail',
        detail: `All ${data.total} JSON-LD blocks contain invalid JSON.`,
        recommendation: 'Fix invalid JSON-LD and validate it with a structured-data testing tool.'
      });
    }
    if (data.invalid) {
      return result(this, {
        points: 3,
        status: 'warn',
        detail: `${data.valid} valid and ${data.invalid} invalid JSON-LD blocks were found.`,
        recommendation: 'Fix or remove malformed JSON-LD blocks.'
      });
    }
    return result(this, {
      points: 5,
      status: 'pass',
      detail: `${data.valid} valid JSON-LD block${data.valid === 1 ? '' : 's'} found${data.types.length ? ` (${data.types.join(', ')})` : ''}.`
    });
  }
}

const DEFAULT_RULES = Object.freeze([
  new TitleRule(),
  new MetaDescriptionRule(),
  new HeadingRule(),
  new ImageAltRule(),
  new CanonicalRule(),
  new RobotsRule(),
  new ContentDepthRule(),
  new ViewportRule(),
  new LanguageRule(),
  new OpenGraphRule(),
  new StructuredDataRule()
]);

module.exports = {
  AnalysisRule,
  CanonicalRule,
  ContentDepthRule,
  DEFAULT_RULES,
  HeadingRule,
  ImageAltRule,
  LanguageRule,
  MetaDescriptionRule,
  OpenGraphRule,
  RobotsRule,
  StructuredDataRule,
  TitleRule,
  ViewportRule,
  parseRobotsDirectives
};
