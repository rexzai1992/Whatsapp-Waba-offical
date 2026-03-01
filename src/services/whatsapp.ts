import type { WabaClient } from '../waba/client'
import { getLastInboundTimestamp, insertMessage, shouldMarkCtaReplyCandidate } from './wa-store'

const WINDOW_MS = 24 * 60 * 60 * 1000

export type SendMessageInput = {
    client: WabaClient
    userId: string
    to: string
    type: 'text' | 'buttons' | 'list' | 'cta_url' | 'template'
    content: any
    actor?: {
        user_id: string
        name: string
        color: string
    } | null
    workflowState?: any | null
}

const MAX_BUTTONS = 3

function normalizeButtons(buttons: Array<{ id: string; title: string }> = []) {
    if (buttons.length <= MAX_BUTTONS) return buttons
    console.warn(`[WhatsApp] Buttons capped at ${MAX_BUTTONS}; trimming ${buttons.length} -> ${MAX_BUTTONS}`)
    return buttons.slice(0, MAX_BUTTONS)
}

export async function canReplyFreely(userId: string): Promise<boolean> {
    const lastInbound = await getLastInboundTimestamp(userId)
    if (!lastInbound) return false
    const lastTime = new Date(lastInbound).getTime()
    return Date.now() - lastTime <= WINDOW_MS
}

export async function sendWhatsAppMessage(input: SendMessageInput) {
    const { client, userId, to, type, workflowState, actor } = input
    let { content } = input
    const messageActor =
        actor ||
        (workflowState
            ? {
                user_id: 'automation',
                name: 'Automation',
                color: '#2563eb'
            }
            : null)
    const withinWindow = await canReplyFreely(userId)
    const sentAtIso = new Date().toISOString()

    let response: any = null

    if (type === 'template') {
        response = await client.sendTemplate(to, content.name, content.language || 'en_US', content.components)
    } else if (!withinWindow) {
        if (content?.template) {
            response = await client.sendTemplate(to, content.template.name, content.template.language || 'en_US', content.template.components)
        } else {
            throw new Error('Outside 24h window: template required')
        }
    } else if (type === 'text') {
        response = await client.sendText(to, content.text)
    } else if (type === 'buttons') {
        const buttons = normalizeButtons(content.buttons || [])
        content = { ...content, buttons }
        response = await client.sendInteractiveButtons(to, content.text, buttons, {
            header: content.header,
            footer: content.footer
        })
    } else if (type === 'list') {
        response = await client.sendInteractiveList(
            to,
            content.text || content.body || '',
            content.button_text || content.buttonText || content.button || '',
            content.sections || [],
            {
                header: content.header,
                footer: content.footer
            }
        )
    } else if (type === 'cta_url') {
        response = await client.sendCtaUrl(
            to,
            content.body || content.text || '',
            content.button_text || content.display_text || '',
            content.url,
            {
                header: content.header,
                footer: content.footer
            }
        )
    } else {
        throw new Error(`Unsupported message type: ${type}`)
    }

    const messageId = response?.messages?.[0]?.id
    if (!messageId) {
        throw new Error('WABA API response missing message ID')
    }

    const ctaReplyCandidate = await shouldMarkCtaReplyCandidate(userId, sentAtIso)
    await insertMessage({
        userId,
        direction: 'out',
        content: {
            type,
            to,
            message_id: messageId,
            payload: content,
            status: 'sent',
            sent_at: sentAtIso,
            cta_entry_candidate: ctaReplyCandidate,
            agent: messageActor
        },
        workflowState: workflowState ?? null
    })

    return { response, messageId }
}
