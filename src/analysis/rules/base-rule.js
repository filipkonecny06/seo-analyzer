'use strict';

/**
 * @param {AnalysisRule} rule
 * @param {{points: number, status: import('../../contracts').AnalysisStatus, detail: string, recommendation?: string}} options
 * @returns {import('../../contracts').RuleEvaluation}
 */
function createRuleResult(rule, options) {
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

/** Base contract implemented by every scoring rule. */
class AnalysisRule {
  /** @param {{id: string, label: string, maxPoints: number}} definition */
  constructor({ id, label, maxPoints }) {
    this.id = id;
    this.label = label;
    this.maxPoints = maxPoints;
  }

  /**
   * @param {import('../../contracts').PageSnapshotEvidence} _snapshot
   * @returns {import('../../contracts').RuleEvaluation}
   */
  evaluate(_snapshot) {
    throw new Error(`${this.constructor.name} must implement evaluate().`);
  }
}

module.exports = {
  AnalysisRule,
  createRuleResult
};
