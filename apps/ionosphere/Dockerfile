FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

# -- Dependencies --
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/ionosphere/package.json apps/ionosphere/
COPY formats/tv.ionosphere/package.json formats/tv.ionosphere/
RUN pnpm install --frozen-lockfile

# -- Build --
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/ionosphere/node_modules ./apps/ionosphere/node_modules
COPY --from=deps /app/formats/tv.ionosphere/node_modules ./formats/tv.ionosphere/node_modules
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/ionosphere/ apps/ionosphere/
COPY formats/tv.ionosphere/ formats/tv.ionosphere/

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

WORKDIR /app/apps/ionosphere
RUN pnpm build

# -- Runner --
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/apps/ionosphere/.next/standalone ./
COPY --from=builder /app/apps/ionosphere/.next/static ./apps/ionosphere/.next/static
COPY --from=builder /app/apps/ionosphere/public ./apps/ionosphere/public

EXPOSE 8080
CMD ["node", "apps/ionosphere/server.js"]
