# Multi-stage Dockerfile for Agent Deployment Challenge
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build web frontend
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4319
ENV HOST=0.0.0.0

# Copy package manifests and built assets
COPY package.json package-lock.json ./
COPY apps/api apps/api
COPY --from=builder /app/apps/web/dist apps/web/dist
COPY --from=builder /app/node_modules ./node_modules

# Remove dev dependencies for a leaner, more secure image
RUN npm prune --omit=dev

# Run as non-root user
USER node

EXPOSE 4319

CMD ["npm", "start"]
