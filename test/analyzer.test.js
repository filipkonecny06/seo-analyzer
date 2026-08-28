'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { PageSnapshot, SeoAnalyzer, analyzeHtml, normalizeUrl } = require('../src/analyzer');
const { AnalysisRule } = require('../src/analysis/rules');

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
  it('produces a perfect, evidence-rich report for a complete document', () => {
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

  it('treats robots none and X-Robots-Tag noindex as restrictive', () => {
    const metaReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><head><meta name="robots" content="none"></head><body><h1>Page</h1></body></html>'
    );
    const headerReport = analyzeHtml(
      'https://example.com',
      '<html lang="en"><body><h1>Page</h1></body></html>',
      { responseHeaders: { 'x-robots-tag': 'googlebot: noindex' } }
    );

    assert.equal(metaReport.checks.find((check) => check.id === 'robots').status, 'fail');
    assert.equal(headerReport.checks.find((check) => check.id === 'robots').status, 'fail');
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
      valid: 1,
      invalid: 1,
      types: ['WebPage']
    });
    assert.equal(report.checks.find((check) => check.id === 'structured-data').status, 'warn');
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
