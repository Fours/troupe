# One image for every festival-night process: a node, or the crowd with `node examples/cluster/crowd.ts`.
# Built from the repository root by docker-compose.cluster.yml, so it runs this checkout's dist/,
# as the multi-process test does, not a version from npm.

# The build: every dev dependency, the package, the Backstage UI.
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# pg is a dev dependency of the package, and the example's own driver. Installed alone, at the
# lockfile's version, so the image gets none of the other dev dependencies.
RUN mkdir /deps && cd /deps && npm init -y >/dev/null \
  && npm install --no-audit --no-fund "pg@$(node -p "require('/src/node_modules/pg/package.json').version")"

# What runs: the package as npm would ship it, and the example, which imports it by name.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
COPY --from=build /deps/node_modules ./node_modules
COPY examples/cluster ./examples/cluster
USER node
CMD ["node", "examples/cluster/node.ts"]
