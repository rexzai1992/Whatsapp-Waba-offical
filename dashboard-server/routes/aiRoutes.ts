import type { Express } from 'express'
import {
    createCompanyAiSettingsStore,
    DEFAULT_COMPANY_AI_SETTINGS,
    type CompanyAiSettingsRecord
} from '../services/aiSettingsStore'

const ENCRYPTED_TOKEN_PREFIX = 'enc:v1:'
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

type ChatMessage = {
    role: 'system' | 'user' | 'assistant'
    content: string
}

function normalizePhoneNumber(input: string | null | undefined): string {
    if (!input) return ''
    return input.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '')
}

function maskApiKey(value: string): string {
    if (!value) return ''
    if (value.length <= 8) return '********'
    return `${value.slice(0, 4)}******${value.slice(-4)}`
}

function extractOutgoingText(content: any): string {
    if (!content || typeof content !== 'object') return ''
    const candidates = [
        content.text,
        content.payload?.text,
        content.payload?.body,
        content.caption,
        content.button_title
    ]
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
    if (typeof content.type === 'string' && content.type.trim()) {
        const kind = content.type.trim().toLowerCase()
        if (kind === 'image') return '[image]'
        if (kind === 'video') return '[video]'
        if (kind === 'document') return '[document]'
    }
    return ''
}

function toAiMessage(direction: string, content: any): ChatMessage | null {
    const text = extractOutgoingText(content)
    if (!text) return null
    return {
        role: direction === 'out' ? 'assistant' : 'user',
        content: text
    }
}

function clampTemperature(value: unknown, fallback: number): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(2, Math.max(0, Number(numeric.toFixed(2))))
}

function clampMaxTokens(value: unknown, fallback: number): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(4096, Math.max(64, Math.floor(numeric)))
}

function clampMemoryMessages(value: unknown, fallback: number): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.min(80, Math.max(0, Math.floor(numeric)))
}

function pickFirstTextContent(value: any): string {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        const chunks = value
            .map((chunk) => {
                if (typeof chunk === 'string') return chunk
                if (chunk && typeof chunk === 'object') {
                    if (typeof chunk.text === 'string') return chunk.text
                    if (typeof chunk?.type === 'string' && chunk.type === 'text' && typeof chunk?.text?.value === 'string') {
                        return chunk.text.value
                    }
                }
                return ''
            })
            .filter(Boolean)
        return chunks.join('\n').trim()
    }
    return ''
}

function extractCompletionText(payload: any): string {
    const firstChoice = payload?.choices?.[0]
    const candidate = firstChoice?.message?.content
    const text = pickFirstTextContent(candidate)
    return text
}

function toPublicSettings(settings: CompanyAiSettingsRecord) {
    const hasApiKey = Boolean(settings.api_key && settings.api_key.trim())
    let apiKeyHint = ''
    if (hasApiKey && settings.api_key) {
        const looksEncrypted = settings.api_key.startsWith(ENCRYPTED_TOKEN_PREFIX)
        apiKeyHint = looksEncrypted ? 'Encrypted key saved' : maskApiKey(settings.api_key)
    }

    return {
        enabled: settings.enabled,
        model: settings.model,
        systemPrompt: settings.system_prompt,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        memoryEnabled: settings.memory_enabled,
        memoryMessages: settings.memory_messages,
        hasApiKey,
        apiKeyHint,
        updatedAt: settings.updated_at
    }
}

async function loadMemoryMessages(
    supabase: any,
    companyId: string,
    contactJid: string,
    memoryMessages: number
): Promise<ChatMessage[]> {
    if (!memoryMessages || memoryMessages <= 0) return []
    const cleanPhone = normalizePhoneNumber(contactJid)
    if (!cleanPhone) return []

    const candidates = Array.from(new Set([cleanPhone, `${cleanPhone}@s.whatsapp.net`]))
    const { data: users, error: userError } = await supabase
        .from('users')
        .select('id, phone_number')
        .eq('company_id', companyId)
        .in('phone_number', candidates)
        .limit(2)

    if (userError || !Array.isArray(users) || users.length === 0) {
        return []
    }

    const matchedUser = users.find((row: any) => row.phone_number === cleanPhone) || users[0]
    const userId = matchedUser?.id
    if (!userId) return []

    const fetchLimit = Math.max(memoryMessages * 3, 24)
    const { data: rows, error: rowsError } = await supabase
        .from('messages')
        .select('direction, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(fetchLimit)

    if (rowsError || !Array.isArray(rows)) {
        return []
    }

    const history = rows
        .slice()
        .reverse()
        .map((row: any) => toAiMessage(row.direction, row.content))
        .filter(Boolean) as ChatMessage[]

    if (history.length <= memoryMessages) return history
    return history.slice(-memoryMessages)
}

export function registerAiRoutes(app: Express, ctx: any) {
    const {
        requireSupabaseUserMiddleware,
        resolveProfileAccess,
        resolvePath,
        readTrimmed,
        supabase,
        encryptToken,
        decryptToken,
        getTokenEncryptionKey
    } = ctx

    const settingsStore = createCompanyAiSettingsStore(resolvePath('company_ai_settings.json'))

    const encryptApiKeyForStore = (value: string): string => {
        if (!value) return value
        if (!getTokenEncryptionKey()) return value
        try {
            return encryptToken(value)
        } catch {
            return value
        }
    }

    const decryptApiKeyFromStore = (storedValue: string): string => {
        if (!storedValue) return ''
        if (!storedValue.startsWith(ENCRYPTED_TOKEN_PREFIX)) return storedValue
        try {
            return decryptToken(storedValue)
        } catch {
            return ''
        }
    }

    app.get('/api/company/ai/settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return

            const settings = settingsStore.get(access.companyId)
            return res.json({
                success: true,
                data: toPublicSettings(settings)
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error?.message || 'Failed to load AI settings' })
        }
    })

    app.post('/api/company/ai/settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return

            const current = settingsStore.get(access.companyId)

            const model = readTrimmed(req.body?.model) || current.model
            const systemPromptInput = typeof req.body?.systemPrompt === 'string'
                ? req.body.systemPrompt.slice(0, 4000)
                : current.system_prompt
            const temperature = clampTemperature(req.body?.temperature, current.temperature)
            const maxTokens = clampMaxTokens(req.body?.maxTokens, current.max_tokens)
            const memoryMessages = clampMemoryMessages(req.body?.memoryMessages, current.memory_messages)
            const enabled = req.body?.enabled === undefined ? current.enabled : Boolean(req.body.enabled)
            const memoryEnabled = req.body?.memoryEnabled === undefined ? current.memory_enabled : Boolean(req.body.memoryEnabled)

            const incomingApiKey = readTrimmed(req.body?.apiKey)
            const clearApiKey = Boolean(req.body?.clearApiKey)
            let nextApiKey = current.api_key ?? null

            if (clearApiKey) {
                nextApiKey = null
            } else if (incomingApiKey) {
                nextApiKey = encryptApiKeyForStore(incomingApiKey)
            }

            const updated = settingsStore.upsert(
                access.companyId,
                {
                    enabled,
                    model,
                    system_prompt: systemPromptInput || DEFAULT_COMPANY_AI_SETTINGS.system_prompt,
                    temperature,
                    max_tokens: maxTokens,
                    memory_enabled: memoryEnabled,
                    memory_messages: memoryMessages,
                    api_key: nextApiKey
                },
                access.user?.id || null
            )

            return res.json({
                success: true,
                data: toPublicSettings(updated)
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error?.message || 'Failed to save AI settings' })
        }
    })

    app.post('/api/company/ai/generate', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return

            const prompt = readTrimmed(req.body?.prompt)
            if (!prompt) {
                return res.status(400).json({ success: false, error: 'prompt is required' })
            }

            const settings = settingsStore.get(access.companyId)
            const decryptedApiKey = settings.api_key ? decryptApiKeyFromStore(settings.api_key) : ''
            if (!decryptedApiKey) {
                return res.status(400).json({ success: false, error: 'OpenAI API key is not configured' })
            }

            const contactJid = readTrimmed(req.body?.contactJid)
            const memoryMessages = settings.memory_enabled
                ? await loadMemoryMessages(supabase, access.companyId, contactJid, settings.memory_messages)
                : []

            const requestMessages: ChatMessage[] = []
            const trimmedSystemPrompt = (settings.system_prompt || '').trim()
            if (trimmedSystemPrompt) {
                requestMessages.push({
                    role: 'system',
                    content: trimmedSystemPrompt
                })
            }
            requestMessages.push(...memoryMessages)
            requestMessages.push({
                role: 'user',
                content: prompt
            })

            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 45000)

            let upstreamBody = ''
            let upstreamPayload: any = null
            let upstreamStatus = 500
            try {
                const upstream = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${decryptedApiKey}`
                    },
                    body: JSON.stringify({
                        model: settings.model,
                        messages: requestMessages,
                        temperature: settings.temperature,
                        max_tokens: settings.max_tokens
                    }),
                    signal: controller.signal
                })
                upstreamStatus = upstream.status
                upstreamBody = await upstream.text()
                if (upstreamBody) {
                    try {
                        upstreamPayload = JSON.parse(upstreamBody)
                    } catch {
                        upstreamPayload = null
                    }
                }
            } finally {
                clearTimeout(timeout)
            }

            if (upstreamStatus < 200 || upstreamStatus >= 300) {
                const detail = upstreamPayload?.error?.message || upstreamBody || `OpenAI request failed (${upstreamStatus})`
                return res.status(502).json({ success: false, error: detail })
            }

            const reply = extractCompletionText(upstreamPayload)
            if (!reply) {
                return res.status(502).json({ success: false, error: 'OpenAI response did not include text output' })
            }

            return res.json({
                success: true,
                data: {
                    reply,
                    model: upstreamPayload?.model || settings.model,
                    usage: upstreamPayload?.usage || null,
                    memoryMessagesUsed: memoryMessages.length
                }
            })
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                return res.status(504).json({ success: false, error: 'OpenAI request timed out' })
            }
            return res.status(500).json({ success: false, error: error?.message || 'Failed to generate AI reply' })
        }
    })
}
