#!/usr/bin/env node
/**
 * Resolve a dependency that the registry mirror cannot serve from a tarball
 * vendored under `docker/vendor/`.
 *
 * SheetJS publishes `xlsx` 0.20.x only from `cdn.sheetjs.com`; that URL is not
 * on any npm registry, so a build host without access to that CDN cannot fetch
 * it (`ERR_PNPM_FETCH_TIMEOUT`). Editing the repository's `pnpm-workspace.yaml`
 * and `pnpm-lock.yaml` would work, but the lockfile changes with every upstream
 * dependency bump, which turns each `git pull` into a conflict.
 *
 * This runs inside the image build instead, before `pnpm install`: it rewrites
 * the manifest specifier and the matching lockfile entries in place, so the
 * install reads the tarball from the build context and never touches the CDN.
 *
 * Every rewrite asserts the text it expects. If the dependency moves or the
 * lockfile format changes, this fails loudly rather than silently restoring a
 * network fetch that only works on a connected host.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Dependency carrying a registry-unreachable tarball URL. */
const URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'

/** Vendored copy of that tarball, relative to the repository root. */
const VENDOR = 'docker/vendor/xlsx-0.20.3.tgz'

/** Manifest declaring the dependency, relative to the repository root. */
const MANIFEST = 'packages/client/ui-sidebar-documentpreview/package.json'

/** Specifier inside that manifest: `file:` paths resolve against the package. */
const MANIFEST_SPEC = `file:../../../${VENDOR}`

/** Lockfile entries are repository-relative. */
const LOCK_SPEC = `file:${VENDOR}`

/** Lockfile importer entries keep the manifest's own specifier text. */
const LOCK_IMPORTER_SPEC = MANIFEST_SPEC

/**
 * Replace one exact string, insisting that it is present.
 * @param text - current file content.
 * @param from - text to replace.
 * @param to - replacement.
 * @param where - file being edited, for the diagnostic.
 * @returns the updated content.
 */
function substitute(text, from, to, where) {
  if (text.includes(to) && !text.includes(from)) return text
  const count = text.split(from).length - 1
  if (count === 0) throw new Error(`${where}: expected to find ${JSON.stringify(from)}`)
  return text.split(from).join(to)
}

/**
 * Apply one replacement set to a file.
 * @param path - file relative to the working directory.
 * @param pairs - `[from, to]` replacements.
 */
function patch(path, pairs) {
  const original = readFileSync(path, 'utf8')
  let text = original
  for (const [from, to] of pairs) text = substitute(text, from, to, path)
  if (text !== original) {
    writeFileSync(path, text)
    console.log(`patch-vendored-deps: rewrote ${path}`)
  }
}

if (!existsSync(VENDOR)) {
  throw new Error(`patch-vendored-deps: ${VENDOR} is missing; copy it into docker/vendor/ (it is a binary and may be untracked in git)`)
}

patch(MANIFEST, [[`"${URL}"`, `"${MANIFEST_SPEC}"`]])
patch('pnpm-lock.yaml', [
  [`specifier: ${URL}`, `specifier: ${LOCK_IMPORTER_SPEC}`],
  [`version: ${URL}`, `version: ${LOCK_SPEC}`],
  [`tarball: ${URL}`, `tarball: ${LOCK_SPEC}`],
  // Both the `packages:` key and the `snapshots:` key use this exact line.
  [`xlsx@${URL}:`, `xlsx@${LOCK_SPEC}:`],
])
