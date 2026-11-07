/**
 * Unit tests for the sandbox preflight.
 *
 *   node --test docker/test/sandbox-preflight.test.mjs
 *
 * The fallback exists because `sandbox-local` fails closed: on a host with no
 * Landlock (kernel < 5.13) and user namespaces disabled
 * (`user.max_user_namespaces = 0`), both Linux runners are unusable and every
 * agent shell command is refused at the default `workspace-write` mode.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySandboxMode,
  BWRAP_PROBE_ARGS,
  FALLBACK_MODE,
  landlockLauncherPath,
  PERMISSION_MODE_ENV,
  planSandboxMode,
  probeBwrap,
  probeLandlock,
  SANDBOX_FALLBACK_ENV,
} from '../sandbox-preflight.mjs'

const NO = { available: false, detail: 'stub: unavailable' }
const YES = { available: true, detail: 'stub: available' }
const probes = (bwrap, landlock) => ({ probeBwrap: () => bwrap, probeLandlock: () => landlock })

test('keeps the default mode when a runner is usable', () => {
  assert.equal(planSandboxMode({ env: {}, ...probes(YES, NO) }).kind, 'available')
  assert.equal(planSandboxMode({ env: {}, ...probes(NO, YES) }).kind, 'available')
})

test('prefers bwrap and does not probe Landlock when bwrap passes', () => {
  let probed = false
  const plan = planSandboxMode({
    env: {},
    probeBwrap: () => YES,
    probeLandlock: () => { probed = true; return NO },
  })
  assert.equal(plan.kind, 'available')
  assert.equal(plan.runner, 'bwrap')
  assert.equal(probed, false)
})

test('falls back to danger-full-access when neither runner is usable', () => {
  const plan = planSandboxMode({ env: {}, ...probes(NO, NO) })
  assert.equal(plan.kind, 'fallback')
  assert.equal(plan.mode, FALLBACK_MODE)
  assert.equal(plan.bwrap.available, false)
  assert.equal(plan.landlock.available, false)
})

test('an explicit permission mode always wins', () => {
  const plan = planSandboxMode({ env: { [PERMISSION_MODE_ENV]: 'read-only' }, ...probes(NO, NO) })
  assert.deepEqual(plan, { kind: 'explicit', mode: 'read-only' })
})

test('an empty permission mode is not explicit', () => {
  assert.equal(planSandboxMode({ env: { [PERMISSION_MODE_ENV]: '  ' }, ...probes(NO, NO) }).kind, 'fallback')
})

test('DSH_SANDBOX_FALLBACK=0 keeps the harness fail-closed', () => {
  const plan = planSandboxMode({ env: { [SANDBOX_FALLBACK_ENV]: '0' }, ...probes(NO, NO) })
  assert.equal(plan.kind, 'unavailable')
})

test('any other DSH_SANDBOX_FALLBACK value leaves the fallback enabled', () => {
  assert.equal(planSandboxMode({ env: { [SANDBOX_FALLBACK_ENV]: '1' }, ...probes(NO, NO) }).kind, 'fallback')
})

test('applies the widened mode only for a fallback', () => {
  const env = {}
  applySandboxMode({ kind: 'fallback', mode: FALLBACK_MODE }, env)
  assert.equal(env[PERMISSION_MODE_ENV], FALLBACK_MODE)

  const untouched = {}
  applySandboxMode({ kind: 'available', runner: 'bwrap' }, untouched)
  assert.deepEqual(untouched, {})
})

test('the launcher path is per architecture', () => {
  assert.equal(landlockLauncherPath('x64', 'linux'), '/app/native/system/packages/linux-x64/bin/landlock-run')
  assert.equal(landlockLauncherPath('arm64', 'linux'), '/app/native/system/packages/linux-arm64/bin/landlock-run')
  assert.equal(landlockLauncherPath('arm64', 'darwin'), undefined)
})

test('a missing launcher reports why', () => {
  const outcome = probeLandlock({ launcher: '/nope', exists: () => false })
  assert.equal(outcome.available, false)
  assert.match(outcome.detail, /missing/u)
})

test('a failing launcher probe reports why', () => {
  assert.equal(probeLandlock({ launcher: '/x', exists: () => true, run: () => false }).available, false)
  assert.equal(probeLandlock({ launcher: '/x', exists: () => true, run: () => true }).available, true)
})

test('the bwrap probe uses the harness read-only profile', () => {
  assert.deepEqual(BWRAP_PROBE_ARGS.slice(-2), ['--', 'true'])
  assert.ok(BWRAP_PROBE_ARGS.includes('--unshare-pid'), 'userns is what the probe must exercise')
  assert.equal(probeBwrap({ run: () => false }).available, false)
  assert.equal(probeBwrap({ run: () => true }).available, true)
})
