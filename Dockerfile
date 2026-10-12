# Scopely production image: one Node process serving / (landing), /app and /api.
# Migrations are a separate release step (pnpm migrate), never run by the server.
FROM node:22-slim
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
ENV SCOPELY_ENV=production HOST=0.0.0.0 PORT=8080 SCOPELY_STORAGE_DIR=/data/storage
EXPOSE 8080
USER node
CMD ["pnpm", "start"]
