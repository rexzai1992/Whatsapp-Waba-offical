
import { createAddonRouter } from './api'
import { webhookService } from './webhook-service'
export { createAddonRouter, webhookService }

export async function handleEvents(profileId: string, events: any) {
    // 1. Connection Update
    if (events['connection.update']) {
        const update = events['connection.update']
        const { connection } = update

        if (connection === 'open') {
            webhookService.trigger(profileId, 'session_opened', { status: 'open' })
        } else if (connection === 'close') {
            webhookService.trigger(profileId, 'session_closed', { reason: 'update.lastDisconnect' })
        }
    }

    // 2. Messages Upsert (Received)
    if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        upsert.messages.forEach((msg: any) => {
            if (!msg.key.fromMe) {
                // Determine content
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
                const type = Object.keys(msg.message || {})[0]

                webhookService.trigger(profileId, 'message_received', {
                    messageId: msg.key.id,
                    from: msg.key.remoteJid,
                    message: text,
                    type,
                    timestamp: msg.messageTimestamp,
                    pushName: msg.pushName
                })
            }
        })
    }

    // 3. Message Status Update (Sent/Delivered/Read)
    if (events['messages.update']) {
        const updates = events['messages.update']
        updates.forEach((update: any) => {
            // Status: 1=pending, 2=server_ack, 3=delivered, 4=read/played
            if (update.update.status) {
                let statusStr = 'unknown'
                switch (update.update.status) {
                    case 3: statusStr = 'delivered'; break;
                    case 4: statusStr = 'read'; break;
                }
                if (statusStr !== 'unknown') {
                    webhookService.trigger(profileId, `message_${statusStr}`, {
                        messageId: update.key.id,
                        to: update.key.remoteJid,
                        status: statusStr
                    })
                }
            }
        })
    }
}
