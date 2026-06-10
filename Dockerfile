FROM ghcr.io/puppeteer/puppeteer:23.11.1

USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

USER pptruser
WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev

COPY --chown=pptruser:pptruser server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
