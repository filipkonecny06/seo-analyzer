FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ANALYSIS_TIMEOUT_MS=5000 \
    ANALYSIS_MAX_OLD_SPACE_MB=128 \
    ANALYSIS_MAX_YOUNG_SPACE_MB=16 \
    ANALYSIS_STACK_SIZE_MB=4

WORKDIR /app
RUN addgroup -S app && adduser -S -G app app

COPY --from=dependencies --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json server.js LICENSE ./
COPY --chown=app:app public ./public
COPY --chown=app:app src ./src

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1

CMD ["node", "server.js"]
