'use strict';

const RULE_WEIGHTS = Object.freeze({
  title: 15,
  description: 15,
  headings: 10,
  images: 10,
  canonical: 10,
  robots: 10,
  content: 10,
  viewport: 5,
  language: 5,
  openGraph: 5,
  structuredData: 5
});

const RULE_THRESHOLDS = Object.freeze({
  title: Object.freeze({ idealMin: 30, idealMax: 60, acceptableMin: 20, acceptableMax: 70 }),
  description: Object.freeze({
    idealMin: 110,
    idealMax: 160,
    acceptableMin: 70,
    acceptableMax: 180
  }),
  imageAlt: Object.freeze({ warningCoverage: 0.8 }),
  contentDepth: Object.freeze({ sufficientWords: 300, moderateWords: 150 }),
  openGraph: Object.freeze({ baselineFields: 3 })
});

const RULE_SCORE_RATIOS = Object.freeze({
  title: Object.freeze({ acceptable: 0.6, outsideRange: 1 / 3 }),
  description: Object.freeze({ acceptable: 0.6, outsideRange: 1 / 3 }),
  headings: Object.freeze({ oneConcern: 0.7, multipleConcerns: 0.5 }),
  canonical: Object.freeze({ invalid: 0.3 }),
  robots: Object.freeze({ nofollow: 0.6 }),
  contentDepth: Object.freeze({ moderate: 0.6, thin: 0.2 }),
  viewport: Object.freeze({ incomplete: 0.4 }),
  language: Object.freeze({ implausible: 0.4 }),
  structuredData: Object.freeze({ invalid: 0.6, untyped: 0.8 })
});

module.exports = {
  RULE_SCORE_RATIOS,
  RULE_THRESHOLDS,
  RULE_WEIGHTS
};
