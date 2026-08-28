'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  loadConfig,
  parseAllowedPorts,
  parseBoolean,
  parseInteger,
  parseUserAgent
} = require('../src/config');

describe('configuration', () => {
  it('loads typed defaults and explicit environment overrides', () => {
    const defaults = loadConfig({});
    assert.equal(defaults.port, 3000);
    assert.deepEqual(defaults.allowedTargetPorts, [80, 443]);
    assert.equal(defaults.analysisTimeoutMs, 5000);
    assert.equal(defaults.analysisMaxOldSpaceMb, 128);
    assert.equal(defaults.analysisMaxYoungSpaceMb, 16);
    assert.equal(defaults.analysisStackSizeMb, 4);
    assert.equal(defaults.trustProxy, false);
    assert.ok(Object.isFrozen(defaults));

    const configured = loadConfig({
      HOST: '127.0.0.1',
      PORT: '8080',
      FETCH_TIMEOUT_MS: '5000',
      ANALYSIS_TIMEOUT_MS: '2500',
      ANALYSIS_MAX_OLD_SPACE_MB: '96',
      ANALYSIS_MAX_YOUNG_SPACE_MB: '12',
      ANALYSIS_STACK_SIZE_MB: '2',
      ALLOWED_TARGET_PORTS: '80, 443, 8443, 443',
      TRUST_PROXY: 'true',
      OUTBOUND_USER_AGENT: 'TestAgent/1.0'
    });
    assert.equal(configured.host, '127.0.0.1');
    assert.equal(configured.port, 8080);
    assert.equal(configured.fetchTimeoutMs, 5000);
    assert.equal(configured.analysisTimeoutMs, 2500);
    assert.equal(configured.analysisMaxOldSpaceMb, 96);
    assert.equal(configured.analysisMaxYoungSpaceMb, 12);
    assert.equal(configured.analysisStackSizeMb, 2);
    assert.deepEqual(configured.allowedTargetPorts, [80, 443, 8443]);
    assert.equal(configured.trustProxy, true);
    assert.equal(configured.userAgent, 'TestAgent/1.0');
  });

  it('rejects malformed integer, boolean, and port settings', () => {
    assert.throws(() => parseInteger({ VALUE: '1.5' }, 'VALUE', 2), /integer/);
    assert.throws(() => parseInteger({ VALUE: '-1' }, 'VALUE', 2), /between/);
    assert.throws(() => parseBoolean({ VALUE: 'yes' }, 'VALUE', false), /true or false/);
    assert.throws(() => parseAllowedPorts({ ALLOWED_TARGET_PORTS: '80,nope' }), /valid ports/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ ANALYSIS_TIMEOUT_MS: '20' }), /ANALYSIS_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ ANALYSIS_MAX_OLD_SPACE_MB: '8' }), /OLD_SPACE/);
  });

  it('rejects outbound user agents containing control characters', () => {
    assert.throws(
      () => parseUserAgent({ OUTBOUND_USER_AGENT: 'Analyzer/2.0\r\nX-Test: injected' }),
      /OUTBOUND_USER_AGENT must not contain control characters/
    );
    assert.throws(
      () => loadConfig({ OUTBOUND_USER_AGENT: 'Analyzer/2.0\tdebug' }),
      /OUTBOUND_USER_AGENT must not contain control characters/
    );
  });
});
