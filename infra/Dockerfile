# Development/lab image only. No automatic production build or push.
FROM node:22.22.1-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /opt/folio
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @folio/contracts build \
 && pnpm --filter @folio/db build \
 && pnpm --filter @folio/server build \
 && pnpm --filter @folio/worker build
USER node
EXPOSE 3100
CMD ["pnpm", "--filter", "@folio/server", "exec", "node", "dist/main.js"]
