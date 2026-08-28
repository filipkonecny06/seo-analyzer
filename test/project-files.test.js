'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { ENV_DEFAULTS } = require('../src/config');

const projectRoot = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('deployment project files', () => {
  test('pins every container base image and keeps the health check port configurable', () => {
    const dockerfile = readProjectFile('Dockerfile');
    const fromLines = dockerfile.match(/^FROM .+$/gm) || [];

    assert.ok(fromLines.length >= 2);
    fromLines.forEach((line) => assert.match(line, /@sha256:[a-f\d]{64}(?:\s+AS\s+\w+)?$/i));
    assert.match(
      dockerfile,
      /HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:\$\{PORT:-3000\}\/api\/health/
    );
    [
      'HOST',
      'PORT',
      'ANALYSIS_TIMEOUT_MS',
      'ANALYSIS_MAX_OLD_SPACE_MB',
      'ANALYSIS_MAX_YOUNG_SPACE_MB',
      'ANALYSIS_STACK_SIZE_MB'
    ].forEach((name) => {
      const setting = `${name}=${ENV_DEFAULTS[name]}`;
      assert.match(dockerfile, new RegExp(`\\b${escapeRegExp(setting)}(?:\\s|\\\\)`));
    });
  });

  test('keeps repository metadata, local secrets, and development artifacts out of builds', () => {
    const ignoredPaths = new Set(
      readProjectFile('.dockerignore')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    );

    [
      '.git',
      '.github',
      '.env',
      '.env.*',
      'coverage',
      'node_modules',
      'test',
      'test-support',
      '.idea',
      '.vscode',
      '*.log'
    ].forEach((entry) => assert.equal(ignoredPaths.has(entry), true, `${entry} must be ignored`));
    assert.equal(
      [...ignoredPaths].some((entry) => entry.startsWith('!.env')),
      false
    );
  });

  test('pins CI actions and prevents checkout from retaining credentials', () => {
    const workflow = readProjectFile('.github/workflows/ci.yml');
    const actionReferences = [...workflow.matchAll(/^\s*- uses:\s*(\S+)/gm)].map(
      (match) => match[1]
    );

    assert.ok(actionReferences.length >= 2);
    actionReferences.forEach((reference) => assert.match(reference, /@[a-f\d]{40}$/i));
    const checkoutSteps = workflow
      .split(/(?=\n\s*- uses:)/)
      .filter((step) => step.includes('actions/checkout@'));
    assert.ok(checkoutSteps.length >= 2);
    checkoutSteps.forEach((step) => assert.match(step, /persist-credentials:\s*false/));
    assert.match(workflow, /docker run --detach --env PORT=3102/);
    assert.match(workflow, /--publish 127\.0\.0\.1:3102:3102/);
    assert.match(workflow, /http:\/\/127\.0\.0\.1:3102\/api\/health/);
    assert.match(workflow, /trap cleanup EXIT/);
  });

  test('loads the browser through the external module bootstrap', () => {
    const html = readProjectFile('public/index.html');
    const bootstrap = readProjectFile('public/app.js');

    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(bootstrap, /import \{ AnalyzerApp \} from '\.\/analyzer-app\.mjs';/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  });
});
