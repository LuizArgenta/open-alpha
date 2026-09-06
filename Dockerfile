# One image that serves both halves, the way vercel.json describes: /api/*
# reaches the handlers in api/, everything else falls back to the SPA shell.
#
# The api/ sources run through tsx rather than being compiled. The root
# tsconfig is noEmit with bundler resolution — it type-checks the handlers,
# it was never meant to emit them — and changing that to satisfy the container
# would risk the handlers Vercel is serving today for no gain here.

FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
RUN npm ci
COPY frontend ./frontend
COPY tsconfig.json ./
RUN npm run build --workspace=frontend

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
# tsx is a runtime dependency here, so --omit=dev must not remove it.
RUN npm ci --omit=dev && npm cache clean --force

COPY api ./api
COPY server ./server
COPY curriculum ./curriculum
COPY tsconfig.json ./
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Where the SQLite file lives when TURSO_DATABASE_URL points at a volume.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
ENV PORT=3000

# Refuses to answer while a migration is unfinished, so an orchestrator can
# tell "still starting" from "up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/schema').then(r=>process.exit(r.status===503?1:0)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
