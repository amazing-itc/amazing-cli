FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bash git gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 amazing \
  && useradd --system --uid 10001 --gid amazing --home-dir /app --shell /usr/sbin/nologin amazing \
  && mkdir -p /data/amazing-cli \
  && chown amazing:amazing /data/amazing-cli

ENV PATH="/root/.local/bin:${PATH}"

# Each installer is independent so an offline/air-gapped build still produces an image.
# `/health` reports which binaries actually landed.
RUN curl -fsSL https://cursor.com/install | bash || echo skip; \
    npm i -g @anthropic-ai/claude-code || echo skip; \
    npm i -g @openai/codex || echo skip; \
    npm i -g @github/copilot || echo skip; \
    curl -fsSL https://antigravity.google/cli/install.sh | bash || echo skip; \
    chmod 755 /root; \
    if [ -d /root/.local ]; then chmod -R a+rX /root/.local; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY openapi.yaml ./
COPY providers ./providers
COPY scripts ./scripts
COPY src ./src
RUN npm run build \
  && chown -R amazing:amazing /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3200/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
