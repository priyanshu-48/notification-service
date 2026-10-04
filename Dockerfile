# Build: compile the API and the dashboard.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY dashboard ./dashboard
RUN npm --prefix dashboard ci && npm --prefix dashboard run build

# Run: production dependencies only, non-root.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY drizzle ./drizzle
COPY public ./public
USER node
EXPOSE 3000
# Migrations are idempotent, so running them on every start is safe and keeps deploys one step.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
