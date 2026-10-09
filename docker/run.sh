#!/usr/bin/env bash
#
# Run the DeepSeek Harness Web UI image without Compose.
#
#   ./docker/run.sh                        # publish 3080, workspace = repository root
#   ./docker/run.sh --port 8080            # publish a different host port
#   ./docker/run.sh --workspace ~/project  # sandbox the agent in one project
#   ./docker/run.sh --shell                # drop into the sandbox instead
#   ./docker/run.sh --python-venv /opt/software/flowai-gp-v4/warehouse/flowai-wh-python/.venv
#
# The startup log prints the exact token URL to open in a browser, including
# when the browser is on another machine.
set -euo pipefail

IMAGE="deepseek-harness-web:0.2.1-alpha.1"
HOST_PORT=3080
CONTAINER_NAME="dsh-web"
WORKSPACE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=""
DETACH=1
BASH_MODE=0
PYTHON_VENV=""
PYTHON_WRITABLE=0

usage() {
  cat <<'EOF'
Usage: run.sh [options]

  --image <tag>            image to run (default: deepseek-harness-web:0.2.1-alpha.1)
  --port <host-port>       host port to publish (default: 3080)
  --name <container>       container name (default: dsh-web)
  --workspace <dir>        directory mounted at /workspace (default: repository root)
  --env-file <file>        environment file passed to the container
  --python-venv <dir>      virtual environment to activate in the container; its
                           base interpreter is mounted too, both read-only and
                           at their original absolute paths
  --python-venv-writable   mount that environment read-write instead
  --foreground             do not detach
  --shell                  run bash in the sandbox instead of the server
  -h, --help               show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?}"; shift 2 ;;
    --port) HOST_PORT="${2:?}"; shift 2 ;;
    --name) CONTAINER_NAME="${2:?}"; shift 2 ;;
    --workspace) WORKSPACE="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --python-venv) PYTHON_VENV="${2:?}"; shift 2 ;;
    --python-venv-writable) PYTHON_WRITABLE=1; shift ;;
    --foreground) DETACH=0; shift ;;
    --shell) BASH_MODE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ! -d "${WORKSPACE}" ]; then
  echo "run.sh: workspace ${WORKSPACE} is not a directory" >&2
  exit 2
fi
WORKSPACE="$(cd "${WORKSPACE}" && pwd)"

PYTHON_MOUNTS=()
PYTHON_ENV=()
if [ -n "${PYTHON_VENV}" ]; then
  if [ ! -d "${PYTHON_VENV}" ]; then
    echo "run.sh: --python-venv ${PYTHON_VENV} is not a directory" >&2
    exit 2
  fi
  PYTHON_VENV="$(cd "${PYTHON_VENV}" && pwd)"
  if [ ! -f "${PYTHON_VENV}/pyvenv.cfg" ]; then
    echo "run.sh: ${PYTHON_VENV} has no pyvenv.cfg; --python-venv expects a virtual environment" >&2
    exit 2
  fi
  MODE="ro"
  [ "${PYTHON_WRITABLE}" = "1" ] && MODE="rw"
  # A venv records absolute paths (pyvenv.cfg's `home`, the bin/python3 symlink),
  # so it must appear at the same path inside the container. Its base runtime
  # usually lives outside the venv and needs the same treatment.
  BASE_HOME="$(sed -n 's/^[[:space:]]*home[[:space:]]*=[[:space:]]*//p' "${PYTHON_VENV}/pyvenv.cfg" | head -1)"
  PYTHON_MOUNTS+=(--volume "${PYTHON_VENV}:${PYTHON_VENV}:${MODE}")
  if [ -n "${BASE_HOME}" ]; then
    BASE_RUNTIME="$(cd "${BASE_HOME}/.." 2>/dev/null && pwd || true)"
    case "${BASE_RUNTIME}" in
      "") echo "run.sh: warning: pyvenv.cfg home ${BASE_HOME} does not exist on this host" >&2 ;;
      "${PYTHON_VENV}"/*) : ;;
      *) PYTHON_MOUNTS+=(--volume "${BASE_RUNTIME}:${BASE_RUNTIME}:${MODE}") ;;
    esac
  fi
  PYTHON_ENV+=(--env "DSH_PYTHON_VENV=${PYTHON_VENV}")
  echo "run.sh: python venv ${PYTHON_VENV} (${MODE})"
fi

ARGS=(
  --name "${CONTAINER_NAME}"
  --publish "${HOST_PORT}:3080"
  --volume "${WORKSPACE}:/workspace"
  --volume "${CONTAINER_NAME}-home:/home/node/.dsh"
  --env "DSH_WORKDIR=/workspace"
  --env "DSH_EXPOSE_PORT=3080"
  --env "DSH_TELEMETRY_DISABLED=true"
  --env "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}"
  "${PYTHON_MOUNTS[@]}"
  "${PYTHON_ENV[@]}"
)
[ -n "${DEEPSEEK_BASE_URL:-}" ] && ARGS+=(--env "DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL}")
[ -n "${DSH_PUBLIC_URL:-}" ] && ARGS+=(--env "DSH_PUBLIC_URL=${DSH_PUBLIC_URL}")
[ -n "${ENV_FILE}" ] && ARGS+=(--env-file "${ENV_FILE}")

if [ "${BASH_MODE}" = "1" ]; then
  exec docker run --rm -it "${ARGS[@]}" "${IMAGE}" bash
fi

if [ "${DETACH}" = "1" ]; then
  ARGS+=(--detach)
fi

exec docker run "${ARGS[@]}" "${IMAGE}" serve
