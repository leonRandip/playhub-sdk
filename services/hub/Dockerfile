# Build context: repo root.  docker build -f services/hub/Dockerfile -t playhub-hub .
#
# Stage 1 bundles the hub (and the protocol package it uses) into ONE JavaScript file.
# Stage 2 is a distroless Node image: no shell, no package manager, no tsx, no node_modules, runs as
# a non-root user. The base image is pinned by digest; Dependabot proposes updates.
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/client packages/client
COPY services/hub services/hub
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @playhub/hub bundle

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/services/hub/bundle/index.js ./index.js
# The base's non-root user (uid 65532), stated here so it is explicit and checkable.
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["index.js"]
