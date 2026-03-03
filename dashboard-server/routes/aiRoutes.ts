import type { Express } from 'express'
import {
    createCompanyAiSettingsStore,
    DEFAULT_COMPANY_AI_SETTINGS,
    type CompanyAiSettingsRecord
} from '../services/aiSettingsStore'
import { loadOpenAiMemoryForUser, requestOpenAiCompletion, type OpenAiChatMessage } from '../services/openaiAssistant'

const ENCRYPTED_TOKEN_PREFIX = 'enc:v1:'

function normalizePhoneNumber(input: string | null | undefined): string {
    if (!input) return ''
    return input.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '')
}

function maskApiKey(value: string): string {
    if (!value) return ''
    if (value.length <= 8) return '********'
    return `${value.slice(0, 4)}******${value.slice(-4)}`
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

async function loadMemoryMessagesByContact(
    supabase: any,
    companyId: string,
    contactJid: string,
    memoryMessages: number
): Promise<OpenAiChatMessage[]> {
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
    if (!matchedUser?.id) return []

    return loadOpenAiMemoryForUser(supabase, matchedUser.id, memoryMessages)
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
        getTokenEncryptionKey,
        aiSettingsStore
    } = ctx

    const settingsStore = aiSettingsStore || createCompanyAiSettingsStore(resolvePath('company_ai_settings.json'))

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
                ? await loadMemoryMessagesByContact(supabase, access.companyId, contactJid, settings.memory_messages)
                : []

            const requestMessages: OpenAiChatMessage[] = []
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

            const completion = await requestOpenAiCompletion({
                apiKey: decryptedApiKey,
                model: settings.model,
                temperature: settings.temperature,
                maxTokens: settings.max_tokens,
                messages: requestMessages,
                timeoutMs: 45000
            })

            return res.json({
                success: true,
                data: {
                    reply: completion.reply,
                    model: completion.model || settings.model,
                    usage: completion.usage,
                    memoryMessagesUsed: memoryMessages.length
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error?.message || 'Failed to generate AI reply' })
        }
    })
}
