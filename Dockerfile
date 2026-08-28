FROM node:22-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
RUN addgroup -S app && adduser -S -G app app

COPY --from=dependencies --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json server.js LICENSE ./
COPY --chown=app:app public ./public
COPY --chown=app:app src ./src

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
