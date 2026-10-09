/**
 * Unit tests for Python runtime selection.
 *
 *   node --test docker/test/python-runtime.test.mjs
 *
 * These pin the resolution order (explicit `DSH_PYTHON_VENV`, then the baked
 * environment, then nothing), the loud failures a misconfigured mount must
 * produce, and the PATH/VIRTUAL_ENV wiring the agent's shell inherits.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPythonRuntime, resolvePythonRuntime, BAKED_VENV_PATH, PYTHON_VENV_ENV } from '../python-runtime.mjs'

/**
 * Build an existence test over a fixed set of paths.
 * @param present - paths that exist.
 * @returns the predicate.
 */
function existsIn(present) {
  const wanted = new Set(present)
  return path => wanted.has(path)
}

test('selects nothing when no environment is configured and none is baked', () => {
  const runtime = resolvePythonRuntime({ env: {}, exists: existsIn([]) })
  assert.deepEqual(runtime, { configured: false })
})

test('selects the baked environment automatically', () => {
  const python = `${BAKED_VENV_PATH}/bin/python`
  const runtime = resolvePythonRuntime({
    env: {},
    exists: existsIn([python]),
    probe: () => 'Python 3.11.2',
  })
  assert.equal(runtime.configured, true)
  assert.equal(runtime.venv, BAKED_VENV_PATH)
  assert.equal(runtime.bin, `${BAKED_VENV_PATH}/bin`)
  assert.equal(runtime.version, 'Python 3.11.2')
})

test('an explicit DSH_PYTHON_VENV wins over the baked environment', () => {
  const explicit = '/mnt/warehouse/flowai-wh-python/.venv'
  const runtime = resolvePythonRuntime({
    env: { [PYTHON_VENV_ENV]: explicit },
    exists: existsIn([`${explicit}/bin/python`]),
    probe: () => 'Python 3.10.18',
  })
  assert.equal(runtime.venv, explicit)
  assert.equal(runtime.version, 'Python 3.10.18')
})

test('falls back to bin/python3 when bin/python is absent', () => {
  const explicit = '/venv'
  const runtime = resolvePythonRuntime({
    env: { [PYTHON_VENV_ENV]: explicit },
    exists: existsIn([`${explicit}/bin/python3`]),
    probe: () => 'Python 3.10.18',
  })
  assert.equal(runtime.python, `${explicit}/bin/python3`)
})

test('an empty DSH_PYTHON_VENV is treated as unset', () => {
  const runtime = resolvePythonRuntime({ env: { [PYTHON_VENV_ENV]: '  ' }, exists: existsIn([]) })
  assert.deepEqual(runtime, { configured: false })
})

test('an explicit path without an interpreter fails loudly', () => {
  assert.throws(
    () => resolvePythonRuntime({ env: { [PYTHON_VENV_ENV]: '/venv' }, exists: existsIn([]) }),
    /not a virtual environment: no bin\/python/u,
  )
})

test('an interpreter that cannot start names glibc as the likely cause', () => {
  assert.throws(
    () => resolvePythonRuntime({
      env: { [PYTHON_VENV_ENV]: '/venv' },
      exists: existsIn(['/venv/bin/python']),
      probe: () => { throw new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found") },
    }),
    /cannot run inside this image: .*GLIBC_2\.38.*glibc/su,
  )
})

test('activating a runtime prepends its bin, dedups PATH, and drops PYTHONHOME', () => {
  const env = { PATH: '/usr/bin:/venv/bin:/bin', VIRTUAL_ENV: '/stale', PYTHONHOME: '/python' }
  applyPythonRuntime({ configured: true, venv: '/venv', bin: '/venv/bin' }, env)
  assert.equal(env.PATH, '/venv/bin:/usr/bin:/bin')
  assert.equal(env.VIRTUAL_ENV, '/venv')
  assert.equal('PYTHONHOME' in env, false)
})

test('activating an unconfigured runtime changes nothing', () => {
  const env = { PATH: '/usr/bin' }
  applyPythonRuntime({ configured: false }, env)
  assert.deepEqual(env, { PATH: '/usr/bin' })
})
