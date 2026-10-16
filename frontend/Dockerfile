# Multi-stage build — docs/35 §3.
# The production image serves static assets only; there is no SSR (docs/03 §10).

# ---------- base ----------
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# ---------- development ----------
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# ---------- build ----------
FROM base AS build
RUN npm ci
COPY . .
# VITE_ variables are compiled into the client and are PUBLIC — no secret may be
# passed here (docs/35 §2). Configuration is injected per environment at build time.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# ---------- runtime ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS production

COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf

USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
