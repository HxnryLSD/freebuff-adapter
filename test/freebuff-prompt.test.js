'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  hasCanonicalOpening,
  hasCanonicalSystemPrompt,
  withCanonicalSystemPrompt,
  INJECTED_SYSTEM_PROMPT,
} = require('../src/freebuff-prompt')
const { MockUpstream } = require('../src/mock')

test('hasCanonicalOpening accepts canonical openings with a suffix', () => {
  assert.equal(hasCanonicalOpening('You are Buffy, the coding agent behind Codebuff.'), true)
  assert.equal(
    hasCanonicalOpening('You are Buffy, the coding agent behind Codebuff. And more.'),
    true,
  )
  // leading whitespace tolerated (template literal trimming)
  assert.equal(
    hasCanonicalOpening('\n  You are Buffy, the coding agent behind Codebuff.'),
    true,
  )
})

test('hasCanonicalOpening rejects near-misses and non-strings', () => {
  assert.equal(hasCanonicalOpening('You are Buffy. the coding agent behind Codebuff.'), false)
  assert.equal(hasCanonicalOpening('you are buffy, the coding agent behind Codebuff.'), false)
  assert.equal(hasCanonicalOpening(''), false)
  assert.equal(hasCanonicalOpening(null), false)
})

test('withCanonicalSystemPrompt prepends when missing and preserves the rest', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  const out = withCanonicalSystemPrompt(messages)
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'system')
  assert.ok(out[0].content.startsWith('You are Buffy, the coding agent behind Codebuff.'))
  assert.deepEqual(out[1], messages[0])
  // input is not mutated
  assert.equal(messages.length, 1)
})

test('withCanonicalSystemPrompt is a no-op when already canonical', () => {
  const messages = [{ role: 'system', content: INJECTED_SYSTEM_PROMPT }, { role: 'user', content: 'hi' }]
  const out = withCanonicalSystemPrompt(messages)
  assert.strictEqual(out, messages)
})

test('withCanonicalSystemPrompt handles missing/empty messages', () => {
  const out = withCanonicalSystemPrompt(undefined)
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'system')
  assert.equal(hasCanonicalSystemPrompt(out), true)
})

test('mock chat gate mirrors the real backend', async () => {
  const mock = new MockUpstream()
  await mock.start()
  try {
    const token = 'mock-token'
    mock.sessions.set(token, {
      instanceId: 'inst-1',
      model: 'deepseek/deepseek-v4-flash',
      admittedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    // without the canonical opening -> 403 free_mode_cli_required
    let res = await fetch(`${mock.base()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
        codebuff_metadata: { freebuff_instance_id: 'inst-1' },
      }),
    })
    assert.equal(res.status, 403)
    assert.match(await res.text(), /free_mode_cli_required/)

    // with the canonical opening -> streams a completion
    res = await fetch(`${mock.base()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [
          { role: 'system', content: INJECTED_SYSTEM_PROMPT },
          { role: 'user', content: 'hello' },
        ],
        codebuff_metadata: { freebuff_instance_id: 'inst-1' },
      }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /chat\.completion\.chunk/)
    assert.match(text, /\[DONE\]/)
  } finally {
    mock.stop()
  }
})
