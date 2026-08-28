'use strict';

const { AnalysisRule, createRuleResult } = require('./base-rule');
const { RULE_SCORE_RATIOS, RULE_THRESHOLDS, RULE_WEIGHTS } = require('./policy');

/** @typedef {import('../../contracts').PageSnapshotEvidence} PageSnapshot */

class HeadingRule extends AnalysisRule {
  constructor() {
    super({ id: 'headings', label: 'Heading structure', maxPoints: RULE_WEIGHTS.headings });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const h1Count = snapshot.content.headings.counts.h1;
    const skips = snapshot.content.headings.skipsHeadingLevel;
    if (!h1Count) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'No H1 heading was found.',
        recommendation:
          'Add a clear primary heading and organize subheadings in a logical hierarchy.'
      });
    }
    if (h1Count === 1 && !skips) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: 'One H1 and a sequential heading structure were detected.'
      });
    }
    const concerns = [];
    if (h1Count > 1) concerns.push(`${h1Count} H1 headings`);
    if (skips) concerns.push('skipped heading levels');
    return createRuleResult(this, {
      points:
        this.maxPoints *
        (h1Count > 1 && skips
          ? RULE_SCORE_RATIOS.headings.multipleConcerns
          : RULE_SCORE_RATIOS.headings.oneConcern),
      status: 'warn',
      detail: `Detected ${concerns.join(' and ')}.`,
      recommendation:
        'Review the heading outline so the main topic and section hierarchy are unambiguous.'
    });
  }
}

class ImageAltRule extends AnalysisRule {
  constructor() {
    super({ id: 'images', label: 'Image alternatives', maxPoints: RULE_WEIGHTS.images });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const images = snapshot.content.images;
    if (!images.total) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: 'No images require alternative-text review.'
      });
    }
    if (!images.missingAlt) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: `All ${images.total} images declare alt attributes; ${images.emptyAlt} use empty alt text for decorative treatment.`
      });
    }
    const coverage = (images.total - images.missingAlt) / images.total;
    return createRuleResult(this, {
      points: coverage * this.maxPoints,
      status: coverage >= RULE_THRESHOLDS.imageAlt.warningCoverage ? 'warn' : 'fail',
      detail: `${images.missingAlt} of ${images.total} images omit the alt attribute.`,
      recommendation:
        'Add meaningful alt text to informative images and alt="" to images that are purely decorative.'
    });
  }
}

class ContentDepthRule extends AnalysisRule {
  constructor() {
    super({ id: 'content', label: 'Content depth', maxPoints: RULE_WEIGHTS.content });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const count = snapshot.content.words.count;
    if (count >= RULE_THRESHOLDS.contentDepth.sufficientWords) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: `Approximately ${count} visible words were detected.`
      });
    }
    if (count >= RULE_THRESHOLDS.contentDepth.moderateWords) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.contentDepth.moderate,
        status: 'warn',
        detail: `Approximately ${count} visible words were detected.`,
        recommendation:
          'Confirm that the page covers its search intent with sufficient useful detail.'
      });
    }
    return createRuleResult(this, {
      points: this.maxPoints * RULE_SCORE_RATIOS.contentDepth.thin,
      status: 'fail',
      detail: `Approximately ${count} visible words were detected.`,
      recommendation:
        'Strengthen thin content where additional detail would genuinely help visitors.'
    });
  }
}

class StructuredDataRule extends AnalysisRule {
  constructor() {
    super({
      id: 'structured-data',
      label: 'Structured data',
      maxPoints: RULE_WEIGHTS.structuredData
    });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const data = snapshot.content.structuredData;
    if (!data.total) {
      return createRuleResult(this, {
        points: 0,
        status: 'warn',
        detail: 'No JSON-LD blocks were found.',
        recommendation:
          'Add relevant schema.org JSON-LD only when it accurately describes visible content.'
      });
    }
    if (!data.parseable) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: `None of the ${data.total} JSON-LD blocks contains a JSON object or array.`,
        recommendation: 'Fix invalid JSON-LD and validate it with a structured-data testing tool.'
      });
    }
    if (!data.typed) {
      return createRuleResult(this, {
        points: 0,
        status: 'warn',
        detail: `${data.parseable} parseable JSON-LD block${data.parseable === 1 ? '' : 's'} found, but none declares a non-empty @type.`,
        recommendation:
          'Declare an accurate schema.org @type for structured data that describes visible content.'
      });
    }
    if (data.invalid) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.structuredData.invalid,
        status: 'warn',
        detail: `${data.typed} typed, ${data.untyped} untyped, and ${data.invalid} invalid JSON-LD blocks were found.`,
        recommendation: 'Fix or remove malformed JSON-LD blocks.'
      });
    }
    if (data.untyped) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.structuredData.untyped,
        status: 'warn',
        detail: `${data.typed} typed and ${data.untyped} untyped JSON-LD blocks were found.`,
        recommendation:
          'Add an accurate schema.org @type to each JSON-LD block or remove blocks that carry no structured-data entity.'
      });
    }
    return createRuleResult(this, {
      points: this.maxPoints,
      status: 'pass',
      detail: `${data.typed} parseable, typed JSON-LD block${data.typed === 1 ? '' : 's'} found (${data.types.join(', ')}).`
    });
  }
}

module.exports = {
  ContentDepthRule,
  HeadingRule,
  ImageAltRule,
  StructuredDataRule
};
