'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, test } = require('node:test');
const cheerio = require('cheerio');

const publicDirectory = path.resolve(__dirname, '../public');
let APP_SELECTORS;
let REPORT_SELECTORS;

before(async () => {
  ({ APP_SELECTORS } = await import('../public/analyzer-app.mjs'));
  ({ REPORT_SELECTORS } = await import('../public/report-renderer.mjs'));
});

describe('browser HTML shell', () => {
  test('contains every element required by the application and report renderer exactly once', () => {
    const $ = cheerio.load(fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8'));

    Object.entries(APP_SELECTORS).forEach(([name, selector]) => {
      const matches = $(selector);
      assert.equal(matches.length, 1, `${name} selector ${selector} must match exactly once`);
    });

    const report = $(APP_SELECTORS.report);
    Object.entries(REPORT_SELECTORS).forEach(([name, selector]) => {
      const matches = report.find(selector);
      assert.equal(
        matches.length,
        1,
        `report ${name} selector ${selector} must match exactly once`
      );
    });

    assert.equal($(APP_SELECTORS.button).find(APP_SELECTORS.buttonLabel).length, 1);
  });
});
