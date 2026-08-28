'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { loadConfig, parseAllowedPorts, parseBoolean, parseInteger } = require('../src/config');

describe('configuration', () => {
  it('loads typed defaults and explicit environment overrides', () => {
    const defaults = loadConfig({});
    assert.equal(defaults.port, 3000);
    assert.deepEqual(defaults.allowedTargetPorts, [80, 443]);
    assert.equal(defaults.trustProxy, false);
    assert.ok(Object.isFrozen(defaults));

    const configured = loadConfig({
      HOST: '127.0.0.1',
      PORT: '8080',
      FETCH_TIMEOUT_MS: '5000',
      ALLOWED_TARGET_PORTS: '80, 443, 8443, 443',
      TRUST_PROXY: 'true',
      OUTBOUND_USER_AGENT: 'TestAgent/1.0'
    });
    assert.equal(configured.host, '127.0.0.1');
    assert.equal(configured.port, 8080);
    assert.equal(configured.fetchTimeoutMs, 5000);
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
  });
});
