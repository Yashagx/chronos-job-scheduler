# Stage 1: Production dependencies only
FROM node:20-alpine AS deps
WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci --only=production

# Stage 2: Full build (TypeScript compile + Prisma generate)
FROM node:20-alpine AS builder
WORKDIR /app
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci
COPY worker/ .
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build

# Stage 3: Minimal production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

CMD ["node", "dist/index.js"]
