'use strict'

/** Freebuff model catalog (wire slugs from the official client). */
const MODELS = [
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    access: 'full',
    note: 'Full access, premium pool, default',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    access: 'full + limited',
    note: 'Non-premium; limited-mode default',
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    access: 'full',
    note: 'Premium',
  },
  {
    id: 'minimax/minimax-m3',
    name: 'MiniMax M3',
    access: 'full',
    note: 'Premium',
  },
  {
    id: 'mimo/mimo-v2.5',
    name: 'MiMo 2.5',
    access: 'full + limited',
    note: 'Non-premium',
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    access: 'earned',
    note: 'Referral / streak sessions only',
  },
]

module.exports = { MODELS }
