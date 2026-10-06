# Multi-stage build — docs/35 §3 and §7.
#   - production dependencies only in the runtime stage
#   - non-root user at runtime
#   - no secrets baked into the image (injected at runtime only)
#   - pinned base versions

# ---------- base ----------
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./

# ---------- development ----------
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .
# A failed client generation must fail the image build, never be swallowed: a dev
# container with a stale client produces confusing runtime errors instead.
RUN npx prisma generate
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ---------- build ----------
FROM base AS build
ENV NODE_ENV=development
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# ---------- production dependencies ----------
FROM base AS prod-deps
ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl wget \
  && addgroup -S servicehub && adduser -S servicehub -G servicehub

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

# Liveness must not depend on the database (docs/34 §6): a database blip must not
# restart healthy instances.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health/live || exit 1

USER servicehub
EXPOSE 4000
CMD ["node", "dist/server.js"]
