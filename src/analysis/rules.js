'use strict';

const { AnalysisRule } = require('./rules/base-rule');
const {
  ContentDepthRule,
  HeadingRule,
  ImageAltRule,
  StructuredDataRule
} = require('./rules/content-rules');
const {
  CanonicalRule,
  LanguageRule,
  MetaDescriptionRule,
  OpenGraphRule,
  TitleRule,
  ViewportRule
} = require('./rules/metadata-rules');
const { RULE_SCORE_RATIOS, RULE_THRESHOLDS, RULE_WEIGHTS } = require('./rules/policy');
const { RobotsRule, parseRobotsDirectives } = require('./rules/robots-rule');

// Registry order is presentation order; weights are validated to total 100 by SeoAnalyzer.
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
  RULE_SCORE_RATIOS,
  RULE_THRESHOLDS,
  RULE_WEIGHTS,
  StructuredDataRule,
  TitleRule,
  ViewportRule,
  parseRobotsDirectives
};
