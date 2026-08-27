FROM node:24-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@11.21.0 --activate

WORKDIR /src
COPY . .

# Skip Electron postinstall; this image never launches Desktop. Rebuild the
# native modules the Web stage actually loads.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild node-pty esbuild

RUN pnpm run build \
  && pnpm run build:dsh \
  && pnpm run stage:dsh -- --surface web

# Same layout as scripts/build-web.mjs, without archives or the Electron
# smoke (that smoke is a developer-host check).
RUN set -eu; \
  dest=/opt/oh-dsh; \
  mkdir -p "$dest/bin" "$dest/lib/oh-dsh-web" "$dest/lib/oh-dsh"; \
  cp dist/web.js "$dest/lib/oh-dsh-web/main.js"; \
  cp dist/ohdsh.js "$dest/lib/oh-dsh/cli.js"; \
  cp install.sh install.ps1 "$dest/lib/oh-dsh/"; \
  cp dist/release-package.json "$dest/package.json"; \
  cp LICENSE THIRD_PARTY_NOTICES.md "$dest/"; \
  cp -a .stage/dsh-runtime "$dest/dsh-runtime"; \
  cp -a .stage/node-runtime "$dest/node-runtime"; \
  cp bin/ohdsh "$dest/bin/ohdsh"; \
  chmod 0755 "$dest/bin/ohdsh"; \
  printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    'ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)' \
    'exec "$ROOT/bin/ohdsh" web "$@"' \
    > "$dest/bin/oh-dsh-web"; \
  chmod 0755 "$dest/bin/oh-dsh-web"

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
