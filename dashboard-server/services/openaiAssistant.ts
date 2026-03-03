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

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

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

function extractResponsesText(payload: any): string {
    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text.trim()
    }

    const outputs = Array.isArray(payload?.output) ? payload.output : []
    const chunks: string[] = []
    outputs.forEach((item: any) => {
        if (!item || item.type !== 'message') return
        const content = Array.isArray(item.content) ? item.content : []
        content.forEach((part: any) => {
            if (!part || typeof part !== 'object') return
            if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
                chunks.push(part.text.trim())
                return
            }
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                chunks.push(part.text.trim())
                return
            }
            if (part.type === 'text' && typeof part?.text?.value === 'string' && part.text.value.trim()) {
                chunks.push(part.text.value.trim())
            }
        })
    })

    return chunks.join('\n').trim()
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
        const systemInstructions = params.messages
            .filter((msg) => msg.role === 'system')
            .map((msg) => msg.content.trim())
            .filter(Boolean)
            .join('\n\n')
            .trim()

        const inputMessages = params.messages
            .filter((msg) => msg.role !== 'system')
            .map((msg) => ({
                role: msg.role,
                // Use plain string content for conversation history across roles
                // (user + assistant) to keep Responses API role/content validation compatible.
                content: msg.content
            }))

        const requestBody: any = {
            model: params.model,
            input: inputMessages
        }
        if (systemInstructions) {
            requestBody.instructions = systemInstructions
        }
        if (Number.isFinite(params.temperature)) {
            requestBody.temperature = params.temperature
        }
        if (Number.isFinite(params.maxTokens) && params.maxTokens > 0) {
            requestBody.max_output_tokens = Math.floor(params.maxTokens)
        }

        const upstream = await fetch(OPENAI_RESPONSES_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${params.apiKey}`
            },
            body: JSON.stringify(requestBody),
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
            throw new Error('OpenAI Responses API request timed out')
        }
        throw error
    } finally {
        clearTimeout(timeout)
    }

    if (upstreamStatus < 200 || upstreamStatus >= 300) {
        const detail = upstreamPayload?.error?.message || upstreamBody || `OpenAI Responses API request failed (${upstreamStatus})`
        throw new Error(detail)
    }

    const reply = extractResponsesText(upstreamPayload)
    if (!reply) {
        throw new Error('OpenAI response did not include text output')
    }

    return {
        reply,
        model: upstreamPayload?.model || params.model,
        usage: upstreamPayload?.usage || null
    }
}
