# DeepSeek Harness Web UI 容器镜像

基于本仓库源码构建的 DeepSeek Harness Web GUI 镜像。镜像内置了常用 Linux 基础命令，
并且可以被**非本地 IP** 访问。

- Harness 版本：`0.2.1-alpha.1`（与本次签出的 `package.json` 一致）
- 支持架构：`linux/amd64`、`linux/arm64`（以及 `node:22-bookworm-slim` 支持的其他架构）
  —— 所有产物都在目标架构镜像内编译，不涉及交叉编译参数
- 基础镜像：`node:22-bookworm-slim`（Debian 12）

English documentation: [README.md](README.md).

## 为什么需要这层镜像

`dsh --profile web` 只绑定 `127.0.0.1`，明确拒绝 `--host 0.0.0.0`，并且对每个 `/api`
请求执行"浏览器信任围栏"（`packages/client/connection/src/api-request-trust.ts`）。
该围栏要求请求的 `Host` 授权域是回环地址或显式声明的 `--trusted-host`。单纯的
Docker 端口映射不会改写任何请求头，因此从其他机器访问的浏览器会带着自己的授权域，
在到达 RPC 桥之前就被回以 **403**。此外，浏览器会话 Cookie 是按**请求授权域**签名的，
授权域在请求间发生变化同样会导致会话失效。

所以镜像不改动 Harness 的任何逻辑，让它继续按设计绑定回环地址，再用一个很小的
反向代理把它发布出去：

```
浏览器  ──►  容器 0.0.0.0:3080        (reverse-proxy.mjs)
                     │  改写 Host → 127.0.0.1:3081，丢弃 Origin，
                     │  按字节转发 WebSocket 升级
                     ▼
              dsh web 监听 127.0.0.1:3081   (源码未改动，回环绑定)
```

由于 `Host` 被改写为回环授权域，信任围栏会放行所有请求，按授权域签名的 Cookie 也
始终一致——**对任意外部 IP 或主机名都生效，不需要维护 `--trusted-host`，也不需要改源码。**

这两件事是相互独立的：同一个镜像也可以直接当作 `dsh` 的沙箱使用
（`docker run --rm -it <image> bash`）。

## 文件说明

| 路径 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建：工具链 → 工作区安装 → 构建 → 精简运行时 |
| `Dockerfile.dockerignore` | 构建上下文过滤（仅对 `Dockerfile` 生效） |
| `entrypoint.mjs` | 容器主控：启动 `dsh web`、打印带 token 的访问地址、托管反向代理 |
| `reverse-proxy.mjs` | 改写 Host 的 HTTP/WebSocket 发布代理（无第三方依赖） |
| `python-runtime.mjs` | 选择并激活 Python 虚拟环境 |
| `dsh-docker-entrypoint` | entrypoint 入口脚本；`serve` 启动服务，其他参数按原样执行 |
| `shell/ll`、`shell/get` | `ll`（`ls -alF`）和 `get`（curl 下载器）的真实命令 |
| `python/requirements-common.txt` | 供 `--python-requirements` 使用的参考依赖清单 |
| `shell/dsh-aliases.sh` | 通过 `/etc/profile.d` 安装的交互式别名 |
| `shell/dsh-python.sh` | 为登录 shell 与 `docker exec` 重新激活 Python 环境 |
| `docker-compose.yml` | Compose 部署 |
| `docker-compose.python.yml` | 挂载宿主机 Python 环境的 Compose override |
| `.env.example` | 复制为 `.env` 供 Compose 使用 |
| `build.sh` | 构建脚本，支持多架构与导出 tar 包 |
| `run.sh` | 不使用 Compose 的 `docker run` 封装 |
| `test/smoke-test.sh` | 通过非回环地址进行的容器端到端测试 |
| `test/reverse-proxy.test.mjs` | 反向代理的免依赖单元测试（Host 改写、Origin 丢弃、WebSocket） |
| `test/python-runtime.test.mjs` | Python 环境选择逻辑的免依赖单元测试 |
| `test/python-mount-test.sh` | 挂载宿主机 Python 环境的端到端测试 |
| `test/check-arm64-packages.py` | 用 Debian arm64 索引校验 apt 包列表 |

## 快速开始

### Compose

```sh
cp docker/.env.example docker/.env
$EDITOR docker/.env                     # 至少填上 DEEPSEEK_API_KEY
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f
```

### docker run

```sh
./docker/build.sh                       # 按本机架构构建
./docker/run.sh --workspace ~/my-project
docker logs -f dsh-web
```

或者手工执行：

```sh
docker run -d --name dsh-web \
  -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD":/workspace \
  -v dsh-home:/home/node/.dsh \
  deepseek-harness-web:0.2.1-alpha.1
```

## 使用预构建部署包

构建好的镜像会导出到 `docker/dist/`，包含可直接 load 的归档和校验和：

```sh
docker load < docker/dist/deepseek-harness-web_0.2.1-alpha.1_amd64.tar.gz
cd docker/dist && sha256sum -c SHA256SUMS.txt
docker run -d --name dsh-web -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... -v dsh-home:/home/node/.dsh \
  deepseek-harness-web:0.2.1-alpha.1
```

该归档与架构绑定。arm64 场景请把仓库拷到 arm64 机器上就地构建，不要把 amd64 归档
跨架构搬运。

## 从其他机器访问

启动日志会打印一段包含本次进程 token 的地址：

```
=====================================================================
 DeepSeek Harness Web UI is ready / 服务已就绪
   in-container : http://127.0.0.1:3081/?token=xxxxxxxx
   remote (LAN) : http://<THIS-HOST-IP>:3080/?token=xxxxxxxx
=====================================================================
```

把 `remote` 那行的 `<THIS-HOST-IP>` 换成运行容器的机器 IP，在浏览器里打开即可。
token 只用于换取一次浏览器会话 Cookie，之后由 Cookie 认证，因此 token 只在第一次
访问时需要。**不要分享带 token 的地址。**

设置 `DSH_PUBLIC_URL`（或 `DSH_PUBLIC_HOST`）可以让打印出来的地址直接就是正确的外部地址：

```sh
docker run ... -e DSH_PUBLIC_URL=http://192.168.1.50:3080 ...
```

## 构建

```sh
./docker/build.sh                                  # 本机架构
./docker/build.sh --tarball dist                   # 顺便导出可直接 load 的 .tar.gz
./docker/build.sh --npm-registry https://registry.npmjs.org
./docker/build.sh --debian-mirror https://mirrors.tuna.tsinghua.edu.cn
./docker/build.sh --arch arm64 --load              # 交叉构建（需要 container driver，较慢）
./docker/build.sh --arch both --registry registry.example.com/team --push
```

直接用 Docker：

```sh
docker build -f docker/Dockerfile -t deepseek-harness-web:0.2.1-alpha.1 .
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t dsh-web:arm64 --load .
```

镜像约 2.7 GB。体积主要来自 Harness 的运行时依赖闭包——profile 启动时会解析的大型可选
provider 与文档/渲染引擎（`@openai/codex`、`@anthropic-ai/claude-agent-sdk`、
`libreoffice-kit`、Mermaid、PDF 与 canvas、`node-pty` 等）。它不是构建残留：多阶段构建
只把 `/app` 和基础工具用户态带进最终镜像。

### arm64

推荐**在 arm64 机器上直接构建**，这是最快、也最能反映真实结果的路径：

```sh
docker build -f docker/Dockerfile -t deepseek-harness-web:0.2.1-alpha.1 .
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1
```

也可以从 `linux/amd64` 交叉构建 `linux/arm64`，但整条 `pnpm install` + TypeScript +
Vite 工具链都会跑在 QEMU 模拟下，非常慢。跨架构构建需要 `docker-container` builder：

```sh
docker buildx create --name dsh-multiarch --driver docker-container --use --bootstrap
docker buildx build --platform linux/arm64 -f docker/Dockerfile -t dsh-web:arm64 --load .
```

Dockerfile 中没有任何与架构绑定的步骤：基础镜像、apt 包列表、pnpm 安装（会按构建
架构解析平台相关的可选依赖），以及 Node-API 的 `flock` 原生插件，都会针对构建目标
平台自行解析。

### 构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_IMAGE` | `node:22-bookworm-slim` | 所有阶段的基础镜像 |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | 构建期使用的 npm 源；镜像源不全时可改为 `https://registry.npmjs.org` |
| `DEBIAN_MIRROR` | 空（沿用基础镜像源） | apt 镜像站根地址，例如 `https://mirrors.tuna.tsinghua.edu.cn`。`deb.debian.org` 不可达时请设置；`apt-get update` 与 pnpm/npm 安装本身已带重试。 |
| `PYTHON_REQUIREMENTS` | 空 | 要安装进 `/opt/dsh-python` 的 requirements 文件路径（仓库内相对路径）；留空则只提供 Debian 的 `python3`。 |
| `PIP_INDEX_URL` | `https://pypi.tuna.tsinghua.edu.cn/simple` | 上述安装使用的包索引。 |
| `PYTHON_EXTRA_PACKAGES` | 空 | 运行镜像额外安装的 apt 包，例如 `build-essential`。 |
| `DSH_CLIENT_COMMIT_HASH` | `0000000` | 嵌入浏览器产物的公开 commit 值；在没有 `.git` 的源码快照中可填真实哈希以便识别版本 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | 模型调用凭据。不设置界面也能启动，但会话调用模型时会失败。 |
| `DEEPSEEK_BASE_URL` | 无 | 兼容 OpenAI 协议的接入点覆盖。 |
| `DSH_PUBLIC_URL` | 未设置 | 启动时打印、并作为 `DSH_WEB_URL` 交给模型的对外地址。 |
| `DSH_PUBLIC_HOST` | 未设置 | 便捷写法：自动拼出 `http://$DSH_PUBLIC_HOST:$DSH_EXPOSE_PORT`。 |
| `DSH_EXPOSE_PORT` | `3080` | 反向代理对外发布的容器端口。 |
| `DSH_INTERNAL_PORT` | `3081` | Harness 绑定的回环端口，必须与 `DSH_EXPOSE_PORT` 不同。 |
| `DSH_LISTEN_HOST` | `0.0.0.0` | 反向代理监听的网卡。 |
| `DSH_WORKDIR` | `/workspace` | `dsh` 启动时的工作目录。 |
| `DSH_HOME` | `/home/node/.dsh` | Harness 主目录：会话、凭据、Cookie、profile。 |
| `DSH_WEB_EXTRA_ARGS` | 未设置 | 追加给 `dsh web` 的额外参数（空格分隔）。 |
| `DSH_TELEMETRY_DISABLED` | 未设置（Compose 中为 `true`） | 关闭 Harness 的匿名产品遥测。 |
| `DSH_PYTHON_VENV` | 未设置 | 要激活的虚拟环境，必须挂载在其原始绝对路径上。用 `PYTHON_REQUIREMENTS` 构建的镜像会自动使用 `/opt/dsh-python`。 |

## 数据持久化

| 路径 | 内容 |
| --- | --- |
| `/home/node/.dsh` | 会话记录、凭据、浏览器会话签名密钥、profile。挂载卷后可跨重启保留会话与登录态。 |
| `/workspace` | Agent 的工作目录。 |

```sh
-v dsh-home:/home/node/.dsh -v /path/to/project:/workspace
```

如果宿主机已有 `~/.dsh` 并希望容器复用，直接挂载该目录即可——格式完全一致。

## 当作沙箱使用

```sh
docker run --rm -it -v "$PWD":/workspace deepseek-harness-web:0.2.1-alpha.1 bash
# 容器内：ll、get、curl、wget、vim、git、rg、fd、bat、jq、tmux、htop、dig、nc、python3、pip ...
docker run --rm deepseek-harness-web:0.2.1-alpha.1 ll /workspace
```

`ll` 和 `get` 是真实可执行文件（不只是别名），因此在非交互式 shell、
`docker run <image> <cmd>` 和脚本里同样可用。

## Python 环境

镜像内置 Debian 的 `python3`（bookworm 上是 3.11）以及 `pip`、`venv` 和开发头文件，
因此 `python3` 随时可用。如果需要特定的解释器与 site-packages，有两种做法，**挂载**
是更省体积的那种。

### 挂载宿主机的虚拟环境（推荐）

虚拟环境会记录自己创建时的绝对路径——`pyvenv.cfg` 写着基础解释器位置，`bin/python3`
也是指向它的符号链接——所以它不能随便搬家。请把整棵目录树**挂载到与宿主机完全相同的
绝对路径**，并用 `DSH_PYTHON_VENV` 指定虚拟环境：

```sh
./docker/run.sh --python-venv /opt/software/flowai-gp-v4/warehouse/flowai-wh-python/.venv
```

`run.sh` 会读取 `pyvenv.cfg`，把虚拟环境**和它的基础运行时**一起以只读方式挂到各自的
原始路径，并导出 `DSH_PYTHON_VENV`。使用 Compose 时：

```sh
# docker/.env
DSH_PYTHON_ROOT=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python
DSH_PYTHON_VENV=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python/.venv

docker compose -f docker/docker-compose.yml \
               -f docker/docker-compose.python.yml up -d
```

手工挂载：

```sh
W=/opt/software/flowai-gp-v4/warehouse/flowai-wh-python
docker run -d --name dsh-web -p 3080:3080 \
  -v "$W:$W:ro" -e DSH_PYTHON_VENV="$W/.venv" \
  -e DEEPSEEK_API_KEY=sk-... \
  deepseek-harness-web:0.2.1-alpha.1
```

entrypoint 会在启动 Harness 之前激活该环境：把它的 `bin` 前置到 `PATH`、导出
`VIRTUAL_ENV`、并清掉会破坏 venv 解析的 `PYTHONHOME`。由于 Harness 会把自己的环境变量
传给 Agent 执行的每个 shell，沙箱内的 `python`、`python3`、`pip` 以及该环境的命令行工具
都会指向它。启动日志会确认：

```
dsh-docker: python Python 3.10.18 (/opt/software/.../flowai-wh-python/.venv)
```

默认以只读方式挂载。若希望 Agent 能往里面 `pip install`，加 `--python-venv-writable`
（或去掉 override 里的 `read_only: true`）。

另外两个入口由 `/etc/profile.d/01-dsh-python.sh` 兜底，它重复同样的选择逻辑：登录 shell
（`bash -l` 会用 `/etc/profile` 重建 `PATH`）以及 `docker exec`（它是全新进程，看不到
entrypoint 的环境）。至于非交互的 `docker exec <container> bash -c ...`，它不读取任何启动
文件——这种情况请显式传 `-e PATH=<venv>/bin:$PATH`，或改用 `./docker/run.sh --shell`。

#### 这个环境能在容器里跑吗？

需要同时满足两点，第二点才是真正容易踩的坑：

1. 容器运行时能读到宿主机的这个路径；
2. 环境里的二进制不依赖比镜像更新的 glibc。Debian 12 提供 **glibc 2.36**。在更新的宿主机
   （Ubuntu 24.04 是 glibc 2.39）上创建的环境，只有当其原生扩展没有超出 2.36 时才能在
   容器内运行——凡是来自 manylinux wheel 的依赖都满足这一点。

挂载前先自检：

```sh
# 该环境的原生扩展要求的最高 glibc 符号版本
find "$W/.venv/lib" -name '*.so' -print0 \
  | xargs -0 -n1 objdump -T 2>/dev/null \
  | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
# 镜像内的 glibc
docker run --rm deepseek-harness-web:0.2.1-alpha.1 ldd --version | head -1
```

如果前者高于后者，请在容器内重建该环境（例如
`docker run --rm -v "$PWD":/w image python3 -m venv /w/.venv`），或改用与构建机匹配的
镜像。遇到这种情况 entrypoint 会**直接报错并给出该诊断**，不会带着一个坏解释器启动。

### 把依赖烘焙进镜像

对于无法挂载环境的内网机器，可以在构建期安装 requirements 文件。镜像会创建
`/opt/dsh-python` 并自动激活它（无需设置 `DSH_PYTHON_VENV`）：

```sh
cp /path/to/requirements.txt docker/python/requirements.txt
./docker/build.sh --python-requirements docker/python/requirements.txt

# 如果暂时没有自己的文件，可以用随包提供的参考清单：
./docker/build.sh --python-requirements docker/python/requirements-common.txt
```

`PYTHON_REQUIREMENTS` 是构建上下文（仓库根目录）内的相对路径；`PIP_INDEX_URL` 选择包索引，
默认使用清华镜像。若文件里包含源码分发包而非 wheel，再加
`--python-extra-packages build-essential`。这条路线正是镜像变大的原因——一份典型的数据类
requirements 会带来数百 MB——也正是「挂载」存在的意义。

### 验证

```sh
# 镜像自带的 python3
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1

# 走真实 entrypoint 端到端验证挂载的环境
./docker/test/python-mount-test.sh --venv /opt/.../flowai-wh-python/.venv
./docker/test/python-mount-test.sh --venv /opt/.../flowai-wh-python/.venv --all

# 不依赖 Docker 的选择逻辑单测
node --test docker/test/python-runtime.test.mjs
```

## 验证镜像

```sh
./docker/test/smoke-test.sh deepseek-harness-web:0.2.1-alpha.1
```

脚本会启动容器、等待健康检查通过，然后**通过非回环地址**断言：Harness 返回 401
（而不是围栏的 403）；token 换取页面返回 UI 外壳并下发会话 Cookie；`/api` 能绕过
围栏正常路由；`/api/remote.mux` 的 WebSocket 升级返回 101；未认证的升级仍被拒绝；
沙箱内所需命令齐备。

反向代理本身可以不依赖 Docker 单独测试：

```sh
node --test docker/test/reverse-proxy.test.mjs
```

它固定了容器依赖的三条性质：上游看到的是回环 `Host`、浏览器的 `Origin` 永远
到不了 Harness 围栏、WebSocket 升级按字节转发。

arm64 方面，`docker/test/check-arm64-packages.py` 会把镜像安装的每个 apt 包与
Debian 的 arm64 索引逐一比对，因此无需 arm64 机器即可验证包列表：

```sh
python3 docker/test/check-arm64-packages.py
```

## 安全说明

反向代理解决的是"网络位置限制"，**没有削弱 Harness 自身的认证**：每个界面请求仍然
需要 token 或签名 Cookie，代理没有增加任何旁路。

但需要清醒认识：一个可被访问的 `dsh` Web UI 在设计上就是远程代码执行面——Agent 会
执行 shell 命令、读写文件。在把它暴露到可信网络之外之前：

- 尽量只开在私有局域网、WireGuard/Tailscale 或 SSH 隧道之后。
- 如果要穿越不可信网络，请在前面终止 TLS（`--public-url https://...` 只改变对外声明
  的地址，不提供 TLS）。
- 不要分享带 token 的地址；重启容器即可轮换启动 token。浏览器会话 Cookie 的有效期
  由连接配置的 `cookieMaxAgeDays` 决定。
- 只挂载 Agent 确实需要修改的目录。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 远端浏览器返回 `403` | 请求没有经过代理。请发布 `DSH_EXPOSE_PORT`（3080），而不是 `DSH_INTERNAL_PORT`（3081）。 |
| `401 dsh web authentication required` | 先用日志里的 token 地址访问一次，之后该浏览器会持有 Cookie。换用不同主机名/IP 属于不同授权域，需要重新带 token。 |
| 启动日志里显示 `127.0.0.1` | 设置 `DSH_PUBLIC_URL`（或 `DSH_PUBLIC_HOST`）为你实际访问的地址。 |
| 容器 unhealthy | 查看 `docker logs`；健康检查会访问 `/__dsh_proxy_health`，它会报告 Harness 本身是否在监听。 |
| 构建时依赖解析失败 | 换用 `--npm-registry https://registry.npmjs.org` 重试；镜像源可能滞后。 |
| `apt-get update` 无法解析 `deb.debian.org` | 已自动重试 5 次后才会失败。可加 `--debian-mirror https://mirrors.tuna.tsinghua.edu.cn`（或其他镜像站根地址）重试。 |
| 构建内存不足 | TypeScript 构建使用 `--max-old-space-size=4096`；请提高构建阶段的 `NODE_OPTIONS` 并给 Docker 更多内存。 |
| 从界面安装插件失败 | 镜像内已装 `pnpm`，但容器需要能访问外网。 |
| `docker build` 报 `resolve : lstat docker: no such file or directory` | 你的 `docker` CLI 是 **snap** 版本，受限于家目录，读不到 `/opt`、`/tmp` 下的构建上下文。可把仓库复制到家目录再构建（`cp -a . ~/dsh-build && cd ~/dsh-build && docker build -f docker/Dockerfile .`），或直接调用未受限的二进制：把 buildx 插件链接到 `~/.docker/cli-plugins` 后使用 `/snap/docker/current/bin/docker build -f docker/Dockerfile .`。 |
