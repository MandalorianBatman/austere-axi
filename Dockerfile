# austere-axi review server in a container. See docs/docker.md: run it with the host's network and
# PID namespace, the state dir and the page folders mounted at the same paths as on the host.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The same tarball `npm publish` would ship: dist, skills, types, README, LICENSE.
RUN npm run build && mkdir /out && npm pack --pack-destination /out

FROM node:${NODE_VERSION}-bookworm-slim
# procps: `ps`, which the server uses to find the unit that runs a process.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /tmp/pkg/
RUN npm install -g --no-audit --no-fund /tmp/pkg/austere-axi-*.tgz \
  && rm -rf /tmp/pkg \
  && npm cache clean --force
# HOME=/tmp: the container runs as the host user's uid, which has no home here (npm cache for `components add`).
ENV AUSTERE_AXI_STATE_DIR=/state \
  AUSTERE_AXI_NO_OPEN=1 \
  OPENUI_TELEMETRY_DISABLED=1 \
  HOME=/tmp
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AUSTERE_AXI_PORT||4388)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["austere-axi"]
CMD ["server", "--persist"]
