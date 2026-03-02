
import { Router } from 'express'
import { webhookService } from './webhook-service'
import type { WabaClient } from '../waba/client'
import type { WorkflowEngine } from '../workflow/engine'
import { findOrCreateUser, getMessagesForUsers, getUsersForCompany, insertMessage } from '../services/wa-store'
import { sendWhatsAppMessage, canReplyFreely } from '../services/whatsapp'

export function createAddonRouter(
    getClient: (profileId: string) => Promise<WabaClient | null>,
    getCompanyIdForProfile: (profileId: string) => Promise<string | null>,
    workflowEngine: WorkflowEngine,
    verifyApiKey: any,
    options?: {
        resolveProfileAccess?: (req: any, res: any) => Promise<{ profileId: string; companyId: string; user: any } | null>
    }
) {
    const router = Router()
    const resolveProfileAccess = options?.resolveProfileAccess

    // 1. Send Message API
    router.post('/api/send-message', verifyApiKey, async (req: any, res: any) => {
        try {
            const { phone, message, media, caption } = req.body
            const profileId = req.apiKeyInfo.profileId

            if (!phone) {
                return res.status(400).json({ success: false, error: 'Phone is required' })
            }
            if (!message && !media) {
                return res.status(400).json({ success: false, error: 'Message or media is required' })
            }

            // Format phone
            let jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`

            const client = await getClient(profileId)
            if (!client) {
                return res.status(503).json({ success: false, error: 'WABA not configured for this profile' })
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                return res.status(400).json({ success: false, error: 'Company not found' })
            }

            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            const user = await findOrCreateUser(companyId, phoneNumber)
            if (!user) {
                return res.status(500).json({ success: false, error: 'Failed to resolve user' })
            }

            let responseMsg;

            if (media) {
                // WABA Cloud API expects a public URL for media
                // 1. Try to determine type via Extension (fastest)
                // 2. Fallback to HEAD request (light)

                let type = 'document'
                const ext = media.split('.').pop()?.toLowerCase() || ''
                if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) type = 'image'
                else if (['mp4', 'avi', 'mov'].includes(ext)) type = 'video'
                else if (['mp3', 'wav', 'ogg'].includes(ext)) type = 'audio'
                else {
                    // Fetch HEAD to check content-type
                    try {
                        const headRes = await fetch(media, { method: 'HEAD' })
                        const contentType = headRes.headers.get('content-type') || ''
                        if (contentType.includes('image')) type = 'image'
                        else if (contentType.includes('video')) type = 'video'
                        else if (contentType.includes('audio')) type = 'audio'
                    } catch (e) {
                        console.warn('HEAD request failed, defaulting to document', e)
                    }
                }

                const withinWindow = await canReplyFreely(user.id)
                if (!withinWindow) {
                    return res.status(400).json({ success: false, error: 'Outside 24h window: template required' })
                }

                responseMsg = await client.sendMedia(
                    jid,
                    type as 'image' | 'video' | 'audio' | 'document',
                    media,
                    {
                        caption: caption || undefined
                    }
                )
                const messageId = responseMsg?.messages?.[0]?.id
                await insertMessage({
                    userId: user.id,
                    direction: 'out',
                    content: {
                        type,
                        to: phoneNumber,
                        message_id: messageId,
                        media_url: media,
                        caption: caption || '',
                        status: 'sent'
                    },
                    workflowState: null
                })

            } else {
                // Text message
                responseMsg = await sendWhatsAppMessage({
                    client,
                    userId: user.id,
                    to: phoneNumber,
                    type: 'text',
                    content: { text: message }
                })
            }

            const messageId = responseMsg?.messageId || responseMsg?.messages?.[0]?.id

            // Trigger event
            webhookService.trigger(profileId, 'message_sent', {
                to: jid,
                message: message || 'media',
                messageId
            })

            res.json({
                success: true,
                data: {
                    messageId,
                    status: 'sent',
                    timestamp: new Date().toISOString()
                }
            })

        } catch (error: any) {
            console.error('Addon Send Error:', error)

            // Trigger failed event
            if (req.apiKeyInfo?.profileId) {
                webhookService.trigger(req.apiKeyInfo.profileId, 'message_failed', {
                    error: error.message
                })
            }

            const status = error?.message?.includes('Outside 24h') ? 400 : 500
            res.status(status).json({ success: false, error: error.message })
        }
    })

    // 2. Get Message History API
    router.get('/api/messages', verifyApiKey, async (req: any, res: any) => {
        try {
            const profileId = req.apiKeyInfo.profileId
            const { phone, limit = 50 } = req.query

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                return res.json({ success: true, data: [] })
            }

            const users = await getUsersForCompany(companyId)
            let filteredUsers = users

            if (phone) {
                const cleanPhone = String(phone).replace(/\D/g, '')
                filteredUsers = users.filter(u => u.phone_number.includes(cleanPhone))
            }

            const messages = await getMessagesForUsers(filteredUsers.map(u => u.id), Number(limit))

            res.json({
                success: true,
                data: messages
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    // 3. Incoming Webhook Listener (Inject info)
    router.post('/webhook/incoming', verifyApiKey, async (req: any, res: any) => {
        try {
            const profileId = req.apiKeyInfo.profileId
            const body = req.body

            const client = await getClient(profileId)
            if (!client) {
                return res.status(503).json({ success: false, error: 'WABA not configured for this profile' })
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                return res.status(400).json({ success: false, error: 'Company not found' })
            }

            const from = body.from || ''
            const text = body.message || ''
            const phoneNumber = from.replace(/\D/g, '')

            await workflowEngine.processInbound({
                companyId,
                profileId,
                client,
                phoneNumber,
                messageType: 'text',
                text,
                raw: body
            })

            // Trigger Webhook (Outgoing)
            webhookService.trigger(profileId, 'message_received', {
                ...body,
                source: 'external_webhook'
            })

            res.json({ success: true, message: 'Processed' })

        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    // 4. Admin Settings API (Webhooks)
    // Accept either dashboard Bearer auth (tenant-scoped) or API key auth.
    const checkAdminAuth = async (req: any, res: any, next: any) => {
        const rawAuth = req.headers?.authorization
        const hasAuthHeader = typeof rawAuth === 'string' && rawAuth.trim().length > 0

        if (hasAuthHeader && resolveProfileAccess) {
            const access = await resolveProfileAccess(req, res)
            if (!access) return
            req.apiKeyInfo = {
                ...(req.apiKeyInfo || {}),
                profileId: access.profileId,
                companyId: access.companyId,
                userId: access.user?.id || null
            }
            return next()
        }

        return verifyApiKey(req, res, next)
    }

    router.get('/admin/webhooks', checkAdminAuth, (req: any, res: any) => {
        try {
            const profileId = req.apiKeyInfo?.profileId || 'default'
            res.json({
                success: true,
                data: webhookService.getWebhooks(profileId)
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message || 'Failed to load webhooks' })
        }
    })

    router.post('/admin/webhooks', checkAdminAuth, (req: any, res: any) => {
        try {
            const profileId = req.apiKeyInfo?.profileId || 'default'
            const { url, events, enabled, secret } = req.body

            if (!url || !events) {
                return res.status(400).json({ success: false, error: 'URL and events required' })
            }

            webhookService.addWebhook(profileId, {
                url,
                events,
                enabled: enabled !== false, // default true
                secret
            })

            res.json({ success: true })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message || 'Failed to save webhook' })
        }
    })

    router.delete('/admin/webhooks', checkAdminAuth, (req: any, res: any) => {
        try {
            const profileId = req.apiKeyInfo?.profileId || 'default'
            const { url } = req.body
            webhookService.removeWebhook(profileId, url)
            res.json({ success: true })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message || 'Failed to delete webhook' })
        }
    })

    return router
}
