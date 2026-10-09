# No `# syntax=docker/dockerfile:1.x` directive on purpose: the built-in
# BuildKit frontend already supports the single extension this file uses
# (`RUN --mount=type=cache`), while the directive adds a Docker Hub round-trip
# — and a failure mode — to every build behind a slow or mirrored registry.
#
# DeepSeek Harness Web UI container image.
#
# Two properties drive this file:
#
#   1. The harness Web profile binds 127.0.0.1 and refuses `--host 0.0.0.0`, and
#      every /api request additionally passes a browser-trust fence that requires
#      the request authority to be loopback or a declared `--trusted-host`
#      authority (packages/client/connection/src/api-request-trust.ts). A plain
#      Docker port mapping rewrites nothing, so a remote browser's Host header
#      would be answered with 403 before reaching the RPC bridge. This image
#      keeps the harness on loopback and publishes it through the
#      Host-rewriting reverse proxy in ./reverse-proxy.mjs.
#   2. Every step runs inside the target-architecture image, so the same
#      Dockerfile builds linux/amd64 and linux/arm64 with no cross-compilation
#      flags: optional platform packages and the Node-API addon resolve for the
#      architecture the build runs on.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t deepseek-harness-web:0.2.1-alpha.1 .
# Build for another architecture:
#   docker buildx build --platform linux/arm64 -f docker/Dockerfile -t dsh-web:arm64 .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
# Optional Debian mirror root, e.g. https://mirrors.tuna.tsinghua.edu.cn .
# Empty keeps the base image's own sources. Reachability of deb.debian.org is
# the usual build failure from mainland China.
ARG DEBIAN_MIRROR=
# Index used when a requirements file is baked in (see PYTHON_REQUIREMENTS).
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
# Extra Debian packages for the runtime image, space-separated, e.g.
# `build-essential` when the sandbox must compile Python source distributions.
ARG PYTHON_EXTRA_PACKAGES=
# Path, relative to the repository root, of a pip requirements file to install
# into the image's own virtual environment (/opt/dsh-python). Empty ships only
# Debian's python3; mounting a virtual environment is the size-friendly
# alternative (see README).
ARG PYTHON_REQUIREMENTS=

# ── builder: toolchain for the native addon and the TypeScript build ─────────
FROM ${NODE_IMAGE} AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NPM_REGISTRY
ARG DEBIAN_MIRROR
# Public commit value embedded in browser artifacts. The default keeps builds
# reproducible from a source snapshot that carries no .git directory.
ARG DSH_CLIENT_COMMIT_HASH=0000000

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

# A flaky resolver must not fail the build: retry the index fetch, then fail
# loudly rather than install against stale or missing indexes.
RUN set -eux; \
    if [ -n "${DEBIAN_MIRROR}" ]; then \
      mirror="${DEBIAN_MIRROR%/}"; \
      sed -i "s|http://deb.debian.org|${mirror}|g; s|http://security.debian.org|${mirror}|g" \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    ok=0; \
    for attempt in 1 2 3 4 5; do \
      if apt-get update -o Acquire::Retries=5; then ok=1; break; fi; \
      echo "apt-get update attempt ${attempt} failed; retrying" >&2; sleep 5; \
    done; \
    [ "${ok}" = 1 ]; \
    apt-get install --yes --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      make \
      g++ \
      pkg-config \
    ; \
    rm -rf /var/lib/apt/lists/*

# Registry and retry policy live in the user `.npmrc`: pnpm ignores the
# `npm_config_registry` environment variable (npm honours it, pnpm does not), so
# a file is the only setting both tools agree on. `PNPM_HOME` plus its PATH entry
# satisfy pnpm's own check that its global bin directory is reachable — without
# it every global-configuration command aborts. Declared after the apt layer so
# changing them does not re-download the toolchain.
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm/bin:/pnpm:${PATH}

RUN set -eux; \
    printf 'registry=%s\nfetch-retries=5\nfetch-retry-maxtimeout=120000\n' "${NPM_REGISTRY}" > /root/.npmrc; \
    for attempt in 1 2 3 4 5; do \
      if npm install --global pnpm@11.7.0; then break; fi; \
      echo "pnpm install attempt ${attempt} failed; retrying" >&2; sleep 5; \
    done; \
    pnpm --version; \
    test "$(pnpm config get registry | sed 's:/$::')" = "${NPM_REGISTRY%/}"

WORKDIR /app

# ── deps: the full workspace install ────────────────────────────────────────
FROM builder AS deps

# Declared so the cache-mount id below resolves without a lint warning; BuildKit
# defines it for every build.
ARG TARGETARCH

# The pnpm store lives on a cache mount, so it is a different filesystem from
# /app: pnpm materializes node_modules as real files instead of hardlinks, which
# keeps `COPY --from=build /app` self-contained in the runtime stage. The store
# id is per-architecture so an amd64 and an arm64 build never share binaries.
ENV npm_config_store_dir=/pnpm/store
RUN mkdir -p /pnpm/store

COPY . .

RUN --mount=type=cache,id=pnpm-store-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# ── build: native addon, host/client bundles, and the Web frontend dist ─────
FROM deps AS build

RUN pnpm run build

# ── runtime-base: the published image's userland ────────────────────────────
# A separate stage so `--target runtime-base` can validate the base image and
# the complete package list for another architecture cheaply.
FROM ${NODE_IMAGE} AS runtime-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG NPM_REGISTRY
ARG DEBIAN_MIRROR
# Only this one is used below; the Python bake arguments are declared in the
# runtime stage that consumes them, so changing them does not invalidate the
# expensive apt layer here.
ARG PYTHON_EXTRA_PACKAGES
ENV DEBIAN_FRONTEND=noninteractive

# Common Linux tooling for interactive use of the sandbox: transfer
# (curl/wget/get), editors (vim/nano), paging and text tools, archives,
# process and network inspection, Python, and multi-arch convenience tools.
RUN set -eux; \
    if [ -n "${DEBIAN_MIRROR}" ]; then \
      mirror="${DEBIAN_MIRROR%/}"; \
      sed -i "s|http://deb.debian.org|${mirror}|g; s|http://security.debian.org|${mirror}|g" \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    ok=0; \
    for attempt in 1 2 3 4 5; do \
      if apt-get update -o Acquire::Retries=5; then ok=1; break; fi; \
      echo "apt-get update attempt ${attempt} failed; retrying" >&2; sleep 5; \
    done; \
    [ "${ok}" = 1 ]; \
    apt-get install --yes --no-install-recommends \
      bash \
      bash-completion \
      ca-certificates \
      curl \
      wget \
      vim \
      nano \
      less \
      coreutils \
      findutils \
      grep \
      sed \
      gawk \
      diffutils \
      tar \
      gzip \
      xz-utils \
      bzip2 \
      unzip \
      zip \
      procps \
      psmisc \
      htop \
      tree \
      file \
      bc \
      jq \
      git \
      openssh-client \
      net-tools \
      netcat-openbsd \
      iproute2 \
      iputils-ping \
      dnsutils \
      lsof \
      tmux \
      rsync \
      ripgrep \
      fd-find \
      bat \
      python3 \
      python3-venv \
      python3-pip \
      python3-dev \
      ${PYTHON_EXTRA_PACKAGES} \
    ; \
    rm -rf /var/lib/apt/lists/*; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    ln -sf /usr/bin/batcat /usr/local/bin/bat; \
    python3 -V; \
    python3 -m venv --help >/dev/null

# The runtime's pnpm home belongs to the unprivileged `node` user, so plugin
# installs from the GUI and an interactive `pnpm add` both work.
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=/home/node/.local/share/pnpm/bin:/home/node/.local/share/pnpm:${PATH}

RUN set -eux; \
    printf 'registry=%s\nfetch-retries=5\nfetch-retry-maxtimeout=120000\n' "${NPM_REGISTRY}" > /home/node/.npmrc; \
    for attempt in 1 2 3 4 5; do \
      if npm install --global pnpm@11.7.0; then break; fi; \
      echo "pnpm install attempt ${attempt} failed; retrying" >&2; sleep 5; \
    done; \
    pnpm --version

# ── runtime: the published image ────────────────────────────────────────────
FROM runtime-base AS runtime

# An ARG goes out of scope at the end of the stage that declared it, so a build
# argument consumed here must be redeclared here. Without this the bake below
# would silently see an empty value and install nothing.
ARG PYTHON_REQUIREMENTS
ARG PIP_INDEX_URL

LABEL org.opencontainers.image.title="DeepSeek Harness Web UI" \
      org.opencontainers.image.description="Self-hosted DeepSeek Harness Web GUI with common Linux tooling, reachable from non-local IPs." \
      org.opencontainers.image.source="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.version="0.2.1-alpha.1" \
      org.opencontainers.image.licenses="MIT"

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DSH_HOME=/home/node/.dsh \
    DSH_WORKDIR=/workspace \
    DSH_LISTEN_HOST=0.0.0.0 \
    DSH_EXPOSE_PORT=3080 \
    DSH_INTERNAL_PORT=3081 \
    NODE_OPTIONS=--max-old-space-size=4096

# The built harness: workspace packages, node_modules, and apps/web/dist.
COPY --from=build --chown=node:node /app /app

# Container glue.
COPY docker/entrypoint.mjs /usr/local/lib/dsh-docker/entrypoint.mjs
COPY docker/reverse-proxy.mjs /usr/local/lib/dsh-docker/reverse-proxy.mjs
COPY docker/container-env.mjs /usr/local/lib/dsh-docker/container-env.mjs
COPY docker/python-runtime.mjs /usr/local/lib/dsh-docker/python-runtime.mjs
COPY docker/dsh-docker-entrypoint /usr/local/bin/dsh-docker-entrypoint
COPY docker/shell/ll /usr/local/bin/ll
COPY docker/shell/get /usr/local/bin/get
COPY docker/shell/dsh-aliases.sh /etc/profile.d/00-dsh-aliases.sh
COPY docker/shell/dsh-python.sh /etc/profile.d/01-dsh-python.sh

# Optional self-contained Python environment. Installing a requirements file
# here is what makes the image large; mounting a virtual environment at runtime
# is the alternative the README documents. `PYTHON_REQUIREMENTS` is a path
# inside the build context, which `COPY . .` already placed at /app. The venv
# path is the BAKED_VENV_PATH constant in ./python-runtime.mjs, which selects
# this environment automatically.
RUN set -eux; \
    if [ -n "${PYTHON_REQUIREMENTS}" ]; then \
      python3 -m venv /opt/dsh-python; \
      /opt/dsh-python/bin/pip install --no-cache-dir --upgrade pip; \
      /opt/dsh-python/bin/pip install --no-cache-dir \
        --index-url "${PIP_INDEX_URL}" --retries 5 \
        -r "/app/${PYTHON_REQUIREMENTS}"; \
      /opt/dsh-python/bin/python -c 'import sys; print("baked python", sys.version.split()[0])'; \
      chown -R node:node /opt/dsh-python; \
    fi

RUN set -eux; \
    chmod 0755 \
      /usr/local/lib/dsh-docker/entrypoint.mjs \
      /usr/local/lib/dsh-docker/reverse-proxy.mjs \
      /usr/local/lib/dsh-docker/container-env.mjs \
      /usr/local/lib/dsh-docker/python-runtime.mjs \
      /usr/local/bin/dsh-docker-entrypoint \
      /usr/local/bin/ll \
      /usr/local/bin/get; \
    chmod 0644 /etc/profile.d/00-dsh-aliases.sh /etc/profile.d/01-dsh-python.sh; \
    printf '\n# DeepSeek Harness container shell setup.\nsource /etc/profile.d/00-dsh-aliases.sh\nsource /etc/profile.d/01-dsh-python.sh\n' >> /etc/bash.bashrc; \
    printf '\n# DeepSeek Harness container shell setup.\nsource /etc/profile.d/00-dsh-aliases.sh\nsource /etc/profile.d/01-dsh-python.sh\n' >> /home/node/.bashrc; \
    mkdir -p /workspace "${DSH_HOME}" "${PNPM_HOME}"; \
    chown -R node:node /workspace "${DSH_HOME}" "${PNPM_HOME}" /home/node/.bashrc /home/node/.npmrc

USER node

WORKDIR /workspace

# 3080 is the published port; 3081 stays on loopback inside the container.
EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${DSH_EXPOSE_PORT}/__dsh_proxy_health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/dsh-docker-entrypoint"]
CMD ["serve"]
