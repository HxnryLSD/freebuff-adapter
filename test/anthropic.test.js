'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { Readable } = require('node:stream')

const anthropic = require('../src/anthropic')

test('anthropicToOpenAI converts a simple request', () => {
  const oai = anthropic.anthropicToOpenAI(
    {
      model: 'anthropic/claude-sonnet-4-5',
      max_tokens: 500,
      temperature: 0.5,
      stop_sequences: ['\n\nHuman:'],
      system: 'Be brief',
      stream: true,
      messages: [{ role: 'user', content: 'hi there' }],
    },
    { resolveModel: (m) => (m.includes('/') ? m : 'deepseek/deepseek-v4-pro') },
  )
  assert.equal(oai.model, 'deepseek/deepseek-v4-pro') // anthropic/ prefix stripped
  assert.equal(oai.max_tokens, 500)
  assert.equal(oai.stream, true)
  assert.deepEqual(oai.stop, ['\n\nHuman:'])
  assert.equal(oai.messages[0].role, 'system')
  assert.equal(oai.messages[0].content, 'Be brief')
  assert.equal(oai.messages[1].role, 'user')
})

test('anthropicToOpenAI converts tool_result and tool_use blocks', () => {
  const oai = anthropic.anthropicToOpenAI({
    model: 'deepseek/deepseek-v4-pro',
    tools: [
      {
        name: 'get_weather',
        description: 'Weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '72F' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'SF' } },
        ],
      },
      { role: 'user', content: 'thanks' },
    ],
  })
  assert.equal(oai.messages[0].role, 'tool')
  assert.equal(oai.messages[0].tool_call_id, 'toolu_01')
  assert.equal(oai.messages[1].role, 'assistant')
  assert.equal(oai.messages[1].tool_calls[0].function.name, 'get_weather')
  assert.equal(oai.messages[1].tool_calls[0].id, 'toolu_01')
  assert.deepEqual(JSON.parse(oai.messages[1].tool_calls[0].function.arguments), {
    city: 'SF',
  })
  assert.equal(oai.tools[0].function.parameters.type, 'object')
})

test('openaiToAnthropicResponse maps content, stop reason, usage', () => {
  const msg = anthropic.openaiToAnthropicResponse(
    {
      id: 'chatcmpl-1',
      choices: [
        {
          message: { role: 'assistant', content: 'Hello', tool_calls: [] },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    },
    'deepseek/deepseek-v4-pro',
  )
  assert.equal(msg.type, 'message')
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.usage.input_tokens, 5)
  assert.equal(msg.usage.output_tokens, 9)
})

test('openaiToAnthropicResponse maps tool calls to tool_use blocks', () => {
  const msg = anthropic.openaiToAnthropicResponse(
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {},
    },
    'm',
  )
  assert.equal(msg.content[0].type, 'tool_use')
  assert.equal(msg.content[0].name, 'get_weather')
  assert.deepEqual(msg.content[0].input, { city: 'SF' })
  assert.equal(msg.stop_reason, 'tool_use')
})

test('countAnthropicTokens returns a positive estimate', () => {
  const n = anthropic.countAnthropicTokens({
    model: 'deepseek/deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hello world, this is a longer test message' }],
  })
  assert.ok(Number.isInteger(n) && n >= 1)
})

function streamOfFrames(frames) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      frames.forEach((f, i) => setTimeout(() => c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`)), i * 10))
      setTimeout(() => c.close(), 120)
    },
  })
}

function collect(webStream) {
  return new Promise((resolve, reject) => {
    let out = ''
    const node = Readable.fromWeb(webStream)
    node.on('data', (c) => (out += c.toString()))
    node.on('end', () => resolve(out))
    node.on('error', reject)
  })
}

test('createAnthropicStream emits the text event sequence', async () => {
  const events = []
  const transform = anthropic.createAnthropicStream({
    model: 'm',
    id: 'msg_1',
    inputTokens: 5,
    onDone: ({ stopReason, outputTokens }) => {
      events.push(['done', stopReason, outputTokens])
    },
  })
  const out = await collect(
    streamOfFrames([
      { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
    ]).pipeThrough(transform),
  )
  assert.match(out, /event: message_start/)
  assert.match(out, /"type":"text_delta","text":"Hel"/)
  assert.match(out, /"type":"text_delta","text":"lo"/)
  assert.match(out, /"stop_reason":"end_turn"/)
  assert.match(out, /event: message_stop/)
  assert.deepEqual(events, [['done', 'end_turn', 9]])
})

test('createAnthropicStream emits tool_use blocks with input_json_delta', async () => {
  const transform = anthropic.createAnthropicStream({
    model: 'm',
    id: 'msg_2',
    inputTokens: 5,
  })
  const out = await collect(
    streamOfFrames([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: {} },
    ]).pipeThrough(transform),
  )
  assert.match(out, /"type":"tool_use","id":"call_1","name":"get_weather"/)
  assert.match(out, /"type":"input_json_delta","partial_json":"\{\\"city\\":/)
  assert.match(out, /"stop_reason":"tool_use"/)
})
