import crypto from 'crypto'
import type { WabaInboundMessage, WabaStatus, WabaWebhookParseResult } from './types'

export function verifyWabaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecrets: string[]): boolean {
    if (!appSecrets || appSecrets.length === 0) return true
    if (!signatureHeader) return false

    const signature = signatureHeader.replace('sha256=', '')
    if (!signature) return false

    for (const secret of appSecrets) {
        if (!secret) continue
        const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
        try {
            const sigBuf = Buffer.from(signature, 'hex')
            const hmacBuf = Buffer.from(hmac, 'hex')
            if (sigBuf.length === hmacBuf.length && crypto.timingSafeEqual(sigBuf, hmacBuf)) {
                return true
            }
        } catch {
            // ignore and continue
        }
    }

    return false
}

export function parseWabaWebhook(payload: any): WabaWebhookParseResult {
    const messages: WabaInboundMessage[] = []
    const statuses: WabaStatus[] = []

    const entries = payload?.entry || []

    for (const entry of entries) {
        const changes = entry?.changes || []
        for (const change of changes) {
            const value = change?.value || {}
            const metadata = value?.metadata || {}
            const phoneNumberId = metadata?.phone_number_id
            const contacts = value?.contacts || []
            const contactMap = new Map<string, string>()

            for (const contact of contacts) {
                if (contact?.wa_id) {
                    contactMap.set(contact.wa_id, contact?.profile?.name)
                }
            }

            const inboundMessages = value?.messages || []
            for (const msg of inboundMessages) {
                if (!msg?.from || !msg?.id) continue
                const contactName = contactMap.get(msg.from)
                const referral =
                    (msg?.referral && typeof msg.referral === 'object' ? msg.referral : null) ||
                    (msg?.context?.referral && typeof msg.context.referral === 'object' ? msg.context.referral : null)
                const buttonReplyId =
                    msg?.button?.payload ||
                    msg?.interactive?.button_reply?.id ||
                    msg?.interactive?.list_reply?.id
                const buttonReplyTitle =
                    msg?.button?.text ||
                    msg?.interactive?.button_reply?.title ||
                    msg?.interactive?.list_reply?.title
                const buttonReplyDescription =
                    msg?.interactive?.list_reply?.description
                messages.push({
                    phoneNumberId,
                    from: msg.from,
                    id: msg.id,
                    timestamp: Number(msg.timestamp || 0),
                    type: msg.type,
                    text: msg.text,
                    button: msg.button,
                    interactive: msg.interactive,
                    image: msg.image,
                    document: msg.document,
                    audio: msg.audio,
                    video: msg.video,
                    referral,
                    contactName,
                    buttonReplyId,
                    buttonReplyTitle,
                    buttonReplyDescription,
                    raw: msg
                })
            }

            const statusUpdates = value?.statuses || []
            for (const status of statusUpdates) {
                if (!status?.id) continue
                statuses.push({
                    phoneNumberId,
                    id: status.id,
                    status: status.status,
                    timestamp: Number(status.timestamp || 0),
                    recipientId: status.recipient_id,
                    conversation: status.conversation,
                    pricing: status.pricing,
                    raw: status
                })
            }
        }
    }

    return { messages, statuses }
}
