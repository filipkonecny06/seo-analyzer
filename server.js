'use strict';

// Process entry point: load validated configuration, start the HTTP server, and own shutdown.

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/http/create-server');

/**
 * Creates the small structured logger used by the process boundary.
 * Error output is intentionally allowlisted so request context is retained without serializing
 * arbitrary error fields that could contain response data or other sensitive values.
 *
 * @returns {{info(fields: object): void, error(fields: object): void}}
 */
function createLogger() {
  return {
    info(fields) {
      process.stdout.write(
        `${JSON.stringify({ level: 'info', time: new Date().toISOString(), ...fields })}\n`
      );
    },
    error(fields) {
      const error = fields.error;
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          time: new Date().toISOString(),
          requestId: fields.requestId,
          code: fields.code,
          message: error?.message || 'Unknown server error'
        })}\n`
      );
    }
  };
}

/**
 * Starts the configured HTTP server and registers one-shot process signal handlers.
 *
 * @returns {import('node:http').Server} The listening server, exposed for tests and embedders.
 */
function start() {
  const config = loadConfig();
  const logger = createLogger();
  const server = createServer({ config, logger });
  let shuttingDown = false;

  server.listen(config.port, config.host, () => {
    logger.info({ event: 'server.started', host: config.host, port: config.port });
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'server.stopping', signal });
    // A deadline keeps orchestrators from waiting forever on stalled open connections.
    const forceTimer = setTimeout(() => process.exit(1), 10_000);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        logger.error({ code: 'SHUTDOWN_FAILED', error });
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) start();

module.exports = {
  createLogger,
  start
};
