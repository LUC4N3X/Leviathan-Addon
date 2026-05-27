FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7000
ENV PYTHONUNBUFFERED=1
ENV PATH="/app/.venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --no-cache-dir "curl_cffi>=0.7.0"

COPY package.json package-lock.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

COPY addon.js manifest.js worker.js ./
COPY core ./core
COPY providers ./providers
COPY public ./public
COPY browser-extension ./browser-extension

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:7000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "addon.js"]
