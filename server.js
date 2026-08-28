'use strict';

const { loadConfig } = require('./src/config');
const { createServer } = require('./src/http/create-server');

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
