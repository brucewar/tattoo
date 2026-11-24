FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS application
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="Tattoo" \
      org.opencontainers.image.source="https://github.com/brucewar/tattoo" \
      org.opencontainers.image.licenses="MIT"
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/scripts/start-api.mjs ./scripts/start-api.mjs
COPY --from=build /app/scripts/reset-admin.mjs ./scripts/reset-admin.mjs
COPY --from=build /app/scripts/configure.mjs ./scripts/configure.mjs
RUN mkdir -p /data/assets && chown node:node /data/assets
USER node
EXPOSE 3000
CMD ["node", "scripts/start-api.mjs"]
