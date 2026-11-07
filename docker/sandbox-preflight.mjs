/**
 * Sandbox preflight: decide whether the harness can confine shell commands in
 * this container, and widen the permission mode when it cannot.
 *
 * `sandbox-local` picks its Linux runner from `bwrap` then the Landlock
 * launcher. It fails **closed**: when neither probe passes, every agent shell
 * command is refused with `SandboxUnavailableError`, which makes the container
 * unusable at the default `workspace-write` mode.
 *
 * Two host conditions leave both runners unusable:
 *
 *   - a kernel older than 5.13 (no Landlock), and
 *   - unprivileged user namespaces disabled (`user.max_user_namespaces = 0`,
 *     the default on RHEL/CentOS 7), which `bwrap` needs;
 *   - an older container runtime whose seccomp profile blocks the Landlock
 *     syscalls (`landlock_create_ruleset` and friends).
 *
 * On such a host the only mode that can run commands is `danger-full-access`.
 * This module probes the same two runners the harness probes and, unless the
 * operator set `DSH_PERMISSION_MODE` or disabled the fallback, sets that mode
 * so the container works instead of failing every command. It never silently
 * widens on a host that can sandbox: a passing probe leaves the default alone.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Permission mode the harness and this module read. */
export const PERMISSION_MODE_ENV = 'DSH_PERMISSION_MODE'

/** Optional switch: set to `0` to keep the harness's fail-closed behaviour. */
export const SANDBOX_FALLBACK_ENV = 'DSH_SANDBOX_FALLBACK'

/** The only mode that runs commands without any confinement backend. */
export const FALLBACK_MODE = 'danger-full-access'

/** Timeout for each probe, matching the harness's own bounded probe. */
const PROBE_TIMEOUT_MS = 5000

/**
 * The read-only bwrap profile `sandbox-local` probes with, followed by a
 * trivial command. `--unshare-pid` is what needs a user namespace.
 */
export const BWRAP_PROBE_ARGS = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
  '--', 'true',
]

/**
 * Absolute path of the Landlock launcher for this platform and architecture.
 * @param arch - `process.arch` of the running image.
 * @param platform - `process.platform` of the running image.
 * @returns the launcher path, or undefined where the image ships none.
 */
export function landlockLauncherPath(arch = process.arch, platform = process.platform) {
  if (platform !== 'linux') return undefined
  return `/app/native/system/packages/linux-${arch}/bin/landlock-run`
}

/**
 * Run one probe command and report whether it exited successfully.
 * @param command - executable to run.
 * @param args - arguments.
 * @returns true only for a zero exit within the timeout.
 */
function succeeded(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    timeout: PROBE_TIMEOUT_MS,
  })
  return result.error === undefined && result.status === 0
}

/**
 * Probe the Landlock launcher the way the harness does: `--probe` applies a
 * maximal ruleset and reports whether the kernel accepted it.
 * @param options - injectable path, existence test, and probe.
 * @returns the probe outcome and a short reason.
 */
export function probeLandlock(options = {}) {
  const launcher = options.launcher ?? landlockLauncherPath()
  const exists = options.exists ?? existsSync
  const run = options.run ?? succeeded
  if (launcher === undefined) return { available: false, detail: 'no Linux launcher' }
  if (!exists(launcher)) return { available: false, detail: `missing ${launcher}` }
  return run(launcher, ['--probe'])
    ? { available: true, detail: launcher }
    : { available: false, detail: 'probe rejected (kernel without Landlock, or seccomp blocking it)' }
}

/**
 * Probe `bwrap` with the harness's own read-only profile plus `true`.
 * @param options - injectable probe runner.
 * @returns the probe outcome and a short reason.
 */
export function probeBwrap(options = {}) {
  const run = options.run ?? succeeded
  return run('bwrap', BWRAP_PROBE_ARGS)
    ? { available: true, detail: 'bwrap' }
    : { available: false, detail: 'probe rejected (missing bwrap, or user namespaces disabled)' }
}

/**
 * Read an environment value, treating unset and empty alike.
 * @param env - environment mapping.
 * @param name - variable name.
 * @returns the trimmed value, or undefined.
 */
function optional(env, name) {
  const raw = env[name]
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
}

/**
 * Decide the permission mode for this container.
 * @param options - environment and injectable probes.
 * @returns an explicit request, the available-runners outcome, the fail-closed
 *   outcome, or the fallback with its diagnostic.
 */
export function planSandboxMode(options = {}) {
  const env = options.env ?? process.env
  const probeL = options.probeLandlock ?? probeLandlock
  const probeB = options.probeBwrap ?? probeBwrap

  const explicit = optional(env, PERMISSION_MODE_ENV)
  if (explicit !== undefined) return { kind: 'explicit', mode: explicit }

  // Mirror the harness order: bwrap is preferred, Landlock is the fallback rung.
  const bwrap = probeB()
  const landlock = bwrap.available ? { available: true, detail: 'not probed' } : probeL()
  if (bwrap.available || landlock.available) {
    return { kind: 'available', runner: bwrap.available ? 'bwrap' : 'landlock' }
  }
  if (optional(env, SANDBOX_FALLBACK_ENV) === '0') {
    return { kind: 'unavailable', bwrap, landlock }
  }
  return { kind: 'fallback', mode: FALLBACK_MODE, bwrap, landlock }
}

/**
 * Apply a plan to an environment mapping: a fallback writes the widened mode
 * so the harness resolves its sandbox policy from it.
 * @param plan - the value from {@link planSandboxMode}.
 * @param env - environment mapping to mutate (defaults to this process's).
 * @returns the plan, unchanged.
 */
export function applySandboxMode(plan, env = process.env) {
  if (plan.kind === 'fallback') env[PERMISSION_MODE_ENV] = plan.mode
  return plan
}
