# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# git: worker clones source + control-plane repos. claude CLI: worker spawns `claude -p`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 build-essential \
 && npm i -g @anthropic-ai/claude-code \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# npm install (not ci): package.json pins several deps to "latest" (no frozen lockfile
# discipline), which npm ci rejects as out-of-sync. install resolves cleanly.
RUN npm install

COPY . .
RUN npm run build

# Default to the server; docker-compose overrides command for the worker.
EXPOSE 3000
CMD ["node", "dist/start-server.js"]
