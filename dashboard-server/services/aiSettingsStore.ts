import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type CompanyAiSettingsRecord = {
    enabled: boolean
    model: string
    system_prompt: string
    temperature: number
    max_tokens: number
    memory_enabled: boolean
    memory_messages: number
    api_key?: string | null
    updated_at: string
    updated_by?: string | null
}

type CompanyAiSettingsMap = Record<string, CompanyAiSettingsRecord>

export const DEFAULT_COMPANY_AI_SETTINGS: CompanyAiSettingsRecord = {
    enabled: false,
    model: 'gpt-4o-mini',
    system_prompt: 'You are a concise, helpful WhatsApp business assistant.',
    temperature: 0.4,
    max_tokens: 512,
    memory_enabled: true,
    memory_messages: 16,
    api_key: null,
    updated_at: '',
    updated_by: null
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

function normalizeSettings(
    value: Partial<CompanyAiSettingsRecord> | undefined,
    fallback: CompanyAiSettingsRecord
): CompanyAiSettingsRecord {
    const source = value || {}
    const model = typeof source.model === 'string' && source.model.trim()
        ? source.model.trim()
        : fallback.model
    const systemPrompt = typeof source.system_prompt === 'string'
        ? source.system_prompt.slice(0, 4000)
        : fallback.system_prompt
    const updatedAt = typeof source.updated_at === 'string'
        ? source.updated_at
        : fallback.updated_at
    const apiKey = source.api_key === undefined
        ? fallback.api_key ?? null
        : (source.api_key ? String(source.api_key) : null)

    return {
        enabled: Boolean(source.enabled),
        model,
        system_prompt: systemPrompt,
        temperature: clampTemperature(source.temperature, fallback.temperature),
        max_tokens: clampMaxTokens(source.max_tokens, fallback.max_tokens),
        memory_enabled: source.memory_enabled === undefined ? fallback.memory_enabled : Boolean(source.memory_enabled),
        memory_messages: clampMemoryMessages(source.memory_messages, fallback.memory_messages),
        api_key: apiKey,
        updated_at: updatedAt,
        updated_by: source.updated_by ? String(source.updated_by) : (fallback.updated_by ?? null)
    }
}

export function createCompanyAiSettingsStore(filePath: string) {
    let cache = readJsonFile<CompanyAiSettingsMap>(filePath, {})

    const persist = () => {
        writeJsonFile(filePath, cache)
    }

    const get = (companyId: string): CompanyAiSettingsRecord => {
        const existing = cache[companyId]
        return normalizeSettings(existing, DEFAULT_COMPANY_AI_SETTINGS)
    }

    const upsert = (
        companyId: string,
        patch: Partial<CompanyAiSettingsRecord>,
        userId?: string | null
    ): CompanyAiSettingsRecord => {
        const previous = get(companyId)
        const merged = normalizeSettings(
            {
                ...previous,
                ...patch,
                updated_at: new Date().toISOString(),
                updated_by: userId ?? previous.updated_by
            },
            previous
        )
        cache[companyId] = merged
        persist()
        return merged
    }

    const setApiKey = (companyId: string, apiKey: string | null, userId?: string | null): CompanyAiSettingsRecord => {
        return upsert(companyId, { api_key: apiKey }, userId)
    }

    const clearApiKey = (companyId: string, userId?: string | null): CompanyAiSettingsRecord => {
        return upsert(companyId, { api_key: null }, userId)
    }

    return {
        get,
        upsert,
        setApiKey,
        clearApiKey
    }
}
