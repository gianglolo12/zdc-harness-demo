# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# git: worker clones source + control-plane repos. claude CLI: worker spawns `claude -p`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 build-essential \
 && npm i -g @anthropic-ai/claude-code \
 && rm -rf /var/lib/apt/lists/*

# Java toolchain: Phase 2 (/auto-implement) builds Spring Boot BE repos with Maven
# inside this container, so it needs a JDK + Maven. Temurin 21 matches the BE stack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg \
 && mkdir -p /etc/apt/keyrings \
 && wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends temurin-21-jdk \
 && ln -s "$(ls -d /usr/lib/jvm/temurin-21-jdk-*)" /opt/java \
 && wget -qO /tmp/maven.tar.gz https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz \
 && tar -xzf /tmp/maven.tar.gz -C /opt \
 && ln -s /opt/apache-maven-3.9.9 /opt/maven \
 && rm -f /tmp/maven.tar.gz \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/opt/java
ENV PATH=/opt/maven/bin:/opt/java/bin:$PATH

# Pre-cache Spring Boot deps so the first `mvn test` in Phase 2 is fast (and survives
# transient network blips). Mirrors the BE skeleton's dependency set.
COPY docker/warmup-pom.xml /tmp/warmup/pom.xml
RUN mvn -q -B -f /tmp/warmup/pom.xml dependency:go-offline || true

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
