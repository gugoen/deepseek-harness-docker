/**
 * Unit tests for container environment normalization.
 *
 *   node --test docker/test/container-env.test.mjs
 *
 * The empty-URL case is a shipped regression: `.env.example` carried an empty
 * `DEEPSEEK_BASE_URL`, Compose passed it through as an empty string, and the
 * harness aborted the whole profile with `TypeError: Invalid URL`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { dropEmptyUrlEnv, URL_VALUED_ENV } from '../container-env.mjs'

test('removes an empty DEEPSEEK_BASE_URL and reports it', () => {
  const env = { DEEPSEEK_BASE_URL: '', DEEPSEEK_API_KEY: 'sk-test' }
  assert.deepEqual(dropEmptyUrlEnv(env), ['DEEPSEEK_BASE_URL'])
  assert.equal('DEEPSEEK_BASE_URL' in env, false)
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
})

test('treats a whitespace-only value as empty', () => {
  const env = { DEEPSEEK_BASE_URL: '   ' }
  assert.deepEqual(dropEmptyUrlEnv(env), ['DEEPSEEK_BASE_URL'])
})

test('removes both URL-valued names', () => {
  const env = { DEEPSEEK_BASE_URL: '', DEEPSEEK_SEARCH_BASE_URL: '' }
  assert.deepEqual(dropEmptyUrlEnv(env), URL_VALUED_ENV)
  assert.deepEqual(env, {})
})

test('keeps a real value untouched', () => {
  const env = { DEEPSEEK_BASE_URL: 'https://internal.example/anthropic' }
  assert.deepEqual(dropEmptyUrlEnv(env), [])
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://internal.example/anthropic')
})

test('keeps an unset variable unset and invents nothing', () => {
  const env = {}
  assert.deepEqual(dropEmptyUrlEnv(env), [])
  assert.deepEqual(env, {})
})

test('never touches unrelated empty variables', () => {
  const env = { DEEPSEEK_API_KEY: '', DSH_PUBLIC_URL: '', PATH: '/usr/bin' }
  assert.deepEqual(dropEmptyUrlEnv(env), [])
  assert.deepEqual(env, { DEEPSEEK_API_KEY: '', DSH_PUBLIC_URL: '', PATH: '/usr/bin' })
})
