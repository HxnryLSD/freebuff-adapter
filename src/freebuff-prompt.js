'use strict'

/**
 * Freebuff free-mode chat gate.
 *
 * The live backend gates free-mode chat to the official freebuff CLI by
 * requiring the request's first system message to open with one of the
 * canonical freebuff root prompts at byte 0 (a byte-exact prefix test on the
 * trimmed content — see `hasFreebuffRootSystemPromptOpening` in the official
 * repo's `common/src/constants/free-agents.ts`). A generic proxy forwards the
 * calling agent's own system prompt (or none), so the server 403s it with
 * `free_mode_cli_required`.
 *
 * The port therefore injects the canonical Buffy system prompt as the first
 * message before forwarding. The openings below are copies of the server-side
 * constants; the base3-free roots the port talks to open with the Codebuff
 * line, which is the one we inject.
 */

const FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS = [
  // base2-free roots (legacy CLI)
  'You are Buffy, the strategic coding assistant.',
  // base3-free roots — the ones the port's models map to
  'You are Buffy, the coding agent behind Codebuff.',
  // Cloud planner roots
  'You are Buffy, the Freebuff Cloud project planner.',
  // LEGACY pre-0.0.119 base2 opening, still accepted by the server
  'You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.',
]

const INJECTED_SYSTEM_PROMPT = `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Freebuff Meta-information
You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free.`

/** True when `text` (trimmed) opens with one of the canonical root prompts. */
function hasCanonicalOpening(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trimStart()
  return FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS.some((opening) =>
    trimmed.startsWith(opening),
  )
}

/** True when `messages[0]` is a system message with a canonical opening. */
function hasCanonicalSystemPrompt(messages) {
  if (!Array.isArray(messages)) return false
  const first = messages[0]
  return Boolean(
    first && first.role === 'system' && hasCanonicalOpening(first.content),
  )
}

/**
 * Ensure the message list opens with the canonical Buffy system prompt.
 * Returns the original array unchanged when it already qualifies; otherwise a
 * new array with the canonical prompt prepended (never mutates the input).
 */
function withCanonicalSystemPrompt(messages) {
  if (hasCanonicalSystemPrompt(messages)) return messages
  const base = Array.isArray(messages) ? messages : []
  return [{ role: 'system', content: INJECTED_SYSTEM_PROMPT }, ...base]
}

module.exports = {
  FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS,
  INJECTED_SYSTEM_PROMPT,
  hasCanonicalOpening,
  hasCanonicalSystemPrompt,
  withCanonicalSystemPrompt,
}
