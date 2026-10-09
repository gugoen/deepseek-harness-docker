/**
 * Unit tests for the publishing reverse proxy.
 *
 * These run with plain Node (no Docker):
 *   node --test docker/test/reverse-proxy.test.mjs
 *
 * They pin the three properties the container depends on: the upstream sees a
 * loopback `Host`, the browser's `Origin` never reaches the harness trust
 * fence, and WebSocket upgrades are forwarded at the byte level.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { startReverseProxy, HEALTH_PATH } from '../reverse-proxy.mjs'

/**
 * Start an HTTP server on an ephemeral port.
 * @param handler - request listener.
 * @returns the server and its port.
 */
async function listen(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  return { server, port: server.address().port }
}

/**
 * Start the proxy in front of an upstream port.
 * @param upstreamPort - port the proxy forwards to.
 * @returns the proxy handle and its port.
 */
async function listenProxy(upstreamPort) {
  const proxy = startReverseProxy({ listenHost: '127.0.0.1', listenPort: 0, targetPort: upstreamPort })
  await new Promise(resolve => proxy.server.once('listening', resolve))
  return { proxy, port: proxy.server.address().port }
}

test('rewrites Host to the loopback upstream authority and drops Origin', async () => {
  const seen = {}
  const { server, port } = await listen((request, response) => {
    seen.host = request.headers.host
    seen.origin = request.headers.origin
    seen.url = request.url
    seen.cookie = request.headers.cookie
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('upstream-ok')
  })
  const { proxy, port: proxyPort } = await listenProxy(port)

  const body = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/api',
      method: 'GET',
      headers: {
        host: '192.168.88.188:3080',
        origin: 'http://192.168.88.188:3080',
        cookie: 'session=value',
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    request.end()
  })

  assert.equal(body.status, 200)
  assert.equal(body.text, 'upstream-ok')
  assert.equal(seen.host, `127.0.0.1:${String(port)}`)
  assert.equal(seen.origin, undefined)
  assert.equal(seen.url, '/api')
  assert.equal(seen.cookie, 'session=value')

  await proxy.close()
  server.close()
})

test('health probe reports the upstream state', async () => {
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const { proxy, port: proxyPort } = await listenProxy(port)

  const healthy = await fetch(`http://127.0.0.1:${String(proxyPort)}${HEALTH_PATH}`)
  assert.equal(healthy.status, 200)

  await new Promise(resolve => server.close(resolve))

  const unhealthy = await fetch(`http://127.0.0.1:${String(proxyPort)}${HEALTH_PATH}`)
  assert.equal(unhealthy.status, 503)

  await proxy.close()
})

test('forwards a WebSocket upgrade with the rewritten handshake', async () => {
  const upstream = http.createServer()
  // `http.Server` accepts sockets with allowHalfOpen, and an upgraded socket is
  // outside its connection tracking, so the fixture owns closing its own end.
  const upgradedSockets = new Set()
  let upstreamSawEnd = false
  upstream.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket)
    socket.on('close', () => upgradedSockets.delete(socket))
    socket.on('end', () => { upstreamSawEnd = true; socket.destroy() })
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `X-Seen-Host: ${String(request.headers.host)}\r\n`
      + `X-Seen-Origin: ${String(request.headers.origin)}\r\n`
      + '\r\n')
    socket.write('pong')
  })
  upstream.listen(0, '127.0.0.1')
  await new Promise(resolve => upstream.once('listening', resolve))
  const upstreamPort = upstream.address().port

  const { proxy, port: proxyPort } = await listenProxy(upstreamPort)

  const client = net.connect(proxyPort, '127.0.0.1')
  await new Promise(resolve => client.once('connect', resolve))
  client.write('GET /api/remote.mux HTTP/1.1\r\n'
    + 'Host: 10.1.2.3:3080\r\n'
    + 'Origin: http://10.1.2.3:3080\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
    + '\r\n')

  let received = ''
  client.setEncoding('utf8')
  client.on('data', (chunk) => { received += chunk })
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    const check = () => {
      if (received.includes('pong')) { clearTimeout(timer); resolve() }
    }
    client.on('data', check)
  })

  assert.match(received, /HTTP\/1\.1 101 Switching Protocols/u)
  assert.match(received, new RegExp(`x-seen-host: 127\\.0\\.0\\.1:${String(upstreamPort)}`, 'iu'))
  assert.match(received, /x-seen-origin: undefined/iu)
  assert.match(received, /pong/u)

  client.destroy()
  await proxy.close()
  // The proxy must propagate the client's disconnect to the upstream half, or
  // the harness would keep the peer (and its session) alive forever.
  await new Promise((resolve) => {
    const deadline = Date.now() + 2000
    const poll = () => {
      if (upstreamSawEnd || Date.now() >= deadline) { resolve(); return }
      setTimeout(poll, 20)
    }
    poll()
  })
  assert.equal(upstreamSawEnd, true)
  await new Promise((resolve) => {
    for (const socket of upgradedSockets) socket.destroy()
    upstream.close(() => resolve())
  })
})
