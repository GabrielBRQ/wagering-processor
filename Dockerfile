FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig*.json nest-cli.json mikro-orm.config.ts ./
COPY src ./src
RUN bun --bun run build

FROM oven/bun:1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/mikro-orm.config.ts ./mikro-orm.config.ts
COPY --from=builder /app/src ./src

EXPOSE 3000
CMD ["bun", "run", "dist/main.js"]