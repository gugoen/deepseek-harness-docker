/**
 * Container-level environment normalization.
 *
 * Compose interpolates an unset variable to the empty string, and
 * `docker run -e NAME=` — like a Kubernetes ConfigMap key with no value —
 * exports one too. The harness reads `DEEPSEEK_BASE_URL` and
 * `DEEPSEEK_SEARCH_BASE_URL` from its launch environment and parses them with
 * `new URL()`, so an exported empty value aborts the whole profile at boot:
 *
 *   llm-deepseek (@deepseek-ai/dsh-llm-deepseek-api-key): TypeError: Invalid URL
 *     at new URL (node:internal/url)
 *     at resolveAdapterOptions (packages/llm/llm-deepseek/src/config.ts)
 *
 * An empty override means "no override" — the harness then falls back to its
 * public endpoint — so those entries are removed before the harness snapshots
 * its environment. The removal is reported, never silent.
 */

/** Environment names the harness parses as URLs, where empty means unset. */
export const URL_VALUED_ENV = ['DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL']

/**
 * Delete URL-valued environment entries that are present but empty.
 * @param env - environment mapping to mutate (defaults to this process's).
 * @returns the names actually removed, in declaration order.
 */
export function dropEmptyUrlEnv(env = process.env) {
  const dropped = []
  for (const name of URL_VALUED_ENV) {
    const value = env[name]
    if (value === undefined || value.trim() !== '') continue
    delete env[name]
    dropped.push(name)
  }
  return dropped
}
