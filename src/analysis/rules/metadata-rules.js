'use strict';

const { AnalysisRule, createRuleResult } = require('./base-rule');
const { RULE_SCORE_RATIOS, RULE_THRESHOLDS, RULE_WEIGHTS } = require('./policy');

/** @typedef {import('../../contracts').PageSnapshotEvidence} PageSnapshot */

class TitleRule extends AnalysisRule {
  constructor() {
    super({ id: 'title', label: 'Title tag', maxPoints: RULE_WEIGHTS.title });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const length = snapshot.metadata.titleLength;
    const thresholds = RULE_THRESHOLDS.title;
    if (!length) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'No title tag was found.',
        recommendation: 'Add a concise, unique title that describes the page intent.'
      });
    }
    if (length >= thresholds.idealMin && length <= thresholds.idealMax) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: `The title is ${length} characters long.`
      });
    }
    const acceptable = length >= thresholds.acceptableMin && length <= thresholds.acceptableMax;
    return createRuleResult(this, {
      points:
        this.maxPoints *
        (acceptable ? RULE_SCORE_RATIOS.title.acceptable : RULE_SCORE_RATIOS.title.outsideRange),
      status: 'warn',
      detail: `The title is ${length} characters long.`,
      recommendation: `Review the title for clarity and likely search-result truncation (roughly ${thresholds.idealMin}–${thresholds.idealMax} characters).`
    });
  }
}

class MetaDescriptionRule extends AnalysisRule {
  constructor() {
    super({
      id: 'description',
      label: 'Meta description',
      maxPoints: RULE_WEIGHTS.description
    });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const length = snapshot.metadata.descriptionLength;
    const thresholds = RULE_THRESHOLDS.description;
    if (!length) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'No meta description was found.',
        recommendation: 'Add a useful, page-specific meta description.'
      });
    }
    if (length >= thresholds.idealMin && length <= thresholds.idealMax) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: `The description is ${length} characters long.`
      });
    }
    const acceptable = length >= thresholds.acceptableMin && length <= thresholds.acceptableMax;
    return createRuleResult(this, {
      points:
        this.maxPoints *
        (acceptable
          ? RULE_SCORE_RATIOS.description.acceptable
          : RULE_SCORE_RATIOS.description.outsideRange),
      status: 'warn',
      detail: `The description is ${length} characters long.`,
      recommendation: `Refine the description for relevance and likely snippet truncation (roughly ${thresholds.idealMin}–${thresholds.idealMax} characters).`
    });
  }
}

class CanonicalRule extends AnalysisRule {
  constructor() {
    super({ id: 'canonical', label: 'Canonical URL', maxPoints: RULE_WEIGHTS.canonical });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    if (!snapshot.metadata.canonicalRaw) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'No canonical link was found.',
        recommendation: 'Declare the preferred HTTP(S) URL with a canonical link element.'
      });
    }
    if (!snapshot.metadata.canonicalValid) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.canonical.invalid,
        status: 'warn',
        detail: 'A canonical link is present but does not resolve to a valid HTTP(S) URL.',
        recommendation: 'Correct the canonical href so it resolves to the intended public page.'
      });
    }
    return createRuleResult(this, {
      points: this.maxPoints,
      status: 'pass',
      detail: `Canonical target: ${snapshot.metadata.canonical}`
    });
  }
}

class ViewportRule extends AnalysisRule {
  constructor() {
    super({ id: 'viewport', label: 'Mobile viewport', maxPoints: RULE_WEIGHTS.viewport });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const viewport = snapshot.metadata.viewport.toLowerCase();
    if (viewport.includes('width=device-width')) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: 'A device-width viewport is configured.'
      });
    }
    if (viewport) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.viewport.incomplete,
        status: 'warn',
        detail: `Viewport content is “${snapshot.metadata.viewport}”.`,
        recommendation: 'Use width=device-width so the layout follows the device viewport.'
      });
    }
    return createRuleResult(this, {
      points: 0,
      status: 'fail',
      detail: 'No viewport meta tag was found.',
      recommendation: 'Add a responsive viewport meta tag.'
    });
  }
}

class LanguageRule extends AnalysisRule {
  constructor() {
    super({ id: 'lang', label: 'Document language', maxPoints: RULE_WEIGHTS.language });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const language = snapshot.metadata.lang;
    if (!language) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'The html element has no lang attribute.',
        recommendation: 'Declare the page language with a valid BCP 47 language tag.'
      });
    }
    const plausibleTag = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language);
    return createRuleResult(
      this,
      plausibleTag
        ? {
            points: this.maxPoints,
            status: 'pass',
            detail: `Document language: ${language}.`
          }
        : {
            points: this.maxPoints * RULE_SCORE_RATIOS.language.implausible,
            status: 'warn',
            detail: `“${language}” does not resemble a valid BCP 47 language tag.`,
            recommendation: 'Correct the html lang value, for example en or en-GB.'
          }
    );
  }
}

class OpenGraphRule extends AnalysisRule {
  constructor() {
    super({
      id: 'open-graph',
      label: 'Open Graph metadata',
      maxPoints: RULE_WEIGHTS.openGraph
    });
  }

  /** @param {PageSnapshot} snapshot */
  evaluate(snapshot) {
    const present = Object.values(snapshot.metadata.og).filter(Boolean).length;
    const required = RULE_THRESHOLDS.openGraph.baselineFields;
    if (present === required) {
      return createRuleResult(this, {
        points: this.maxPoints,
        status: 'pass',
        detail: 'Open Graph title, description, and image are present.'
      });
    }
    return createRuleResult(this, {
      points: present ? Math.max(1, Math.round((present / required) * this.maxPoints)) : 0,
      status: present >= required - 1 ? 'warn' : 'fail',
      detail: `${present} of ${required} baseline Open Graph fields are present.`,
      recommendation:
        'Provide og:title, og:description, and og:image for dependable social previews.'
    });
  }
}

module.exports = {
  CanonicalRule,
  LanguageRule,
  MetaDescriptionRule,
  OpenGraphRule,
  TitleRule,
  ViewportRule
};
