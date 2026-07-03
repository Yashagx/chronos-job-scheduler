# Stage 1: Production dependencies only
FROM node:20-alpine AS deps
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm ci --omit=dev

# Stage 2: Full build (TypeScript compile + Prisma generate)
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY api/package.json api/package-lock.json* ./
RUN npm ci
COPY api/ .
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build

# Stage 3: Minimal production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache curl openssl

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

