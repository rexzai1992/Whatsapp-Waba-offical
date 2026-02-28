
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash, randomBytes } from 'crypto'
import type { Socket as NetSocket } from 'net'
import * as addon from './src/addon'
import { resolvePath } from './src/config'
import { supabase } from './src/supabase'
import { WabaRegistry } from './src/waba/registry'
import { parseWabaWebhook, verifyWabaSignature } from './src/waba/webhook'
import type { WabaInboundMessage, WabaStatus, WabaConfig } from './src/waba/types'
import { resolveCompanyId, findOrCreateUser, getMessagesForUsers, getUsersForCompany, insertMessage, getUserByPhone, deleteMessagesForUser, normalizePhoneNumber, updateMessageStatusByMessageId, updateUserName, setUserTags, getUsersWithExpiringWindow, updateUserWindowReminder } from './src/services/wa-store'
import type { MessageRecord } from './src/services/wa-store'
import { sendWhatsAppMessage, canReplyFreely } from './src/services/whatsapp'
import { WorkflowEngine } from './src/workflow/engine'
import { encryptToken, decryptToken, getTokenEncryptionKey } from './src/services/token-vault'
import { exchangeCodeForToken, exchangeForLongLivedToken, fetchBusinesses, fetchOwnedWabaAccounts, fetchClientWabaAccounts, fetchPhoneNumbers, subscribeWabaApp, createSystemUserToken, unsubscribeWabaApp } from './src/services/meta-graph'

// Helper functions replaced by store methods
const app = express()
app.use(cors())
app.use(express.json({
    verify: (req, _res, buf) => {
        ;(req as any).rawBody = buf
    }
}))

const httpServer = createServer(app)
const activeSockets = new Set<NetSocket>()

httpServer.on('connection', (socket) => {
    activeSockets.add(socket)
    socket.on('close', () => {
        activeSockets.delete(socket)
    })
})
const io = new Server(httpServer, {
    cors: { origin: '*' }
})

type CpuSnapshot = { idle: number; total: number }

function readCpuSnapshot(): CpuSnapshot {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    cpus.forEach(cpu => {
        const times = cpu.times
        idle += times.idle
        total += times.user + times.nice + times.sys + times.irq + times.idle
    })
    return { idle, total }
}

let lastCpuSnapshot: CpuSnapshot | null = null
type NetSnapshot = { bytesRead: number; bytesWritten: number; timestamp: number }
let lastNetSnapshot: NetSnapshot | null = null
let lastServerStats: any | null = null

function readNetworkSnapshot(): { bytesRead: number; bytesWritten: number } {
    let bytesRead = 0
    let bytesWritten = 0
    activeSockets.forEach((socket) => {
        bytesRead += socket.bytesRead || 0
        bytesWritten += socket.bytesWritten || 0
    })
    return { bytesRead, bytesWritten }
}

function broadcastServerStats() {
    const snapshot = readCpuSnapshot()
    const now = Date.now()
    let cpuUsage = 0
    if (!lastCpuSnapshot) {
        lastCpuSnapshot = snapshot
    } else {
        const idleDelta = snapshot.idle - lastCpuSnapshot.idle
        const totalDelta = snapshot.total - lastCpuSnapshot.total
        cpuUsage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
        lastCpuSnapshot = snapshot
    }

    const memTotal = os.totalmem()
    const memFree = os.freemem()
    const memUsed = memTotal - memFree
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
    const memory = process.memoryUsage()

    const netNow = readNetworkSnapshot()
    let bandwidth = { inBps: 0, outBps: 0, inBytes: 0, outBytes: 0 }
    if (!lastNetSnapshot) {
        lastNetSnapshot = { ...netNow, timestamp: now }
    } else {
        const elapsedSec = Math.max(1, (now - lastNetSnapshot.timestamp) / 1000)
        const inBytes = Math.max(0, netNow.bytesRead - lastNetSnapshot.bytesRead)
        const outBytes = Math.max(0, netNow.bytesWritten - lastNetSnapshot.bytesWritten)
        bandwidth = {
            inBps: inBytes / elapsedSec,
            outBps: outBytes / elapsedSec,
            inBytes,
            outBytes
        }
        lastNetSnapshot = { ...netNow, timestamp: now }
    }

    const payload = {
        cpu: Number(cpuUsage.toFixed(1)),
        memUsed,
        memTotal,
        memPct: Number(memPct.toFixed(1)),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        bandwidth,
        timestamp: now
    }

    lastServerStats = payload
    io.emit('server.stats', payload)
}

broadcastServerStats()
setInterval(() => {
    broadcastServerStats()
}, 10_000)

const wabaRegistry = new WabaRegistry()
wabaRegistry.refresh(true).catch((err) => console.error('[WABA] Initial load failed:', err))
setInterval(() => {
    wabaRegistry.refresh().catch((err) => console.error('[WABA] Refresh failed:', err))
}, 60_000)

const WABA_OAUTH_SCOPES = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'business_management'
]

const WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_REMINDER_TEXT = 'Heads up! Our 24h reply window closes soon. Reply now if you need anything.'
const reminderRunningProfiles = new Set<string>()
const reminderCache = new Map<string, number>()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'

async function runWindowReminders() {
    const configs = await wabaRegistry.getProfileIds()
    for (const profileId of configs) {
        if (reminderRunningProfiles.has(profileId)) continue
        reminderRunningProfiles.add(profileId)
        try {
            const config = await wabaRegistry.getConfigByProfile(profileId)
            if (!config || !config.windowReminderEnabled) continue
            const minutes = Number(config.windowReminderMinutes || 0)
            if (!minutes || minutes <= 0) continue

            const companyId = await resolveCompanyId(config.companyId || profileId)
            if (!companyId) continue
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) continue

            const users = await getUsersWithExpiringWindow(companyId, minutes)
            for (const user of users) {
                const lastInboundMs = user.last_inbound_at ? new Date(user.last_inbound_at).getTime() : null
                if (!lastInboundMs || Number.isNaN(lastInboundMs)) continue
                const remainingMs = lastInboundMs + WINDOW_MS - Date.now()
                if (remainingMs <= 0) continue
                const cachedReminder = reminderCache.get(user.id)
                if (cachedReminder && cachedReminder >= lastInboundMs) continue

                const fallbackText = config.windowReminderText || DEFAULT_REMINDER_TEXT
                const message = fallbackText.replace('{minutes}', String(Math.max(1, Math.ceil(remainingMs / 60000))))

                try {
                    await sendWhatsAppMessage({
                        client,
                        userId: user.id,
                        to: user.phone_number,
                        type: 'text',
                        content: { text: message },
                        workflowState: null
                    })
                    await updateUserWindowReminder(user.id)
                    reminderCache.set(user.id, lastInboundMs)
                } catch (err: any) {
                    console.warn('[Reminder] Failed to send window reminder:', err?.message || err)
                }
            }
        } finally {
            reminderRunningProfiles.delete(profileId)
        }
    }
}

setInterval(() => {
    runWindowReminders().catch(err => console.error('[Reminder] tick failed:', err))
}, 60_000)

const workflowEngine = new WorkflowEngine()

function parseDateInput(raw: any, endOfDay = false) {
    if (!raw || typeof raw !== 'string') return null
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'
    const date = new Date(`${raw}${suffix}`)
    if (Number.isNaN(date.getTime())) return null
    return date
}

function toDayKey(date: Date) {
    return date.toISOString().slice(0, 10)
}

function lowerBound(nums: number[], target: number) {
    let lo = 0
    let hi = nums.length
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (nums[mid] < target) lo = mid + 1
        else hi = mid
    }
    return lo
}

async function getCompanyIdForProfile(profileId: string) {
    const config = await wabaRegistry.getConfigByProfile(profileId)
    return resolveCompanyId(config?.companyId || config?.profileId || profileId)
}

async function getCompanyIdForProfileOrProfileTable(profileId: string) {
    const { data } = await supabase
        .from('profiles')
        .select('company_id')
        .eq('id', profileId)
        .maybeSingle()

    if (data?.company_id) return data.company_id
    return getCompanyIdForProfile(profileId)
}

function hashOAuthState(state: string) {
    return createHash('sha256').update(state).digest('hex')
}

async function getSupabaseUserFromRequest(req: any, res: any) {
    const rawAuth = req.headers['authorization'] || ''
    const token = typeof rawAuth === 'string' && rawAuth.startsWith('Bearer ')
        ? rawAuth.slice(7)
        : rawAuth

    if (!token) {
        res.status(401).json({ success: false, error: 'Authorization token required' })
        return null
    }

    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) {
        res.status(401).json({ success: false, error: 'Invalid or expired session' })
        return null
    }

    return user
}

function getUserCompanyId(user: any): string | null {
    return user?.user_metadata?.company_id || user?.app_metadata?.company_id || null
}

async function assertProfileCompany(profileId: string, companyId: string): Promise<boolean> {
    const { data } = await supabase
        .from('profiles')
        .select('company_id')
        .eq('id', profileId)
        .maybeSingle()

    if (!data?.company_id) return false
    return data.company_id === companyId
}

function resolveOauthRedirectUri(req: any) {
    if (process.env.WABA_OAUTH_REDIRECT_URI) return process.env.WABA_OAUTH_REDIRECT_URI
    const host = req.get('host')
    const protocol = req.protocol || 'https'
    return `${protocol}://${host}/auth/waba/callback`
}

function resolveOauthReturnUrl(req: any) {
    return process.env.WABA_OAUTH_RETURN_URL || process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}`
}

function buildEmbeddedSignupUrl(params: {
    appId: string
    redirectUri: string
    state: string
    scopes: string[]
    apiVersion: string
    configId?: string
}) {
    const base = `https://www.facebook.com/${params.apiVersion}/dialog/oauth`
    const search = new URLSearchParams({
        client_id: params.appId,
        redirect_uri: params.redirectUri,
        response_type: 'code',
        scope: params.scopes.join(','),
        state: params.state
    })
    if (params.configId) search.set('config_id', params.configId)
    return `${base}?${search.toString()}`
}

app.get('/', (req: any, res: any) => {
    res.send('Dashboard Server Running')
})


app.get('/api/flows', async (req: any, res: any) => {
    try {
        const profileId = req.query.profileId || 'default'
        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) return res.json({ workflows: [] })

        const { data, error } = await supabase
            .from('workflows')
            .select('*')
            .eq('company_id', companyId)

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ workflows: data || [] })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/flows', async (req: any, res: any) => {
    try {
        const profileId = req.query.profileId || 'default'
        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) return res.status(400).json({ success: false, error: 'Company not found' })

        const payload = req.body?.workflows || req.body
        if (!Array.isArray(payload)) {
            return res.status(400).json({ success: false, error: 'workflows array required' })
        }

        const toUpsert = payload.map((wf: any) => ({
            id: wf.id,
            company_id: companyId,
            trigger_keyword: wf.trigger_keyword || wf.triggerKeyword || '',
            actions: wf.actions || [],
            builder: wf.builder || null
        }))

        const { error } = await supabase.from('workflows').upsert(toUpsert, { onConflict: 'id' })
        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ success: true })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Advanced analytics
app.get('/api/analytics', async (req: any, res: any) => {
    try {
        const profileId = req.query.profileId || 'default'
        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const now = new Date()
        const startDate = parseDateInput(req.query.start) || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        const endDate = parseDateInput(req.query.end, true) || now
        if (startDate.getTime() > endDate.getTime()) {
            return res.status(400).json({ success: false, error: 'Invalid date range' })
        }

        const { data: users, error: userError } = await supabase
            .from('users')
            .select('id, tags')
            .eq('company_id', companyId)

        if (userError) {
            return res.status(500).json({ success: false, error: userError.message })
        }

        const allTags = new Set<string>()
        ;(users || []).forEach((u: any) => {
            const tags = Array.isArray(u.tags) ? u.tags : []
            tags.forEach((t: any) => {
                if (typeof t === 'string' && t.trim()) allTags.add(t.trim())
            })
        })

        const tagFilter = typeof req.query.tag === 'string' ? req.query.tag.trim() : ''
        const filteredUsers = tagFilter
            ? (users || []).filter((u: any) => Array.isArray(u.tags) && u.tags.includes(tagFilter))
            : (users || [])

        const userIds = filteredUsers.map((u: any) => u.id)
        if (userIds.length === 0) {
            return res.json({
                success: true,
                data: {
                    totals: { messages_total: 0, messages_sent: 0, workflow_runs: 0, expired_messages: 0 },
                    per_day: [],
                    tags: Array.from(allTags).sort()
                }
            })
        }

        const startIso = startDate.toISOString()
        const endIso = endDate.toISOString()
        const lookbackIso = new Date(startDate.getTime() - WINDOW_MS).toISOString()

        const fetchMessages = async (fromIso: string, toIso: string) => {
            const chunkSize = 200
            const rows: any[] = []
            for (let i = 0; i < userIds.length; i += chunkSize) {
                const chunk = userIds.slice(i, i + chunkSize)
                const { data, error } = await supabase
                    .from('messages')
                    .select('user_id, direction, created_at, workflow_state')
                    .in('user_id', chunk)
                    .gte('created_at', fromIso)
                    .lte('created_at', toIso)

                if (error) {
                    throw new Error(error.message)
                }
                rows.push(...(data || []))
            }
            return rows
        }

        const messagesInRange = await fetchMessages(startIso, endIso)
        const messagesForInbound = await fetchMessages(lookbackIso, endIso)

        const totals = {
            messages_total: 0,
            messages_sent: 0,
            workflow_runs: 0,
            expired_messages: 0
        }

        const perDayMap = new Map<string, { total: number; inbound: number; sent: number }>()

        messagesInRange.forEach((msg: any) => {
            const createdAt = new Date(msg.created_at)
            const dayKey = toDayKey(createdAt)
            const row = perDayMap.get(dayKey) || { total: 0, inbound: 0, sent: 0 }
            row.total += 1
            if (msg.direction === 'out') row.sent += 1
            if (msg.direction === 'in') row.inbound += 1
            perDayMap.set(dayKey, row)

            totals.messages_total += 1
            if (msg.direction === 'out') totals.messages_sent += 1

            if (msg.direction === 'out') {
                const wfId = msg.workflow_state?.workflow_id || msg.workflow_state?.workflowId
                const stepIndex = Number(msg.workflow_state?.step_index)
                if (wfId && (!Number.isFinite(stepIndex) || stepIndex <= 1)) {
                    totals.workflow_runs += 1
                }
            }
        })

        const inboundMap = new Map<string, number[]>()
        messagesForInbound.forEach((msg: any) => {
            if (msg.direction !== 'in') return
            const arr = inboundMap.get(msg.user_id) || []
            const ts = new Date(msg.created_at).getTime()
            if (!Number.isNaN(ts)) arr.push(ts)
            inboundMap.set(msg.user_id, arr)
        })
        inboundMap.forEach((arr) => arr.sort((a, b) => a - b))

        messagesInRange.forEach((msg: any) => {
            if (msg.direction !== 'out') return
            const outTs = new Date(msg.created_at).getTime()
            if (Number.isNaN(outTs)) return
            const inboundTimes = inboundMap.get(msg.user_id) || []
            const lower = outTs - WINDOW_MS
            const idx = lowerBound(inboundTimes, lower)
            if (idx >= inboundTimes.length || inboundTimes[idx] > outTs) {
                totals.expired_messages += 1
            }
        })

        const per_day = Array.from(perDayMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([date, row]) => ({
                date,
                total: row.total,
                inbound: row.inbound,
                sent: row.sent
            }))

        res.json({
            success: true,
            data: {
                totals,
                per_day,
                tags: Array.from(allTags).sort()
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || 'Failed to load analytics' })
    }
})

// ============================================
// API KEY AUTHENTICATION MIDDLEWARE
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================
const API_KEYS_FILE = resolvePath('api_keys.json')

function loadApiKeys() {
    if (fs.existsSync(API_KEYS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf-8'))
        } catch (e) {
            return {}
        }
    }
    // Default API key for testing
    return { 'default-api-key': { profileId: 'default', name: 'Default Key' } }
}

function saveApiKeys(keys: any) {
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2))
}

let apiKeys = loadApiKeys()

function resolveProfileIdFromRequest(req: any, res: any): string | null {
    const adminPassword = req.query?.adminPassword || req.body?.adminPassword
    if (adminPassword === ADMIN_PASSWORD) {
        return req.query?.profileId || req.body?.profileId || 'default'
    }

    const apiKey = req.headers['x-api-key'] || req.query.apiKey
    if (!apiKey) {
        res.status(401).json({
            success: false,
            error: 'API key required. Provide via X-API-Key header or apiKey query parameter.'
        })
        return null
    }

    const keyInfo = apiKeys[apiKey]
    if (!keyInfo) {
        res.status(403).json({
            success: false,
            error: 'Invalid API key'
        })
        return null
    }

    return keyInfo.profileId
}

// Middleware to verify API key
const verifyApiKey = (req: any, res: any, next: any) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey

    if (!apiKey) {
        return res.status(401).json({
            success: false,
            error: 'API key required. Provide via X-API-Key header or apiKey query parameter.'
        })
    }

    const keyInfo = apiKeys[apiKey]
    if (!keyInfo) {
        return res.status(403).json({
            success: false,
            error: 'Invalid API key'
        })
    }

    req.apiKeyInfo = keyInfo
    next()
}




// ============================================
// WEBHOOK CONFIGURATION
// WEBHOOK CONFIGURATION
// ============================================
const WEBHOOKS_FILE = resolvePath('webhooks.json')

function loadWebhooks() {
    if (fs.existsSync(WEBHOOKS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'))
        } catch (e) {
            return {}
        }
    }
    return {}
}

function saveWebhooks(webhooks: any) {
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2))
}

let webhooks = loadWebhooks()

async function sendWebhook(profileId: string, event: string, data: any) {
    const webhook = webhooks[profileId]
    if (!webhook || !webhook.url) return

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

// ============================================
// PUBLIC API ENDPOINTS
// ============================================

// Send text message
app.post('/api/send-message', verifyApiKey, async (req: any, res: any) => {
    try {
        const { phone, message } = req.body
        const profileId = req.apiKeyInfo.profileId

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                error: 'Phone and message are required'
            })
        }

        // Format phone number
        let jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({
                success: false,
                error: 'WABA not configured for this profile.'
            })
        }

        const config = await wabaRegistry.getConfigByProfile(profileId)
        const companyId = await resolveCompanyId(config?.companyId || profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
        const user = await findOrCreateUser(companyId, phoneNumber)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const { messageId } = await sendWhatsAppMessage({
            client,
            userId: user.id,
            to: phoneNumber,
            type: 'text',
            content: { text: message }
        })

        res.json({
            success: true,
            data: {
                messageId: messageId || Date.now().toString(),
                phone: jid,
                message,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error: any) {
        console.error('Send message error:', error)
        const status = error?.message?.includes('Outside 24h') ? 400 : 500
        res.status(status).json({
            success: false,
            error: error.message || 'Failed to send message'
        })
    }
})

// Send image message
app.post('/api/send-image', verifyApiKey, async (req: any, res: any) => {
    try {
        const { phone, imageUrl, caption } = req.body
        const profileId = req.apiKeyInfo.profileId

        if (!phone || !imageUrl) {
            return res.status(400).json({
                success: false,
                error: 'Phone and imageUrl are required'
            })
        }

        // Format phone number
        let jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({
                success: false,
                error: 'WABA not configured for this profile.'
            })
        }

        const config = await wabaRegistry.getConfigByProfile(profileId)
        const companyId = await resolveCompanyId(config?.companyId || profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
        const user = await findOrCreateUser(companyId, phoneNumber)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const withinWindow = await canReplyFreely(user.id)
        if (!withinWindow) {
            return res.status(400).json({ success: false, error: 'Outside 24h window: template required' })
        }

        const response = await client.sendImage(phoneNumber, imageUrl, caption || '')
        const messageId = response?.messages?.[0]?.id

        await insertMessage({
            userId: user.id,
            direction: 'out',
            content: {
                type: 'image',
                to: phoneNumber,
                message_id: messageId,
                image_url: imageUrl,
                caption: caption || '',
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId: messageId || Date.now().toString(),
                phone: jid,
                imageUrl,
                caption,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error: any) {
        console.error('Send image error:', error)
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to send image'
        })
    }
})

// Get connection status
app.get('/api/status', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    wabaRegistry.getClientByProfile(profileId).then(client => {
        const status = client ? 'open' : 'close'
        res.json({
            success: true,
            data: {
                profileId,
                status,
                connected: status === 'open',
                user: client ? { phoneNumberId: client.phoneNumberId } : null
            }
        })
    }).catch(err => {
        console.error('Status error:', err)
        res.status(500).json({ success: false, error: 'Failed to check status' })
    })
})

// Configure conversational components (welcome message, commands, prompts)
app.get('/api/waba/conversational-automation', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return
        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const response = await client.getConversationalAutomation()
        res.json({ success: true, data: response })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/conversational-automation', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return
        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const { enable_welcome_message, commands, prompts } = req.body || {}
        const response = await client.setConversationalAutomation({
            enable_welcome_message,
            commands,
            prompts
        })

        res.json({ success: true, data: response })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Configure window reminder settings (24h window warning)
app.get('/api/waba/window-reminder', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const { data, error } = await supabase
            .from('waba_configs')
            .select('window_reminder_enabled, window_reminder_minutes, window_reminder_text')
            .eq('profile_id', profileId)
            .maybeSingle()

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: data || {
                window_reminder_enabled: false,
                window_reminder_minutes: null,
                window_reminder_text: null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/window-reminder', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const { data: existing, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id')
            .eq('profile_id', profileId)
            .maybeSingle()

        if (fetchError) {
            return res.status(500).json({ success: false, error: fetchError.message })
        }

        if (!existing) {
            return res.status(404).json({ success: false, error: 'WABA config not found for this profile.' })
        }

        const enabled = Boolean(req.body?.enabled)
        const minutesRaw = req.body?.minutes
        const minutesNumber = Number(minutesRaw)
        const minutes = Number.isFinite(minutesNumber) && minutesNumber > 0 ? Math.round(minutesNumber) : null
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : null

        const updatePayload = {
            window_reminder_enabled: enabled,
            window_reminder_minutes: minutes,
            window_reminder_text: text || null
        }

        const { error } = await supabase
            .from('waba_configs')
            .update(updatePayload)
            .eq('profile_id', profileId)

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        await wabaRegistry.refresh(true)

        res.json({ success: true, data: updatePayload })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// ============================================
// WABA EMBEDDED SIGNUP (OAUTH)
// ============================================
app.get('/api/waba/embedded-signup/url', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const profileId = typeof req.query?.profileId === 'string' ? req.query.profileId : undefined
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const appId = process.env.WABA_APP_ID || process.env.APP_ID
        const appSecret = process.env.WABA_APP_SECRET || process.env.APP_SECRET
        const verifyToken = process.env.WABA_VERIFY_TOKEN || process.env.VERIFY_TOKEN
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).json({ success: false, error: 'Missing WABA_APP_ID, WABA_APP_SECRET, or WABA_VERIFY_TOKEN' })
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).json({ success: false, error: 'Missing WABA_TOKEN_ENCRYPTION_KEY' })
        }

        const redirectUri = resolveOauthRedirectUri(req)
        const apiVersion = process.env.WABA_API_VERSION || 'v19.0'
        const configId = process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID

        const state = randomBytes(16).toString('hex')
        const stateHash = hashOAuthState(state)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

        const requestedBusinessId = typeof req.query?.businessId === 'string' ? req.query.businessId : null
        const requestedWabaId = typeof req.query?.wabaId === 'string' ? req.query.wabaId : null
        const requestedPhoneNumberId = typeof req.query?.phoneNumberId === 'string' ? req.query.phoneNumberId : null

        const redirectUrl = resolveOauthReturnUrl(req)

        const { error } = await supabase
            .from('waba_oauth_states')
            .insert({
                state_hash: stateHash,
                profile_id: profileId,
                company_id: companyId,
                user_id: user.id,
                requested_business_id: requestedBusinessId,
                requested_waba_id: requestedWabaId,
                requested_phone_number_id: requestedPhoneNumberId,
                redirect_url: redirectUrl,
                expires_at: expiresAt
            })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const url = buildEmbeddedSignupUrl({
            appId,
            redirectUri,
            state,
            scopes: WABA_OAUTH_SCOPES,
            apiVersion,
            configId: configId || undefined
        })

        res.json({ success: true, url })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

function renderOauthHtml(title: string, message: string, returnUrl?: string) {
    const link = returnUrl ? `<p><a href=\"${returnUrl}\">Return to dashboard</a></p>` : ''
    return `<!doctype html><html><head><meta charset=\"utf-8\"/><title>${title}</title></head><body style=\"font-family:Arial, sans-serif; padding:24px;\"><h2>${title}</h2><p>${message}</p>${link}</body></html>`
}

app.get('/auth/waba/callback', async (req: any, res: any) => {
    try {
        const errorParam = typeof req.query?.error === 'string' ? req.query.error : null
        const errorDescription = typeof req.query?.error_description === 'string' ? req.query.error_description : null
        if (errorParam) {
            return res.status(400).send(renderOauthHtml('Connection failed', errorDescription || errorParam, resolveOauthReturnUrl(req)))
        }

        const code = typeof req.query?.code === 'string' ? req.query.code : null
        const state = typeof req.query?.state === 'string' ? req.query.state : null
        if (!code || !state) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing code or state.', resolveOauthReturnUrl(req)))
        }

        const stateHash = hashOAuthState(state)
        const { data: stateRow, error: stateError } = await supabase
            .from('waba_oauth_states')
            .select('*')
            .eq('state_hash', stateHash)
            .maybeSingle()

        if (stateError || !stateRow) {
            return res.status(400).send(renderOauthHtml('Invalid state', 'OAuth state not found or expired.', resolveOauthReturnUrl(req)))
        }

        if (stateRow.used_at) {
            return res.status(400).send(renderOauthHtml('State already used', 'Please restart the signup flow.', stateRow.redirect_url || resolveOauthReturnUrl(req)))
        }

        if (stateRow.expires_at && new Date(stateRow.expires_at).getTime() < Date.now()) {
            return res.status(400).send(renderOauthHtml('State expired', 'Please restart the signup flow.', stateRow.redirect_url || resolveOauthReturnUrl(req)))
        }

        await supabase
            .from('waba_oauth_states')
            .update({ used_at: new Date().toISOString() })
            .eq('id', stateRow.id)

        const appId = process.env.WABA_APP_ID || process.env.APP_ID
        const appSecret = process.env.WABA_APP_SECRET || process.env.APP_SECRET
        const verifyToken = process.env.WABA_VERIFY_TOKEN || process.env.VERIFY_TOKEN
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).send(renderOauthHtml('Server misconfigured', 'Missing WABA_APP_ID, WABA_APP_SECRET, or WABA_VERIFY_TOKEN.'))
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).send(renderOauthHtml('Server misconfigured', 'Missing WABA_TOKEN_ENCRYPTION_KEY.'))
        }

        const apiVersion = process.env.WABA_API_VERSION || 'v19.0'
        const redirectUri = resolveOauthRedirectUri(req)

        const tokenData = await exchangeCodeForToken({
            appId,
            appSecret,
            redirectUri,
            code,
            apiVersion
        })

        let accessToken = tokenData.access_token
        let tokenType = tokenData.token_type
        let expiresIn = tokenData.expires_in

        try {
            const longLived = await exchangeForLongLivedToken({
                appId,
                appSecret,
                shortLivedToken: accessToken,
                apiVersion
            })
            if (longLived?.access_token) {
                accessToken = longLived.access_token
                tokenType = longLived.token_type || tokenType
                expiresIn = longLived.expires_in || expiresIn
            }
        } catch (err: any) {
            console.warn('[WABA] Long-lived token exchange failed:', err?.message || err)
        }

        let businessId = stateRow.requested_business_id as string | null
        if (!businessId) {
            const businesses = await fetchBusinesses(accessToken, apiVersion)
            if (!businesses.length) {
                return res.status(400).send(renderOauthHtml('No businesses found', 'This account has no Meta businesses available.'))
            }
            if (businesses.length > 1) {
                const list = businesses.map((b) => `${b.name || 'Business'} (${b.id})`).join(', ')
                return res.status(400).send(renderOauthHtml('Multiple businesses found', `Please restart and select a business ID. Found: ${list}`))
            }
            businessId = businesses[0].id
        }

        let wabaId = stateRow.requested_waba_id as string | null
        if (!wabaId) {
            const owned = await fetchOwnedWabaAccounts(businessId, accessToken, apiVersion)
            const candidates = owned.length ? owned : await fetchClientWabaAccounts(businessId, accessToken, apiVersion)
            if (!candidates.length) {
                return res.status(400).send(renderOauthHtml('No WABA found', 'No WhatsApp Business Accounts found for this business.'))
            }
            if (candidates.length > 1) {
                const list = candidates.map((b) => `${b.name || 'WABA'} (${b.id})`).join(', ')
                return res.status(400).send(renderOauthHtml('Multiple WABAs found', `Please restart and select a WABA ID. Found: ${list}`))
            }
            wabaId = candidates[0].id
        }

        let phoneNumberId = stateRow.requested_phone_number_id as string | null
        if (!phoneNumberId) {
            const numbers = await fetchPhoneNumbers(wabaId, accessToken, apiVersion)
            if (!numbers.length) {
                return res.status(400).send(renderOauthHtml('No phone numbers found', 'No phone numbers were found for this WABA.'))
            }
            phoneNumberId = numbers[0].id
        }

        try {
            await subscribeWabaApp(wabaId, accessToken, apiVersion)
        } catch (err: any) {
            return res.status(500).send(renderOauthHtml('Subscription failed', err?.message || 'Failed to subscribe app.'))
        }

        let systemUserToken: string | null = null
        let systemUserTokenExpiresAt: string | null = null
        const systemUserId = process.env.WABA_SYSTEM_USER_ID
        if (systemUserId) {
            try {
                const systemTokenResponse = await createSystemUserToken({
                    systemUserId,
                    accessToken,
                    scopes: WABA_OAUTH_SCOPES,
                    apiVersion
                }) as any
                if (systemTokenResponse?.access_token) {
                    systemUserToken = systemTokenResponse.access_token
                    if (systemTokenResponse.expires_in) {
                        systemUserTokenExpiresAt = new Date(Date.now() + Number(systemTokenResponse.expires_in) * 1000).toISOString()
                    }
                }
            } catch (err: any) {
                console.warn('[WABA] System user token exchange failed:', err?.message || err)
            }
        }

        const nowIso = new Date().toISOString()
        const accessTokenExpiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null

        const payload: any = {
            profile_id: stateRow.profile_id,
            company_id: stateRow.company_id,
            app_id: appId,
            phone_number_id: phoneNumberId,
            business_id: businessId,
            waba_id: wabaId,
            business_account_id: wabaId,
            access_token: encryptToken(accessToken),
            access_token_type: tokenType || null,
            access_token_expires_at: accessTokenExpiresAt,
            token_scopes: WABA_OAUTH_SCOPES,
            token_source: systemUserToken ? 'system_user' : 'user',
            system_user_token: systemUserToken ? encryptToken(systemUserToken) : null,
            system_user_token_expires_at: systemUserTokenExpiresAt,
            token_last_refreshed_at: nowIso,
            verify_token: verifyToken,
            app_secret: appSecret,
            api_version: apiVersion,
            enabled: true,
            connected_at: nowIso
        }

        const { error: upsertError } = await supabase
            .from('waba_configs')
            .upsert(payload, { onConflict: 'profile_id' })

        if (upsertError) {
            return res.status(500).send(renderOauthHtml('Storage failed', upsertError.message))
        }

        await wabaRegistry.refresh(true)

        const returnUrl = stateRow.redirect_url || resolveOauthReturnUrl(req)
        if (returnUrl) {
            const redirect = new URL(returnUrl)
            redirect.searchParams.set('waba', 'connected')
            return res.redirect(302, redirect.toString())
        }

        return res.send(renderOauthHtml('Connected', 'WhatsApp Business account connected successfully.'))
    } catch (error: any) {
        res.status(500).send(renderOauthHtml('Unexpected error', error.message || 'Unexpected error'))
    }
})

app.get('/api/waba/clients', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .eq('company_id', companyId)

        const profileIds = (profiles || []).map((row: any) => row.id).filter(Boolean)

        let query = supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, waba_id, business_account_id, enabled, connected_at, access_token_expires_at, token_source, api_version')

        if (profileIds.length > 0) {
            const inList = profileIds.map((id: string) => `"${id}"`).join(',')
            query = query.or(`company_id.eq.${companyId},profile_id.in.(${inList})`)
        } else {
            query = query.eq('company_id', companyId)
        }

        const { data, error } = await query
        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ success: true, data: data || [] })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/clients/disconnect', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const profileId = req.body?.profileId
        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const revoke = Boolean(req.body?.revoke)

        const { data: config, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, waba_id, business_account_id, access_token, system_user_token, api_version')
            .eq('profile_id', profileId)
            .maybeSingle()

        if (fetchError || !config) {
            return res.status(404).json({ success: false, error: fetchError?.message || 'WABA config not found' })
        }

        const wabaId = config.waba_id || config.business_account_id
        let unsubscribed = false
        let unsubscribeError: string | null = null

        if (revoke && wabaId) {
            try {
                const token = decryptToken(config.system_user_token || config.access_token)
                await unsubscribeWabaApp(wabaId, token, config.api_version || process.env.WABA_API_VERSION || 'v19.0')
                unsubscribed = true
            } catch (err: any) {
                unsubscribeError = err?.message || 'Failed to unsubscribe app'
            }
        }

        const { error: updateError } = await supabase
            .from('waba_configs')
            .update({ enabled: false })
            .eq('profile_id', profileId)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        await wabaRegistry.refresh(true)

        if (unsubscribeError) {
            return res.json({ success: false, error: unsubscribeError, disabled: true, unsubscribed })
        }

        res.json({ success: true, disabled: true, unsubscribed })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Connected client businesses for Meta app
app.get('/api/waba/connected-client-businesses', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(profileId)
        const rawAppId = req.query?.appId
        const appId = (Array.isArray(rawAppId) ? rawAppId[0] : rawAppId) || config?.appId

        if (!appId) {
            return res.status(400).json({
                success: false,
                error: 'Application ID is required. Add app_id to waba_configs or pass appId query param.'
            })
        }

        const rawFields = req.query?.fields
        const fields = Array.isArray(rawFields) ? rawFields.join(',') : rawFields
        const rawLimit = req.query?.limit
        const limit = rawLimit !== undefined ? Number(rawLimit) : undefined
        const rawAfter = req.query?.after
        const rawBefore = req.query?.before

        const response = await client.getConnectedClientBusinesses(String(appId), {
            fields: typeof fields === 'string' && fields.trim() ? fields.trim() : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            after: typeof rawAfter === 'string' ? rawAfter : Array.isArray(rawAfter) ? rawAfter[0] : undefined,
            before: typeof rawBefore === 'string' ? rawBefore : Array.isArray(rawBefore) ? rawBefore[0] : undefined
        })

        res.json({ success: true, data: response })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Configure global fallback settings (company-level)
app.get('/api/company/fallback-settings', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const companyId = await getCompanyIdForProfileOrProfileTable(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const { data, error } = await supabase
            .from('company')
            .select('fallback_text, fallback_limit')
            .eq('id', companyId)
            .maybeSingle()

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: {
                fallback_text: data?.fallback_text ?? null,
                fallback_limit: data?.fallback_limit ?? null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/fallback-settings', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const companyId = await getCompanyIdForProfileOrProfileTable(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const rawText = req.body?.fallback_text
        const rawLimit = req.body?.fallback_limit

        const fallbackText = typeof rawText === 'string' ? rawText.trim() : undefined
        let fallbackLimit: number | null | undefined
        if (rawLimit === '' || rawLimit === null || rawLimit === undefined) {
            fallbackLimit = null
        } else {
            const parsed = Number(rawLimit)
            fallbackLimit = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null
        }

        const { error } = await supabase
            .from('company')
            .update({
                fallback_text: fallbackText,
                fallback_limit: fallbackLimit
            })
            .eq('id', companyId)

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: { fallback_text: fallbackText ?? null, fallback_limit: fallbackLimit ?? null }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

const normalizeQuickReplyShortcut = (value: unknown): string => {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim()
    if (!trimmed) return ''
    const withoutSlash = trimmed.replace(/^\/+/, '')
    const token = withoutSlash.split(/\s+/)[0]
    return token.toLowerCase()
}

// Configure quick replies (company-level)
app.get('/api/company/quick-replies', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const companyId = await getCompanyIdForProfileOrProfileTable(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, text, created_at, updated_at')
            .eq('company_id', companyId)
            .order('shortcut', { ascending: true })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ success: true, data: data || [] })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/quick-replies', async (req: any, res: any) => {
    try {
        const profileId = resolveProfileIdFromRequest(req, res)
        if (!profileId) return

        const companyId = await getCompanyIdForProfileOrProfileTable(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const rawItems = req.body?.items
        if (!Array.isArray(rawItems)) {
            return res.status(400).json({ success: false, error: 'items must be an array' })
        }

        const seen = new Set<string>()
        const cleaned: Array<{ shortcut: string; text: string }> = []
        rawItems.forEach((item: any) => {
            const shortcut = normalizeQuickReplyShortcut(item?.shortcut)
            const text = typeof item?.text === 'string' ? item.text.trim() : ''
            if (!shortcut || !text) return
            if (seen.has(shortcut)) {
                return
            }
            seen.add(shortcut)
            cleaned.push({ shortcut, text })
        })

        const { error: deleteError } = await supabase
            .from('quick_replies')
            .delete()
            .eq('company_id', companyId)

        if (deleteError) {
            return res.status(500).json({ success: false, error: deleteError.message })
        }

        if (cleaned.length > 0) {
            const { error: insertError } = await supabase
                .from('quick_replies')
                .insert(cleaned.map(item => ({
                    company_id: companyId,
                    shortcut: item.shortcut,
                    text: item.text,
                    updated_at: new Date().toISOString()
                })))

            if (insertError) {
                return res.status(500).json({ success: false, error: insertError.message })
            }
        }

        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, text, created_at, updated_at')
            .eq('company_id', companyId)
            .order('shortcut', { ascending: true })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ success: true, data: data || [] })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// ============================================
// WABA WEBHOOK (Meta Cloud API)
// ============================================
app.get('/webhook', async (req: any, res: any) => {
    const mode = req.query['hub.mode']
    const token = Array.isArray(req.query['hub.verify_token']) ? req.query['hub.verify_token'][0] : req.query['hub.verify_token']
    const challenge = Array.isArray(req.query['hub.challenge']) ? req.query['hub.challenge'][0] : req.query['hub.challenge']

    if (mode !== 'subscribe' || !token) {
        return res.status(400).send('Invalid webhook verification request')
    }

    const tokens = await wabaRegistry.getVerifyTokens()
    if (tokens.includes(token)) {
        return res.status(200).send(challenge)
    }

    return res.status(403).send('Verification failed')
})

app.post('/webhook', async (req: any, res: any) => {
    try {
        const rawBody: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}))
        const signature = req.headers['x-hub-signature-256'] as string | undefined
        const appSecrets = await wabaRegistry.getAppSecrets()

        const valid = verifyWabaSignature(rawBody, signature, appSecrets)
        if (!valid) {
            return res.status(401).send('Invalid signature')
        }

        const { messages, statuses } = parseWabaWebhook(req.body || {})

        for (const msg of messages) {
            const config = await wabaRegistry.getConfigByPhoneNumberId(msg.phoneNumberId)
            if (!config) {
                console.warn('[WABA] No config for phone_number_id:', msg.phoneNumberId)
                continue
            }
            await handleInboundMessage(config, msg)
        }

        for (const status of statuses) {
            const config = await wabaRegistry.getConfigByPhoneNumberId(status.phoneNumberId)
            if (!config) continue
            await handleStatusUpdate(config, status)
        }

        return res.sendStatus(200)
    } catch (error) {
        console.error('WABA webhook error:', error)
        return res.sendStatus(500)
    }
})

// Configure webhook
app.post('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const { url, events } = req.body
    const profileId = req.apiKeyInfo.profileId

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'Webhook URL is required'
        })
    }

    webhooks[profileId] = {
        url,
        events: events || ['message', 'status']
    }
    saveWebhooks(webhooks)

    res.json({
        success: true,
        data: {
            profileId,
            webhook: webhooks[profileId]
        }
    })
})

// Get webhook config
app.get('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    res.json({
        success: true,
        data: webhooks[profileId] || null
    })
})

// Delete webhook
app.delete('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    delete webhooks[profileId]
    saveWebhooks(webhooks)
    res.json({ success: true })
})

// API Key management endpoints
app.post('/api/admin/api-keys', (req: any, res: any) => {
    const { adminPassword, profileId, name } = req.body

    // Simple admin password (you should change this!)
    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, error: 'Invalid admin password' })
    }

    const apiKey = `barly_${Date.now()}_${Math.random().toString(36).substring(7)}`
    apiKeys[apiKey] = { profileId, name }
    saveApiKeys(apiKeys)

    res.json({ success: true, data: { apiKey, profileId, name } })
})

app.get('/api/admin/api-keys', (req: any, res: any) => {
    const { adminPassword } = req.query

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, error: 'Invalid admin password' })
    }

    res.json({ success: true, data: apiKeys })
})

// ============================================
// ADMIN SUMMARY (/my)
// ============================================
app.get('/my', async (req: any, res: any) => {
    try {
        const adminPassword = req.query?.adminPassword || req.headers['x-admin-password']
        if (adminPassword !== ADMIN_PASSWORD) {
            return res.status(403).json({ success: false, error: 'Invalid admin password' })
        }

        const { data: companies, error } = await supabase
            .from('company')
            .select('*')
            .order('created_at', { ascending: false })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const companyRows = companies || []

        const companyStats = await Promise.all(companyRows.map(async (company: any) => {
            const [
                profilesCount,
                usersCount,
                workflowsCount,
                wabaCount,
                wabaEnabledCount,
                messagesCount
            ] = await Promise.all([
                supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
                supabase.from('users').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
                supabase.from('workflows').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
                supabase.from('waba_configs').select('profile_id', { count: 'exact', head: true }).eq('company_id', company.id),
                supabase.from('waba_configs').select('profile_id', { count: 'exact', head: true }).eq('company_id', company.id).eq('enabled', true),
                supabase
                    .from('messages')
                    .select('id, users!inner(company_id)', { count: 'exact', head: true })
                    .eq('users.company_id', company.id)
            ])

            return {
                id: company.id,
                name: company.name,
                email: company.email,
                created_at: company.created_at,
                counts: {
                    profiles: profilesCount.count || 0,
                    contacts: usersCount.count || 0,
                    workflows: workflowsCount.count || 0,
                    waba_configs: wabaCount.count || 0,
                    waba_enabled: wabaEnabledCount.count || 0,
                    messages: messagesCount.count || 0
                }
            }
        }))

        const totals = companyStats.reduce(
            (acc, row) => {
                acc.companies += 1
                acc.profiles += row.counts.profiles
                acc.contacts += row.counts.contacts
                acc.workflows += row.counts.workflows
                acc.waba_configs += row.counts.waba_configs
                acc.waba_enabled += row.counts.waba_enabled
                acc.messages += row.counts.messages
                return acc
            },
            { companies: 0, profiles: 0, contacts: 0, workflows: 0, waba_configs: 0, waba_enabled: 0, messages: 0 }
        )

        return res.json({ success: true, totals, companies: companyStats })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load admin summary' })
    }
})

const getClient = async (profileId: string) => wabaRegistry.getClientByProfile(profileId)
app.use('/addon', addon.createAddonRouter(getClient, getCompanyIdForProfile, workflowEngine, verifyApiKey))

function buildSyntheticMessage(inbound: WabaInboundMessage) {
    const from = (inbound.from || '').replace(/\D/g, '')
    const remoteJid = `${from}@s.whatsapp.net`
    const timestamp = inbound.timestamp ? Number(inbound.timestamp) : Math.floor(Date.now() / 1000)

    let text = inbound.text?.body || ''
    if (inbound.buttonReplyTitle && !text) {
        text = inbound.buttonReplyTitle
    }
    if (inbound.type === 'request_welcome' && !text) {
        text = 'request_welcome'
    }

    const message: any = {}

    if (inbound.type === 'text' || inbound.type === 'interactive' || inbound.type === 'button' || inbound.type === 'request_welcome') {
        message.conversation = text
    } else if (inbound.type === 'image') {
        message.imageMessage = {
            mimetype: inbound.image?.mime_type,
            caption: inbound.image?.caption,
            mediaId: inbound.image?.id
        }
    } else if (inbound.type === 'document') {
        message.documentMessage = {
            mimetype: inbound.document?.mime_type,
            fileName: inbound.document?.filename,
            fileLength: inbound.document?.file_size,
            caption: inbound.document?.caption,
            mediaId: inbound.document?.id
        }
    } else if (inbound.type === 'audio') {
        message.audioMessage = {
            mimetype: inbound.audio?.mime_type,
            mediaId: inbound.audio?.id
        }
    } else if (inbound.type === 'video') {
        message.videoMessage = {
            mimetype: inbound.video?.mime_type,
            caption: inbound.video?.caption,
            mediaId: inbound.video?.id
        }
    }

    const syntheticMsg = {
        key: {
            remoteJid,
            fromMe: false,
            id: inbound.id
        },
        messageTimestamp: timestamp,
        pushName: inbound.contactName,
        message
    }

    return { syntheticMsg, remoteJid, text }
}

function recordToSyntheticMessage(
    record: MessageRecord,
    userMap: Map<string, { phone: string; name?: string | null }>
) {
    const info = userMap.get(record.user_id)
    const cleanPhone = normalizePhoneNumber(info?.phone || '')
    if (!cleanPhone) return null

    const remoteJid = `${cleanPhone}@s.whatsapp.net`
    const timestamp = Math.floor(new Date(record.created_at).getTime() / 1000)
    const content = record.content || {}
    const type = content.type || content.payload?.type || 'text'

    const message: any = {}

    if (type === 'text') {
        message.conversation = content.text || content.payload?.text || ''
        if (!message.conversation && content.payload?.template?.name) {
            message.conversation = `Template: ${content.payload.template.name}`
        }
    } else if (type === 'buttons') {
        const payload = content.payload || {}
        const text = payload.text || content.text || ''
        message.conversation = text
        if (!message.conversation && payload.template?.name) {
            message.conversation = `Template: ${payload.template.name}`
        }
        const buttons = Array.isArray(payload.buttons) ? payload.buttons : []
        message.buttonsMessage = {
            contentText: text,
            footerText: payload.footer || payload.footerText || undefined,
            buttons: buttons.map((button: any, idx: number) => ({
                buttonId: button?.id || button?.buttonId || `button_${idx + 1}`,
                buttonText: { displayText: button?.title || button?.text || button?.id || `Button ${idx + 1}` },
                type: 1
            }))
        }
    } else if (type === 'list') {
        const payload = content.payload || {}
        const description = payload.text || payload.body || content.text || ''
        message.conversation = description
        if (!message.conversation && payload.template?.name) {
            message.conversation = `Template: ${payload.template.name}`
        }
        const sections = Array.isArray(payload.sections) ? payload.sections : []
        message.listMessage = {
            title: payload.header?.text || payload.headerText || undefined,
            description,
            buttonText: payload.button_text || payload.buttonText || payload.button || '',
            footerText: payload.footer || payload.footerText || undefined,
            listType: 1,
            sections: sections.map((section: any, sectionIdx: number) => ({
                title: section?.title || undefined,
                rows: (Array.isArray(section?.rows) ? section.rows : []).map((row: any, rowIdx: number) => ({
                    rowId: row?.id || row?.rowId || `row_${sectionIdx}_${rowIdx}`,
                    title: row?.title || row?.id || `Option ${rowIdx + 1}`,
                    description: row?.description || undefined
                }))
            }))
        }
    } else if (type === 'image') {
        message.imageMessage = {
            caption: content.caption,
            mediaId: content.media_id
        }
    } else if (type === 'document') {
        message.documentMessage = {
            caption: content.caption,
            fileName: content.filename,
            fileLength: content.file_size,
            mediaId: content.media_id,
            mimetype: content.mimetype || content.payload?.mimetype
        }
    } else if (type === 'audio') {
        message.audioMessage = {
            mediaId: content.media_id
        }
    } else if (type === 'video') {
        message.videoMessage = {
            caption: content.caption,
            mediaId: content.media_id
        }
    } else {
        message.conversation = content.text || type
    }

    return {
        key: {
            remoteJid,
            fromMe: record.direction === 'out',
            id: content.message_id || record.id
        },
        status: content.status,
        messageTimestamp: timestamp,
        pushName: info?.name || cleanPhone,
        message
    }
}

async function handleInboundMessage(config: WabaConfig, inbound: WabaInboundMessage) {
    const { syntheticMsg, remoteJid, text } = buildSyntheticMessage(inbound)
    const profileId = config.profileId
    const companyId = await resolveCompanyId(config.companyId || profileId)
    const phoneNumber = remoteJid.replace(/@s\\.whatsapp\\.net$/, '')

    const client = await wabaRegistry.getClientByProfile(profileId)
    if (!client || !companyId) {
        console.warn(`[${profileId}] Missing WABA client or companyId.`)
        return
    }

    const workflowResult = await workflowEngine.processInbound({
        companyId,
        profileId,
        client,
        phoneNumber,
        messageType: inbound.type,
        text,
        buttonId: inbound.buttonReplyId,
        buttonTitle: inbound.buttonReplyTitle,
        media: inbound.image || inbound.document || inbound.audio || inbound.video,
        raw: inbound.raw
    })

    const user = await getUserByPhone(companyId, phoneNumber)
    if (user && inbound.contactName) {
        const trimmedName = inbound.contactName.trim()
        const nameDigits = trimmedName.replace(/\D/g, '')
        const looksLikePhone = nameDigits.length >= 6 && nameDigits === phoneNumber
        if (!looksLikePhone && trimmedName && trimmedName !== user.name) {
            await updateUserName(user.id, trimmedName)
            user.name = trimmedName
        }
    }

    const { data: profile } = await supabase.from('profiles').select('*').eq('id', profileId).single()

    if (profile) {
        const newCount = (profile.unreadCount || 0) + 1
        await supabase.from('profiles').update({ unreadCount: newCount }).eq('id', profileId)
        const { data: userProfiles } = await supabase.from('profiles').select('*').eq('user_id', profile.user_id)
        io.to(profile.user_id).emit('profiles.update', userProfiles)
    }

    if (profile && workflowResult?.error) {
        io.to(profile.user_id).emit('profile.error', { message: `Workflow error: ${workflowResult.error}` })
    }

    if (profile) {
        const inboundAt = inbound.timestamp ? new Date(Number(inbound.timestamp) * 1000).toISOString() : null
        io.to(profile.user_id).emit('contacts.update', {
            profileId,
            contacts: [{
                id: remoteJid,
                name: user?.name || inbound.contactName || phoneNumber,
                lastInboundAt: inboundAt,
                tags: user?.tags || []
            }]
        })
    }

    const buttonReply = inbound.buttonReplyId
        ? {
            id: inbound.buttonReplyId,
            title: inbound.buttonReplyTitle,
            description: inbound.buttonReplyDescription
        }
        : null

    sendWebhook(profileId, 'message', {
        message: syntheticMsg,
        sender: {
            jid: remoteJid,
            name: inbound.contactName || null
        },
        button_reply: buttonReply,
        interactive: inbound.interactive || null,
        raw: inbound.raw
    })

    addon.webhookService.trigger(profileId, 'message_received', {
        messageId: inbound.id,
        from: remoteJid,
        message: text || inbound.type,
        type: inbound.type,
        timestamp: inbound.timestamp,
        pushName: inbound.contactName,
        button_reply: buttonReply,
        interactive: inbound.interactive || null,
        raw: inbound.raw
    })

    if (profile) {
        io.to(profile.user_id).emit('messages.upsert', { profileId, messages: [syntheticMsg], type: 'notify' })
    }
}

async function handleStatusUpdate(config: WabaConfig, status: WabaStatus) {
    const profileId = config.profileId
    const statusName = status.status
    let eventName: string | null = null

    if (statusName === 'delivered') eventName = 'message_delivered'
    else if (statusName === 'read') eventName = 'message_read'
    else if (statusName === 'sent') eventName = 'message_sent'
    else if (statusName === 'failed') eventName = 'message_failed'

    if (!eventName) return

    await updateMessageStatusByMessageId(status.id, statusName)

    const { data: profile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('id', profileId)
        .maybeSingle()

    if (profile?.user_id) {
        io.to(profile.user_id).emit('message.status', {
            profileId,
            messageId: status.id,
            status: statusName
        })
    }

    addon.webhookService.trigger(profileId, eventName, {
        messageId: status.id,
        to: status.recipientId,
        status: statusName,
        timestamp: status.timestamp,
        conversation: status.conversation,
        pricing: status.pricing
    })
}

// Auth Middleware for Socket.io
io.use(async (socket, next) => {
    try {
        const token = (socket.handshake.auth as any).token
        if (!token) return next(new Error('Authentication error: Token missing'))

        const { data: { user }, error } = await supabase.auth.getUser(token)
        if (error || !user) return next(new Error('Authentication error: Invalid session'))

        socket.data.user = user
        next()
    } catch (e) {
        next(new Error('Internal auth error'))
    }
})

io.on('connection', async (socket) => {
    const userId = socket.data.user.id
    console.log(`User connected: ${socket.data.user.email} (${userId})`)
    const companyId = socket.data.user?.user_metadata?.company_id || socket.data.user?.app_metadata?.company_id
    if (!companyId) {
        socket.emit('profile.error', { message: 'Company ID missing. Please log in again.' })
        socket.disconnect(true)
        return
    }
    socket.data.companyId = companyId

    // Join user-specific room for private emits
    socket.join(userId)

    if (lastServerStats) {
        socket.emit('server.stats', lastServerStats)
    }

    try {
        await supabase.from('company').upsert({
            id: companyId,
            name: companyId,
            email: socket.data.user?.email || null
        }, { onConflict: 'id' })
    } catch (err: any) {
        console.warn(`[${userId}] Failed to ensure company ${companyId}:`, err?.message || err)
    }

    // Send initial profiles for this user
    let { data: userProfiles, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })

    if (fetchError) console.error(`[${userId}] Profile fetch error:`, fetchError.message)

    if (!fetchError && (!userProfiles || userProfiles.length === 0)) {
        const { data: legacyProfiles, error: legacyError } = await supabase
            .from('profiles')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })
        if (!legacyError && legacyProfiles && legacyProfiles.length > 0) {
            await supabase.from('profiles').update({ company_id: companyId }).eq('user_id', userId)
            userProfiles = legacyProfiles.map(p => ({ ...p, company_id: companyId }))
        }
    }

    // Auto-provision a default profile if none exist (single-company WABA setup)
    if (!fetchError && (!userProfiles || userProfiles.length === 0)) {
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
            console.warn(`[${userId}] Cannot auto-create profile: missing service role key`)
        } else {
            // Prefer a stable "default" profile id for WABA config binding
            let createdProfile = null as any
            const defaultId = companyId

            const { data: existingDefault } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', defaultId)
                .maybeSingle()

            if (existingDefault) {
                // Ensure the profile belongs to this company/user
                const updates: any = {}
                if (existingDefault.user_id !== userId) updates.user_id = userId
                if (existingDefault.company_id !== companyId) updates.company_id = companyId
                if (Object.keys(updates).length > 0) {
                    await supabase.from('profiles').update(updates).eq('id', defaultId)
                    Object.assign(existingDefault, updates)
                }
                createdProfile = existingDefault
            } else {
                const { data: newProfile, error: createError } = await supabase
                    .from('profiles')
                    .insert({
                        id: defaultId,
                        user_id: userId,
                        name: companyId,
                        company_id: companyId,
                        unreadCount: 0
                    })
                    .select()
                    .single()

                if (createError) {
                    console.error(`[${userId}] Auto-create default profile failed:`, createError.message)
                } else {
                    createdProfile = newProfile
                }
            }

            if (createdProfile) {
                userProfiles = [createdProfile]
            }
        }
    }

    socket.emit('profiles.update', userProfiles || [])

    socket.on('switchProfile', async (profileId) => {
        if (!profileId) return
        const currentCompanyId = socket.data.companyId || companyId
        if (!currentCompanyId) {
            socket.emit('profile.error', { message: 'Company ID missing. Please log in again.' })
            return
        }
        const { data: profileCheck } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', profileId)
            .eq('company_id', currentCompanyId)
            .maybeSingle()
        if (!profileCheck) {
            socket.emit('profile.error', { message: 'Profile not found for this company.' })
            return
        }
        const client = await wabaRegistry.getClientByProfile(profileId)
        socket.emit('connection.update', { profileId, connection: client ? 'open' : 'close' })

        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            socket.emit('contacts.update', { profileId, contacts: [] })
            socket.emit('messages.history', { profileId, messages: [] })
        } else {
            const users = await getUsersForCompany(companyId)
            const contacts = users.map(u => {
                const phone = normalizePhoneNumber(u.phone_number)
                return {
                    id: phone ? `${phone}@s.whatsapp.net` : `${u.phone_number}@s.whatsapp.net`,
                    name: u.name || phone || u.phone_number,
                    lastInboundAt: u.last_inbound_at || null,
                    tags: u.tags || []
                }
            })
            socket.emit('contacts.update', { profileId, contacts })

            const messages = await getMessagesForUsers(users.map(u => u.id), 500)
            const userMap = new Map(
                users.map(u => [
                    u.id,
                    {
                        phone: normalizePhoneNumber(u.phone_number),
                        name: u.name || null
                    }
                ])
            )
            const syntheticMessages = messages
                .map(msg => recordToSyntheticMessage(msg, userMap))
                .filter(Boolean)
                .reverse()

            socket.emit('messages.history', { profileId, messages: syntheticMessages })
        }

        // Reset unread for this profile when switched to
        await supabase.from('profiles').update({ unreadCount: 0 }).eq('id', profileId).eq('company_id', currentCompanyId)
        const { data: refreshed } = await supabase.from('profiles').select('*').eq('company_id', currentCompanyId).order('created_at', { ascending: true })
        io.to(userId).emit('profiles.update', refreshed || [])
    })

    // Lightweight refresh without resetting unread counts
    socket.on('refreshMessages', async (profileId) => {
        if (!profileId) return
        const client = await wabaRegistry.getClientByProfile(profileId)
        socket.emit('connection.update', { profileId, connection: client ? 'open' : 'close' })

        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            socket.emit('contacts.update', { profileId, contacts: [] })
            socket.emit('messages.history', { profileId, messages: [] })
            return
        }

        const users = await getUsersForCompany(companyId)
        const contacts = users.map(u => {
            const phone = normalizePhoneNumber(u.phone_number)
            return {
                id: phone ? `${phone}@s.whatsapp.net` : `${u.phone_number}@s.whatsapp.net`,
                name: u.name || phone || u.phone_number,
                lastInboundAt: u.last_inbound_at || null,
                tags: u.tags || []
            }
        })
        socket.emit('contacts.update', { profileId, contacts })

        const messages = await getMessagesForUsers(users.map(u => u.id), 500)
        const userMap = new Map(
            users.map(u => [
                u.id,
                {
                    phone: normalizePhoneNumber(u.phone_number),
                    name: u.name || null
                }
            ])
        )
        const syntheticMessages = messages
            .map(msg => recordToSyntheticMessage(msg, userMap))
            .filter(Boolean)
            .reverse()

        socket.emit('messages.history', { profileId, messages: syntheticMessages })
    })

    socket.on('contact.update', async ({ profileId, jid, name, tags }) => {
        try {
            if (!profileId || !jid) return
            if (jid.endsWith('@g.us')) {
                socket.emit('profile.error', { message: 'Contact update is not supported for groups.' })
                return
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                socket.emit('profile.error', { message: 'Company not found.' })
                return
            }

            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            const user = await findOrCreateUser(companyId, phoneNumber)
            if (!user) {
                socket.emit('profile.error', { message: 'Failed to resolve user.' })
                return
            }

            if (typeof name === 'string') {
                await updateUserName(user.id, name)
            }
            if (Array.isArray(tags)) {
                await setUserTags(user.id, tags)
            }

            const updated = await getUserByPhone(companyId, phoneNumber)
            if (updated) {
                io.to(userId).emit('contacts.update', {
                    profileId,
                    contacts: [{
                        id: `${phoneNumber}@s.whatsapp.net`,
                        name: updated.name || phoneNumber,
                        lastInboundAt: updated.last_inbound_at || null,
                        tags: updated.tags || []
                    }]
                })
            }
        } catch (err: any) {
            socket.emit('profile.error', { message: err?.message || 'Failed to update contact.' })
        }
    })

    socket.on('clearChat', async ({ profileId, jid }) => {
        try {
            if (!profileId || !jid) return
            if (jid.endsWith('@g.us')) {
                socket.emit('profile.error', { message: 'Clear chat is not supported for groups.' })
                return
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                socket.emit('profile.error', { message: 'Company not found.' })
                return
            }

            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            if (!phoneNumber) {
                socket.emit('profile.error', { message: 'Invalid chat ID.' })
                return
            }

            const user = await getUserByPhone(companyId, phoneNumber)
            if (user) {
                await deleteMessagesForUser(user.id)
            }

            io.to(userId).emit('messages.cleared', { profileId, jid })
        } catch (error: any) {
            console.error('Clear chat error:', error)
            socket.emit('profile.error', { message: error?.message || 'Failed to clear chat.' })
        }
    })

    socket.on('addProfile', async (name) => {
        const currentCompanyId = socket.data.companyId || companyId
        if (!currentCompanyId) {
            socket.emit('profile.error', { message: 'Company ID missing. Please log in again.' })
            return
        }
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
            socket.emit('profile.error', { message: 'CRITICAL: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) is missing in .env! Backend cannot save bot data.' })
            return
        }
        const id = `profile-${Date.now()}`
        console.log(`[${userId}] Creating new profile: ${name} (${id})`)

        const { data: newProfile, error } = await supabase.from('profiles').insert({
            id,
            user_id: userId,
            company_id: currentCompanyId,
            name,
            unreadCount: 0
        }).select().single()

        if (error) {
            console.error('Add profile database error:', error)
            socket.emit('profile.error', { message: 'Failed to save profile to database. Check SQL setup.' })
            return
        }

        console.log(`[${userId}] Profile saved to DB, refreshing list...`)
        const { data: refreshed } = await supabase.from('profiles').select('*').eq('company_id', currentCompanyId).order('created_at', { ascending: true })
        io.to(userId).emit('profiles.update', refreshed)

        console.log(`[${userId}] Profile ${id} created. WABA config required to activate.`)
        socket.emit('profile.added', id)
    })

    socket.on('updateProfileName', async ({ profileId, name }) => {
        const currentCompanyId = socket.data.companyId || companyId
        await supabase.from('profiles').update({ name }).eq('id', profileId).eq('company_id', currentCompanyId)
        const { data: refreshed } = await supabase.from('profiles').select('*').eq('company_id', currentCompanyId).order('created_at', { ascending: true })
        io.to(userId).emit('profiles.update', refreshed)
    })

    socket.on('deleteProfile', async (profileId: string) => {
        const currentCompanyId = socket.data.companyId || companyId
        // Security check: ensure company owns profile
        const { data: check } = await supabase.from('profiles').select('id').eq('id', profileId).eq('company_id', currentCompanyId).single()
        if (!check) return

        // 1. Delete from Supabase
        await supabase.from('profiles').delete().eq('id', profileId)

        // 2. Clean up files
        if (fs.existsSync(resolvePath(`flows_${profileId}.json`))) fs.unlinkSync(resolvePath(`flows_${profileId}.json`))
        if (fs.existsSync(resolvePath(`sessions_${profileId}.json`))) fs.unlinkSync(resolvePath(`sessions_${profileId}.json`))

        const { data: refreshed } = await supabase.from('profiles').select('*').eq('company_id', currentCompanyId).order('created_at', { ascending: true })
        io.to(userId).emit('profiles.update', refreshed || [])
    })

    socket.on('logout', async (profileId) => {
        socket.emit('profile.error', { message: 'WABA Cloud API does not support logout. Disable the config in Supabase instead.' })
        const client = await wabaRegistry.getClientByProfile(profileId)
        io.to(userId).emit('connection.update', { profileId, connection: client ? 'open' : 'close' })
    })

    socket.on('refreshQR', async (profileId) => {
        socket.emit('pairing.error', { profileId, error: 'WABA Cloud API does not use QR codes.' })
    })

    socket.on('requestPairingCode', async ({ profileId, phoneNumber }) => {
        socket.emit('pairing.error', { profileId, error: 'WABA Cloud API does not support pairing codes.' })
    })

    socket.on('sendMessage', async (data) => {
        let { profileId, jid, text } = data
        if (!jid.includes('@')) jid = `${jid}@s.whatsapp.net`
        try {
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) {
                socket.emit('profile.error', { message: 'WABA not configured for this profile.' })
                return
            }
            const config = await wabaRegistry.getConfigByProfile(profileId)
            const companyId = await resolveCompanyId(config?.companyId || profileId)
            if (!companyId) {
                socket.emit('profile.error', { message: 'Company not found.' })
                return
            }
            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            const user = await findOrCreateUser(companyId, phoneNumber)
            if (!user) {
                socket.emit('profile.error', { message: 'Failed to resolve user.' })
                return
            }
            await sendWhatsAppMessage({
                client,
                userId: user.id,
                to: phoneNumber,
                type: 'text',
                content: { text }
            })
        } catch (error: any) {
            socket.emit('profile.error', { message: error.message || 'Failed to send message' })
        }
    })

    socket.on('startWorkflow', async (data) => {
        let { profileId, jid, workflowId } = data || {}
        if (!profileId || !jid || !workflowId) return
        if (!jid.includes('@')) jid = `${jid}@s.whatsapp.net`
        if (jid.endsWith('@g.us')) {
            socket.emit('profile.error', { message: 'Workflows are not supported for groups.' })
            return
        }

        try {
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) {
                socket.emit('profile.error', { message: 'WABA not configured for this profile.' })
                return
            }
            const config = await wabaRegistry.getConfigByProfile(profileId)
            const companyId = await resolveCompanyId(config?.companyId || profileId)
            if (!companyId) {
                socket.emit('profile.error', { message: 'Company not found.' })
                return
            }

            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            const result = await workflowEngine.startWorkflow(
                {
                    companyId,
                    profileId,
                    client,
                    phoneNumber,
                    messageType: 'manual_start'
                },
                workflowId
            )

            if (result?.error) {
                socket.emit('profile.error', { message: result.error })
                return
            }

            socket.emit('workflow.started', { workflowId, jid })
        } catch (error: any) {
            socket.emit('profile.error', { message: error.message || 'Failed to start workflow' })
        }
    })

    socket.on('sendTemplate', async (data) => {
        let { profileId, jid, name, language, components } = data
        if (!jid || !name) return
        if (!jid.includes('@')) jid = `${jid}@s.whatsapp.net`

        try {
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) {
                socket.emit('profile.error', { message: 'WABA not configured for this profile.' })
                return
            }
            const config = await wabaRegistry.getConfigByProfile(profileId)
            const companyId = await resolveCompanyId(config?.companyId || profileId)
            if (!companyId) {
                socket.emit('profile.error', { message: 'Company not found.' })
                return
            }
            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            const user = await findOrCreateUser(companyId, phoneNumber)
            if (!user) {
                socket.emit('profile.error', { message: 'Failed to resolve user.' })
                return
            }

            await sendWhatsAppMessage({
                client,
                userId: user.id,
                to: phoneNumber,
                type: 'template',
                content: {
                    name,
                    language: language || 'en_US',
                    components: Array.isArray(components) && components.length > 0 ? components : undefined
                }
            })
        } catch (error: any) {
            socket.emit('profile.error', { message: error.message || 'Failed to send template' })
        }
    })

    socket.on('downloadMedia', async (data) => {
        const { profileId, message } = data
        try {
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) {
                socket.emit('profile.error', { message: 'WABA not configured for this profile.' })
                return
            }

            const mediaId =
                message?.message?.imageMessage?.mediaId ||
                message?.message?.documentMessage?.mediaId ||
                message?.message?.audioMessage?.mediaId ||
                message?.message?.videoMessage?.mediaId

            if (!mediaId) {
                console.warn('No mediaId found on message for download')
                return
            }

            const media = await client.downloadMedia(mediaId)
            socket.emit('mediaDownloaded', {
                messageId: message.key.id,
                mediaId,
                data: media.buffer.toString('base64'),
                mimetype: media.mimeType
            })
        } catch (error) {
            console.error('Error downloading media:', error)
        }
    })

    // ============================================
    // SUPER ADMIN HANDLERS
    // ============================================

    socket.on('admin.getStats', async () => {
        // Verify role in user_roles table
        const { data: userRole } = await supabase.from('user_roles').select('role').eq('user_id', userId).single()
        if (userRole?.role !== 'admin') {
            console.warn(`Unauthorized admin access attempt by ${socket.data.user.email}`)
            return
        }

        // Fetch all profiles
        const { data: allProfiles } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })

        const activeProfileIds = new Set(await wabaRegistry.getProfileIds())
        const enriched = (allProfiles || []).map(p => ({
            ...p,
            status: activeProfileIds.has(p.id) ? 'open' : 'close',
            // In a real prod setup, you'd store email in a public profiles/user_meta table
            user_email: 'User ' + p.user_id.substring(0, 8)
        }))

        socket.emit('admin.statsUpdate', enriched)
    })

    socket.on('admin.profileAction', async ({ type, profileId }) => {
        const { data: userRole } = await supabase.from('user_roles').select('role').eq('user_id', userId).single()
        if (userRole?.role !== 'admin') return

        if (type === 'logout') {
            socket.emit('profile.error', { message: 'WABA Cloud API does not support logout. Disable the config in Supabase.' })
        } else if (type === 'delete') {
            // Security: Delete from DB
            await supabase.from('profiles').delete().eq('id', profileId)

            // Cleanup files
            if (fs.existsSync(resolvePath(`flows_${profileId}.json`))) fs.unlinkSync(resolvePath(`flows_${profileId}.json`))
            if (fs.existsSync(resolvePath(`sessions_${profileId}.json`))) fs.unlinkSync(resolvePath(`sessions_${profileId}.json`))
        }

        // Refresh admin stats for all admins
        // We'll just refresh for the current socket for simplicity
        socket.emit('admin.getStats')
    })
})

// Serve Frontend (Deployment Support)
const frontendPath = path.join(process.cwd(), 'dashboard/dist')
if (fs.existsSync(frontendPath)) {
    console.log('Serving frontend from:', frontendPath)
    app.use(express.static(frontendPath))
    // Express 5 + path-to-regexp v6 doesn't accept '*' wildcard
    app.get('/*', (req: any, res: any) => {
        // Skip API/Socket paths to avoid HTML response on 404s
        if (req.path.startsWith('/api') || req.path.startsWith('/addon') || req.path.startsWith('/socket.io')) {
            return res.status(404).json({ error: 'Not Found' })
        }
        res.sendFile(path.join(frontendPath, 'index.html'))
    })
}

const PORT = Number(process.env.PORT || 3000)
httpServer.listen(PORT, async () => {
    console.log(`Dashboard Server listening on port ${PORT}`)

    const activeProfiles = await wabaRegistry.getProfileIds()
    console.log(`[WABA] Loaded configs for ${activeProfiles.length} profile(s).`)
})
