/**
 * Python runtime selection for the container.
 *
 * The image always ships a Debian `python3`. A deployment that needs a
 * specific interpreter and site-packages — a warehouse virtual environment
 * built elsewhere, or a requirements file baked at image-build time — points
 * the container at it instead:
 *
 *   - `DSH_PYTHON_VENV` names a virtual environment directory explicitly. The
 *     directory must be reachable at the *same absolute path* it was created
 *     at, because a venv records that path (`pyvenv.cfg`'s `home`, and the
 *     `bin/python3` symlink) and fails to start when it moves.
 *   - `/opt/dsh-python` is the venv the image itself creates when built with
 *     `--build-arg PYTHON_REQUIREMENTS=...`; it is selected automatically.
 *
 * Selecting a venv prepends its `bin` to `PATH` and exports `VIRTUAL_ENV`, so
 * `python`, `python3`, `pip`, and console scripts resolve to it — for the
 * harness process, and therefore for every shell the agent runs.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Virtual environment the image creates when a requirements file is baked in. */
export const BAKED_VENV_PATH = '/opt/dsh-python'

/** Environment variable naming a virtual environment to activate. */
export const PYTHON_VENV_ENV = 'DSH_PYTHON_VENV'

/** Seconds allowed for the interpreter probe. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Read the interpreter version, which also proves the binary can start.
 * @param python - absolute path to the interpreter.
 * @returns the version line, or throws with the interpreter's own diagnostic.
 */
function probeInterpreter(python) {
  return execFileSync(python, ['-c', 'import sys; print("Python " + sys.version.split()[0])'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Report this process's glibc, for diagnosing a venv built against a newer one.
 * @returns the glibc version, or undefined off glibc.
 */
export function runtimeGlibc() {
  return process.report?.getReport?.()?.header?.glibcVersionRuntime
}

/**
 * Resolve the virtual environment to activate.
 * @param options - environment, existence test, and version probe (all injectable for tests).
 * @returns `{ configured: false }`, or the resolved venv, interpreter, and bin directory.
 * @throws when `DSH_PYTHON_VENV` names a directory that has no usable interpreter.
 */
export function resolvePythonRuntime(options = {}) {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const probe = options.probe ?? probeInterpreter

  const explicit = env[PYTHON_VENV_ENV]?.trim() === '' ? undefined : env[PYTHON_VENV_ENV]?.trim()
  const baked = join(BAKED_VENV_PATH, 'bin', 'python')
  const chosen = explicit ?? (exists(baked) ? BAKED_VENV_PATH : undefined)
  if (chosen === undefined) return { configured: false }

  const bin = join(chosen, 'bin')
  const python = [join(bin, 'python'), join(bin, 'python3')].find(candidate => exists(candidate))
  if (python === undefined) {
    if (explicit === undefined) return { configured: false }
    throw new Error(
      `${PYTHON_VENV_ENV}=${explicit} is not a virtual environment: no bin/python or bin/python3. `
      + 'Mount the environment at the same absolute path it was created at, then set '
      + `${PYTHON_VENV_ENV} to that path.`,
    )
  }

  let version
  try {
    version = probe(python)
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).trim().split('\n')[0]
    const glibc = runtimeGlibc()
    throw new Error(
      `the Python at ${python} cannot run inside this image: ${detail}`
      + (glibc === undefined
        ? ''
        : `. A virtual environment built against a newer glibc than this image's ${glibc} `
          + 'cannot start here; rebuild it inside the container, or use an image matching the build host.'),
    )
  }
  return { configured: true, venv: chosen, python, bin, version }
}

/**
 * Activate a resolved runtime on an environment mapping.
 * @param runtime - the value from {@link resolvePythonRuntime}.
 * @param env - environment mapping to mutate (defaults to this process's).
 */
export function applyPythonRuntime(runtime, env = process.env) {
  if (!runtime.configured) return
  const path = (env.PATH ?? '').split(':').filter(entry => entry !== '' && entry !== runtime.bin)
  env.PATH = [runtime.bin, ...path].join(':')
  env.VIRTUAL_ENV = runtime.venv
  // A stale PYTHONHOME overrides venv prefix discovery and breaks every import.
  delete env.PYTHONHOME
}
