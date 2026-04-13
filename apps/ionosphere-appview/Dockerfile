FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all workspace packages (needed for workspace: dependencies)
COPY apps/ionosphere-appview/package.json apps/ionosphere-appview/
COPY formats/tv.ionosphere/package.json formats/tv.ionosphere/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/ionosphere-appview/ apps/ionosphere-appview/
COPY formats/tv.ionosphere/ formats/tv.ionosphere/
COPY apps/data/atmosphere-projects.json apps/data/atmosphere-projects.json
COPY apps/data/highlights.json apps/data/highlights.json

WORKDIR /app/apps/ionosphere-appview

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["pnpm", "appview"]
