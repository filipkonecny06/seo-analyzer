'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { PageSnapshot, SeoAnalyzer, analyzeHtml, normalizeUrl } = require('../src/analyzer');
const { AnalysisRule, RULE_THRESHOLDS, RULE_WEIGHTS } = require('../src/analysis/rules');

function completeHtml() {
  const description = 'A'.repeat(130);
  const body = Array.from({ length: 310 }, () => 'optimization').join(' ');
  return `<!doctype html>
    <html lang="en-GB">
      <head>
        <title>A practical technical SEO analysis for growing teams</title>
        <meta name="description" content="${description}">
        <meta name="robots" content="index, follow">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="/guide">
        <meta property="og:title" content="SEO guide">
        <meta property="og:description" content="A useful SEO guide">
        <meta property="og:image" content="/social.png">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
      </head>
      <body>
        <h1>Technical SEO guide</h1><h2>Start here</h2>
        <img src="chart.png" alt="Traffic growth chart"><img src="divider.png" alt="">
        <a href="/about">About</a><a href="https://external.example/resource">Reference</a>
        <main>${body}</main>
      </body>
    </html>`;
}

describe('SeoAnalyzer', () => {
  it('returns 100 points and extracted evidence for a complete document', () => {
    const report = analyzeHtml('https://example.com/guide', completeHtml());

    assert.equal(report.score, 100);
    assert.equal(report.maxScore, 100);
    assert.equal(report.grade, 'A');
    assert.equal(report.methodologyVersion, '2.0');
    assert.equal(report.metadata.canonical, 'https://example.com/guide');
    assert.deepEqual(report.content.images, {
      total: 2,
      withAlt: 1,
      emptyAlt: 1,
      missingAlt: 0
    });
    assert.deepEqual(report.content.links, { total: 2, internal: 1, external: 1 });
    assert.deepEqual(report.content.structuredData.types, ['Article']);
    assert.equal(report.recommendations.length, 0);
  });

  it('uses a real parser for comments, scripts, entities, and quoted greater-than signs', () => {
    const html = `
      <html lang="en"><head>
        <title>Research &amp; development overview</title>
        <meta name="description" content="Research > assumptions &amp; clear outcomes">
      </head><body>
        <!-- <h1>Comment heading</h1> -->
        <script>const markup = '<h1>Script heading</h1>';</script>
        <h1>Visible heading</h1>
      </body></html>`;
    const snapshot = new PageSnapshot('https://example.com', html);

    assert.equal(snapshot.metadata.title, 'Research & development overview');
    assert.equal(snapshot.metadata.description, 'Research > assumptions & clear outcomes');
    assert.equal(snapshot.content.headings.counts.h1, 1);
    assert.deepEqual(snapshot.content.headings.h1Texts, ['Visible heading']);
  });

  it('treats robots, googlebot, and X-Robots-Tag noindex as restrictive', () => {
    const metaReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><head><meta name="robots" content="none"></head><body><h1>Page</h1></body></html>'
    );
    const headerReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      { responseHeaders: { 'x-robots-tag': 'googlebot: noindex' } }
    );
    const googlebotReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><head><meta name="googlebot" content="noindex"></head><body><h1>Page</h1></body></html>'
    );

    assert.equal(metaReport.checks.find((check) => check.id === 'robots').status, 'fail');
    assert.equal(headerReport.checks.find((check) => check.id === 'robots').status, 'fail');
    assert.equal(googlebotReport.metadata.googlebot, 'noindex');
    assert.equal(googlebotReport.checks.find((check) => check.id === 'robots').status, 'fail');
  });

  it('ignores X-Robots-Tag directives scoped to unrelated crawlers', () => {
    const genericReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      { responseHeaders: { 'x-robots-tag': 'max-snippet: 120, noindex' } }
    );
    const unrelatedCrawlerReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      { responseHeaders: { 'x-robots-tag': 'adsbot-google: noindex, nofollow' } }
    );
    const mixedScopeReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      {
        responseHeaders: {
          'x-robots-tag': 'adsbot-google: noindex, googlebot: nofollow'
        }
      }
    );

    assert.equal(genericReport.checks.find((check) => check.id === 'robots').status, 'fail');
    assert.equal(
      unrelatedCrawlerReport.checks.find((check) => check.id === 'robots').status,
      'pass'
    );
    assert.equal(mixedScopeReport.checks.find((check) => check.id === 'robots').status, 'warn');
  });

  it('resets crawler scope for each distinct X-Robots-Tag field line', () => {
    const report = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      {
        responseHeaders: {
          'x-robots-tag': ['bingbot: noindex', 'nofollow']
        }
      }
    );

    assert.deepEqual(report.metadata.xRobotsTags, ['bingbot: noindex', 'nofollow']);
    assert.equal(report.metadata.xRobotsTag, 'bingbot: noindex, nofollow');
    assert.equal(report.checks.find((check) => check.id === 'robots').status, 'warn');
  });

  it('distinguishes decorative images from omitted alt attributes', () => {
    const report = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1><img alt=""><img src="missing.png"></body></html>'
    );

    assert.deepEqual(report.content.images, {
      total: 2,
      withAlt: 0,
      emptyAlt: 1,
      missingAlt: 1
    });
    assert.match(report.checks.find((check) => check.id === 'images').detail, /1 of 2 images/);
  });

  it('validates JSON-LD instead of counting script tags only', () => {
    const report = analyzeHtml(
      'https://example.com',
      `<html lang="en"><body><h1>Page</h1>
        <script type="application/ld+json">{"@type":"WebPage"}</script>
        <script type="application/ld+json">{broken</script>
      </body></html>`
    );

    assert.deepEqual(report.content.structuredData, {
      total: 2,
      parseable: 1,
      typed: 1,
      untyped: 0,
      invalid: 1,
      types: ['WebPage']
    });
    assert.equal(report.checks.find((check) => check.id === 'structured-data').status, 'warn');
  });

  it('does not award a structured-data pass to empty or untyped JSON values', () => {
    const report = analyzeHtml(
      'https://example.com',
      `<html lang="en"><body><h1>Page</h1>
        <script type="application/ld+json">{}</script>
        <script type="application/ld+json">[]</script>
      </body></html>`
    );

    assert.deepEqual(report.content.structuredData, {
      total: 2,
      parseable: 2,
      typed: 0,
      untyped: 2,
      invalid: 0,
      types: []
    });
    const check = report.checks.find((candidate) => candidate.id === 'structured-data');
    assert.equal(check.status, 'warn');
    assert.equal(check.points, 0);
    assert.match(check.detail, /none declares a non-empty @type/);
  });

  it('discovers deterministic types in graphs and nested JSON-LD entities', () => {
    const report = analyzeHtml(
      'https://example.com',
      `<html lang="en"><body><h1>Page</h1>
        <script type="application/ld+json">{
          "@context":"https://schema.org",
          "@graph":[{
            "@type":["WebPage","Article",""],
            "mainEntity":{"@type":"Person"},
            "publisher":{"details":{"@type":"Organization"}}
          }]
        }</script>
      </body></html>`
    );

    assert.deepEqual(report.content.structuredData, {
      total: 1,
      parseable: 1,
      typed: 1,
      untyped: 0,
      invalid: 0,
      types: ['Article', 'Organization', 'Person', 'WebPage']
    });
    const check = report.checks.find((candidate) => candidate.id === 'structured-data');
    assert.equal(check.status, 'pass');
    assert.equal(check.points, 5);
  });

  it('does not mistake JSON-LD context type coercion for an entity type', () => {
    const report = analyzeHtml(
      'https://example.com',
      `<html lang="en"><body><h1>Page</h1>
        <script type="application/ld+json">{
          "@context":{"image":{"@type":"@id"}},
          "name":"Untyped page"
        }</script>
      </body></html>`
    );

    assert.deepEqual(report.content.structuredData.types, []);
    const check = report.checks.find((candidate) => candidate.id === 'structured-data');
    assert.equal(check.status, 'warn');
    assert.equal(check.points, 0);
  });

  it('warns when typed JSON-LD is mixed with an untyped block', () => {
    const report = analyzeHtml(
      'https://example.com',
      `<html lang="en"><body><h1>Page</h1>
        <script type="application/ld+json">{"@type":"WebPage"}</script>
        <script type="application/ld+json">{"name":"Page"}</script>
      </body></html>`
    );

    const check = report.checks.find((candidate) => candidate.id === 'structured-data');
    assert.equal(check.status, 'warn');
    assert.equal(check.points, 4);
    assert.match(check.detail, /1 typed and 1 untyped/);
  });

  it('extracts and ranks Unicode keywords deterministically', () => {
    const snapshot = new PageSnapshot(
      'https://example.com',
      '<html><body>Žluťoučký kůň, žluťoučký kůň. 東京 東京. café café café.</body></html>'
    );

    assert.deepEqual(snapshot.content.words.topKeywords.slice(0, 4), [
      { term: 'café', count: 3 },
      { term: 'kůň', count: 2 },
      { term: 'žluťoučký', count: 2 },
      { term: '東京', count: 2 }
    ]);
  });

  it('reports missing and malformed fundamentals without throwing', () => {
    const report = analyzeHtml(
      'https://example.com/path',
      '<html lang="not_a_tag"><head><link rel="canonical" href="mailto:test@example.com"><meta name="viewport" content="initial-scale=1"></head><body><h2>Skipped start</h2><h4>Deep heading</h4></body></html>'
    );

    assert.equal(report.grade, 'F');
    assert.equal(report.checks.find((check) => check.id === 'canonical').status, 'warn');
    assert.equal(report.checks.find((check) => check.id === 'headings').status, 'fail');
    assert.equal(report.checks.find((check) => check.id === 'lang').status, 'warn');
    assert.ok(report.recommendations.length >= 5);
  });

  it('enforces unique rule IDs and a stable 100-point registry', () => {
    assert.equal(
      Object.values(RULE_WEIGHTS).reduce((total, weight) => total + weight, 0),
      100
    );
    assert.ok(Object.isFrozen(RULE_WEIGHTS));
    assert.ok(Object.isFrozen(RULE_THRESHOLDS));
    Object.values(RULE_THRESHOLDS).forEach((thresholds) => assert.ok(Object.isFrozen(thresholds)));

    class StubRule extends AnalysisRule {
      constructor(id, maxPoints) {
        super({ id, label: id, maxPoints });
      }

      evaluate() {
        return {
          id: this.id,
          label: this.label,
          maxPoints: this.maxPoints,
          points: 0,
          status: 'warn',
          detail: ''
        };
      }
    }

    assert.throws(
      () => new SeoAnalyzer({ rules: [new StubRule('same', 50), new StubRule('same', 50)] }),
      /unique/
    );
    assert.throws(() => new SeoAnalyzer({ rules: [new StubRule('partial', 99)] }), /total 100/);
    assert.throws(
      () => new AnalysisRule({ id: 'base', label: 'Base', maxPoints: 100 }).evaluate(),
      /implement/
    );
  });
});

describe('normalizeUrl', () => {
  it('adds HTTPS to a bare hostname and removes fragments', () => {
    assert.equal(normalizeUrl('example.com/path#section'), 'https://example.com/path');
  });

  it('rejects non-HTTP protocols and credentials', () => {
    assert.throws(() => normalizeUrl('ftp://example.com/file'), /HTTP and HTTPS/);
    assert.throws(() => normalizeUrl('https://user:secret@example.com'), /credentials/);
  });
});
