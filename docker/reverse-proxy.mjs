/**
 * Publishing reverse proxy for the loopback-bound dsh Web server.
 *
 * `dsh --profile web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, and every
 * `/api` request additionally passes a browser-trust fence that requires the
 * `Host` header to be loopback or a declared `--trusted-host` authority
 * (`packages/client/connection/src/api-request-trust.ts`). A Docker port
 * mapping rewrites nothing, so a browser reaching the container from another
 * machine sends the host machine's authority and the fence answers 403 before
 * the request can reach the RPC bridge.
 *
 * This proxy terminates the external connection on all interfaces and forwards
 * it upstream with `Host: 127.0.0.1:<internal port>`. The fence then sees its
 * own loopback authority on every request, and the browser-session cookie —
 * which is signed for, and looked up by, the request authority — stays
 * consistent across the whole session. `Origin` is dropped for the same
 * reason: the fence accepts an absent `Origin`, while the browser's external
 * origin cannot match the rewritten authority.
 *
 * WebSocket upgrades under `/api` are forwarded at the byte level, so the
 * gateway's upgrade handshake and framing are untouched.
 */

import http from 'node:http'
import net from 'node:net'

/** Path answered by the proxy itself; used by the container health check. */
export const HEALTH_PATH = '/__dsh_proxy_health'

/** Request headers that must never be forwarded verbatim. */
const STRIPPED_REQUEST_HEADERS = new Set(['host', 'origin'])

/** Response headers the Node HTTP server re-derives for the downstream hop. */
const STRIPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding'])

/**
 * Build the upstream request headers: drop the external authority and the
 * browser's origin, then claim the loopback authority the fence expects.
 * @param headers - the incoming Node request headers.
 * @param upstreamAuthority - `host:port` the upstream fence accepts.
 * @returns headers safe to send upstream.
 */
function upstreamRequestHeaders(headers, upstreamAuthority) {
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue
    if (value === undefined) continue
    forwarded[name] = value
  }
  forwarded.host = upstreamAuthority
  return forwarded
}

/**
 * Build the downstream response headers, letting Node own the downstream
 * connection framing.
 * @param headers - the upstream response headers.
 * @returns headers safe to send downstream.
 */
function downstreamResponseHeaders(headers) {
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
    if (value === undefined) continue
    forwarded[name] = value
  }
  return forwarded
}

/**
 * Forward one WebSocket upgrade by piping the two sockets, after rewriting the
 * handshake request head.
 *
 * An upgraded socket leaves the HTTP server's connection tracking, so both ends
 * are mirrored explicitly and the client socket is registered for shutdown.
 * @param request - the incoming upgrade request.
 * @param clientSocket - the accepted client socket.
 * @param head - bytes already read past the request head.
 * @param options - resolved upstream target and authority.
 * @param upgraded - live upgraded client sockets, destroyed when the proxy closes.
 */
function proxyUpgrade(request, clientSocket, head, options, upgraded) {
  const upstream = net.connect(options.targetPort, options.targetHost)
  let established = false
  upgraded.add(clientSocket)
  const closeBoth = () => {
    clientSocket.destroy()
    upstream.destroy()
  }
  clientSocket.on('error', closeBoth)
  // Either half ending must tear down the other: an upgraded socket is a raw
  // tunnel, so a half-closed side has nothing left to carry, and keeping the
  // opposite socket open would leak the connection and the upstream server's
  // socket with it.
  clientSocket.on('end', closeBoth)
  clientSocket.on('close', () => {
    upgraded.delete(clientSocket)
    upstream.destroy()
  })
  upstream.on('error', () => {
    if (!established) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
    }
    closeBoth()
  })
  upstream.on('end', closeBoth)
  upstream.on('close', () => { clientSocket.destroy() })
  upstream.on('connect', () => {
    established = true
    const headers = upstreamRequestHeaders(request.headers, options.upstreamAuthority)
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
}

/**
 * Answer the proxy's own health probe: 200 when the upstream port accepts a
 * connection, 503 otherwise.
 * @param response - the probe response.
 * @param options - resolved upstream target.
 */
function answerHealth(response, options) {
  const probe = net.connect(options.targetPort, options.targetHost)
  let settled = false
  const finish = (status, body) => {
    if (settled) return
    settled = true
    probe.destroy()
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  }
  probe.setTimeout(2000, () => finish(503, 'upstream timeout\n'))
  probe.on('connect', () => finish(200, 'ok\n'))
  probe.on('error', error => finish(503, `upstream unreachable: ${error.message}\n`))
}

/**
 * Start the publishing proxy.
 * @param options - listen/target addresses and an optional logger.
 * @returns the listening `http.Server`, plus a `close()` that resolves once it stopped.
 */
export function startReverseProxy(options) {
  const targetHost = options.targetHost ?? '127.0.0.1'
  const upstreamAuthority = `${targetHost}:${String(options.targetPort)}`
  const log = options.log ?? (() => {})
  const resolved = { ...options, targetHost, upstreamAuthority }

  const server = http.createServer((request, response) => {
    if (request.url === HEALTH_PATH) {
      answerHealth(response, resolved)
      return
    }
    const headers = upstreamRequestHeaders(request.headers, upstreamAuthority)
    const upstream = http.request({
      host: targetHost,
      port: options.targetPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        downstreamResponseHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(response)
    })
    upstream.on('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end(`dsh reverse proxy: upstream ${upstreamAuthority} unreachable: ${error.message}\n`)
    })
    request.pipe(upstream)
  })

  const upgrades = new Set()

  server.on('upgrade', (request, socket, head) => {
    proxyUpgrade(request, socket, head, resolved, upgrades)
  })
  server.on('clientError', (_error, socket) => {
    socket?.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
  })

  const close = () => new Promise((resolve) => {
    // Upgraded sockets are outside the server's connection tracking.
    for (const socket of upgrades) socket.destroy()
    upgrades.clear()
    server.close(() => resolve())
    server.closeAllConnections?.()
  })

  server.listen(options.listenPort, options.listenHost ?? '0.0.0.0', () => {
    log(`proxy: listening on ${options.listenHost ?? '0.0.0.0'}:${String(options.listenPort)} -> ${upstreamAuthority}`)
  })
  return { server, close }
}
