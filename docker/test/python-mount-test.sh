#!/usr/bin/env bash
#
# Integration test: mount a host Python virtual environment into the image and
# prove the container activates and can use it.
#
#   ./docker/test/python-mount-test.sh --venv /opt/.../flowai-wh-python/.venv
#   ./docker/test/python-mount-test.sh --venv /srv/py/.venv --all
#
# It asserts, through the real entrypoint (not by calling the interpreter
# directly), that `python3` and `pip` resolve to the mounted environment and
# that its packages import.
#
# A virtual environment records the absolute path it was created at, so the
# tree is mounted back at that same path. `--stage-from/--stage-to` exists for
# hosts whose container runtime cannot read the original location (the confined
# snap daemon, for example): it mounts a copy instead, still at the original
# container path.
set -uo pipefail

IMAGE="deepseek-harness-web:0.2.1-alpha.1"
VENV="${DSH_PYTHON_VENV:-}"
STAGE_FROM=""
STAGE_TO=""
MODULES="pandas,numpy,sqlalchemy,lxml,requests,yaml,pymysql,openpyxl"
CHECK_ALL=0

usage() {
  cat <<'EOF'
Usage: python-mount-test.sh --venv <dir> [options]

  --venv <dir>            host virtual environment to mount (or $DSH_PYTHON_VENV)
  --image <tag>           image under test (default: deepseek-harness-web:0.2.1-alpha.1)
  --modules <a,b,c>       modules whose import the container must prove
  --all                   import every top-level module the environment declares
  --stage-from <dir>      original host root that the runtime cannot read
  --stage-to <dir>        readable copy of that root
  -h, --help              show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --venv) VENV="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --modules) MODULES="${2:?}"; shift 2 ;;
    --all) CHECK_ALL=1; shift ;;
    --stage-from) STAGE_FROM="${2:?}"; shift 2 ;;
    --stage-to) STAGE_TO="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "python-mount-test.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
info() { printf '\033[36m==> %s\033[0m\n' "$1"; }
FAILURES=0

if [ -z "${VENV}" ]; then
  echo "python-mount-test.sh: --venv is required (or set DSH_PYTHON_VENV)" >&2
  exit 2
fi
[ -d "${VENV}" ] || { echo "python-mount-test.sh: ${VENV} is not a directory" >&2; exit 2; }
VENV="$(cd "${VENV}" && pwd)"
[ -f "${VENV}/pyvenv.cfg" ] || { echo "python-mount-test.sh: ${VENV} has no pyvenv.cfg" >&2; exit 2; }

# Map one original host path to the path the container runtime should mount.
map_source() {
  local original="$1"
  if [ -n "${STAGE_FROM}" ] && [ -n "${STAGE_TO}" ]; then
    printf '%s%s' "${STAGE_TO%/}" "${original#"${STAGE_FROM%/}"}"
  else
    printf '%s' "${original}"
  fi
}

MOUNTS=()
mount_path() {
  local original="$1" source
  source="$(map_source "${original}")"
  if [ ! -d "${source}" ]; then
    echo "python-mount-test.sh: cannot mount ${original}: ${source} is not a directory" >&2
    exit 2
  fi
  MOUNTS+=(--volume "${source}:${original}:ro")
}

mount_path "${VENV}"
BASE_HOME="$(sed -n 's/^[[:space:]]*home[[:space:]]*=[[:space:]]*//p' "${VENV}/pyvenv.cfg" | head -1)"
BASE_RUNTIME=""
if [ -n "${BASE_HOME}" ]; then
  BASE_RUNTIME="$(cd "${BASE_HOME}/.." 2>/dev/null && pwd || true)"
  if [ -n "${BASE_RUNTIME}" ]; then
    mount_path "${BASE_RUNTIME}"
  fi
fi

info "image ${IMAGE}"
info "venv  ${VENV}"
[ -n "${BASE_RUNTIME}" ] && info "base  ${BASE_RUNTIME}"

HOST_VERSION="$("${VENV}/bin/python" -c 'import sys; print(sys.version.split()[0])' 2>/dev/null || echo unknown)"
info "host interpreter reports ${HOST_VERSION}"

if [ "${CHECK_ALL}" = "1" ]; then
  SP="$(find "${VENV}/lib" -maxdepth 3 -type d -name 'site-packages' | head -1)"
  if [ -z "${SP}" ]; then
    echo "python-mount-test.sh: no site-packages under ${VENV}/lib" >&2
    exit 2
  fi
  MODULES="$(cat "${SP}"/*.dist-info/top_level.txt 2>/dev/null \
    | grep -vE '^[[:space:]]*$' | grep -vE '^_' | sort -u | paste -sd, -)"
  COUNT="$(printf '%s' "${MODULES}" | tr ',' '\n' | grep -c . || true)"
  if [ "${COUNT}" -lt 1 ]; then
    echo "python-mount-test.sh: no top_level.txt entries found under ${SP}" >&2
    exit 2
  fi
  info "checking every declared top-level module (${COUNT} entries)"
fi

REPORT="$(timeout 300 docker run --rm \
  "${MOUNTS[@]}" \
  --env "DSH_PYTHON_VENV=${VENV}" \
  --env "DSH_TEST_MODULES=${MODULES}" \
  "${IMAGE}" bash -lc '
    echo "which-python $(command -v python3)"
    echo "which-pip $(command -v pip)"
    echo "version $(python3 -c "import sys; print(sys.version.split()[0])")"
    echo "prefix $(python3 -c "import sys; print(sys.prefix)")"
    echo "virtualenv ${VIRTUAL_ENV:-unset}"
    python3 -c "import importlib,os
mods=[m for m in os.environ.get(\"DSH_TEST_MODULES\",\"\").split(\",\") if m]
ok=[];bad=[]
for m in mods:
    try:
        importlib.import_module(m);ok.append(m)
    except Exception as e:
        bad.append(m+\"(\"+type(e).__name__+\")\")
print(\"imported\",len(ok),\"of\",len(mods))
print(\"failed\",\",\".join(bad) if bad else \"none\")
"
  ' 2>&1)"
STATUS=$?

echo "${REPORT}"

info "results"
if [ "${STATUS}" -ne 0 ]; then
  fail "container exited ${STATUS}"
else
  pass "container ran the mounted environment"
fi
grep -q "which-python ${VENV}/bin/python3" <<<"${REPORT}" \
  && pass "python3 resolves to the mounted environment" \
  || fail "python3 does not resolve to ${VENV}/bin/python3"
grep -q "prefix ${VENV}" <<<"${REPORT}" \
  && pass "sys.prefix is the mounted environment" \
  || fail "sys.prefix is not ${VENV}"
grep -q "virtualenv ${VENV}" <<<"${REPORT}" \
  && pass "VIRTUAL_ENV is exported" \
  || fail "VIRTUAL_ENV is not ${VENV}"
grep -q "version ${HOST_VERSION}" <<<"${REPORT}" \
  && pass "interpreter version matches the host (${HOST_VERSION})" \
  || fail "interpreter version differs from the host (${HOST_VERSION})"
grep -q "^failed none$" <<<"${REPORT}" \
  && pass "every requested module imported" \
  || fail "some modules did not import (see the report above)"

echo
if [ "${FAILURES}" -eq 0 ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m\n'
  exit 0
fi
printf '\033[31m%s CHECK(S) FAILED\033[0m\n' "${FAILURES}"
exit 1
