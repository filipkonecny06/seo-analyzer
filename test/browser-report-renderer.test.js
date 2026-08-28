'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const { FakeDocument, buildReport, reportPayload } = require('../test-support/browser-fixtures');

let ReportRenderer;

before(async () => {
  ({ ReportRenderer } = await import('../public/report-renderer.mjs'));
});

describe('ReportRenderer', () => {
  function createRenderer() {
    const document = new FakeDocument();
    const report = buildReport(document);
    document.root.append(report);
    const renderer = new ReportRenderer(report, {
      window: document.defaultView,
      numberFormatter: { format: (value) => String(value) },
      dateFormatter: { format: () => 'Aug 28, 2026' }
    });
    return { document, report, renderer };
  }

  test('renders report content, score, metrics, keywords, and checks safely', () => {
    const { report, renderer } = createRenderer();
    const payload = reportPayload({
      score: 110,
      grade: '<svg onload=alert(1)>',
      recommendations: ['<img src=x onerror=alert(1)>'],
      content: {
        words: { count: 10, topKeywords: [{ term: '<script>alert(1)</script>', count: 2 }] },
        headings: { counts: { h1: 1 } },
        images: { missingAlt: 0 },
        links: { internal: 1, external: 2 },
        structuredDataCount: 0
      },
      checks: [
        { label: '<b>Title</b>', status: 'PASS', points: 5, maxPoints: 5, detail: '<i>ok</i>' },
        { label: 'Custom', status: 'unexpected', points: null, maxPoints: 'bad', detail: '' }
      ]
    });
    payload.url = 'javascript:alert(1)';

    renderer.render(payload);

    assert.equal(report.hidden, false);
    assert.equal(report.getAttribute('aria-busy'), 'false');
    assert.equal(report.querySelector('#analyzed-url').textContent, 'javascript:alert(1)');
    assert.equal(report.querySelector('#analyzed-url').hasAttribute('href'), false);
    assert.equal(report.querySelector('#score-value').textContent, '100');
    assert.match(report.querySelector('#score-dial').className, /score-dial--good/);
    assert.equal(report.querySelector('#score-dial').style.getPropertyValue('--score'), '100');
    assert.equal(report.querySelector('#recommendations').querySelector('img'), null);
    assert.equal(
      report.querySelector('#recommendations').textContent,
      '<img src=x onerror=alert(1)>'
    );
    assert.match(report.querySelector('#metrics').textContent, /Title length22 characters/);
    assert.equal(report.querySelector('#keywords').textContent, '<script>alert(1)</script>×2');
    assert.match(report.querySelector('#checks-summary').textContent, /2 checks: 1 passed/);
    assert.match(report.querySelector('#checks-body').textContent, /Unknown/);
    assert.equal(report.querySelector('#checks-body').querySelector('b'), null);
  });

  test('renders safe links and all empty or fallback states', () => {
    const { report, renderer } = createRenderer();
    const payload = reportPayload({
      score: 65,
      grade: '',
      recommendations: [],
      metadata: {},
      content: { words: {}, headings: {}, images: {}, links: {} },
      checks: []
    });
    payload.url = 'https://example.com/page';
    payload.fetchedAt = 'invalid';

    renderer.render(payload);

    const link = report.querySelector('#analyzed-url');
    assert.equal(link.href, 'https://example.com/page');
    assert.match(link.getAttribute('aria-label'), /Open analyzed page/);
    assert.equal(report.querySelector('#fetched-at').textContent, 'Analysis completed just now');
    assert.match(report.querySelector('#score-dial').className, /score-dial--warning/);
    assert.equal(report.querySelector('#score-grade').textContent, 'Grade —');
    assert.match(report.querySelector('#recommendations').textContent, /did not produce/);
    assert.match(report.querySelector('#keywords').textContent, /No meaningful keyword/);
    assert.match(report.querySelector('#checks-body').textContent, /No detailed checks/);
    assert.equal(
      report.querySelector('#checks-body').children[0].children[0].getAttribute('colspan'),
      '4'
    );
    assert.equal(
      report.querySelector('#checks-summary').textContent,
      'No rule-by-rule checks were returned.'
    );

    renderer.renderScore(20, 'F');
    assert.match(report.querySelector('#score-dial').className, /score-dial--critical/);
    renderer.renderSource('mailto:test@example.com', '2026-08-28T10:00:00Z');
    assert.equal(link.hasAttribute('href'), false);
    assert.equal(report.querySelector('#fetched-at').textContent, 'Completed Aug 28, 2026');
  });

  test('clears stale state and focuses with motion preferences', () => {
    const { document, report, renderer } = createRenderer();
    renderer.render(reportPayload());
    renderer.clear();

    assert.equal(report.hidden, true);
    assert.equal(report.querySelector('#analyzed-url').textContent, '');
    assert.equal(report.querySelector('#analyzed-url').hasAttribute('aria-label'), false);
    assert.equal(report.querySelector('#recommendations').children.length, 0);
    assert.equal(report.querySelector('#score-dial').hasAttribute('aria-label'), false);

    document.defaultView.prefersReducedMotion = true;
    renderer.focus();
    assert.equal(report.querySelector('#report-title').focused, true);
    assert.deepEqual(report.querySelector('#report-title').focusOptions, { preventScroll: true });
    assert.deepEqual(report.scrollOptions, { behavior: 'auto', block: 'start' });
  });
});
