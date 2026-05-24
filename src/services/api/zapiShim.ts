/**
 * Zapi Gateway shim for OpenClaude.
 *
 * Translates Anthropic SDK calls into Zapi's custom REST format and
 * streams back synthetic Anthropic SSE events so the rest of the codebase
 * is completely unaware of the difference.
 *
 * Zapi Claude endpoint:
 *   POST https://z.os7.site/api/llm/claude
 *   Authorization: Bearer <ZAPI_API_KEY>
 *   Body: { apikey, prompt, systemprompt? }
 *
 * Differences from OpenAI-compatible providers:
 *   - No native streaming  — simulated by emitting the full response as a
 *     single delta event in the Anthropic SSE format.
 *   - No native tool calls — tool schemas are injected into systemprompt,
 *     and <tool_call> XML markers are parsed from the response text.
 *   - No multi-turn history — the full conversation is flattened into a
 *     single `prompt` string before being sent.
 *
 * Environment variables:
 *   CLAUDE_CODE_USE_ZAPI=1    — enable this provider
 *   ZAPI_API_KEY=zp_...       — Zapi API key (required, starts with zp_)
 *   ZAPI_BASE_URL=...         — optional base URL override
 *   ZAPI_MODEL=claude         — optional model/endpoint path (default: claude)
 */

import { APIError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import type {
  AnthropicStreamEvent,
  ShimCreateParams,
} from './codexShim.js'

export const DEFAULT_ZAPI_BASE_URL = 'https://z.os7.site'
export const DEFAULT_ZAPI_MODEL = 'claude'

function getZapiApiKey(): string {
  return process.env.ZAPI_API_KEY?.trim() ?? ''
}

export function getZapiBaseUrl(): string {
  return (process.env.ZAPI_BASE_URL?.trim() ?? DEFAULT_ZAPI_BASE_URL).replace(/\/+$/, '')
}

function getZapiModel(): string {
  return process.env.ZAPI_MODEL?.trim() || DEFAULT_ZAPI_MODEL
}

// ---------------------------------------------------------------------------
// System prompt conversion (mirrors openaiShim's convertSystemPrompt)
// ---------------------------------------------------------------------------

function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return (system as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .filter(t => !t.startsWith('x-anthropic-billing-header'))
      .join('\n\n')
  }
  return String(system)
}

// ---------------------------------------------------------------------------
// Message flattening: Anthropic messages[] → single prompt string
// Zapi has no concept of message history, so we concatenate everything.
// ---------------------------------------------------------------------------

function extractTextFromBlock(block: Record<string, unknown>): string {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'tool_use': {
      const inputStr = JSON.stringify(block.input ?? {})
      return `[Tool call: ${block.name}(${inputStr})]`
    }
    case 'tool_result': {
      const c = block.content
      const resultText =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as Array<{ type?: string; text?: string }>)
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('\n')
            : JSON.stringify(c ?? '')
      const prefix = block.is_error ? 'Error: ' : ''
      return `[Tool result for ${block.tool_use_id}: ${prefix}${resultText}]`
    }
    case 'image':
      return '[Image attachment — not supported by Zapi]'
    case 'thinking':
      return ''
    default:
      return ''
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return (content as Array<Record<string, unknown>>)
    .map(block => extractTextFromBlock(block))
    .filter(Boolean)
    .join('\n')
}

function flattenMessagesToPrompt(messages: Array<Record<string, unknown>>): string {
  const lines: string[] = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'Human'
    const text = extractContentText(msg.content).trim()
    if (text) {
      lines.push(`${role}: ${text}`)
    }
  }
  return lines.join('\n\n')
}

// ---------------------------------------------------------------------------
// Tool schema injection into systemprompt
// Zapi has no native function-calling, so we teach the model via prompting.
// ---------------------------------------------------------------------------

const TOOL_USE_INSTRUCTION = `
When you need to use a tool, output ONLY a JSON block wrapped in <tool_call> tags:

<tool_call>
{"name": "<tool_name>", "arguments": {<arguments_as_json_object>}}
</tool_call>

Wait for the tool result before continuing. Available tools:`

function injectToolsIntoSystemPrompt(
  systemPrompt: string,
  tools: Array<Record<string, unknown>>,
): string {
  if (!tools.length) return systemPrompt

  const schemas = tools
    .map(tool => {
      const name = String(tool.name ?? '')
      const desc = String(tool.description ?? '')
      const inputSchema = tool.input_schema ?? {}
      return `• ${name}: ${desc}\n  Input schema: ${JSON.stringify(inputSchema)}`
    })
    .join('\n\n')

  const toolSection = `${TOOL_USE_INSTRUCTION}\n\n${schemas}`
  return systemPrompt ? `${systemPrompt}\n\n---\n${toolSection}` : toolSection
}

// ---------------------------------------------------------------------------
// Tool call parsing from plain-text response
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

let _toolCallCounter = 0
function makeToolCallId(): string {
  return `toolu_zapi_${Date.now()}_${String(++_toolCallCounter).padStart(3, '0')}`
}

function makeMessageId(): string {
  return `msg_zapi_${Date.now()}`
}

function parseToolCallsFromText(text: string): ParsedToolCall[] | null {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  const calls: ParsedToolCall[] = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>
      if (typeof parsed?.name === 'string') {
        calls.push({
          id: makeToolCallId(),
          name: parsed.name,
          input: (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>,
        })
      }
    } catch {
      // skip malformed blocks
    }
  }

  return calls.length > 0 ? calls : null
}

function stripToolCallMarkers(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
}

// ---------------------------------------------------------------------------
// Synthetic Anthropic SSE event generator
// ---------------------------------------------------------------------------

function* yieldTextResponse(
  messageId: string,
  model: string,
  text: string,
  inputTokens: number,
  outputTokens: number,
): Generator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'ping' }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }
  yield { type: 'message_stop' }
}

function* yieldToolResponse(
  messageId: string,
  model: string,
  toolCalls: ParsedToolCall[],
  prefixText: string,
  inputTokens: number,
  outputTokens: number,
): Generator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }

  let blockIndex = 0

  if (prefixText) {
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: prefixText },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  for (const call of toolCalls) {
    yield {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    }
    yield {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    }
    yield { type: 'content_block_stop', index: blockIndex }
    blockIndex++
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }
  yield { type: 'message_stop' }
}

// ---------------------------------------------------------------------------
// HTTP call to the Zapi endpoint
// ---------------------------------------------------------------------------

interface ZapiResponseBody {
  response?: string
  message?: string
  text?: string
  content?: string
  error?: string
  [key: string]: unknown
}

async function callZapi(options: {
  apiKey: string
  baseUrl: string
  model: string
  prompt: string
  systemprompt?: string
}): Promise<string> {
  const url = `${options.baseUrl}/api/llm/${options.model}`

  const body: Record<string, unknown> = {
    apikey: options.apiKey,
    prompt: options.prompt,
  }
  if (options.systemprompt) {
    body.systemprompt = options.systemprompt
  }

  logForDebugging(`[Zapi] POST ${url} model=${options.model}`)

  const response = await fetchWithProxyRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new APIError(
      response.status,
      { error: { message: `Zapi ${response.status}: ${errorText}` } },
      `Zapi request failed (HTTP ${response.status}): ${errorText}`,
      response.headers as never,
    )
  }

  const data = (await response.json()) as ZapiResponseBody

  const text =
    (typeof data.response === 'string' ? data.response : undefined) ??
    (typeof data.message === 'string' ? data.message : undefined) ??
    (typeof data.text === 'string' ? data.text : undefined) ??
    (typeof data.content === 'string' ? data.content : undefined)

  if (text !== undefined) {
    logForDebugging(`[Zapi] Response OK (${text.length} chars)`)
    return text
  }

  if (data.error) {
    throw new APIError(
      400,
      { error: { message: String(data.error) } },
      `Zapi returned error: ${data.error}`,
      {} as never,
    )
  }

  // Fallback: stringify whatever came back
  const fallback = JSON.stringify(data)
  logForDebugging(`[Zapi] Unknown response shape, stringifying: ${fallback.slice(0, 200)}`)
  return fallback
}

// ---------------------------------------------------------------------------
// Main async generator — emits Anthropic-format stream events
// ---------------------------------------------------------------------------

export async function* performZapiRequest(
  params: ShimCreateParams,
): AsyncGenerator<AnthropicStreamEvent> {
  const apiKey = getZapiApiKey()
  const baseUrl = getZapiBaseUrl()
  const model = getZapiModel()
  const messageId = makeMessageId()

  if (!apiKey) {
    throw new APIError(
      401,
      {
        error: {
          message:
            'ZAPI_API_KEY is not set. Export your Zapi API key (starts with zp_) as ZAPI_API_KEY.',
        },
      },
      'Missing ZAPI_API_KEY',
      {} as never,
    )
  }

  const rawSystem = convertSystemPrompt(params.system)
  const tools = (params.tools ?? []) as Array<Record<string, unknown>>
  const systemprompt =
    tools.length > 0 ? injectToolsIntoSystemPrompt(rawSystem, tools) : rawSystem

  const messages = (params.messages ?? []) as Array<Record<string, unknown>>
  const prompt = flattenMessagesToPrompt(messages)

  const inputTokens = Math.ceil((prompt.length + systemprompt.length) / 4)

  let responseText: string
  try {
    responseText = await callZapi({
      apiKey,
      baseUrl,
      model,
      prompt,
      systemprompt: systemprompt || undefined,
    })
  } catch (err) {
    if (err instanceof APIError) throw err
    throw new APIError(
      500,
      { error: { message: String(err) } },
      `Zapi network error: ${err}`,
      {} as never,
    )
  }

  const outputTokens = Math.ceil(responseText.length / 4)

  if (tools.length > 0) {
    const toolCalls = parseToolCallsFromText(responseText)
    if (toolCalls) {
      const prefixText = stripToolCallMarkers(responseText)
      yield* yieldToolResponse(messageId, model, toolCalls, prefixText, inputTokens, outputTokens)
      return
    }
  }

  yield* yieldTextResponse(messageId, model, responseText, inputTokens, outputTokens)
}

// ---------------------------------------------------------------------------
// Shim client factory — same shape as createOpenAIShimClient
// ---------------------------------------------------------------------------

class ZapiShimMessages {
  private defaultHeaders: Record<string, string>

  constructor(defaultHeaders: Record<string, string>) {
    this.defaultHeaders = defaultHeaders
  }

  async create(params: ShimCreateParams): Promise<unknown> {
    if (params.stream === false) {
      const events: AnthropicStreamEvent[] = []
      for await (const event of performZapiRequest(params)) {
        events.push(event)
      }
      const startEvt = events.find(e => e.type === 'message_start')
      return (startEvt as Record<string, unknown>)?.message ?? {
        type: 'message',
        role: 'assistant',
        content: [],
      }
    }
    return this._asStream(params)
  }

  private _asStream(params: ShimCreateParams): unknown {
    const gen = performZapiRequest(params)
    let closed = false

    const iter: AsyncIterable<AnthropicStreamEvent> & { controller: { abort(): void } } = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (closed) return { done: true as const, value: undefined }
            const r = await gen.next()
            if (r.done) {
              closed = true
              return { done: true as const, value: undefined }
            }
            return { done: false, value: r.value }
          },
          async return() {
            closed = true
            await gen.return(undefined)
            return { done: true as const, value: undefined }
          },
        }
      },
      controller: {
        abort() {
          closed = true
        },
      },
    }
    return iter
  }
}

class ZapiShimBeta {
  messages: ZapiShimMessages

  constructor(defaultHeaders: Record<string, string>) {
    this.messages = new ZapiShimMessages(defaultHeaders)
  }
}

export function createZapiShimClient(options: {
  defaultHeaders?: Record<string, string>
  maxRetries?: number
  timeout?: number
}): unknown {
  const beta = new ZapiShimBeta(options.defaultHeaders ?? {})
  return {
    beta,
    messages: beta.messages,
  }
}
