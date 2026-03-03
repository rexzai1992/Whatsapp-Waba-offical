import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type WebhookConfig = {
    url: string
    events: string[]
}

export function createWebhookStore(filePath: string) {
    let webhooks = readJsonFile<Record<string, WebhookConfig>>(filePath, {})

    const persist = () => writeJsonFile(filePath, webhooks)

    return {
        get: (profileId: string) => webhooks[profileId] || null,
        set: (profileId: string, value: WebhookConfig) => {
            webhooks[profileId] = value
            persist()
        },
        remove: (profileId: string) => {
            delete webhooks[profileId]
            persist()
        },
        getAll: () => webhooks,
        async send(profileId: string, event: string, data: any) {
            const webhook = webhooks[profileId]
            if (!webhook?.url) return

            try {
                await fetch(webhook.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Event': event,
                        'X-Profile-Id': profileId
                    },
                    body: JSON.stringify({
                        event,
                        profileId,
                        timestamp: new Date().toISOString(),
                        data
                    })
                })
            } catch (error) {
                console.error(`Webhook error for ${profileId}:`, error)
            }
        }
    }
}
