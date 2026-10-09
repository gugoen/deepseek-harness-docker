#!/usr/bin/env node
/**
 * Container supervisor for the DeepSeek Harness Web UI.
 *
 * The harness Web server binds loopback and fences `/api` on the request
 * authority, so the container publishes it through {@link startReverseProxy}
 * instead of binding all interfaces directly. This process owns both sides:
 * it starts the harness, mirrors its output to the container log, and prints a
 * ready banner naming the exact token URL a remote browser needs.
 *
 * `serve` (the image CMD) runs the server. Any other first argument is executed
 * verbatim, so the same image is usable as a plain sandbox shell:
 * `docker run --rm -it <image> bash`.
 *
 * A selected Python virtual environment (see ./python-runtime.mjs) is activated
 * before either path runs, so `python`/`pip` in the harness and in every shell
 * the agent executes resolve to it.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { dropEmptyUrlEnv } from './container-env.mjs'
import { applyPythonRuntime, resolvePythonRuntime } from './python-runtime.mjs'
import { startReverseProxy } from './reverse-proxy.mjs'

/** Path of the built `dsh` bin inside the image. */
const DSH_BIN = '/app/apps/cli/lib/bin.js'

const DSH_WEB_URL_LINE = /dsh web:\s*(\S+)/u
const TOKEN_QUERY = /[?&]token=([A-Za-z0-9_-]+)/u

/**
 * Select and activate the Python runtime for this container.
 * @returns a one-line description to log, or undefined when the image's own
 *   `python3` is what callers get.
 */
function activatePython() {
  const runtime = resolvePythonRuntime()
  if (!runtime.configured) return undefined
  applyPythonRuntime(runtime)
  return `${runtime.version} (${runtime.venv})`
}

/**
 * Read a positive integer environment variable.
 * @param name - variable name.
 * @param fallback - value used when unset or empty.
 * @returns the parsed port or count.
 */
function integerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Read an environment variable, treating unset and empty alike. Compose
 * interpolates an unset variable to the empty string, which is not a value.
 * @param name - variable name.
 * @returns the value, or undefined when it is effectively unset.
 */
function optionalEnv(name) {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? undefined : raw
}

/**
 * Print the access banner once the harness published its token URL.
 * @param internalPort - loopback port the harness bound.
 * @param exposePort - container port the proxy publishes.
 * @param advertisedUrl - token URL exactly as the harness printed it.
 */
function printReadyBanner(internalPort, exposePort, advertisedUrl) {
  const token = TOKEN_QUERY.exec(advertisedUrl)?.[1]
  const suffix = token === undefined ? '/' : `/?token=${token}`
  const lines = [
    '',
    '=====================================================================',
    ' DeepSeek Harness Web UI is ready / 服务已就绪',
    `   in-container : http://127.0.0.1:${String(internalPort)}${suffix}`,
    `   remote (LAN) : http://<THIS-HOST-IP>:${String(exposePort)}${suffix}`,
    '   把 <THIS-HOST-IP> 换成运行容器的机器 IP 即可从其他机器访问。',
    `   advertised   : ${advertisedUrl}`,
    '   (set DSH_PUBLIC_URL or DSH_PUBLIC_HOST to fix the advertised address)',
    token === undefined ? '' : `   launch token : ${token}`,
    '=====================================================================',
    '',
  ].filter(line => line !== '')
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Mirror one child stream to the container log and watch for the token URL.
 * @param stream - child stdout or stderr.
 * @param sink - destination stream.
 * @param onLine - called with each complete line.
 */
function mirror(stream, sink, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    sink.write(chunk)
    pending += chunk
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) onLine(line)
  })
  stream.on('end', () => {
    if (pending !== '') onLine(pending)
  })
}

/**
 * Run one command with the container's inherited stdio and exit with its code.
 * @param command - executable name or path.
 * @param args - arguments passed verbatim.
 */
function runCommand(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.on('error', (error) => {
    process.stderr.write(`dsh-docker: cannot run ${command}: ${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128))
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { child.kill(signal) })
  }
}

/**
 * Start the harness Web profile behind the publishing proxy and stay alive
 * until either side exits.
 */
function serve() {
  const internalPort = integerEnv('DSH_INTERNAL_PORT', 3081)
  const exposePort = integerEnv('DSH_EXPOSE_PORT', 3080)
  const listenHost = optionalEnv('DSH_LISTEN_HOST') ?? '0.0.0.0'
  if (internalPort === exposePort) {
    throw new Error(`DSH_INTERNAL_PORT and DSH_EXPOSE_PORT must differ (both ${String(internalPort)})`)
  }

  const publicHost = optionalEnv('DSH_PUBLIC_HOST')
  const publicUrl = optionalEnv('DSH_PUBLIC_URL')
    ?? (publicHost === undefined ? undefined : `http://${publicHost}:${String(exposePort)}`)

  const extra = (optionalEnv('DSH_WEB_EXTRA_ARGS') ?? '').split(/\s+/u).filter(Boolean)
  const args = [DSH_BIN, 'web', '--port', String(internalPort), '--no-open']
  if (publicUrl !== undefined) args.push('--public-url', publicUrl)
  args.push(...extra)

  const proxy = startReverseProxy({
    listenHost,
    listenPort: exposePort,
    targetHost: '127.0.0.1',
    targetPort: internalPort,
    log: message => process.stdout.write(`${message}\n`),
  })

  const child = spawn(process.execPath, args, {
    cwd: optionalEnv('DSH_WORKDIR') ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  proxy.server.on('error', (error) => {
    process.stderr.write(`dsh-docker: reverse proxy failed: ${error.message}\n`)
    child.kill('SIGTERM')
    process.exit(1)
  })

  let announced = false
  const inspect = (line) => {
    const match = DSH_WEB_URL_LINE.exec(line)
    if (match === null || announced) return
    announced = true
    printReadyBanner(internalPort, exposePort, match[1])
  }
  mirror(child.stdout, process.stdout, inspect)
  mirror(child.stderr, process.stderr, inspect)

  child.on('error', (error) => {
    process.stderr.write(`dsh-docker: cannot start the harness: ${error.message}\n`)
    process.exitCode = 127
    void proxy.close()
  })

  // The exit code a signal handler asked for, so a requested stop still reports
  // its own status instead of the child's signal-kill status.
  let requestedExit
  child.on('exit', (code, signal) => {
    process.stdout.write(`dsh-docker: harness exited (code ${String(code)}, signal ${String(signal)})\n`)
    void proxy.close().finally(() => {
      process.exit(requestedExit ?? code ?? 1)
    })
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (requestedExit !== undefined) return
      requestedExit = signal === 'SIGINT' ? 130 : 0
      child.kill(signal)
      // A harness that ignores the stop request must not hold the container.
      const force = setTimeout(() => {
        child.kill('SIGKILL')
        process.exit(requestedExit)
      }, 10000)
      force.unref()
    })
  }
}

const [, , command = 'serve', ...rest] = process.argv
try {
  // Before anything reads the environment: an exported empty URL aborts the
  // harness profile at boot, and an empty override means "no override".
  const droppedEnv = dropEmptyUrlEnv()
  if (droppedEnv.length > 0) {
    process.stdout.write(`dsh-docker: ignoring empty ${droppedEnv.join(', ')}\n`)
  }
  const python = activatePython()
  if (python !== undefined) process.stdout.write(`dsh-docker: python ${python}\n`)
  if (command === 'serve') {
    serve()
  } else {
    runCommand(command, rest)
  }
} catch (error) {
  process.stderr.write(`dsh-docker: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
