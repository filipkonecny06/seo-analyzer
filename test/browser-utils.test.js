'use strict';

const assert = require('node:assert/strict');
const { before, describe, test } = require('node:test');
const { FakeDocument } = require('../test-support/browser-fixtures');

let ElementFactory;
let ui;

before(async () => {
  ui = await import('../public/ui-utils.mjs');
  ({ ElementFactory } = ui);
});

describe('browser utilities', () => {
  test('normalizes display values, scores, statuses, and safe URLs', () => {
    const formatter = { format: (value) => `#${value}` };
    assert.equal(ui.isRecord({}), true);
    assert.equal(ui.isRecord([]), false);
    assert.deepEqual(ui.asRecord(null), {});
    assert.deepEqual(ui.asArray('no'), []);
    assert.equal(ui.hasValue(0), true);
    assert.equal(ui.hasValue(''), false);
    assert.equal(ui.displayText('', 'fallback'), 'fallback');
    assert.equal(ui.displayText(0), '0');
    assert.equal(ui.displayNumber(null, '', formatter), 'Not available');
    assert.equal(ui.displayNumber('bad', '', formatter), 'Not available');
    assert.equal(ui.displayNumber(12, ' px', formatter), '#12 px');
    assert.equal(ui.clampScore(200), 100);
    assert.equal(ui.clampScore(-2), 0);
    assert.equal(ui.clampScore('bad'), 0);
    assert.equal(ui.getScoreTone(90), 'good');
    assert.equal(ui.getScoreTone(65), 'warning');
    assert.equal(ui.getScoreTone(20), 'critical');
    assert.match(ui.getScoreMessage(95), /Most configured/);
    assert.match(ui.getScoreMessage(85), /few/);
    assert.match(ui.getScoreMessage(65), /Several/);
    assert.match(ui.getScoreMessage(10), /Many/);
    assert.equal(ui.normalizeCheckStatus('PASS'), 'pass');
    assert.equal(ui.normalizeCheckStatus('other'), 'unknown');
    assert.equal(ui.getStatusLabel('warn'), 'Review');
    assert.equal(ui.getSafeHttpUrl('https://example.com/path'), 'https://example.com/path');
    assert.equal(ui.getSafeHttpUrl('javascript:alert(1)'), null);
    assert.equal(ui.getSafeHttpUrl('not a url'), null);
  });

  test('requires selectors and creates text-only elements', () => {
    const document = new FakeDocument();
    const factory = new ElementFactory(document);
    const element = factory.create('span', {
      className: 'value',
      text: '<img src=x>',
      attributes: { role: 'note' }
    });
    assert.equal(element.className, 'value');
    assert.equal(element.textContent, '<img src=x>');
    assert.equal(element.getAttribute('role'), 'note');
    assert.equal(factory.fragment().isFragment, true);
    assert.throws(() => ui.getRequiredElement(document, '#missing'), /Required UI element/);
  });
});
