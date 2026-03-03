export type OpenAiChatMessage = {
    role: 'system' | 'user' | 'assistant'
    content: string
}

type OpenAiCompletionParams = {
    apiKey: string
    model: string
    temperature: number
    maxTokens: number
    messages: OpenAiChatMessage[]
    timeoutMs?: number
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

function extractMessageText(content: any): string {
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

export function toOpenAiMessage(direction: string, content: any): OpenAiChatMessage | null {
    const text = extractMessageText(content)
    if (!text) return null
    return {
        role: direction === 'out' ? 'assistant' : 'user',
        content: text
    }
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
    return pickFirstTextContent(candidate)
}

export async function loadOpenAiMemoryForUser(
    supabase: any,
    userId: string,
    memoryMessages: number
): Promise<OpenAiChatMessage[]> {
    if (!userId || !memoryMessages || memoryMessages <= 0) return []

    const fetchLimit = Math.max(memoryMessages * 3, 24)
    const { data: rows, error } = await supabase
        .from('messages')
        .select('direction, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(fetchLimit)

    if (error || !Array.isArray(rows)) {
        return []
    }

    const history = rows
        .slice()
        .reverse()
        .map((row: any) => toOpenAiMessage(row.direction, row.content))
        .filter(Boolean) as OpenAiChatMessage[]

    if (history.length <= memoryMessages) return history
    return history.slice(-memoryMessages)
}

export async function requestOpenAiCompletion(params: OpenAiCompletionParams): Promise<{
    reply: string
    model: string
    usage: any
}> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs || 45000)

    let upstreamBody = ''
    let upstreamPayload: any = null
    let upstreamStatus = 500
    try {
        const upstream = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${params.apiKey}`
            },
            body: JSON.stringify({
                model: params.model,
                messages: params.messages,
                temperature: params.temperature,
                max_tokens: params.maxTokens
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
    } catch (error: any) {
        clearTimeout(timeout)
        if (error?.name === 'AbortError') {
            throw new Error('OpenAI request timed out')
        }
        throw error
    } finally {
        clearTimeout(timeout)
    }

    if (upstreamStatus < 200 || upstreamStatus >= 300) {
        const detail = upstreamPayload?.error?.message || upstreamBody || `OpenAI request failed (${upstreamStatus})`
        throw new Error(detail)
    }

    const reply = extractCompletionText(upstreamPayload)
    if (!reply) {
        throw new Error('OpenAI response did not include text output')
    }

    return {
        reply,
        model: upstreamPayload?.model || params.model,
        usage: upstreamPayload?.usage || null
    }
}
