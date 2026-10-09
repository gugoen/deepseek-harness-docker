# DeepSeek Harness Web UI container image

A self-contained Docker image for the DeepSeek Harness Web GUI, built from this
repository's source. It ships the common Linux tooling the agent and its sandbox
need, and it is reachable from a non-local IP.

- Harness version: `0.2.1-alpha.1` (whatever `package.json` in this checkout says)
- Architectures: `linux/amd64`, `linux/arm64` (and anything else
  `node:22-bookworm-slim` supports) — everything compiles inside the target
  image, so no cross-compilation flags are involved
- Base image: `node:22-bookworm-slim` (Debian 12)

中文文档见 [README.zh.md](README.zh.md)。

## Why this image exists

`dsh --profile web` binds `127.0.0.1`, refuses `--host 0.0.0.0`, and applies a
browser-trust fence to every `/api` request
(`packages/client/connection/src/api-request-trust.ts`). That fence requires the
request's `Host` authority to be loopback or an explicitly declared
`--trusted-host`. A plain Docker port mapping rewrites no headers, so a browser
on another machine sends its own authority and receives **403** before the
request ever reaches the RPC bridge. On top of that the browser-session cookie
is signed *for the request authority*, so an authority that changes between
requests also breaks the session.

The image therefore leaves the harness exactly as designed on loopback, and
publishes it through a small Host-rewriting reverse proxy:

```
browser  ──►  container:0.0.0.0:3080   (reverse-proxy.mjs)
                     │  rewrites Host → 127.0.0.1:3081, drops Origin,
                     │  forwards WebSocket upgrades byte-for-byte
                     ▼
              dsh web on 127.0.0.1:3081  (untouched source, loopback bind)
```

Because `Host` is rewritten to the loopback authority, the trust fence admits
every request and the authority-bound cookie stays consistent — for any external
IP or hostname, with no `--trusted-host` bookkeeping and no source patch.

The two behaviours are independent: the container is also a usable sandbox for
`dsh` itself (`docker run --rm -it <image> bash`).

## Files

| Path | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage build: toolchain → workspace install → build → slim runtime |
| `Dockerfile.dockerignore` | Build-context filter (specific to `Dockerfile`) |
| `entrypoint.mjs` | Container supervisor: starts `dsh web`, prints the token URL, runs the proxy |
| `reverse-proxy.mjs` | Host-rewriting HTTP/WebSocket publisher (no third-party dependencies) |
| `python-runtime.mjs` | Selects and activates the Python virtual environment |
| `dsh-docker-entrypoint` | Entrypoint shim; `serve` starts the server, anything else is executed verbatim |
| `shell/ll`, `shell/get` | Real commands for `ll` (`ls -alF`) and `get` (curl downloader) |
| `python/requirements-common.txt` | Reference dependency set for `--python-requirements` |
| `shell/dsh-aliases.sh` | Interactive aliases in `/etc/profile.d` |
| `shell/dsh-python.sh` | Re-activates the Python environment for login shells and `docker exec` |
| `docker-compose.yml` | Compose deployment |
| `docker-compose.python.yml` | Compose override mounting a host Python environment |
| `.env.example` | Copy to `.env` for Compose |
| `build.sh` | Build helper, including multi-arch and tarball export |
| `run.sh` | `docker run` helper without Compose |
| `test/smoke-test.sh` | End-to-end container test over a non-loopback address |
| `test/reverse-proxy.test.mjs` | Keyless unit tests for the proxy (Host rewrite, Origin drop, WebSocket) |
| `test/python-runtime.test.mjs` | Keyless unit tests for Python environment selection |
| `test/python-mount-test.sh` | End-to-end test of a mounted host Python environment |
| `test/check-arm64-packages.py` | Checks the apt package list against the Debian arm64 indexes |

## Quick start

### Compose

```sh
cp docker/.env.example docker/.env
$EDITOR docker/.env                     # at least DEEPSEEK_API_KEY
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f
```

### docker run

```sh
./docker/build.sh                       # build for this machine's architecture
./docker/run.sh --workspace ~/my-project
docker logs -f dsh-web
```

Or by hand:

```sh
docker run -d --name dsh-web \
  -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD":/workspace \
  -v dsh-home:/home/node/.dsh \
  deepseek-harness-web:0.2.1-alpha.1
```

## Deploying the prebuilt package

A built image is exported to `docker/dist/` as a loadable archive plus its
checksum:

```sh
docker load < docker/dist/deepseek-harness-web_0.2.1-alpha.1_amd64.tar.gz
sha256sum -c docker/dist/SHA256SUMS.txt   # from inside docker/dist
docker run -d --name dsh-web -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... -v dsh-home:/home/node/.dsh \
  deepseek-harness-web:0.2.1-alpha.1
```

The archive is architecture-specific. Copy the repository to the arm64 machine
and build there instead of shipping the amd64 archive across architectures.

## Accessing it from another machine

The startup log prints a ready banner with the exact URL, including the
per-process launch token:

```
=====================================================================
 DeepSeek Harness Web UI is ready / 服务已就绪
   in-container : http://127.0.0.1:3081/?token=xxxxxxxx
   remote (LAN) : http://<THIS-HOST-IP>:3080/?token=xxxxxxxx
=====================================================================
```

Open the `remote` URL with `<THIS-HOST-IP>` replaced by the address of the
machine running the container. The token mints a browser-session cookie; that
cookie is then what authenticates the UI, so the token is only needed for the
first request. Do not share a token URL.

Set `DSH_PUBLIC_URL` (or `DSH_PUBLIC_HOST`) so the harness prints a fixed,
correct address instead of the `127.0.0.1` default:

```sh
docker run ... -e DSH_PUBLIC_URL=http://192.168.1.50:3080 ...
```

Chat and sessions work over that address, but **the settings pages do not** — the
harness only enables those for a loopback address. See
[Settings require a loopback address](#settings-require-a-loopback-address).

### Settings require a loopback address

The harness gates its **settings** surface on the hostname the browser used.
`location.hostname` must be `localhost`, `[::1]`, or a `127.x.x.x` literal;
on any other authority the client disables Host-backed settings:

```ts
// packages/client/ui-settings/src/client/index.ts
const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
```

A non-loopback page therefore opens **Settings → Models** with
`settings are unavailable in this browser`, and every other form backed by the
Host settings document behaves the same way. This is deliberate and documented
upstream — [ui-settings README](../../packages/client/ui-settings/README.md),
"Non-loopback pages get no durable settings".

Two things it is **not**:

- not a browser problem (any Chrome/Edge/Firefox behaves identically);
- not something this image's reverse proxy can change. The proxy rewrites the
  `Host` *header* on the wire, while this check reads the browser's own address
  bar. `--trusted-host` and `DSH_PUBLIC_URL` grant API access and change what is
  advertised; neither makes the page loopback.

Chat, sessions, and the composer's model picker are unaffected — the model list
comes from the Host catalog, not from the settings mirror. Only the settings
pages need a loopback address.

Both fixes below forward a local port on the client machine to the container's
published port, so the browser's own URL becomes `127.0.0.1`.

#### Windows: `netsh interface portproxy` (no extra software)

Run this in an **elevated** Command Prompt on the Windows client. Windows'
`IP Helper` service (`iphlpsvc`) must be running.

```bat
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3080 connectaddress=<SERVER-IP> connectport=3080
```

For example, against a server at `10.64.1.3`:

```bat
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3080 connectaddress=10.64.1.3 connectport=3080
```

Inspect the rules, and remove one when you are done:

```bat
netsh interface portproxy show all

netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=3080
```

- `listenaddress=127.0.0.1` keeps the forwarder on the client's own loopback —
  that is exactly what makes the browser's hostname loopback. Do **not** use
  `0.0.0.0` on a client machine: that turns it into an open relay for everyone on
  the network.
- `connectaddress` is the machine running the container; `connectport` is the
  **published host port** (the left side of `-p <host>:3080`).
- `listenport` is free to choose; reusing the published port keeps the printed
  URL valid as-is.

It is the **published** port that matters, not the container's internal one. If
the container runs as `-p 3081:3080`, the forward target is `connectport=3081`:

```bat
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3080 connectaddress=10.64.1.3 connectport=3081
```

Then browse `http://127.0.0.1:3080/?token=<token from docker logs>` (or
`http://127.0.0.1:3081/...` when `listenport` is also 3081).

If the container is the only thing you reach this way, advertise that address so
the startup banner prints the URL you should actually open:

```sh
docker run ... -e DSH_PUBLIC_URL=http://127.0.0.1:3080 ...
```

#### Any platform: SSH local forwarding

```sh
ssh -L 3080:127.0.0.1:3080 user@<SERVER-IP>
# Windows without OpenSSH: plink -L 3080:127.0.0.1:3080 user@<SERVER-IP>
```

Then browse `http://127.0.0.1:3080/?token=<token>`.

#### If you cannot forward a port

Set the model credentials through the container environment instead of the GUI.
The agent needs no settings write to call a model:

```sh
docker run ... -e DEEPSEEK_API_KEY=sk-... deepseek-harness-web:0.2.1-alpha.1
```

Only the settings *pages* are gated; the composer's model picker keeps working.

## Building

```sh
./docker/build.sh                                  # native architecture
./docker/build.sh --tarball dist                   # ... and export a loadable .tar.gz
./docker/build.sh --npm-registry https://registry.npmjs.org
./docker/build.sh --debian-mirror https://mirrors.tuna.tsinghua.edu.cn
./docker/build.sh --arch arm64 --load              # cross-build (needs a container driver, slow)
./docker/build.sh --arch both --registry registry.example.com/team --push
```

Directly with Docker:

```sh
docker build -f docker/Dockerfile -t deepseek-harness-web:0.2.1-alpha.1 .
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t dsh-web:arm64 --load .
```

The image is about 2.7 GB. Most of it is the harness's runtime dependency
closure — large optional providers and document/render engines (`@openai/codex`,
`@anthropic-ai/claude-agent-sdk`, `libreoffice-kit`, Mermaid, PDF and canvas
builds, `node-pty`) that the profile resolves at boot. It is not build residue:
the multi-stage build ships only `/app` and the tooling userland.

### arm64

Build on an arm64 machine — that is the fastest path and the truest test:

```sh
docker build -f docker/Dockerfile -t deepseek-harness-web:0.2.1-alpha.1 .
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1
```

Cross-building `linux/arm64` from `linux/amd64` also works, but runs the whole
`pnpm install` + TypeScript + Vite toolchain under QEMU, which is very slow. It
needs a `docker-container` builder:

```sh
docker buildx create --name dsh-multiarch --driver docker-container --use --bootstrap
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t dsh-web:arm64 --load .
```

The Dockerfile contains no architecture-specific step: the base image, the apt
package list, the pnpm install (which resolves platform-conditional optional
dependencies for the build architecture), and the Node-API `flock` addon all
resolve for whatever platform the build targets.

### Build arguments

| Argument | Default | Purpose |
| --- | --- | --- |
| `NODE_IMAGE` | `node:22-bookworm-slim` | Base image for every stage |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | npm registry used during the build; use `https://registry.npmjs.org` if the mirror is incomplete |
| `DEBIAN_MIRROR` | empty (base image sources) | apt mirror root, e.g. `https://mirrors.tuna.tsinghua.edu.cn`. Set it when `deb.debian.org` is unreachable; both `apt-get update` and the pnpm/npm installs already retry transient resolver failures. |
| `PYTHON_REQUIREMENTS` | empty | Requirements file (path inside the repository) installed into `/opt/dsh-python`; empty ships only Debian's `python3`. |
| `PIP_INDEX_URL` | `https://pypi.tuna.tsinghua.edu.cn/simple` | Package index used by that install. |
| `PYTHON_EXTRA_PACKAGES` | empty | Extra apt packages for the runtime image, e.g. `build-essential`. |
| `DSH_CLIENT_COMMIT_HASH` | `0000000` | Public commit value embedded in browser artifacts; set it to a real hash to make builds from a `.git`-less snapshot identify themselves |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Model access. The UI boots without it; sessions fail when they call the model. |
| `DEEPSEEK_BASE_URL` | unset | OpenAI-compatible endpoint override. Must not be exported empty — see the `Invalid URL` row under Troubleshooting. |
| `DSH_PUBLIC_URL` | unset | Advertised URL printed at startup and given to the model as `DSH_WEB_URL`. |
| `DSH_PUBLIC_HOST` | unset | Convenience alternative: `http://$DSH_PUBLIC_HOST:$DSH_EXPOSE_PORT` is derived. |
| `DSH_EXPOSE_PORT` | `3080` | Container port the reverse proxy publishes. |
| `DSH_INTERNAL_PORT` | `3081` | Loopback port the harness binds. Must differ from `DSH_EXPOSE_PORT`. |
| `DSH_LISTEN_HOST` | `0.0.0.0` | Interface the proxy listens on. |
| `DSH_WORKDIR` | `/workspace` | Working directory `dsh` starts in. |
| `DSH_HOME` | `/home/node/.dsh` | Harness home: sessions, credentials, cookies, profiles. |
| `DSH_WEB_EXTRA_ARGS` | unset | Extra arguments appended to `dsh web` (whitespace-separated). |
| `DSH_TELEMETRY_DISABLED` | unset (`true` in Compose) | Disable the harness's anonymous product telemetry. |
| `DSH_PYTHON_VENV` | unset | Virtual environment to activate; must be mounted at its original absolute path. `/opt/dsh-python` is used automatically when the image was built with `PYTHON_REQUIREMENTS`. |

## Persistence

| Path | Contents |
| --- | --- |
| `/home/node/.dsh` | Sessions, credentials, the browser-session signing secret, profiles. Mount a volume here to keep sessions and browsers logged in across restarts. |
| `/workspace` | The agent's working directory. |

```sh
-v dsh-home:/home/node/.dsh -v /path/to/project:/workspace
```

If you already have a `~/.dsh` on the host and want the container to reuse it,
mount that directory instead — it is the same format.

## Using the image as a sandbox

```sh
docker run --rm -it -v "$PWD":/workspace deepseek-harness-web:0.2.1-alpha.1 bash
# inside: ll, get, curl, wget, vim, git, rg, fd, bat, jq, tmux, htop, dig, nc, python3, pip, ...
docker run --rm deepseek-harness-web:0.2.1-alpha.1 ll /workspace
```

`ll` and `get` are real executables (not only aliases), so they also work in
non-interactive shells, `docker run <image> <cmd>` and scripts.

## Python

The image carries Debian's `python3` (3.11 on bookworm) with `pip`, `venv`, and
the development headers, so `python3` always works. A deployment that needs a
specific interpreter and site-packages has two options; mounting is the
size-friendly one.

### Mount a host virtual environment (recommended)

A virtual environment records the absolute path it was created at — `pyvenv.cfg`
names its base interpreter, and `bin/python3` is a symlink to it — so it cannot
simply be moved. Mount the tree **at the same absolute path** it lives at on the
host, and name the environment in `DSH_PYTHON_VENV`:

```sh
./docker/run.sh --python-venv /opt/software/flowai-gp-v4/warehouse/flowai-wh-python/.venv
```

`run.sh` reads `pyvenv.cfg`, mounts the environment *and* its base runtime
read-only at their original paths, and exports `DSH_PYTHON_VENV`. With Compose:

```sh
# docker/.env
DSH_PYTHON_ROOT=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python
DSH_PYTHON_VENV=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python/.venv

docker compose -f docker/docker-compose.yml \
               -f docker/docker-compose.python.yml up -d
```

By hand:

```sh
W=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python
docker run -d --name dsh-web -p 3080:3080 \
  -v "$W:$W:ro" -e DSH_PYTHON_VENV="$W/.venv" \
  -e DEEPSEEK_API_KEY=sk-... \
  deepseek-harness-web:0.2.1-alpha.1
```

The entrypoint activates the environment before starting the harness: its `bin`
goes to the front of `PATH`, `VIRTUAL_ENV` is exported, and a stale `PYTHONHOME`
is dropped. Because the harness passes its own environment to every shell the
agent runs, `python`, `python3`, `pip`, and the environment's console scripts
resolve to it inside the sandbox too. The startup log confirms it:

```
dsh-docker: python Python 3.10.18 (/opt/software/.../flowai-wh-python/.venv)
```

Mounts are read-only by default. Use `--python-venv-writable` (or drop
`read_only: true`) when the agent should `pip install` into it.

Two other entry points are covered by `/etc/profile.d/01-dsh-python.sh`, which
re-applies the same selection: a login shell (`bash -l`, which rebuilds `PATH`
from `/etc/profile`) and `docker exec`, which starts a process that never saw
the entrypoint's environment. A non-interactive `docker exec <container> bash -c
...` reads no startup file at all — pass `-e PATH=<venv>/bin:$PATH` there, or use
`./docker/run.sh --shell`.

#### Will a given environment run here?

Two things must hold, and the second is the one that bites:

1. The container runtime must be able to read the host path.
2. The environment's binaries must not need a newer glibc than the image's.
   Debian 12 provides **glibc 2.36**. A virtual environment built on a newer host
   (Ubuntu 24.04 is glibc 2.39) works only if its native extensions stayed within
   2.36 — which is the case for anything installed from manylinux wheels.

Check before mounting:

```sh
# highest glibc symbol the environment's native extensions require
find "$W/.venv/lib" -name '*.so' -print0 \
  | xargs -0 -n1 objdump -T 2>/dev/null \
  | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
# glibc inside the image
docker run --rm deepseek-harness-web:0.2.1-alpha.1 ldd --version | head -1
```

If the first is above the second, rebuild the environment inside the container
(`docker run --rm -v "$PWD":/w image python3 -m venv /w/.venv`) or use an image
matching the build host. The entrypoint fails loudly with that diagnosis rather
than starting a broken interpreter.

### Bake the requirements into the image

For an intranet host that cannot mount the environment, install a requirements
file at build time. The image creates `/opt/dsh-python` and activates it
automatically (no `DSH_PYTHON_VENV` needed):

```sh
cp /path/to/requirements.txt docker/python/requirements.txt
./docker/build.sh --python-requirements docker/python/requirements.txt

# a reference set ships with the image if you have no file of your own:
./docker/build.sh --python-requirements docker/python/requirements-common.txt
```

`PYTHON_REQUIREMENTS` is a path inside the build context (the repository root);
`PIP_INDEX_URL` selects the package index and defaults to the Tsinghua mirror.
Add `--python-extra-packages build-essential` when the file contains source
distributions rather than wheels. This is the option that makes the image large
— several hundred MB for a typical data-science requirements file — which is
exactly why mounting exists.

### Verify

```sh
# the image's own python3
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1

# a mounted environment, end to end through the real entrypoint
./docker/test/python-mount-test.sh --venv /opt/.../flowai-wh-python/.venv
./docker/test/python-mount-test.sh --venv /opt/.../flowai-wh-python/.venv --all

# the selection logic, without Docker
node --test docker/test/python-runtime.test.mjs
```

## Verifying an image

```sh
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1
```

The script starts a container, waits for its health check, then asserts *over a
non-loopback address* that: the harness answers 401 (not the fence's 403); the
launch-token exchange returns the UI shell and issues a session cookie; `/api`
is routed past the fence; the `/api/remote.mux` WebSocket upgrade returns 101;
an unauthenticated upgrade is still refused; and the expected commands exist
inside the sandbox.

The reverse proxy itself is covered without Docker:

```sh
node --test docker/test/reverse-proxy.test.mjs
```

It pins the three properties the container relies on: the upstream sees a
loopback `Host`, the browser's `Origin` never reaches the harness fence, and
WebSocket upgrades are forwarded at the byte level.

For arm64, `docker/test/check-arm64-packages.py` checks every apt package this
image installs against the Debian arm64 indexes, so the package list can be
validated without an arm64 host:

```sh
python3 docker/test/check-arm64-packages.py
```

## Security

The proxy removes the network-location restriction; it does **not** weaken the
harness's own authentication. Every UI request still needs the launch token or
the signed browser-session cookie, and the proxy does not add a bypass.

That said, a reachable `dsh` Web UI is a remote code execution surface by
design: the agent runs shell commands and edits files. Before exposing it beyond
a trusted network:

- Keep the port on a private LAN, WireGuard/Tailscale, or behind an SSH tunnel.
- Terminate TLS in front of it (`--public-url https://...` sets the advertised
  URL only; it does not add TLS) if it crosses an untrusted network.
- Do not share the token URL, and restart the container to rotate the launch
  token. The browser-session cookie lasts as long as `cookieMaxAgeDays` in the
  connection config.
- Mount only the directory the agent should be able to modify.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403` from a remote browser | The request did not go through the proxy. Publish `DSH_EXPOSE_PORT` (3080), not `DSH_INTERNAL_PORT` (3081). |
| `401 dsh web authentication required` | Open the token URL from the log once; the cookie then persists in that browser. A different host/IP is a different authority and needs the token again. |
| Banner shows `127.0.0.1` | Set `DSH_PUBLIC_URL` (or `DSH_PUBLIC_HOST`) to the address you browse to. |
| Container unhealthy | Inspect `docker logs`; the health check probes `/__dsh_proxy_health`, which reports whether the harness itself is listening. |
| Build fails resolving packages | Re-run with `--npm-registry https://registry.npmjs.org`; the default mirror may lag. |
| `apt-get update` cannot resolve `deb.debian.org` | Retried five times before failing. Re-run with `--debian-mirror https://mirrors.tuna.tsinghua.edu.cn` (or another mirror root). |
| Build runs out of memory | The TypeScript build uses `--max-old-space-size=4096`. Raise `NODE_OPTIONS` in the build stage and give Docker more memory. |
| Plugin install from the GUI fails | `pnpm` is installed in the image but the container needs outbound network access. |
| `settings are unavailable in this browser` in Settings → Models | The page is not on a loopback address, which is where the harness keeps Host-backed settings (see [Settings require a loopback address](#settings-require-a-loopback-address)). Forward a local port — `netsh interface portproxy` on Windows — and browse `http://127.0.0.1:<port>`, or pass the model credentials through the container environment. |
| `llm-deepseek … TypeError: Invalid URL` at boot | An **empty** `DEEPSEEK_BASE_URL` (or `DEEPSEEK_SEARCH_BASE_URL`) is exported. The harness parses it with `new URL()`, and an empty override is not the same as no override. Leave the line commented out in `.env`; the entrypoint drops empty values and logs `dsh-docker: ignoring empty …` so the profile boots. |
| `docker build` fails with `resolve : lstat docker: no such file or directory` | The `docker` CLI is a **snap**, which is confined to your home directory and cannot read a build context under `/opt` or `/tmp`. Build from a copy inside `$HOME` (`cp -a . ~/dsh-build && cd ~/dsh-build && docker build -f docker/Dockerfile .`), or invoke the unconfined binary directly (`/snap/docker/current/bin/docker build -f docker/Dockerfile .`) after linking the buildx plugin into `~/.docker/cli-plugins`. |
