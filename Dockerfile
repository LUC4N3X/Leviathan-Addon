FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=7000

WORKDIR /app

COPY package*.json ./

RUN set -eux; \
    if [ -f package-lock.json ]; then \
        npm ci --omit=dev --no-audit --no-fund; \
    else \
        npm install --omit=dev --no-audit --no-fund; \
    fi; \
    npm cache clean --force

COPY . .

RUN chown -R node:node /app

USER node

EXPOSE 7000

CMD ["node", "addon.js"]
