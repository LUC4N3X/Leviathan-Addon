FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=7000 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN chown -R node:node /app

USER node

RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/python -m pip install --no-cache-dir "curl_cffi>=0.7.0"

COPY --chown=node:node package.json package-lock.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node addon.js manifest.js worker.js ./
COPY --chown=node:node core ./core
COPY --chown=node:node providers ./providers
COPY --chown=node:node public ./public
COPY --chown=node:node browser-extension ./browser-extension

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:7000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "addon.js"]
