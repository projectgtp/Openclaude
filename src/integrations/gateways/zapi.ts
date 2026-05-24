import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'zapi',
  label: 'Zapi Gateway',
  category: 'aggregating',
  defaultBaseUrl: 'https://z.os7.site',
  defaultModel: 'claude',
  supportsModelRouting: false,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['ZAPI_API_KEY'],
    setupPrompt:
      'Set ZAPI_API_KEY to your Zapi API key (starts with zp_). ' +
      'Get one at https://z.os7.site/dashboard',
  },
  transportConfig: {
    kind: 'openai-compatible',
  },
  preset: {
    id: 'zapi',
    description: 'Zapi Gateway — multi-model API gateway (Claude, Gemini, Llama, Qwen, and more)',
    label: 'Zapi Gateway',
    name: 'Zapi Gateway',
    apiKeyEnvVars: ['ZAPI_API_KEY'],
    baseUrlEnvVars: ['ZAPI_BASE_URL'],
    modelEnvVars: ['ZAPI_MODEL'],
    fallbackBaseUrl: 'https://z.os7.site',
    fallbackModel: 'claude',
  },
  catalog: {
    source: 'static',
    models: [
      { id: 'zapi-claude', apiName: 'claude', label: 'Claude (via Zapi)', default: true },
      { id: 'zapi-gemini', apiName: 'gemini', label: 'Gemini (via Zapi)' },
      { id: 'zapi-llama3', apiName: 'llama3', label: 'Llama 3.1 8B (via Zapi)' },
      { id: 'zapi-llama-3.3', apiName: 'llama-3.3', label: 'Llama 3.3 70B (via Zapi)' },
      { id: 'zapi-llama-4-scout', apiName: 'llama-4-scout', label: 'Llama 4 Scout 17B (via Zapi)' },
      { id: 'zapi-qwen', apiName: 'qwen', label: 'Qwen 3 235B (via Zapi)' },
      { id: 'zapi-qwq-32b', apiName: 'qwq-32b', label: 'QwQ 32B (via Zapi)' },
      { id: 'zapi-kimi-k2', apiName: 'kimi-k2', label: 'Kimi K2 (via Zapi)' },
      { id: 'zapi-venice', apiName: 'venice', label: 'Venice (via Zapi)' },
    ],
  },
  usage: { supported: false },
  validation: {
    kind: 'credential-env',
    credentialEnvVars: ['ZAPI_API_KEY'],
    missingCredentialMessage:
      'ZAPI_API_KEY is required. Set it to your Zapi API key (starts with zp_).',
    routing: {
      enablementEnvVar: 'CLAUDE_CODE_USE_ZAPI',
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['z.os7.site'],
    },
  },
})
