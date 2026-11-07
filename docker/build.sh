#!/usr/bin/env bash
#
# Build the DeepSeek Harness Web UI image.
#
#   ./docker/build.sh                          # build for this machine's architecture
#   ./docker/build.sh --tarball dist           # also export a loadable .tar.gz
#   ./docker/build.sh --arch both --push       # multi-arch push (needs a registry)
#   ./docker/build.sh --arch arm64 --load      # cross-build arm64 and load it
#
# Everything is compiled inside the target-architecture image, so an arm64
# build is a plain `--platform linux/arm64` build rather than a cross-compile.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

IMAGE_TAG="deepseek-harness-web:0.2.2-rc.1"
ARCH="native"
NPM_REGISTRY="https://registry.npmmirror.com"
DEBIAN_MIRROR=""
PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
PYTHON_REQUIREMENTS=""
PYTHON_EXTRA_PACKAGES=""
MODE="load"
TARBALL_DIR=""
NO_CACHE=""
PUSH_REGISTRY=""

usage() {
  cat <<'EOF'
Usage: build.sh [options]

  --arch <native|amd64|arm64|both>   architectures to build (default: native)
  --tag <image:tag>                  image tag (default: deepseek-harness-web:0.2.2-rc.1)
  --push                             push the built image(s) to a registry
  --load                             load a single-architecture build into Docker (default)
  --registry <host/namespace>        prefix for --push, e.g. registry.example.com/team
  --npm-registry <url>               npm registry used inside the build
                                     (default: https://registry.npmmirror.com)
  --debian-mirror <url>              apt mirror root used inside the build, e.g.
                                     https://mirrors.tuna.tsinghua.edu.cn
                                     (default: the base image's own sources)
  --python-requirements <path>       requirements file (path inside the repository)
                                     installed into /opt/dsh-python in the image,
                                     which the container then activates
  --pip-index-url <url>              package index for that install
                                     (default: https://pypi.tuna.tsinghua.edu.cn/simple)
  --python-extra-packages <pkgs>     extra apt packages, e.g. build-essential
  --tarball <dir>                    export the built image as <dir>/<name>-<arch>.tar.gz
  --no-cache                         disable the Docker build cache
  -h, --help                         show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch) ARCH="${2:?--arch needs a value}"; shift 2 ;;
    --tag) IMAGE_TAG="${2:?--tag needs a value}"; shift 2 ;;
    --push) MODE="push"; shift ;;
    --load) MODE="load"; shift ;;
    --registry) PUSH_REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --npm-registry) NPM_REGISTRY="${2:?--npm-registry needs a value}"; shift 2 ;;
    --debian-mirror) DEBIAN_MIRROR="${2:?--debian-mirror needs a value}"; shift 2 ;;
    --python-requirements) PYTHON_REQUIREMENTS="${2:?--python-requirements needs a value}"; shift 2 ;;
    --pip-index-url) PIP_INDEX_URL="${2:?--pip-index-url needs a value}"; shift 2 ;;
    --python-extra-packages) PYTHON_EXTRA_PACKAGES="${2:?--python-extra-packages needs a value}"; shift 2 ;;
    --tarball) TARBALL_DIR="${2:?--tarball needs a directory}"; shift 2 ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

NATIVE_ARCH="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo amd64)"
case "${NATIVE_ARCH}" in
  x86_64|amd64) NATIVE_ARCH="amd64" ;;
  aarch64|arm64) NATIVE_ARCH="arm64" ;;
esac

# The image build rewrites dependencies that are only published outside npm
# (SheetJS `xlsx` lives on its own CDN) to tarballs vendored under
# docker/vendor/ — see docker/patch-vendored-deps.mjs. Those binaries may be
# untracked in git, so check them before a long build starts instead of failing
# at the install step.
VENDORED_TARBALL="${SCRIPT_DIR}/vendor/xlsx-0.20.3.tgz"
if [ ! -f "${VENDORED_TARBALL}" ]; then
  echo "build.sh: missing ${VENDORED_TARBALL}" >&2
  echo "build.sh: xlsx 0.20.x is only published on cdn.sheetjs.com; copy the vendored copy" >&2
  echo "build.sh: into docker/vendor/ (docker/patch-vendored-deps.mjs names the file), then re-run." >&2
  exit 2
fi

case "${ARCH}" in
  native) PLATFORMS="linux/${NATIVE_ARCH}" ;;
  amd64) PLATFORMS="linux/amd64" ;;
  arm64) PLATFORMS="linux/arm64" ;;
  both) PLATFORMS="linux/amd64,linux/arm64" ;;
  *) echo "build.sh: --arch must be native, amd64, arm64, or both" >&2; exit 2 ;;
esac

if [ "${MODE}" = "push" ]; then
  if [ -z "${PUSH_REGISTRY}" ]; then
    echo "build.sh: --push needs --registry <host/namespace>" >&2
    exit 2
  fi
  TARGET="${PUSH_REGISTRY%/}/${IMAGE_TAG}"
  OUTPUT=(--push)
elif [ "${PLATFORMS}" = "linux/amd64,linux/arm64" ]; then
  echo "build.sh: loading two architectures at once is not possible; use --push for multi-arch" >&2
  exit 2
else
  TARGET="${IMAGE_TAG}"
  OUTPUT=(--load)
fi

# buildx is optional for a native build. Detect it in a form that survives
# `set -o pipefail`: a failing command substitution inside an assignment aborts
# the whole script, and discarding its stderr makes that exit silent.
BUILDX_VERSION=""
if BUILDX_VERSION="$(docker buildx version 2>&1)"; then
  :
else
  BUILDX_VERSION=""
fi

# `--load` for a non-native platform needs the docker-container driver, because
# the default "docker" driver builds only for the host architecture.
DRIVER=""
if [ -n "${BUILDX_VERSION}" ]; then
  if INSPECT_OUTPUT="$(docker buildx inspect --bootstrap 2>&1)"; then
    DRIVER="$(printf '%s\n' "${INSPECT_OUTPUT}" | awk -F': *' '/^Driver/{print $2; exit}')"
  else
    echo "build.sh: warning: 'docker buildx inspect --bootstrap' failed:" >&2
    printf '%s\n' "${INSPECT_OUTPUT}" | sed 's/^/  /' >&2
  fi
fi

CROSS_BUILD=0
if [ "${PLATFORMS}" != "linux/${NATIVE_ARCH}" ]; then
  CROSS_BUILD=1
fi

if [ "${CROSS_BUILD}" = "1" ]; then
  if [ -z "${BUILDX_VERSION}" ] || [ "${DRIVER}" != "docker-container" ]; then
    cat >&2 <<EOF
build.sh: building ${PLATFORMS} from ${NATIVE_ARCH} needs buildx with the
"docker-container" driver (detected: ${DRIVER:-no usable buildx}).

Install the plugin if it is missing, then create a container builder once:

  docker buildx create --name dsh-multiarch --driver docker-container --use --bootstrap
  docker buildx inspect --bootstrap

Note: a non-native build runs the whole toolchain under emulation. Build on the
target machine (or an arm64 CI runner) when you can — that is both faster and a
truer test of the arm64 result.
EOF
    exit 3
  fi
fi

echo "==> building ${TARGET} for ${PLATFORMS} (npm registry: ${NPM_REGISTRY})"
if [ -n "${BUILDX_VERSION}" ] && [ -n "${DRIVER}" ]; then
  # shellcheck disable=SC2086
  docker buildx build \
    --file "${SCRIPT_DIR}/Dockerfile" \
    --platform "${PLATFORMS}" \
    --tag "${TARGET}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR}" \
    --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}" \
    --build-arg "PYTHON_REQUIREMENTS=${PYTHON_REQUIREMENTS}" \
    --build-arg "PYTHON_EXTRA_PACKAGES=${PYTHON_EXTRA_PACKAGES}" \
    ${NO_CACHE} \
    "${OUTPUT[@]}" \
    "${ROOT_DIR}"
else
  # No usable buildx. Two fallbacks, cheapest first:
  #   1. `DOCKER_BUILDKIT=1 docker build` — Docker 19.03–20.10 ship BuildKit in
  #      the CLI, so this works without the plugin.
  #   2. The classic builder over a copy of the Dockerfile whose only
  #      BuildKit-only instruction (`RUN --mount=type=cache`) is dropped. Docker
  #      23 and newer refuse fallback 1 with "the buildx component is missing",
  #      and the cache mount is the Dockerfile's only BuildKit feature.
  # A native build needs no --platform; a push becomes a separate `docker push`.
  echo "build.sh: buildx unavailable; trying 'DOCKER_BUILDKIT=1 docker build'" >&2
  # shellcheck disable=SC2086
  if DOCKER_BUILDKIT=1 docker build \
    --file "${SCRIPT_DIR}/Dockerfile" \
    --tag "${TARGET}" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
    --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR}" \
    --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}" \
    --build-arg "PYTHON_REQUIREMENTS=${PYTHON_REQUIREMENTS}" \
    --build-arg "PYTHON_EXTRA_PACKAGES=${PYTHON_EXTRA_PACKAGES}" \
    ${NO_CACHE} \
    "${ROOT_DIR}"; then
    :
  else
    echo "build.sh: BuildKit needs the buildx plugin here; falling back to the classic builder" >&2
    LEGACY_DOCKERFILE="$(mktemp)"
    sed 's/^RUN --mount=type=cache[^ ]* /RUN /' "${SCRIPT_DIR}/Dockerfile" > "${LEGACY_DOCKERFILE}"
    LEGACY_IGNORE_CREATED=0
    if [ ! -f "${ROOT_DIR}/.dockerignore" ]; then
      # The classic builder only reads `.dockerignore` at the context root, not
      # the `<dockerfile>.dockerignore` name BuildKit resolves.
      cp "${SCRIPT_DIR}/Dockerfile.dockerignore" "${ROOT_DIR}/.dockerignore"
      LEGACY_IGNORE_CREATED=1
    fi
    cleanup_legacy() {
      rm -f "${LEGACY_DOCKERFILE}"
      if [ "${LEGACY_IGNORE_CREATED}" = "1" ]; then rm -f "${ROOT_DIR}/.dockerignore"; fi
    }
    trap cleanup_legacy EXIT
    # shellcheck disable=SC2086
    DOCKER_BUILDKIT=0 docker build \
      --file "${LEGACY_DOCKERFILE}" \
      --tag "${TARGET}" \
      --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" \
      --build-arg "DEBIAN_MIRROR=${DEBIAN_MIRROR}" \
      --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}" \
      --build-arg "PYTHON_REQUIREMENTS=${PYTHON_REQUIREMENTS}" \
      --build-arg "PYTHON_EXTRA_PACKAGES=${PYTHON_EXTRA_PACKAGES}" \
      ${NO_CACHE} \
      "${ROOT_DIR}"
    cleanup_legacy
    trap - EXIT
    if [ "${MODE}" = "push" ]; then
      docker push "${TARGET}"
    fi
  fi
fi

if [ -n "${TARBALL_DIR}" ]; then
  mkdir -p "${TARBALL_DIR}"
  SAFE_NAME="$(printf '%s' "${IMAGE_TAG}" | tr '/:' '__')"
  OUT_FILE="${TARBALL_DIR}/${SAFE_NAME}_${PLATFORMS##*/}.tar.gz"
  echo "==> exporting ${TARGET} to ${OUT_FILE}"
  docker save "${TARGET}" | gzip -1 > "${OUT_FILE}"
  echo "==> ${OUT_FILE} ($(du -h "${OUT_FILE}" | cut -f1))"
fi

echo "==> done: ${TARGET}"
