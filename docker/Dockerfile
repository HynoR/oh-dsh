# Oh-DSH Web-only image. linux/amd64 matches the published linux-x64
# release; linux-arm64 assets are not published.
FROM --platform=linux/amd64 debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY install.sh /tmp/install.sh
COPY docker/entrypoint.sh /usr/local/bin/ohdsh-web-entrypoint

RUN chmod 0755 /tmp/install.sh /usr/local/bin/ohdsh-web-entrypoint \
  && groupadd --gid 1000 ohdsh \
  && useradd --uid 1000 --gid ohdsh --create-home --home-dir /home/ohdsh \
    --shell /bin/bash ohdsh \
  && mkdir -p /opt/oh-dsh /data /workspace

# Installer records stay next to the payload, not under the runtime data root.
ARG OH_DSH_VERSION=
ARG GH_TOKEN=

RUN set -eu; \
  export OH_DSH_INSTALLER_HOME=/opt/oh-dsh/installer; \
  mkdir -p "$OH_DSH_INSTALLER_HOME"; \
  if [ -n "$OH_DSH_VERSION" ]; then \
    sh /tmp/install.sh --surface web --os linux --arch x64 \
      --dest /opt/oh-dsh --bin-dir /usr/local/bin --version "$OH_DSH_VERSION"; \
  else \
    sh /tmp/install.sh --surface web --os linux --arch x64 \
      --dest /opt/oh-dsh --bin-dir /usr/local/bin; \
  fi; \
  rm -f /tmp/install.sh; \
  chown ohdsh:ohdsh /data /workspace /home/ohdsh

ENV OH_DSH_HOME=/data
ENV OH_DSH_UPDATE_CHECK=0
ENV DSH_OH_WEB_OPEN=0
ENV HOME=/home/ohdsh

WORKDIR /workspace
USER ohdsh
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/ohdsh-web-entrypoint"]
