# Packaged Web is bin/ohdsh -> node-runtime + lib/oh-dsh/cli.js, which
# launches the Web profile. Produce that layout with the same scripts as
# pnpm run dist:web; do not install a GitHub release and do not compile
# upstream source when npm already ships lib/. Follow the builder CPU;
# do not pin --platform.
FROM node:24-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@11.21.0 --activate

WORKDIR /src
COPY . .

# Skip Electron postinstall; this image never launches Desktop.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild node-pty esbuild

# After install: empty gitlinks do not change the lockfile. Fill the Web
# stage inputs Nix also substitutes (npm lib/ for context and auth, TUI
# presets, GitHub source for Better Sidebar).
RUN node scripts/prepare-web-upstreams.mjs

RUN pnpm run build \
  && pnpm run build:dsh \
  && pnpm run stage:dsh -- --surface web

# Same tree as scripts/build-web.mjs writes under release/; skip archives
# and the Electron-hosted smoke by writing the layout to /opt/oh-dsh.
RUN OH_DSH_WEB_PACKAGE_DIR=/opt/oh-dsh node scripts/build-web.mjs

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /usr/local/bin/ohdsh-web-entrypoint
COPY --from=builder /opt/oh-dsh /opt/oh-dsh

RUN chmod 0755 /usr/local/bin/ohdsh-web-entrypoint \
  && groupadd --gid 1000 ohdsh \
  && useradd --uid 1000 --gid ohdsh --create-home --home-dir /home/ohdsh \
    --shell /bin/bash ohdsh \
  && mkdir -p /data /workspace \
  && chown ohdsh:ohdsh /data /workspace /home/ohdsh

ENV OH_DSH_HOME=/data
ENV OH_DSH_UPDATE_CHECK=0
ENV DSH_OH_WEB_OPEN=0
ENV HOME=/home/ohdsh

WORKDIR /workspace
USER ohdsh
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/ohdsh-web-entrypoint"]
