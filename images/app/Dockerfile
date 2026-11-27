# The app image — the SvelteKit BFF that serves the UI and proxies /api/v1/* to the control
# plane server-side (browsers never reach the orchestrator directly, so this is the deployment's
# only public-facing container). The build stage runs vite through the workspace's Bun toolchain
# (bun.lock pins the npm dependency tree); the runtime stage is plain Node serving adapter-node's
# build output. Configure at runtime via PORT (default 3000), ORIGIN (the public URL, needed for
# correct form/CSRF handling), RYPH_API_URL (the control-plane address), and the PUBLIC_GITHUB_*
# and PUBLIC_GITLAB_* vars from packages/app/.env.example.
#
# The Bun and Node versions mirror the mise.toml pins; bump them together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/app/Dockerfile -t ryph-app .

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS build
WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
# Every member's manifest, since bun wants each workspace a package names on disk; only the app's
# own dependency tree is installed.
COPY --parents packages/*/package.json ./
# Not --production: every one of the app's packages is a devDependency that vite bundles. Install
# scripts run only for bun's trusted list (esbuild's binary among them), not the whole tree.
RUN bun install --frozen-lockfile --filter @ryph/app
COPY packages/app/ packages/app/
# The auth BFF bundles @ryph/shared/http's body reader into its server output; that package
# imports nothing, so its source is all the build needs of it.
COPY packages/shared/src/ packages/shared/src/
WORKDIR /build/packages/app
RUN bun run build

FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5
WORKDIR /app
# adapter-node emits a self-contained server. The app carries no production dependencies — every
# package is a devDependency, so vite bundles it into the server output rather than leaving it
# external — so nothing needs installing at runtime. package.json rides over only for its
# "type": "module", which tells Node to load build/index.js as ESM.
COPY --from=build --chown=node:node /build/packages/app/build ./build
COPY --from=build --chown=node:node /build/packages/app/package.json ./
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "build/index.js"]
