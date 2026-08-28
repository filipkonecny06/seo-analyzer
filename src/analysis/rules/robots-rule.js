'use strict';

const { AnalysisRule, createRuleResult } = require('./base-rule');
const { RULE_SCORE_RATIOS, RULE_WEIGHTS } = require('./policy');

const PARAMETERIZED_ROBOTS_DIRECTIVES = new Set([
  'max-image-preview',
  'max-snippet',
  'max-video-preview',
  'unavailable_after'
]);

/** @param {Set<string>} directives @param {unknown} value */
function addDirectiveTokens(directives, value) {
  const tokens = String(value || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]*/gu);
  tokens?.forEach((token) => directives.add(token));
}

/** @param {Set<string>} directives @param {unknown} value */
function addXRobotsTagDirectives(directives, value) {
  // X-Robots-Tag may scope subsequent comma-separated directives to a named crawler.
  let appliesToGooglebot = true;

  String(value || '')
    .split(',')
    .forEach((part) => {
      const scopedDirective = part.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/iu);
      const directiveText = scopedDirective ? scopedDirective[2] : part;

      if (scopedDirective) {
        const prefix = scopedDirective[1].toLowerCase();
        if (PARAMETERIZED_ROBOTS_DIRECTIVES.has(prefix)) {
          if (appliesToGooglebot) addDirectiveTokens(directives, part);
          return;
        }
        appliesToGooglebot = prefix === 'googlebot';
      }
      if (appliesToGooglebot) addDirectiveTokens(directives, directiveText);
    });
}

/**
 * Combines HTML and repeated HTTP indexing directives into the policy relevant to Googlebot.
 * The shorthand "none" expands to its defined noindex/nofollow behavior.
 *
 * @param {import('../../contracts').PageSnapshotEvidence} snapshot
 * @returns {Set<string>}
 */
function parseRobotsDirectives(snapshot) {
  const directives = new Set();
  addDirectiveTokens(directives, snapshot.metadata.robots);
  addDirectiveTokens(directives, snapshot.metadata.googlebot);
  const xRobotsTags = Array.isArray(snapshot.metadata.xRobotsTags)
    ? snapshot.metadata.xRobotsTags
    : [snapshot.metadata.xRobotsTag];
  xRobotsTags.forEach((value) => addXRobotsTagDirectives(directives, value));

  if (directives.has('none')) {
    directives.add('noindex');
    directives.add('nofollow');
  }
  return directives;
}

class RobotsRule extends AnalysisRule {
  constructor() {
    super({ id: 'robots', label: 'Indexing directives', maxPoints: RULE_WEIGHTS.robots });
  }

  /** @param {import('../../contracts').PageSnapshotEvidence} snapshot */
  evaluate(snapshot) {
    const directives = parseRobotsDirectives(snapshot);
    if (directives.has('noindex')) {
      return createRuleResult(this, {
        points: 0,
        status: 'fail',
        detail: 'A noindex directive is present in page metadata or HTTP headers.',
        recommendation: 'Remove noindex if this page is intended to appear in search results.'
      });
    }
    if (directives.has('nofollow')) {
      return createRuleResult(this, {
        points: this.maxPoints * RULE_SCORE_RATIOS.robots.nofollow,
        status: 'warn',
        detail: 'A nofollow directive is present.',
        recommendation: 'Confirm that blocking link discovery is intentional for this page.'
      });
    }
    return createRuleResult(this, {
      points: this.maxPoints,
      status: 'pass',
      detail: directives.size
        ? 'No restrictive indexing directive was detected.'
        : 'Default index and follow behavior applies.'
    });
  }
}

module.exports = {
  RobotsRule,
  parseRobotsDirectives
};
