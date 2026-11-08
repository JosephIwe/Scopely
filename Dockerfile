# Scopely production image: one Node process serving / (landing), /app and /api.
# Migrations (and the pre-deploy backup and owner bootstrap) are a separate release step,
# `pnpm release` (railway.json preDeployCommand), never run by the server.
FROM node:22-slim
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# pg_dump/pg_restore for the pre-deploy backup (src/ops/backup.ts). Production runs Postgres 18 and
# pg_dump refuses a newer server, so the client comes from the PostgreSQL project's own apt
# repository, pinned to major version 18 and verified with its signing key.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
ENV SCOPELY_ENV=production HOST=0.0.0.0 PORT=8080 SCOPELY_STORAGE_DIR=/data/storage
EXPOSE 8080
# Runs as the image's root user so the platform volume mounted at /data is writable.
CMD ["pnpm", "start"]
