# -------- Build stage --------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install deps (with dev for build/tools)
COPY package.json package-lock.json* ./
RUN npm ci

# Prisma generate (needs deps)
COPY prisma ./prisma
RUN npx prisma generate

# Build TS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -------- Runtime stage --------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# (optional but safe) TLS roots for fetch/oauth
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# App artifacts

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY assets ./assets

# Static assets for fastify-static -> fixes: root path "/app/public" must exist
COPY public ./public

# (optional) if your code imports package.json (e.g. /version endpoint)
COPY package.json ./

EXPOSE 18080
CMD ["node","dist/index.js"]
