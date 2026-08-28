'use strict';

const { PageSnapshot } = require('./page-snapshot');
const { DEFAULT_RULES } = require('./rules');
const { METHODOLOGY_VERSION } = require('../version');

function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

class SeoAnalyzer {
  constructor(options = {}) {
    this.rules = Object.freeze([...(options.rules || DEFAULT_RULES)]);
    const identifiers = new Set(this.rules.map((rule) => rule.id));
    if (identifiers.size !== this.rules.length) {
      throw new TypeError('SEO rule identifiers must be unique.');
    }
    this.maxScore = this.rules.reduce((total, rule) => total + rule.maxPoints, 0);
    if (this.maxScore !== 100) {
      throw new TypeError(`SEO rule weights must total 100; received ${this.maxScore}.`);
    }
  }

  analyze(pageUrl, html, options = {}) {
    const snapshot = new PageSnapshot(pageUrl, html, options);
    const checks = this.rules.map((rule) => rule.evaluate(snapshot));
    const score = checks.reduce((total, check) => total + check.points, 0);
    const recommendations = checks
      .filter((check) => check.recommendation)
      .sort((left, right) => {
        const priority = { fail: 0, warn: 1, pass: 2 };
        return priority[left.status] - priority[right.status] || right.maxPoints - left.maxPoints;
      })
      .map((check) => check.recommendation);

    return {
      score,
      maxScore: this.maxScore,
      grade: gradeForScore(score),
      methodologyVersion: METHODOLOGY_VERSION,
      metadata: snapshot.metadata,
      content: snapshot.content,
      checks: checks.map(({ recommendation: _recommendation, ...check }) => check),
      recommendations
    };
  }
}

module.exports = {
  SeoAnalyzer,
  gradeForScore
};
