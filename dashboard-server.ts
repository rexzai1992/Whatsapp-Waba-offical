
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
import { resolveCompanyId, findOrCreateUser, getMessagesForUsers, getUsersForCompany, insertMessage, getUserByPhone, deleteMessagesForUser, normalizePhoneNumber, updateMessageStatusByMessageId, updateUserName, setUserTags, getUsersWithExpiringWindow, updateUserWindowReminder, activateUserCtaFreeWindow, getUserById, assignUserToAgentIfUnassigned, setUserAssignee, hasHumanTakeover, setUserHumanTakeover } from './src/services/wa-store'
import type { MessageRecord, User as WaStoreUser } from './src/services/wa-store'
import { sendWhatsAppMessage } from './src/services/whatsapp'
import { WorkflowEngine } from './src/workflow/engine'
import { encryptToken, decryptToken, getTokenEncryptionKey } from './src/services/token-vault'
import { exchangeCodeForToken, exchangeForLongLivedToken, fetchBusinesses, fetchOwnedWabaAccounts, fetchClientWabaAccounts, fetchPhoneNumbers, subscribeWabaApp, createSystemUserToken, unsubscribeWabaApp, fetchClientBusinessId, fetchBusinessIntegrationSystemUserToken } from './src/services/meta-graph'
import { createApiKeyStore } from './dashboard-server/services/apiKeyStore'
import { createWebhookStore } from './dashboard-server/services/webhookStore'
import { registerFlowRoutes } from './dashboard-server/routes/flowRoutes'
import { registerPublicInfoRoutes } from './dashboard-server/routes/publicInfoRoutes'
import { registerPublicAuthRoutes } from './dashboard-server/routes/publicAuthRoutes'
import { registerWabaRoutes } from './dashboard-server/routes/wabaRoutes'
import { registerCompanyRoutes } from './dashboard-server/routes/companyRoutes'
import { registerInvoiceRoutes } from './dashboard-server/routes/invoiceRoutes'
import { registerAiRoutes } from './dashboard-server/routes/aiRoutes'
import { getCompanyAiSettings } from './dashboard-server/services/aiSettingsSupabase'
import { loadOpenAiMemoryForUser, requestOpenAiCompletion, type OpenAiChatMessage } from './dashboard-server/services/openaiAssistant'
import { registerSocketHandlers } from './dashboard-server/socket/registerSocketHandlers'
import { errorHandler } from './dashboard-server/middleware/error'
import { requireSupabaseUser } from './dashboard-server/middleware/auth'

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

type TeamRole = 'owner' | 'admin' | 'agent'
type TeamDepartment = 'finance' | 'sales' | 'marketing' | 'production' | 'custom'

const TENANT_ROOT_DOMAIN = String(process.env.TENANT_ROOT_DOMAIN || '2fast.xyz').trim().toLowerCase()
const RESERVED_TENANT_SUBDOMAINS = new Set(['www', 'admin', 'myadmin'])
const TEAM_DEPARTMENTS = new Set<TeamDepartment>(['finance', 'sales', 'marketing', 'production', 'custom'])

const TEAM_ROLE_ORDER: Record<TeamRole, number> = {
    agent: 1,
    admin: 2,
    owner: 3
}

const AGENT_BADGE_COLORS = [
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#ec4899',
    '#84cc16',
    '#14b8a6',
    '#f97316'
]

function normalizeTeamRole(input: any): TeamRole {
    const value = typeof input === 'string' ? input.trim().toLowerCase() : ''
    if (value === 'owner' || value === 'admin' || value === 'agent') return value
    return 'agent'
}

function normalizeTeamDepartment(input: any): TeamDepartment {
    const value = typeof input === 'string' ? input.trim().toLowerCase() : ''
    if (TEAM_DEPARTMENTS.has(value as TeamDepartment)) return value as TeamDepartment
    return 'custom'
}

function normalizeTeamCustomDepartment(input: any): string | null {
    const value = typeof input === 'string' ? input.trim() : ''
    if (!value) return null
    return value.slice(0, 64)
}

function parseHostnameFromHeaderValue(value: any): string {
    const raw = Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : ''
    const first = raw.split(',')[0]?.trim().toLowerCase() || ''
    if (!first) return ''
    return first.replace(/:\d+$/, '')
}

function getHostnameFromHeaders(headers: any): string {
    return parseHostnameFromHeaderValue(headers?.['x-forwarded-host']) || parseHostnameFromHeaderValue(headers?.host)
}

function resolveCompanyIdFromHostname(hostname: string): string | null {
    if (!hostname) return null
    if (hostname === TENANT_ROOT_DOMAIN) return null
    if (hostname === 'localhost' || hostname === '127.0.0.1' || /^[0-9.]+$/.test(hostname)) return null

    const suffix = `.${TENANT_ROOT_DOMAIN}`
    if (!hostname.endsWith(suffix)) return null

    const label = hostname.slice(0, -suffix.length)
    if (!label || label.includes('.')) return null
    if (RESERVED_TENANT_SUBDOMAINS.has(label)) return null
    if (!/^[a-z0-9-]+$/.test(label)) return null
    return label
}

function normalizeCompanyId(value: any): string {
    const raw = typeof value === 'string' ? value.trim() : value ? String(value).trim() : ''
    return raw.toLowerCase()
}

function hasRoleAtLeast(role: TeamRole, minimum: TeamRole): boolean {
    return TEAM_ROLE_ORDER[normalizeTeamRole(role)] >= TEAM_ROLE_ORDER[normalizeTeamRole(minimum)]
}

function computeAgentColor(userId: string): string {
    if (!userId) return AGENT_BADGE_COLORS[0]
    let hash = 0
    for (let i = 0; i < userId.length; i += 1) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
    }
    return AGENT_BADGE_COLORS[hash % AGENT_BADGE_COLORS.length]
}

function deriveAgentName(user: any): string {
    const candidates = [
        user?.user_metadata?.full_name,
        user?.user_metadata?.name,
        user?.user_metadata?.display_name,
        user?.email ? String(user.email).split('@')[0] : null,
        user?.id
    ]
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim()
        }
    }
    return 'Agent'
}

function buildAgentIdentity(user: any): { user_id: string; name: string; color: string } {
    const userId = typeof user?.id === 'string' ? user.id : ''
    return {
        user_id: userId,
        name: deriveAgentName(user),
        color: computeAgentColor(userId)
    }
}

function getCompanyRoom(companyId: string): string {
    return `company:${companyId}`
}

function buildContactPayload(user: any) {
    const phone = normalizePhoneNumber(user?.phone_number)
    return {
        id: phone ? `${phone}@s.whatsapp.net` : `${user?.phone_number || ''}@s.whatsapp.net`,
        name: user?.name || phone || user?.phone_number || '',
        lastInboundAt: user?.last_inbound_at || null,
        tags: user?.tags || [],
        humanTakeover: hasHumanTakeover(user),
        assigneeUserId: user?.assigned_to_user_id || null,
        assigneeName: user?.assigned_to_name || null,
        assigneeColor: user?.assigned_to_color || null,
        ctaReferralAt: user?.cta_referral_at || null,
        ctaFreeWindowStartedAt: user?.cta_free_window_started_at || null,
        ctaFreeWindowExpiresAt: user?.cta_free_window_expires_at || null
    }
}

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

async function findConflictingActivePhoneNumberConfig(phoneNumberId: string, profileId: string): Promise<{ profileId: string; companyId: string | null } | null> {
    const { data, error } = await supabase
        .from('waba_configs')
        .select('profile_id, company_id')
        .eq('phone_number_id', phoneNumberId)
        .eq('enabled', true)
        .neq('profile_id', profileId)
        .limit(1)
        .maybeSingle()

    if (error) {
        throw new Error(error.message)
    }

    if (!data?.profile_id) return null
    return {
        profileId: String(data.profile_id),
        companyId: data.company_id ? String(data.company_id) : null
    }
}

function hashOAuthState(state: string) {
    return createHash('sha256').update(state).digest('hex')
}

async function getSupabaseUserFromRequest(req: any, res: any) {
    const requestHostname = getHostnameFromHeaders(req?.headers)
    const hostCompanyId = resolveCompanyIdFromHostname(requestHostname)
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

    const directCompanyId = normalizeCompanyId(getUserCompanyId(user))
    if (hostCompanyId && !directCompanyId) {
        res.status(403).json({
            success: false,
            error: 'This account is not assigned to any company. Ask your admin to set up your account first.'
        })
        return null
    }
    if (hostCompanyId && directCompanyId && directCompanyId !== hostCompanyId) {
        res.status(403).json({
            success: false,
            error: `This account belongs to "${directCompanyId}" and cannot access "${hostCompanyId}.${TENANT_ROOT_DOMAIN}".`
        })
        return null
    }

    const { user: ensuredUser } = await ensureUserCompanyId(user)
    const ensuredCompanyId = normalizeCompanyId(getUserCompanyId(ensuredUser))
    if (hostCompanyId && ensuredCompanyId !== hostCompanyId) {
        res.status(403).json({
            success: false,
            error: `Company mismatch for this subdomain. Expected "${hostCompanyId}".`
        })
        return null
    }
    return ensuredUser
}

function getUserCompanyId(user: any): string | null {
    const raw = user?.user_metadata?.company_id || user?.app_metadata?.company_id || null
    if (typeof raw !== 'string') return raw ? String(raw) : null
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
}

async function deriveCompanyIdFromProfiles(userId: string): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id, company_id, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })

        if (error) {
            console.warn(`[${userId}] Failed to load profiles for company resolution:`, error.message)
            return null
        }

        if (!data || data.length === 0) return null

        const distinctCompanyIds = Array.from(new Set(
            data
                .map(row => (typeof row.company_id === 'string' ? row.company_id.trim() : ''))
                .filter(Boolean)
        ))

        if (distinctCompanyIds.length === 1) return distinctCompanyIds[0]
        if (distinctCompanyIds.length === 0 && data.length === 1) {
            const profileId = typeof data[0].id === 'string' ? data[0].id.trim() : ''
            return profileId || null
        }
        if (distinctCompanyIds.length > 1) {
            console.warn(`[${userId}] Multiple company_id values found for profiles; using the first match.`)
            return distinctCompanyIds[0]
        }
    } catch (err: any) {
        console.warn(`[${userId}] Failed to resolve company from profiles:`, err?.message || err)
    }
    return null
}

async function ensureCompanyRecord(companyId: string, user: any) {
    if (!companyId) return
    const userId = user?.id || 'unknown'
    try {
        const { data: existingCompany, error: companyCheckError } = await supabase
            .from('company')
            .select('id')
            .eq('id', companyId)
            .maybeSingle()

        if (companyCheckError) {
            console.warn(`[${userId}] Failed to check company ${companyId}:`, companyCheckError.message)
        } else if (!existingCompany?.id) {
            const { error: companyInsertError } = await supabase
                .from('company')
                .insert({
                    id: companyId,
                    name: companyId,
                    email: user?.email || null
                })

            if (companyInsertError) {
                const isDuplicate = companyInsertError.code === '23505' || /duplicate/i.test(companyInsertError.message)
                if (!isDuplicate) {
                    console.warn(`[${userId}] Failed to create company ${companyId}:`, companyInsertError.message)
                }
            } else {
                console.log(`[${userId}] Created company: ${companyId}`)
            }
        }
    } catch (err: any) {
        console.warn(`[${userId}] Failed to ensure company ${companyId}:`, err?.message || err)
    }
}

async function ensureUserCompanyId(user: any): Promise<{ user: any; companyId: string | null }> {
    const existingCompanyId = getUserCompanyId(user)
    if (existingCompanyId) {
        await ensureUserRoleMembership(user, existingCompanyId)
        return { user, companyId: existingCompanyId }
    }

    let companyId = await deriveCompanyIdFromProfiles(user.id)
    if (!companyId && typeof user?.id === 'string') companyId = user.id.trim()
    if (!companyId) return { user, companyId: null }

    await ensureCompanyRecord(companyId, user)

    const updatedMetadata = { ...(user?.user_metadata || {}), company_id: companyId }
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)

    if (hasServiceRole) {
        try {
            const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
                user_metadata: updatedMetadata
            })
            if (error) {
                console.warn(`[${user.id}] Failed to update user metadata company_id:`, error.message)
            } else if (data?.user) {
                user = data.user
            }
        } catch (err: any) {
            console.warn(`[${user.id}] Failed to update user metadata company_id:`, err?.message || err)
        }
    } else {
        console.warn(`[${user.id}] Missing service role key; cannot persist company_id to auth metadata.`)
    }

    if (!user?.user_metadata) user.user_metadata = {}
    user.user_metadata.company_id = companyId

    try {
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ company_id: companyId })
            .eq('user_id', user.id)
            .is('company_id', null)

        if (updateError) {
            console.warn(`[${user.id}] Failed to backfill profile company_id:`, updateError.message)
        }
    } catch (err: any) {
        console.warn(`[${user.id}] Failed to backfill profile company_id:`, err?.message || err)
    }

    await ensureUserRoleMembership(user, companyId)

    return { user, companyId }
}

async function getUserRoleInCompany(userId: string, companyId: string): Promise<TeamRole | null> {
    if (!userId || !companyId) return null
    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('company_id', companyId)
        .maybeSingle()
    if (error) return null
    if (data?.role) return normalizeTeamRole(data.role)

    const { data: fallback, error: fallbackError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .is('company_id', null)
        .maybeSingle()
    if (fallbackError) return null
    return fallback?.role ? normalizeTeamRole(fallback.role) : null
}

async function ensureUserRoleMembership(user: any, companyId: string): Promise<TeamRole> {
    const userId = typeof user?.id === 'string' ? user.id : ''
    if (!userId || !companyId) return 'agent'

    const { data: existing, error: existingError } = await supabase
        .from('user_roles')
        .select('user_id, role, company_id')
        .eq('user_id', userId)
        .maybeSingle()

    if (existingError) {
        console.warn(`[${userId}] Failed to load user role:`, existingError.message)
    }

    if (existing?.user_id) {
        const role = normalizeTeamRole(existing.role)
        const updates: any = {}
        if (existing.company_id !== companyId) updates.company_id = companyId
        if (existing.role !== role) updates.role = role
        if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabase
                .from('user_roles')
                .update(updates)
                .eq('user_id', userId)
            if (updateError) {
                console.warn(`[${userId}] Failed to normalize user role:`, updateError.message)
            }
        }
        return role
    }

    const { count: companyRoleCount, error: countError } = await supabase
        .from('user_roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('company_id', companyId)

    if (countError) {
        console.warn(`[${userId}] Failed to count company roles:`, countError.message)
    }

    const initialRole: TeamRole = (companyRoleCount || 0) === 0 ? 'owner' : 'agent'
    const { error: insertError } = await supabase
        .from('user_roles')
        .insert({
            user_id: userId,
            company_id: companyId,
            role: initialRole
        })

    if (insertError) {
        const isDuplicate = insertError.code === '23505' || /duplicate/i.test(insertError.message)
        if (!isDuplicate) {
            console.warn(`[${userId}] Failed to create user role:`, insertError.message)
        }
        const fallbackRole = await getUserRoleInCompany(userId, companyId)
        return fallbackRole || 'agent'
    }

    return initialRole
}

async function isAdminUser(userId: string, companyId?: string): Promise<boolean> {
    if (!userId) return false
    const role = companyId ? await getUserRoleInCompany(userId, companyId) : null
    if (role) return hasRoleAtLeast(role, 'admin')
    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle()
    if (error) return false
    const fallback = data?.role ? normalizeTeamRole(data.role) : null
    return fallback ? hasRoleAtLeast(fallback, 'admin') : false
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

async function resolveProfileAccess(req: any, res: any) {
    const user = req?.supabaseUser || await getSupabaseUserFromRequest(req, res)
    if (!user) return null

    const profileId = typeof req.query?.profileId === 'string'
        ? req.query.profileId
        : typeof req.body?.profileId === 'string'
            ? req.body.profileId
            : undefined

    if (!profileId) {
        res.status(400).json({ success: false, error: 'profileId is required' })
        return null
    }

    const companyId = getUserCompanyId(user)
    if (!companyId) {
        res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        return null
    }

    const ownsProfile = await assertProfileCompany(profileId, companyId)
    if (!ownsProfile) {
        res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        return null
    }

    return { user, profileId, companyId }
}

async function resolveCompanyAccess(
    req: any,
    res: any,
    minimumRole: TeamRole = 'agent'
): Promise<{ user: any; companyId: string; role: TeamRole } | null> {
    const user = req?.supabaseUser || await getSupabaseUserFromRequest(req, res)
    if (!user) return null

    const companyId = getUserCompanyId(user)
    if (!companyId) {
        res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        return null
    }

    const role = await ensureUserRoleMembership(user, companyId)
    if (!hasRoleAtLeast(role, minimumRole)) {
        res.status(403).json({ success: false, error: `${minimumRole} role required` })
        return null
    }

    return { user, companyId, role }
}

function readTrimmed(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function isObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function extractPositionalVars(text: string): number[] {
    const vars = new Set<number>()
    const regex = /{{\s*(\d+)\s*}}/g
    let match = regex.exec(text)
    while (match) {
        const capture = match[1] || ''
        const value = Number.parseInt(capture, 10)
        if (Number.isFinite(value)) vars.add(value)
        match = regex.exec(text)
    }
    return Array.from(vars).sort((a, b) => a - b)
}

function extractNamedVars(text: string): string[] {
    const vars = new Set<string>()
    const regex = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g
    let match = regex.exec(text)
    while (match) {
        const capture = match[1]
        if (capture) vars.add(capture)
        match = regex.exec(text)
    }
    return Array.from(vars)
}

const MARKETING_NAMED_PARAM_REGEX = /^[a-z_][a-z0-9_]*$/

function hasBodyExamples(bodyComponent: any): boolean {
    if (!isObject(bodyComponent)) return false
    const example = bodyComponent.example
    if (!isObject(example)) return false
    if (Array.isArray(example.body_text) && example.body_text.length > 0) return true
    if (Array.isArray(example.body_text_named_params) && example.body_text_named_params.length > 0) return true
    return false
}

function countBodyExamples(bodyComponent: any): number {
    if (!isObject(bodyComponent)) return 0
    const example = bodyComponent.example
    if (!isObject(example)) return 0

    if (Array.isArray(example.body_text) && example.body_text.length > 0) {
        const first = example.body_text[0]
        if (Array.isArray(first)) return first.filter((item: any) => readTrimmed(String(item)).length > 0).length
    }
    if (Array.isArray(example.body_text_named_params)) {
        return example.body_text_named_params.length
    }

    return 0
}

function hasHeaderHandle(component: any): boolean {
    if (!isObject(component)) return false
    const topLevelHandle = component.header_handle
    if (typeof topLevelHandle === 'string' && topLevelHandle.trim()) return true
    if (Array.isArray(topLevelHandle) && topLevelHandle.some((item: any) => typeof item === 'string' && item.trim())) return true

    const example = component.example
    if (!isObject(example)) return false
    const exampleHandle = example.header_handle
    if (typeof exampleHandle === 'string' && exampleHandle.trim()) return true
    if (Array.isArray(exampleHandle) && exampleHandle.some((item: any) => typeof item === 'string' && item.trim())) return true
    return false
}

function extractHeaderHandle(component: any): string {
    if (!isObject(component)) return ''

    const topLevelHandle = component.header_handle
    if (typeof topLevelHandle === 'string' && topLevelHandle.trim()) return topLevelHandle.trim()
    if (Array.isArray(topLevelHandle)) {
        const first = topLevelHandle.find((item: any) => typeof item === 'string' && item.trim())
        if (typeof first === 'string') return first.trim()
    }

    const example = component.example
    if (!isObject(example)) return ''
    const exampleHandle = example.header_handle
    if (typeof exampleHandle === 'string' && exampleHandle.trim()) return exampleHandle.trim()
    if (Array.isArray(exampleHandle)) {
        const first = exampleHandle.find((item: any) => typeof item === 'string' && item.trim())
        if (typeof first === 'string') return first.trim()
    }

    return ''
}

function normalizeTemplateCreationComponents(raw: any[]): any[] {
    const normalized: any[] = []
    for (const component of raw) {
        if (!isObject(component)) continue
        const type = readTrimmed(component.type).toUpperCase()
        if (!type) continue

        const next: any = { ...component, type }
        if (type === 'HEADER') {
            const format = readTrimmed(component.format).toUpperCase()
            if (format) next.format = format
        }
        if (type === 'BUTTONS' && Array.isArray(component.buttons)) {
            next.buttons = component.buttons
                .filter((button: any) => isObject(button))
                .map((button: any) => ({
                    ...button,
                    type: readTrimmed(button.type).toUpperCase()
                }))
        }

        normalized.push(next)
    }

    return normalized
}

function validateUtilityTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const category = readTrimmed(input?.category || 'utility').toLowerCase()
    if (category !== 'utility') errors.push('category must be utility')

    const parameterFormat = readTrimmed(input?.parameter_format || input?.parameterFormat || 'positional').toLowerCase()
    if (parameterFormat !== 'named' && parameterFormat !== 'positional') {
        errors.push('parameter_format must be named or positional')
    }

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    if (rawComponents.length === 0) errors.push('components array is required')
    const components = normalizeTemplateCreationComponents(rawComponents)

    const headerComponents = components.filter((component: any) => component.type === 'HEADER')
    const bodyComponents = components.filter((component: any) => component.type === 'BODY')
    const footerComponents = components.filter((component: any) => component.type === 'FOOTER')
    const buttonComponents = components.filter((component: any) => component.type === 'BUTTONS')

    if (headerComponents.length > 1) errors.push('only one HEADER component is allowed')
    if (bodyComponents.length !== 1) errors.push('exactly one BODY component is required')
    if (footerComponents.length > 1) errors.push('only one FOOTER component is allowed')
    if (buttonComponents.length > 1) errors.push('only one BUTTONS component is allowed')

    const bodyComponent = bodyComponents[0]
    if (bodyComponent) {
        const bodyText = readTrimmed(bodyComponent.text)
        if (!bodyText) {
            errors.push('BODY.text is required')
        } else {
            if (bodyText.length > 1024) errors.push('BODY.text must be <= 1024 characters')

            const positionalVars = extractPositionalVars(bodyText)
            const namedVars = extractNamedVars(bodyText)

            if (parameterFormat === 'positional') {
                if (namedVars.length > 0) errors.push('BODY uses named variables but parameter_format is positional')
                positionalVars.forEach((value, index) => {
                    const expected = index + 1
                    if (value !== expected) errors.push('positional BODY variables must be sequential like {{1}}, {{2}}, {{3}}')
                })
            }

            if (parameterFormat === 'named' && positionalVars.length > 0) {
                errors.push('BODY uses positional variables but parameter_format is named')
            }

            if ((positionalVars.length > 0 || namedVars.length > 0) && !hasBodyExamples(bodyComponent)) {
                errors.push('BODY variables require example values')
            }

            const requiredExampleCount = parameterFormat === 'named' ? namedVars.length : positionalVars.length
            if (requiredExampleCount > 0) {
                const actualExamples = countBodyExamples(bodyComponent)
                if (actualExamples > 0 && actualExamples < requiredExampleCount) {
                    errors.push(`BODY example count (${actualExamples}) is less than variable count (${requiredExampleCount})`)
                }
            }
        }
    }

    const headerComponent = headerComponents[0]
    if (headerComponent) {
        const format = readTrimmed(headerComponent.format).toUpperCase()
        const allowedFormats = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'])
        if (!format || !allowedFormats.has(format)) {
            errors.push('HEADER.format must be one of TEXT, IMAGE, VIDEO, DOCUMENT, LOCATION')
        } else if (format === 'TEXT') {
            const headerText = readTrimmed(headerComponent.text)
            if (!headerText) errors.push('HEADER.text is required when HEADER.format is TEXT')
            if (headerText.length > 60) errors.push('HEADER.text must be <= 60 characters')
        } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
            if (!hasHeaderHandle(headerComponent)) {
                errors.push(`HEADER.format ${format} requires header_handle (usually in HEADER.example.header_handle)`)
            }
        }
    }

    const footerComponent = footerComponents[0]
    if (footerComponent) {
        const footerText = readTrimmed(footerComponent.text)
        if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
        if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
    }

    const buttonsComponent = buttonComponents[0]
    if (buttonsComponent) {
        const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : []
        if (buttons.length === 0) {
            errors.push('BUTTONS.buttons must contain at least one button')
        }
        if (buttons.length > 10) {
            errors.push('BUTTONS supports up to 10 buttons')
        }

        const allowedButtonTypes = new Set(['URL', 'PHONE_NUMBER', 'QUICK_REPLY', 'COPY_CODE', 'CALL_REQUEST'])
        buttons.forEach((button: any, index: number) => {
            const buttonType = readTrimmed(button?.type).toUpperCase()
            if (!allowedButtonTypes.has(buttonType)) {
                errors.push(`BUTTONS.buttons[${index}].type is invalid`)
                return
            }

            const label = readTrimmed(button?.text || button?.title)
            if (label && label.length > 25) {
                errors.push(`BUTTONS.buttons[${index}] label must be <= 25 characters`)
            }

            if (buttonType !== 'CALL_REQUEST' && !label) {
                errors.push(`BUTTONS.buttons[${index}] label is required`)
            }

            if (buttonType === 'PHONE_NUMBER') {
                const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                if (!phone) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number is required`)
                } else if (phone.length > 20) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number must be <= 20 characters`)
                }
            }

            if (buttonType === 'URL') {
                const url = readTrimmed(button?.url)
                if (!url) errors.push(`BUTTONS.buttons[${index}].url is required`)
            }
        })
    }

    if (errors.length > 0) return { payload: null, errors }

    return {
        payload: {
            name,
            category: 'UTILITY',
            language,
            parameter_format: parameterFormat.toUpperCase(),
            components
        },
        errors: []
    }
}

function normalizeMarketingToken(value: any): string {
    const normalized = readTrimmed(value).toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'quickreply') return 'quick_reply'
    if (normalized === 'phonenumber' || normalized === 'phone') return 'phone_number'
    if (normalized === 'copycode') return 'copy_code'
    if (normalized === 'limitedtimeoffer') return 'limited_time_offer'
    return normalized
}

function normalizeMarketingCreateComponents(raw: any[]): any[] {
    const normalizeButtons = (buttons: any[]): any[] => {
        return buttons
            .filter((button: any) => isObject(button))
            .map((button: any) => {
                const type = normalizeMarketingToken(button.type)
                return {
                    ...button,
                    type: type || readTrimmed(button.type).toLowerCase()
                }
            })
    }

    return raw
        .filter((component: any) => isObject(component))
        .map((component: any) => {
            const type = normalizeMarketingToken(component.type)
            if (!type) return null

            const next: any = {
                ...component,
                type
            }

            if (type === 'header') {
                const format = normalizeMarketingToken(component.format)
                if (format) next.format = format
            }

            if (type === 'buttons' && Array.isArray(component.buttons)) {
                next.buttons = normalizeButtons(component.buttons)
            }

            if (type === 'carousel' && Array.isArray(component.cards)) {
                next.cards = component.cards
                    .filter((card: any) => isObject(card))
                    .map((card: any) => ({
                        ...card,
                        components: normalizeMarketingCreateComponents(Array.isArray(card.components) ? card.components : [])
                    }))
            }

            return next
        })
        .filter(Boolean)
}

function countMarketingComponents(components: any[], type: string): number {
    return components.filter((component: any) => component?.type === type).length
}

function firstMarketingComponent(components: any[], type: string): any | null {
    return components.find((component: any) => component?.type === type) || null
}

function ensureOnlyMarketingTopTypes(components: any[], allowed: Set<string>, errors: string[], prefix = '') {
    components.forEach((component: any) => {
        const type = readTrimmed(component?.type)
        if (!type) return
        if (allowed.has(type)) return
        const label = prefix ? `${prefix}.components` : 'components'
        errors.push(`${label} does not support type "${type}"`)
    })
}

function toStringArray(raw: any): string[] {
    if (Array.isArray(raw)) {
        return raw.map((value) => readTrimmed(String(value))).filter(Boolean)
    }
    const single = readTrimmed(raw)
    return single ? [single] : []
}

function readBodyPositionalExamples(bodyComponent: any): string[] {
    const example = isObject(bodyComponent?.example) ? bodyComponent.example : null
    const bodyTextRows = Array.isArray(example?.body_text) ? example.body_text : []
    const firstRow = Array.isArray(bodyTextRows[0]) ? bodyTextRows[0] : []
    return firstRow.map((value: any) => readTrimmed(String(value))).filter(Boolean)
}

function readBodyNamedExamples(bodyComponent: any): Array<{ param_name: string; example: string }> {
    const example = isObject(bodyComponent?.example) ? bodyComponent.example : null
    const rawEntries = Array.isArray(example?.body_text_named_params) ? example.body_text_named_params : []
    const output: Array<{ param_name: string; example: string }> = []
    rawEntries.forEach((entry: any) => {
        if (!isObject(entry)) return
        const rawName = readTrimmed(entry.param_name)
        const paramName = rawName.replace(/^{{\s*|\s*}}$/g, '')
        const exampleValue = readTrimmed(entry.example)
        if (!paramName || !exampleValue) return
        output.push({
            param_name: paramName,
            example: exampleValue
        })
    })
    return output
}

function hasAlphaNumericOnly(value: string): boolean {
    if (!value) return false
    return /^[a-z0-9]+$/i.test(value)
}

function buildNormalizedBodyComponent(
    bodyComponent: any,
    options: {
        label: string
        maxLength: number
        parameterFormat: 'named' | 'positional'
        allowNamed: boolean
        allowPositional: boolean
        requireExamples: boolean
        enforceNamedRegex?: RegExp
    },
    errors: string[]
): {
    component: any | null
    namedVars: string[]
    positionalVars: number[]
    effectiveParameterFormat: 'named' | 'positional'
} {
    const fallback = {
        component: null,
        namedVars: [] as string[],
        positionalVars: [] as number[],
        effectiveParameterFormat: options.parameterFormat
    }

    if (!isObject(bodyComponent)) {
        errors.push(`${options.label} component is required`)
        return fallback
    }

    const text = readTrimmed(bodyComponent.text)
    if (!text) {
        errors.push(`${options.label}.text is required`)
        return fallback
    }

    if (text.length > options.maxLength) {
        errors.push(`${options.label}.text must be <= ${options.maxLength} characters`)
    }

    const namedVars = extractNamedVars(text)
    const positionalVars = extractPositionalVars(text)

    if (namedVars.length > 0 && positionalVars.length > 0) {
        errors.push(`${options.label} cannot mix named and positional variables`)
    }

    if (!options.allowNamed && namedVars.length > 0) {
        errors.push(`${options.label} supports positional variables only`)
    }
    if (!options.allowPositional && positionalVars.length > 0) {
        errors.push(`${options.label} supports named variables only`)
    }

    positionalVars.forEach((value, index) => {
        const expected = index + 1
        if (value !== expected) {
            errors.push(`${options.label} positional variables must be sequential like {{1}}, {{2}}, {{3}}`)
        }
    })

    if (options.enforceNamedRegex) {
        namedVars.forEach((name) => {
            if (!options.enforceNamedRegex!.test(name)) {
                errors.push(`${options.label} named variable "${name}" must use lowercase letters, numbers, and underscores`)
            }
        })
    }

    let effectiveParameterFormat: 'named' | 'positional' = options.parameterFormat
    if (namedVars.length > 0) effectiveParameterFormat = 'named'
    if (positionalVars.length > 0) effectiveParameterFormat = 'positional'

    if (options.parameterFormat === 'named' && positionalVars.length > 0) {
        errors.push(`${options.label} uses positional variables but parameter_format is named`)
    }
    if (options.parameterFormat === 'positional' && namedVars.length > 0) {
        errors.push(`${options.label} uses named variables but parameter_format is positional`)
    }

    const normalized: any = {
        type: 'body',
        text
    }

    if (namedVars.length > 0 || positionalVars.length > 0) {
        if (effectiveParameterFormat === 'named') {
            const parsedNamedExamples = readBodyNamedExamples(bodyComponent)
            if (options.requireExamples && parsedNamedExamples.length === 0) {
                errors.push(`${options.label}.example.body_text_named_params is required for named variables`)
            }

            const seen = new Set<string>()
            const normalizedNamed = parsedNamedExamples.filter((entry) => {
                if (seen.has(entry.param_name)) return false
                seen.add(entry.param_name)
                return true
            })

            if (options.enforceNamedRegex) {
                normalizedNamed.forEach((entry) => {
                    if (!options.enforceNamedRegex!.test(entry.param_name)) {
                        errors.push(`${options.label}.example named param "${entry.param_name}" must use lowercase letters, numbers, and underscores`)
                    }
                })
            }

            namedVars.forEach((name) => {
                if (!seen.has(name)) {
                    errors.push(`${options.label}.example is missing value for ${name}`)
                }
            })

            if (normalizedNamed.length > 0) {
                normalized.example = {
                    body_text_named_params: normalizedNamed
                }
            }
        } else {
            const positionalExamples = readBodyPositionalExamples(bodyComponent)
            if (options.requireExamples && positionalExamples.length === 0) {
                errors.push(`${options.label}.example.body_text[0] is required for positional variables`)
            }
            if (positionalExamples.length > 0 && positionalExamples.length < positionalVars.length) {
                errors.push(`${options.label}.example count (${positionalExamples.length}) is less than variable count (${positionalVars.length})`)
            }
            if (positionalExamples.length > 0) {
                normalized.example = {
                    body_text: [positionalExamples]
                }
            }
        }
    }

    return {
        component: normalized,
        namedVars,
        positionalVars,
        effectiveParameterFormat
    }
}

function validateMarketingTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const category = readTrimmed(input?.category || 'marketing').toLowerCase()
    if (category !== 'marketing') errors.push('category must be marketing')

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const inputParameterFormat = readTrimmed(input?.parameter_format || input?.parameterFormat || 'positional').toLowerCase()
    if (inputParameterFormat !== 'named' && inputParameterFormat !== 'positional') {
        errors.push('parameter_format must be named or positional')
    }
    const parameterFormat = inputParameterFormat === 'named' ? 'named' : 'positional'

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    if (rawComponents.length === 0) errors.push('components array is required')
    const components = normalizeMarketingCreateComponents(rawComponents)

    const topLevelTypes = components.map((component: any) => component.type)
    const hasLimitedTimeOffer = topLevelTypes.includes('limited_time_offer')
    const hasCarousel = topLevelTypes.includes('carousel')

    const topButtonsComponent = firstMarketingComponent(components, 'buttons')
    const topButtons = Array.isArray(topButtonsComponent?.buttons) ? topButtonsComponent.buttons : []
    const hasMpmButton = topButtons.some((button: any) => button?.type === 'mpm')
    const hasCopyCodeButton = topButtons.some((button: any) => button?.type === 'copy_code')

    let marketingPattern: 'standard' | 'limited_time_offer' | 'coupon_code' | 'media_card_carousel' | 'product_card_carousel' | 'mpm' = 'standard'
    if (hasCarousel) {
        const carousel = firstMarketingComponent(components, 'carousel')
        const cards = Array.isArray(carousel?.cards) ? carousel.cards : []
        const hasProductHeader = cards.some((card: any) => {
            const cardComponents = Array.isArray(card?.components) ? card.components : []
            const header = firstMarketingComponent(cardComponents, 'header')
            return readTrimmed(header?.format).toLowerCase() === 'product'
        })
        marketingPattern = hasProductHeader ? 'product_card_carousel' : 'media_card_carousel'
    } else if (hasLimitedTimeOffer) {
        marketingPattern = 'limited_time_offer'
    } else if (hasMpmButton) {
        marketingPattern = 'mpm'
    } else if (hasCopyCodeButton) {
        marketingPattern = 'coupon_code'
    }

    const normalizedComponents: any[] = []
    let outputParameterFormat: 'named' | 'positional' = parameterFormat

    if (marketingPattern === 'limited_time_offer') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'limited_time_offer', 'body', 'buttons']), errors)
        if (countMarketingComponents(components, 'header') !== 1) errors.push('limited_time_offer template requires exactly one HEADER')
        if (countMarketingComponents(components, 'limited_time_offer') !== 1) errors.push('limited_time_offer template requires exactly one LIMITED_TIME_OFFER component')
        if (countMarketingComponents(components, 'body') !== 1) errors.push('limited_time_offer template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('limited_time_offer template requires exactly one BUTTONS')
        if (countMarketingComponents(components, 'footer') > 0) errors.push('limited_time_offer template does not allow FOOTER')

        const ordered = components.map((component: any) => component.type).join(',')
        if (ordered !== 'header,limited_time_offer,body,buttons') {
            errors.push('limited_time_offer components must be in order: header, limited_time_offer, body, buttons')
        }

        const headerComponent = firstMarketingComponent(components, 'header')
        const headerFormat = readTrimmed(headerComponent?.format).toLowerCase()
        if (headerFormat !== 'image' && headerFormat !== 'video') {
            errors.push('limited_time_offer HEADER.format must be image or video')
        }
        const headerHandle = extractHeaderHandle(headerComponent)
        if (!headerHandle) errors.push('limited_time_offer HEADER requires example.header_handle')
        normalizedComponents.push({
            type: 'header',
            format: headerFormat || 'image',
            example: {
                header_handle: headerHandle ? [headerHandle] : []
            }
        })

        const offerComponent = firstMarketingComponent(components, 'limited_time_offer')
        const offerData = isObject(offerComponent?.limited_time_offer) ? offerComponent.limited_time_offer : null
        const offerText = readTrimmed(offerData?.text)
        if (!offerText) errors.push('limited_time_offer.text is required')
        if (offerText.length > 16) errors.push('limited_time_offer.text must be <= 16 characters')
        const hasExpiration = parseBooleanOption(offerData?.has_expiration)
        if (hasExpiration === undefined) errors.push('limited_time_offer.has_expiration must be true or false')
        normalizedComponents.push({
            type: 'limited_time_offer',
            limited_time_offer: {
                text: offerText,
                has_expiration: Boolean(hasExpiration)
            }
        })

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 600,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length !== 2) {
            errors.push('limited_time_offer buttons must contain exactly 2 buttons: copy_code and url')
        }

        const normalizedButtons: any[] = []
        buttons.forEach((button: any, index: number) => {
            const type = normalizeMarketingToken(button?.type)
            if (index === 0 && type !== 'copy_code') {
                errors.push('limited_time_offer button[0] must be type copy_code')
            }
            if (index === 1 && type !== 'url') {
                errors.push('limited_time_offer button[1] must be type url')
            }

            if (type === 'copy_code') {
                const example = readTrimmed(button?.example)
                if (!example) errors.push('limited_time_offer copy_code button requires example')
                if (example.length > 15) errors.push('limited_time_offer copy_code example must be <= 15 characters')
                normalizedButtons.push({
                    type: 'copy_code',
                    example
                })
                return
            }

            if (type === 'url') {
                const text = readTrimmed(button?.text || button?.title)
                const url = readTrimmed(button?.url)
                const urlExamples = toStringArray(button?.example)
                if (!text) errors.push('limited_time_offer url button text is required')
                if (text.length > 25) errors.push('limited_time_offer url button text must be <= 25 characters')
                if (!url) errors.push('limited_time_offer url button url is required')
                if (url.length > 2000) errors.push('limited_time_offer url button url must be <= 2000 characters')
                if (urlExamples.length !== 1) errors.push('limited_time_offer url button requires one example URL')
                normalizedButtons.push({
                    type: 'url',
                    text,
                    url,
                    example: urlExamples.slice(0, 1)
                })
                return
            }

            errors.push(`limited_time_offer button[${index}] has unsupported type ${type || '(empty)'}`)
        })

        normalizedComponents.push({
            type: 'buttons',
            buttons: normalizedButtons
        })
    } else if (marketingPattern === 'coupon_code') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'buttons']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('coupon_code template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('coupon_code template requires exactly one BUTTONS')
        if (countMarketingComponents(components, 'footer') > 0) errors.push('coupon_code template does not allow FOOTER')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (countMarketingComponents(components, 'header') > 1) errors.push('coupon_code template allows at most one HEADER')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format || 'text').toLowerCase()
            if (format !== 'text') errors.push('coupon_code HEADER.format must be text')
            const text = readTrimmed(headerComponent.text)
            if (!text) errors.push('coupon_code HEADER.text is required')
            if (text.length > 60) errors.push('coupon_code HEADER.text must be <= 60 characters')
            normalizedComponents.push({
                type: 'header',
                format: 'text',
                text
            })
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length === 0) errors.push('coupon_code BUTTONS.buttons must contain at least one button')
        if (buttons.length > 2) errors.push('coupon_code BUTTONS.buttons supports at most 2 buttons')

        const copyCodeButtons = buttons.filter((button: any) => normalizeMarketingToken(button?.type) === 'copy_code')
        if (copyCodeButtons.length !== 1) errors.push('coupon_code template requires exactly one copy_code button')

        const normalizedButtons: any[] = []
        buttons.forEach((button: any, index: number) => {
            const type = normalizeMarketingToken(button?.type)
            if (type === 'quick_reply') {
                const text = readTrimmed(button?.text || button?.title)
                if (!text) errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text is required`)
                if (text.length > 25) errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text must be <= 25 characters`)
                if (text && !hasAlphaNumericOnly(text.replace(/\s+/g, ''))) {
                    errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text must be alphanumeric`)
                }
                normalizedButtons.push({
                    type: 'quick_reply',
                    text
                })
                return
            }
            if (type === 'copy_code') {
                const example = readTrimmed(button?.example)
                if (!example) errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example is required`)
                if (example.length > 20) errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example must be <= 20 characters`)
                if (example && !hasAlphaNumericOnly(example)) {
                    errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example must be alphanumeric`)
                }
                normalizedButtons.push({
                    type: 'copy_code',
                    example
                })
                return
            }
            errors.push(`coupon_code BUTTONS.buttons[${index}].type must be quick_reply or copy_code`)
        })

        if (normalizedButtons.length === 2) {
            if (normalizedButtons[0]?.type !== 'quick_reply' || normalizedButtons[1]?.type !== 'copy_code') {
                errors.push('coupon_code buttons must be ordered: quick_reply (optional), then copy_code')
            }
        }

        normalizedComponents.push({
            type: 'buttons',
            buttons: normalizedButtons
        })
    } else if (marketingPattern === 'media_card_carousel' || marketingPattern === 'product_card_carousel') {
        ensureOnlyMarketingTopTypes(components, new Set(['body', 'carousel']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('carousel template requires exactly one BODY component')
        if (countMarketingComponents(components, 'carousel') !== 1) errors.push('carousel template requires exactly one CAROUSEL component')

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const carouselComponent = firstMarketingComponent(components, 'carousel')
        const cards = Array.isArray(carouselComponent?.cards) ? carouselComponent.cards : []
        if (cards.length < 2) errors.push('carousel.cards must contain at least 2 cards')
        if (cards.length > 10) errors.push('carousel.cards must contain at most 10 cards')
        if (marketingPattern === 'product_card_carousel' && cards.length !== 2) {
            errors.push('product_card_carousel create requires exactly 2 cards')
        }

        let expectedSignature = ''
        let expectedHasBody: boolean | null = null
        const normalizedCards: any[] = []

        cards.forEach((card: any, cardIndex: number) => {
            const label = `carousel.cards[${cardIndex}]`
            const cardComponents = Array.isArray(card?.components) ? normalizeMarketingCreateComponents(card.components) : []
            ensureOnlyMarketingTopTypes(cardComponents, new Set(['header', 'body', 'buttons']), errors, label)

            if (countMarketingComponents(cardComponents, 'header') !== 1) {
                errors.push(`${label} requires exactly one header`)
            }
            if (countMarketingComponents(cardComponents, 'buttons') !== 1) {
                errors.push(`${label} requires exactly one buttons component`)
            }
            if (countMarketingComponents(cardComponents, 'body') > 1) {
                errors.push(`${label} allows at most one body component`)
            }

            const cardHeader = firstMarketingComponent(cardComponents, 'header')
            const cardHeaderFormat = readTrimmed(cardHeader?.format).toLowerCase()
            const cardBody = firstMarketingComponent(cardComponents, 'body')
            const cardButtonsComponent = firstMarketingComponent(cardComponents, 'buttons')
            const cardButtons = Array.isArray(cardButtonsComponent?.buttons) ? cardButtonsComponent.buttons : []

            const normalizedCardComponents: any[] = []
            if (marketingPattern === 'product_card_carousel') {
                if (cardHeaderFormat !== 'product') {
                    errors.push(`${label}.header.format must be product`)
                }
                normalizedCardComponents.push({
                    type: 'header',
                    format: 'product'
                })
            } else {
                if (cardHeaderFormat !== 'image' && cardHeaderFormat !== 'video') {
                    errors.push(`${label}.header.format must be image or video`)
                }
                const handle = extractHeaderHandle(cardHeader)
                if (!handle) errors.push(`${label}.header requires example.header_handle`)
                normalizedCardComponents.push({
                    type: 'header',
                    format: cardHeaderFormat || 'image',
                    example: {
                        header_handle: handle ? [handle] : []
                    }
                })
            }

            if (cardBody) {
                const cardBodyValidation = buildNormalizedBodyComponent(
                    cardBody,
                    {
                        label: `${label}.body`,
                        maxLength: 160,
                        parameterFormat: 'positional',
                        allowNamed: false,
                        allowPositional: true,
                        requireExamples: true
                    },
                    errors
                )
                if (cardBodyValidation.component) normalizedCardComponents.push(cardBodyValidation.component)
            }

            const normalizedCardButtons: any[] = []
            if (cardButtons.length === 0) errors.push(`${label}.buttons.buttons must not be empty`)

            cardButtons.forEach((button: any, buttonIndex: number) => {
                const buttonType = normalizeMarketingToken(button?.type)
                const buttonLabel = `${label}.buttons.buttons[${buttonIndex}]`
                if (!buttonType) {
                    errors.push(`${buttonLabel}.type is required`)
                    return
                }

                if (marketingPattern === 'product_card_carousel' && buttonType !== 'spm' && buttonType !== 'url') {
                    errors.push(`${buttonLabel}.type must be spm or url`)
                    return
                }

                if (marketingPattern === 'product_card_carousel' && cardButtons.length !== 1) {
                    errors.push(`${label} must have exactly one button`)
                }

                if (marketingPattern === 'media_card_carousel' && !new Set(['quick_reply', 'url', 'phone_number']).has(buttonType)) {
                    errors.push(`${buttonLabel}.type must be quick_reply, url, or phone_number`)
                    return
                }

                if (buttonType === 'quick_reply') {
                    const text = readTrimmed(button?.text || button?.title)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    normalizedCardButtons.push({
                        type: 'quick_reply',
                        text
                    })
                    return
                }

                if (buttonType === 'phone_number') {
                    const text = readTrimmed(button?.text || button?.title)
                    const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    if (!phone) errors.push(`${buttonLabel}.phone_number is required`)
                    if (phone.length > 20) errors.push(`${buttonLabel}.phone_number must be <= 20 characters`)
                    normalizedCardButtons.push({
                        type: 'phone_number',
                        text,
                        phone_number: phone
                    })
                    return
                }

                if (buttonType === 'spm') {
                    const text = readTrimmed(button?.text || 'View')
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    normalizedCardButtons.push({
                        type: 'spm',
                        text: text || 'View'
                    })
                    return
                }

                if (buttonType === 'url') {
                    const text = readTrimmed(button?.text || button?.title)
                    const url = readTrimmed(button?.url)
                    const example = toStringArray(button?.example)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    if (!url) errors.push(`${buttonLabel}.url is required`)
                    if (url.length > 2000) errors.push(`${buttonLabel}.url must be <= 2000 characters`)
                    if (url.includes('{{') && example.length === 0) {
                        errors.push(`${buttonLabel}.example is required when URL uses variables`)
                    }
                    const normalizedUrl: any = {
                        type: 'url',
                        text,
                        url
                    }
                    if (example.length > 0) normalizedUrl.example = [example[0]]
                    normalizedCardButtons.push(normalizedUrl)
                }
            })

            normalizedCardComponents.push({
                type: 'buttons',
                buttons: normalizedCardButtons
            })

            const hasCardBody = Boolean(cardBody)
            if (marketingPattern === 'media_card_carousel') {
                if (expectedHasBody === null) expectedHasBody = hasCardBody
                else if (expectedHasBody !== hasCardBody) {
                    errors.push('If one media carousel card has a body, all cards must include a body')
                }
            }

            const signature = JSON.stringify({
                types: normalizedCardComponents.map((item) => item.type),
                buttonTypes: normalizedCardButtons.map((item) => item.type),
                headerFormat: normalizedCardComponents[0]?.format || ''
            })
            if (!expectedSignature) expectedSignature = signature
            else if (expectedSignature !== signature) {
                errors.push('All carousel cards must have the same component structure and button order')
            }

            normalizedCards.push({
                components: normalizedCardComponents
            })
        })

        normalizedComponents.push({
            type: 'carousel',
            cards: normalizedCards
        })
    } else if (marketingPattern === 'mpm') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'footer', 'buttons']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('mpm template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('mpm template requires exactly one BUTTONS')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (countMarketingComponents(components, 'header') > 1) errors.push('mpm template allows at most one HEADER')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format || 'text').toLowerCase()
            if (format !== 'text') errors.push('mpm HEADER.format must be text')
            const text = readTrimmed(headerComponent.text)
            if (!text) errors.push('mpm HEADER.text is required')
            if (text.length > 60) errors.push('mpm HEADER.text must be <= 60 characters')
            const headerVars = extractPositionalVars(text)
            if (headerVars.length > 1) errors.push('mpm HEADER supports at most one variable')
            const headerExamples = toStringArray(headerComponent?.example?.header_text)
            if (headerVars.length > 0 && headerExamples.length === 0) {
                errors.push('mpm HEADER.example.header_text is required when header has variables')
            }
            const normalizedHeader: any = {
                type: 'header',
                format: 'text',
                text
            }
            if (headerExamples.length > 0) normalizedHeader.example = { header_text: [headerExamples[0]] }
            normalizedComponents.push(normalizedHeader)
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const footerComponent = firstMarketingComponent(components, 'footer')
        if (countMarketingComponents(components, 'footer') > 1) errors.push('mpm template allows at most one FOOTER')
        if (footerComponent) {
            const footerText = readTrimmed(footerComponent.text)
            if (!footerText) errors.push('mpm FOOTER.text is required')
            if (footerText.length > 60) errors.push('mpm FOOTER.text must be <= 60 characters')
            if (extractPositionalVars(footerText).length > 0 || extractNamedVars(footerText).length > 0) {
                errors.push('mpm FOOTER.text must not contain variables')
            }
            normalizedComponents.push({
                type: 'footer',
                text: footerText
            })
        }

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length !== 1) {
            errors.push('mpm BUTTONS must contain exactly one button')
        }
        const mpmButton = buttons[0]
        const mpmButtonType = normalizeMarketingToken(mpmButton?.type)
        if (mpmButtonType !== 'mpm') errors.push('mpm BUTTONS.buttons[0].type must be mpm')
        const mpmButtonText = readTrimmed(mpmButton?.text || mpmButton?.title)
        if (!mpmButtonText) errors.push('mpm button text is required')
        if (mpmButtonText.length > 25) errors.push('mpm button text must be <= 25 characters')
        normalizedComponents.push({
            type: 'buttons',
            buttons: [
                {
                    type: 'mpm',
                    text: mpmButtonText
                }
            ]
        })
    } else {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'footer', 'buttons']), errors)
        if (countMarketingComponents(components, 'header') > 1) errors.push('only one HEADER component is allowed')
        if (countMarketingComponents(components, 'body') !== 1) errors.push('exactly one BODY component is required')
        if (countMarketingComponents(components, 'footer') > 1) errors.push('only one FOOTER component is allowed')
        if (countMarketingComponents(components, 'buttons') > 1) errors.push('only one BUTTONS component is allowed')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format).toLowerCase()
            if (!new Set(['text', 'image', 'video', 'document', 'location']).has(format)) {
                errors.push('HEADER.format must be one of text, image, video, document, location')
            } else if (format === 'text') {
                const text = readTrimmed(headerComponent.text)
                if (!text) errors.push('HEADER.text is required when HEADER.format is text')
                if (text.length > 60) errors.push('HEADER.text must be <= 60 characters')
                normalizedComponents.push({
                    type: 'header',
                    format: 'text',
                    text
                })
            } else if (format === 'image' || format === 'video' || format === 'document') {
                const handle = extractHeaderHandle(headerComponent)
                if (!handle) errors.push(`HEADER.format ${format} requires example.header_handle`)
                normalizedComponents.push({
                    type: 'header',
                    format,
                    example: {
                        header_handle: handle ? [handle] : []
                    }
                })
            } else {
                normalizedComponents.push({
                    type: 'header',
                    format: 'location'
                })
            }
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat,
                allowNamed: true,
                allowPositional: true,
                requireExamples: true,
                enforceNamedRegex: MARKETING_NAMED_PARAM_REGEX
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = bodyValidation.effectiveParameterFormat

        const footerComponent = firstMarketingComponent(components, 'footer')
        if (footerComponent) {
            const footerText = readTrimmed(footerComponent.text)
            if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
            if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
            normalizedComponents.push({
                type: 'footer',
                text: footerText
            })
        }

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        if (buttonsComponent) {
            const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : []
            if (buttons.length === 0) errors.push('BUTTONS.buttons must contain at least one button')
            if (buttons.length > 10) errors.push('BUTTONS supports up to 10 buttons')

            const normalizedButtons: any[] = []
            buttons.forEach((button: any, index: number) => {
                const type = normalizeMarketingToken(button?.type)
                const label = readTrimmed(button?.text || button?.title)
                const buttonLabel = `BUTTONS.buttons[${index}]`

                if (!new Set(['url', 'phone_number', 'quick_reply', 'copy_code', 'call_request', 'spm', 'mpm']).has(type)) {
                    errors.push(`${buttonLabel}.type is invalid`)
                    return
                }

                const nextButton: any = { type }
                if (label) {
                    if (label.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    nextButton.text = label
                } else if (type !== 'call_request' && type !== 'copy_code') {
                    errors.push(`${buttonLabel}.text is required`)
                }

                if (type === 'url') {
                    const url = readTrimmed(button?.url)
                    if (!url) errors.push(`${buttonLabel}.url is required`)
                    nextButton.url = url
                    const example = toStringArray(button?.example)
                    if (url.includes('{{') && example.length === 0) {
                        errors.push(`${buttonLabel}.example is required when URL uses variables`)
                    }
                    if (example.length > 0) nextButton.example = [example[0]]
                }
                if (type === 'phone_number') {
                    const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                    if (!phone) errors.push(`${buttonLabel}.phone_number is required`)
                    if (phone.length > 20) errors.push(`${buttonLabel}.phone_number must be <= 20 characters`)
                    nextButton.phone_number = phone
                }
                if (type === 'copy_code') {
                    const example = readTrimmed(button?.example)
                    if (example) {
                        if (example.length > 20) errors.push(`${buttonLabel}.example must be <= 20 characters`)
                        nextButton.example = example
                    }
                }

                normalizedButtons.push(nextButton)
            })

            normalizedComponents.push({
                type: 'buttons',
                buttons: normalizedButtons
            })
        }
    }

    if (errors.length > 0) return { payload: null, errors }

    return {
        payload: {
            name,
            category: 'marketing',
            language,
            parameter_format: outputParameterFormat,
            components: normalizedComponents
        },
        errors: []
    }
}

function hasEmoji(value: string): boolean {
    if (!value) return false
    return /(?:[\u2600-\u27BF]|[\uD83C-\uDBFF][\uDC00-\uDFFF])/.test(value)
}

function hasUrlLikeText(value: string): boolean {
    if (!value) return false
    return /(https?:\/\/|www\.)/i.test(value)
}

function parseBooleanOption(value: any): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false
    }
    return undefined
}

function parseLanguageCodes(value: any): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => readTrimmed(item)).filter(Boolean)
    }
    if (typeof value === 'string') {
        return value.split(',').map((part) => part.trim()).filter(Boolean)
    }
    return []
}

function hasUnsupportedAuthUpsertButtonFields(components: any[]): string[] {
    const errors: string[] = []
    components.forEach((component: any, componentIndex: number) => {
        if (!isObject(component) || component.type !== 'BUTTONS' || !Array.isArray(component.buttons)) return
        component.buttons.forEach((button: any, buttonIndex: number) => {
            if (!isObject(button)) return
            if (Object.prototype.hasOwnProperty.call(button, 'text')) {
                errors.push(`components[${componentIndex}].buttons[${buttonIndex}].text is not supported in upsert_message_templates`)
            }
            if (Object.prototype.hasOwnProperty.call(button, 'autofill_text')) {
                errors.push(`components[${componentIndex}].buttons[${buttonIndex}].autofill_text is not supported in upsert_message_templates`)
            }
        })
    })
    return errors
}

function validateAuthenticationTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const category = readTrimmed(input?.category || 'authentication').toLowerCase()
    if (category !== 'authentication') {
        errors.push('category must be authentication')
    }

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const ttlRaw = input?.message_send_ttl_seconds
    let messageSendTtlSeconds: number | undefined
    if (ttlRaw !== undefined && ttlRaw !== null && `${ttlRaw}`.trim() !== '') {
        const parsed = Number(ttlRaw)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            errors.push('message_send_ttl_seconds must be a positive number')
        } else {
            messageSendTtlSeconds = Math.floor(parsed)
        }
    }

    const addSecurityRecommendationRaw = input?.add_security_recommendation
    const addSecurityRecommendation = parseBooleanOption(addSecurityRecommendationRaw)
    if (addSecurityRecommendationRaw !== undefined && addSecurityRecommendation === undefined) {
        errors.push('add_security_recommendation must be true or false')
    }

    const expirationRaw = input?.code_expiration_minutes
    let codeExpirationMinutes: number | undefined
    if (expirationRaw !== undefined && expirationRaw !== null && `${expirationRaw}`.trim() !== '') {
        const parsed = Number(expirationRaw)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
            errors.push('code_expiration_minutes must be between 1 and 90')
        } else {
            codeExpirationMinutes = Math.floor(parsed)
        }
    }

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    const components = normalizeTemplateCreationComponents(rawComponents)

    if (components.some((component: any) => component.type === 'HEADER')) {
        errors.push('authentication templates do not support HEADER/media components')
    }

    const bodyComponents = components.filter((component: any) => component.type === 'BODY')
    const footerComponents = components.filter((component: any) => component.type === 'FOOTER')
    const buttonsComponents = components.filter((component: any) => component.type === 'BUTTONS')

    if (components.length > 0 && bodyComponents.length !== 1) {
        errors.push('exactly one BODY component is required when components are provided')
    }
    if (footerComponents.length > 1) errors.push('only one FOOTER component is allowed')
    if (buttonsComponents.length > 1) errors.push('only one BUTTONS component is allowed')

    const body = bodyComponents[0]
    if (body) {
        const bodyText = readTrimmed(body.text)
        if (!bodyText) {
            errors.push('BODY.text is required')
        } else {
            if (bodyText.length > 1024) errors.push('BODY.text must be <= 1024 characters')
            if (!bodyText.includes('{{1}}')) errors.push('BODY.text must include OTP placeholder {{1}}')
            if (hasUrlLikeText(bodyText)) errors.push('BODY.text must not contain URLs')
            if (hasEmoji(bodyText)) errors.push('BODY.text must not contain emojis')
        }
    }

    const footer = footerComponents[0]
    if (footer) {
        const footerText = readTrimmed(footer.text)
        if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
        if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
        if (hasUrlLikeText(footerText)) errors.push('FOOTER.text must not contain URLs')
        if (hasEmoji(footerText)) errors.push('FOOTER.text must not contain emojis')
    }

    const buttonsBlock = buttonsComponents[0]
    if (buttonsBlock) {
        const buttons = Array.isArray(buttonsBlock.buttons) ? buttonsBlock.buttons : []
        if (buttons.length === 0) errors.push('BUTTONS.buttons must contain at least one button')
        if (buttons.length > 1) errors.push('authentication templates support only one OTP button')

        const allowedTypes = new Set(['OTP', 'COPY_CODE', 'ONE_TAP', 'ZERO_TAP', 'URL'])
        buttons.forEach((button: any, index: number) => {
            const type = readTrimmed(button?.type).toUpperCase()
            if (!allowedTypes.has(type)) {
                errors.push(`BUTTONS.buttons[${index}].type must be OTP-compatible`)
            }
            const label = readTrimmed(button?.text || button?.title)
            if (hasEmoji(label)) errors.push(`BUTTONS.buttons[${index}] label must not contain emojis`)
            if (button?.url) errors.push(`BUTTONS.buttons[${index}] must not define a custom URL for authentication`)
        })
    }

    if (errors.length > 0) return { payload: null, errors }

    const payload: any = {
        name,
        language,
        category: 'AUTHENTICATION'
    }
    if (components.length > 0) payload.components = components
    if (messageSendTtlSeconds !== undefined) payload.message_send_ttl_seconds = messageSendTtlSeconds
    if (addSecurityRecommendation !== undefined) payload.add_security_recommendation = addSecurityRecommendation
    if (codeExpirationMinutes !== undefined) payload.code_expiration_minutes = codeExpirationMinutes

    return { payload, errors: [] }
}

function validateAuthenticationUpsertInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const languages = parseLanguageCodes(input?.languages)
    if (languages.length === 0) {
        errors.push('languages is required and must contain at least one language code')
    }

    const baseValidation = validateAuthenticationTemplateInput({
        ...input,
        language: languages[0] || input?.language || 'en_US'
    })
    if (baseValidation.errors.length > 0 || !baseValidation.payload) {
        return { payload: null, errors: baseValidation.errors }
    }

    const components = Array.isArray(baseValidation.payload.components) ? baseValidation.payload.components : []
    errors.push(...hasUnsupportedAuthUpsertButtonFields(components))

    if (errors.length > 0) return { payload: null, errors }

    const payload: any = {
        ...baseValidation.payload,
        languages,
        category: 'AUTHENTICATION'
    }
    delete payload.language

    return { payload, errors: [] }
}

function parseAuthenticationPreviewOptions(input: any): { options: any; errors: string[] } {
    const errors: string[] = []
    const options: any = {}

    const languages = parseLanguageCodes(input?.language)
    if (languages.length > 0) options.language = languages

    const addSecurityRaw = input?.add_security_recommendation
    if (addSecurityRaw !== undefined) {
        const parsed = parseBooleanOption(addSecurityRaw)
        if (parsed === undefined) errors.push('add_security_recommendation must be true or false')
        else options.addSecurityRecommendation = parsed
    }

    const codeExpirationRaw = input?.code_expiration_minutes
    if (codeExpirationRaw !== undefined && codeExpirationRaw !== null && `${codeExpirationRaw}`.trim() !== '') {
        const parsed = Number(codeExpirationRaw)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
            errors.push('code_expiration_minutes must be between 1 and 90')
        } else {
            options.codeExpirationMinutes = Math.floor(parsed)
        }
    }

    return { options, errors }
}

function parseAuthenticationCode(value: any): { code: string; error: string | null } {
    const code = readTrimmed(value)
    if (!code) return { code: '', error: 'code is required' }
    if (code.length > 15) return { code: '', error: 'code must be <= 15 characters' }
    if (hasEmoji(code)) return { code: '', error: 'code must not contain emojis' }
    return { code, error: null }
}

function normalizeTemplateSendComponents(raw: any): any[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const components = raw
        .filter((component: any) => isObject(component))
        .map((component: any) => {
            const normalizedType = readTrimmed(component.type).toLowerCase()
            const normalizedSubType = readTrimmed(component.sub_type).toLowerCase()
            const next: any = { ...component }
            if (normalizedType) next.type = normalizedType
            if (normalizedSubType) next.sub_type = normalizedSubType
            return next
        })
        .filter((component: any) => readTrimmed(component.type))
    return components.length > 0 ? components : undefined
}

function normalizeTemplateSendParameters(raw: any): any[] {
    if (!Array.isArray(raw)) return []
    const params: any[] = []
    raw.forEach((item) => {
        if (isObject(item)) {
            params.push(item)
            return
        }
        if (item === null || item === undefined) return
        params.push({
            type: 'text',
            text: String(item)
        })
    })
    return params
}

function buildTemplateSendComponents(input: any): any[] | undefined {
    const direct = normalizeTemplateSendComponents(input?.components)
    if (direct) return direct

    const headerParameters = normalizeTemplateSendParameters(input?.headerParameters || input?.header_parameters)
    const bodyParameters = normalizeTemplateSendParameters(input?.bodyParameters || input?.body_parameters || input?.parameters)

    const built: any[] = []
    if (headerParameters.length > 0) built.push({ type: 'header', parameters: headerParameters })
    if (bodyParameters.length > 0) built.push({ type: 'body', parameters: bodyParameters })
    return built.length > 0 ? built : undefined
}

function validateTemplateSendComponents(components: any[] | undefined): string[] {
    const errors: string[] = []
    if (!Array.isArray(components) || components.length === 0) return errors

    const validateList = (list: any[], path: string, insideCarouselCard: boolean) => {
        list.forEach((component: any, index: number) => {
            if (!isObject(component)) {
                errors.push(`${path}[${index}] must be an object`)
                return
            }

            const type = readTrimmed(component.type).toLowerCase()
            if (!type) {
                errors.push(`${path}[${index}].type is required`)
                return
            }

            const componentPath = `${path}[${index}]`

            if (type === 'header' || type === 'body') {
                if (component.parameters !== undefined && !Array.isArray(component.parameters)) {
                    errors.push(`${componentPath}.parameters must be an array`)
                }
                return
            }

            if (type === 'limited_time_offer') {
                if (insideCarouselCard) {
                    errors.push(`${componentPath}.type limited_time_offer is not supported inside carousel cards`)
                }
                const parameters = Array.isArray(component.parameters) ? component.parameters : []
                if (parameters.length !== 1) {
                    errors.push(`${componentPath}.parameters must contain one limited_time_offer parameter`)
                    return
                }
                const param = parameters[0]
                if (!isObject(param) || readTrimmed(param.type).toLowerCase() !== 'limited_time_offer') {
                    errors.push(`${componentPath}.parameters[0].type must be limited_time_offer`)
                    return
                }
                const expiration = Number(param?.limited_time_offer?.expiration_time_ms)
                if (!Number.isFinite(expiration) || expiration <= 0) {
                    errors.push(`${componentPath}.parameters[0].limited_time_offer.expiration_time_ms must be a positive unix timestamp (ms)`)
                }
                return
            }

            if (type === 'carousel') {
                if (insideCarouselCard) {
                    errors.push(`${componentPath}.type carousel is not supported inside carousel cards`)
                    return
                }
                const cards = Array.isArray(component.cards) ? component.cards : []
                if (cards.length === 0) {
                    errors.push(`${componentPath}.cards must contain at least one card`)
                    return
                }
                if (cards.length > 10) {
                    errors.push(`${componentPath}.cards must contain at most 10 cards`)
                }
                cards.forEach((card: any, cardIndex: number) => {
                    if (!isObject(card)) {
                        errors.push(`${componentPath}.cards[${cardIndex}] must be an object`)
                        return
                    }
                    const parsedCardIndex = Number(card.card_index)
                    if (!Number.isFinite(parsedCardIndex) || parsedCardIndex < 0) {
                        errors.push(`${componentPath}.cards[${cardIndex}].card_index must be a non-negative number`)
                    }
                    const cardComponents = Array.isArray(card.components) ? card.components : []
                    if (cardComponents.length === 0) {
                        errors.push(`${componentPath}.cards[${cardIndex}].components must not be empty`)
                        return
                    }
                    validateList(cardComponents, `${componentPath}.cards[${cardIndex}].components`, true)
                })
                return
            }

            if (type === 'button') {
                const subType = normalizeMarketingToken(component.sub_type || component.subType)
                if (!subType) {
                    errors.push(`${componentPath}.sub_type is required`)
                    return
                }

                const supported = new Set(['url', 'quick_reply', 'copy_code', 'mpm', 'spm', 'phone_number'])
                if (!supported.has(subType)) {
                    errors.push(`${componentPath}.sub_type "${subType}" is not supported`)
                    return
                }

                const parameters = Array.isArray(component.parameters) ? component.parameters : []
                if (parameters.length === 0) {
                    errors.push(`${componentPath}.parameters is required`)
                    return
                }
                const first = parameters[0]
                if (!isObject(first)) {
                    errors.push(`${componentPath}.parameters[0] must be an object`)
                    return
                }

                const parsedIndex = Number.parseInt(String(component.index ?? ''), 10)
                if (!Number.isFinite(parsedIndex)) {
                    errors.push(`${componentPath}.index is required`)
                }

                if (subType === 'url') {
                    const text = readTrimmed(first.text)
                    if (!text) errors.push(`${componentPath}.parameters[0].text is required for url button`)
                } else if (subType === 'copy_code') {
                    const code = readTrimmed(first.coupon_code)
                    if (!code) errors.push(`${componentPath}.parameters[0].coupon_code is required`)
                    if (code.length > 20) errors.push(`${componentPath}.parameters[0].coupon_code must be <= 20 characters`)
                } else if (subType === 'mpm') {
                    if (parsedIndex !== 0) errors.push(`${componentPath}.index must be 0 for mpm button`)
                    if (readTrimmed(first.type).toLowerCase() !== 'action') {
                        errors.push(`${componentPath}.parameters[0].type must be action`)
                    }
                    const action = isObject(first.action) ? first.action : null
                    if (!action) {
                        errors.push(`${componentPath}.parameters[0].action is required`)
                    } else {
                        const thumb = readTrimmed(action.thumbnail_product_retailer_id)
                        if (!thumb) errors.push(`${componentPath}.parameters[0].action.thumbnail_product_retailer_id is required`)
                        const sections = Array.isArray(action.sections) ? action.sections : []
                        if (sections.length === 0) errors.push(`${componentPath}.parameters[0].action.sections must not be empty`)
                        if (sections.length > 10) errors.push(`${componentPath}.parameters[0].action.sections supports at most 10 sections`)
                        let productCount = 0
                        sections.forEach((section: any, sectionIndex: number) => {
                            if (!isObject(section)) {
                                errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}] must be an object`)
                                return
                            }
                            const title = readTrimmed(section.title)
                            if (!title) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].title is required`)
                            if (title.length > 24) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].title must be <= 24 characters`)
                            const items = Array.isArray(section.product_items) ? section.product_items : []
                            if (items.length === 0) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].product_items must not be empty`)
                            productCount += items.length
                            items.forEach((item: any, itemIndex: number) => {
                                if (!isObject(item) || !readTrimmed(item.product_retailer_id)) {
                                    errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].product_items[${itemIndex}].product_retailer_id is required`)
                                }
                            })
                        })
                        if (productCount > 30) {
                            errors.push(`${componentPath}.parameters[0].action.sections contains more than 30 product_items`)
                        }
                    }
                }
                return
            }

            if (insideCarouselCard) {
                errors.push(`${componentPath}.type "${type}" is not supported in carousel cards`)
            } else {
                errors.push(`${componentPath}.type "${type}" is not supported`)
            }
        })
    }

    validateList(components, 'components', false)
    return errors
}

function parseMarketingProductPolicy(value: any): 'STRICT' | 'CLOUD_API_FALLBACK' | undefined {
    const normalized = readTrimmed(value).toUpperCase()
    if (!normalized) return undefined
    if (normalized === 'STRICT' || normalized === 'CLOUD_API_FALLBACK') return normalized
    return undefined
}

async function createTemplateMediaHeaderHandle(params: {
    accessToken: string
    appId: string
    apiVersion: string
    fileName: string
    fileType: string
    fileBuffer: Buffer
}): Promise<{ sessionId: string; headerHandle: string }> {
    const cleanApiVersion = readTrimmed(params.apiVersion || '').replace(/^\/+|\/+$/g, '') || 'v23.0'
    const cleanFileName = readTrimmed(params.fileName) || `template_asset_${Date.now()}`
    const cleanFileType = readTrimmed(params.fileType) || 'application/octet-stream'

    const initUrl = new URL(`https://graph.facebook.com/${cleanApiVersion}/${params.appId}/uploads`)
    initUrl.searchParams.set('file_name', cleanFileName)
    initUrl.searchParams.set('file_length', String(params.fileBuffer.byteLength))
    initUrl.searchParams.set('file_type', cleanFileType)

    const initRes = await fetch(initUrl.toString(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.accessToken}`
        }
    })
    const initText = await initRes.text()
    const initData = initText ? JSON.parse(initText) : null
    if (!initRes.ok || initData?.error) {
        const message = initData?.error?.message || initRes.statusText || 'Failed to start upload session'
        const code = initData?.error?.code
        throw new Error(`Upload session error ${initRes.status}${code ? ` (${code})` : ''}: ${message}`)
    }

    const sessionId = readTrimmed(initData?.id)
    if (!sessionId) {
        throw new Error('Upload session ID missing from Graph response')
    }

    const uploadBody = Uint8Array.from(params.fileBuffer)

    const uploadRes = await fetch(`https://graph.facebook.com/${cleanApiVersion}/${sessionId}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.accessToken}`,
            'file_offset': '0',
            'Content-Type': 'application/octet-stream'
        },
        body: uploadBody
    })
    const uploadText = await uploadRes.text()
    const uploadData = uploadText ? JSON.parse(uploadText) : null
    if (!uploadRes.ok || uploadData?.error) {
        const message = uploadData?.error?.message || uploadRes.statusText || 'Failed to upload binary data'
        const code = uploadData?.error?.code
        throw new Error(`Upload binary error ${uploadRes.status}${code ? ` (${code})` : ''}: ${message}`)
    }

    const headerHandle = readTrimmed(uploadData?.h)
    if (!headerHandle) {
        throw new Error('header_handle missing from upload response')
    }

    return {
        sessionId,
        headerHandle
    }
}

function parseMarketingSendOptions(input: any): {
    options: {
        components?: any[]
        productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
        messageActivitySharing?: boolean
        ttl?: number
        degreesOfFreedomSpec?: Record<string, any>
    }
    errors: string[]
} {
    const errors: string[] = []
    const options: {
        components?: any[]
        productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
        messageActivitySharing?: boolean
        ttl?: number
        degreesOfFreedomSpec?: Record<string, any>
    } = {}

    const components = buildTemplateSendComponents(input)
    if (components) {
        const componentErrors = validateTemplateSendComponents(components)
        componentErrors.forEach((error) => errors.push(error))
        options.components = components
    }

    const productPolicy = parseMarketingProductPolicy(input?.product_policy || input?.productPolicy)
    if ((input?.product_policy || input?.productPolicy) && !productPolicy) {
        errors.push('product_policy must be STRICT or CLOUD_API_FALLBACK')
    }
    if (productPolicy) options.productPolicy = productPolicy

    if (input?.message_activity_sharing !== undefined || input?.messageActivitySharing !== undefined) {
        const rawSharing = input?.message_activity_sharing ?? input?.messageActivitySharing
        if (typeof rawSharing !== 'boolean') {
            errors.push('message_activity_sharing must be boolean')
        } else {
            options.messageActivitySharing = rawSharing
        }
    }

    if (input?.ttl !== undefined) {
        const rawTtl = Number(input.ttl)
        if (!Number.isFinite(rawTtl) || rawTtl <= 0) {
            errors.push('ttl must be a positive number (seconds)')
        } else {
            options.ttl = Math.floor(rawTtl)
        }
    }

    const degrees = input?.degrees_of_freedom_spec ?? input?.degreesOfFreedomSpec
    if (degrees !== undefined) {
        if (!isObject(degrees)) {
            errors.push('degrees_of_freedom_spec must be an object')
        } else {
            options.degreesOfFreedomSpec = degrees
        }
    }

    return { options, errors }
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
    includeScopes?: boolean
}) {
    const base = `https://www.facebook.com/${params.apiVersion}/dialog/oauth`
    const search = new URLSearchParams({
        client_id: params.appId,
        redirect_uri: params.redirectUri,
        response_type: 'code',
        state: params.state
    })
    if (params.includeScopes !== false && params.scopes.length) {
        search.set('scope', params.scopes.join(','))
    }
    if (params.configId) search.set('config_id', params.configId)
    return `${base}?${search.toString()}`
}

function resolveOauthMode(configId?: string | null) {
    const raw = (process.env.WABA_OAUTH_MODE || '').trim().toLowerCase()
    if (raw === 'user' || raw === 'user_token') return 'user'
    if (raw === 'business_integration' || raw === 'business' || raw === 'bisuat') return 'business_integration'
    return configId ? 'business_integration' : 'user'
}

registerFlowRoutes(app, {
    supabase,
    getCompanyIdForProfile,
    parseDateInput,
    toDayKey,
    lowerBound,
    WINDOW_MS
})

registerPublicAuthRoutes(app, { supabase })

// ============================================
// API KEY AUTHENTICATION MIDDLEWARE
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================
const apiKeyStore = createApiKeyStore(resolvePath('api_keys.json'))
const verifyApiKey = apiKeyStore.middleware

const webhookStore = createWebhookStore(resolvePath('webhooks.json'))

// ============================================
// PUBLIC API ENDPOINTS
// ============================================

// Send text message
app.post('/api/send-message', verifyApiKey, async (req: any, res: any) => {
    try {
        const { phone, message, mediaType, mediaUrl, filename } = req.body
        const profileId = req.apiKeyInfo.profileId

        const cleanMessage = typeof message === 'string' ? message.trim() : ''
        const cleanMediaType = typeof mediaType === 'string' ? mediaType.toLowerCase().trim() : ''
        const cleanMediaUrl = typeof mediaUrl === 'string' ? mediaUrl.trim() : ''
        const cleanFilename = typeof filename === 'string' ? filename.trim() : ''
        const normalizedMedia =
            (cleanMediaType === 'image' || cleanMediaType === 'video' || cleanMediaType === 'document') && cleanMediaUrl
                ? {
                    type: cleanMediaType,
                    link: cleanMediaUrl,
                    ...(cleanMediaType === 'document' && cleanFilename ? { filename: cleanFilename } : {})
                }
                : null

        if (!phone || (!cleanMessage && !normalizedMedia)) {
            return res.status(400).json({
                success: false,
                error: 'Phone and message or media are required'
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
            content: {
                text: cleanMessage,
                ...(normalizedMedia ? { media: normalizedMedia } : {})
            }
        })

        res.json({
            success: true,
            data: {
                messageId: messageId || Date.now().toString(),
                phone: jid,
                message: cleanMessage,
                ...(normalizedMedia ? { media: normalizedMedia } : {}),
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
        const status = error?.message?.includes('Outside 24h') ? 400 : 500
        res.status(status).json({
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
registerWabaRoutes(app, {
    assertProfileCompany,
    buildEmbeddedSignupUrl,
    buildTemplateSendComponents,
    createSystemUserToken,
    createTemplateMediaHeaderHandle,
    decryptToken,
    encryptToken,
    exchangeCodeForToken,
    exchangeForLongLivedToken,
    fetchBusinessIntegrationSystemUserToken,
    fetchBusinesses,
    fetchClientBusinessId,
    fetchClientWabaAccounts,
    fetchOwnedWabaAccounts,
    fetchPhoneNumbers,
    findConflictingActivePhoneNumberConfig,
    findOrCreateUser,
    getCompanyIdForProfile,
    getSupabaseUserFromRequest,
    getTokenEncryptionKey,
    getUserCompanyId,
    hashOAuthState,
    insertMessage,
    isAdminUser,
    normalizePhoneNumber,
    parseAuthenticationCode,
    parseAuthenticationPreviewOptions,
    parseMarketingSendOptions,
    randomBytes,
    readTrimmed,
    resolveOauthMode,
    resolveOauthRedirectUri,
    resolveOauthReturnUrl,
    resolveProfileAccess,
    sendWhatsAppMessage,
    subscribeWabaApp,
    supabase,
    unsubscribeWabaApp,
    validateAuthenticationTemplateInput,
    validateAuthenticationUpsertInput,
    validateMarketingTemplateInput,
    validateTemplateSendComponents,
    validateUtilityTemplateInput,
    wabaRegistry,
    WABA_OAUTH_SCOPES
})

const requireSupabaseUserMiddleware = requireSupabaseUser(getSupabaseUserFromRequest)

registerCompanyRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveProfileAccess,
    resolveCompanyAccess,
    supabase,
    normalizeTeamRole,
    normalizeTeamDepartment,
    normalizeTeamCustomDepartment,
    computeAgentColor,
    deriveAgentName,
    readTrimmed
})

registerInvoiceRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveCompanyAccess,
    supabase
})

registerAiRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveProfileAccess,
    readTrimmed,
    supabase,
    encryptToken,
    decryptToken,
    getTokenEncryptionKey
})

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

    webhookStore.set(profileId, {
        url,
        events: events || ['message', 'status']
    })

    res.json({
        success: true,
        data: {
            profileId,
            webhook: webhookStore.get(profileId)
        }
    })
})

// Get webhook config
app.get('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    res.json({
        success: true,
        data: webhookStore.get(profileId)
    })
})

// Delete webhook
app.delete('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    webhookStore.remove(profileId)
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
    apiKeyStore.set(apiKey, { profileId, name })

    res.json({ success: true, data: { apiKey, profileId, name } })
})

app.get('/api/admin/api-keys', (req: any, res: any) => {
    const { adminPassword } = req.query

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, error: 'Invalid admin password' })
    }

    res.json({ success: true, data: apiKeyStore.getAll() })
})

function isWabaAdminUser(user: any): boolean {
    const userMeta = user?.user_metadata || {}
    const appMeta = user?.app_metadata || {}
    const candidates = [
        userMeta.waba_admin,
        userMeta.is_waba_admin,
        appMeta.waba_admin,
        appMeta.is_waba_admin,
        appMeta.role
    ]
    return candidates.some((value) => {
        if (value === true) return true
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase()
            return normalized === 'true' || normalized === 'waba_admin' || normalized === 'super_admin'
        }
        return false
    })
}

function extractAdminEmail(req: any): string {
    const bodyEmail = req.body?.email ?? req.body?.adminId
    const queryEmail = req.query?.email ?? req.query?.adminId
    const headerEmail = req.headers?.['x-admin-email']
    if (Array.isArray(bodyEmail) && bodyEmail.length > 0) return String(bodyEmail[0] || '').trim().toLowerCase()
    if (typeof bodyEmail === 'string') return bodyEmail.trim().toLowerCase()
    if (Array.isArray(queryEmail) && queryEmail.length > 0) return String(queryEmail[0] || '').trim().toLowerCase()
    if (typeof queryEmail === 'string') return queryEmail.trim().toLowerCase()
    if (Array.isArray(headerEmail) && headerEmail.length > 0) return String(headerEmail[0] || '').trim().toLowerCase()
    if (typeof headerEmail === 'string') return headerEmail.trim().toLowerCase()
    return ''
}

function extractAdminPassword(req: any): string {
    const bodyPassword = req.body?.password ?? req.body?.adminPassword
    const queryPassword = req.query?.password ?? req.query?.adminPassword
    const headerPassword = req.headers?.['x-admin-password']
    if (Array.isArray(bodyPassword) && bodyPassword.length > 0) return String(bodyPassword[0] || '')
    if (typeof bodyPassword === 'string') return bodyPassword
    if (Array.isArray(queryPassword) && queryPassword.length > 0) return String(queryPassword[0] || '')
    if (typeof queryPassword === 'string') return queryPassword
    if (Array.isArray(headerPassword) && headerPassword.length > 0) return String(headerPassword[0] || '')
    if (typeof headerPassword === 'string') return headerPassword
    return ''
}

function extractBearerToken(req: any): string {
    const rawAuth = req.headers?.authorization
    if (!rawAuth || typeof rawAuth !== 'string') return ''
    if (rawAuth.startsWith('Bearer ')) return rawAuth.slice(7).trim()
    return rawAuth.trim()
}

async function countWabaAdminUsers(): Promise<number> {
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
    if (!hasServiceRole) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for WABA admin setup')
    }

    let page = 1
    const perPage = 200
    let count = 0

    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
        if (error) {
            throw new Error(error.message)
        }

        const users = Array.isArray(data?.users) ? data.users : []
        users.forEach((user: any) => {
            if (isWabaAdminUser(user)) count += 1
        })

        if (users.length < perPage || page >= 50) break
        page += 1
    }

    return count
}

async function resolveWabaAdminAccess(req: any, res: any) {
    const token = extractBearerToken(req)
    if (!token) {
        res.status(401).json({ success: false, error: 'Authorization token required' })
        return null
    }

    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) {
        res.status(401).json({ success: false, error: 'Invalid or expired session' })
        return null
    }

    if (!isWabaAdminUser(user)) {
        res.status(403).json({ success: false, error: 'WABA admin access required' })
        return null
    }

    return { user, token }
}

async function buildAdminSummaryPayload() {
    const { data: companies, error } = await supabase
        .from('company')
        .select('*')
        .order('created_at', { ascending: false })

    if (error) {
        throw new Error(error.message)
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

    return { totals, companies: companyStats }
}

// ============================================
// MYADMIN (Super Admin Monitor)
// ============================================
app.get('/api/admin/setup-status', async (_req: any, res: any) => {
    try {
        const admins = await countWabaAdminUsers()
        return res.json({
            success: true,
            data: {
                setupOpen: admins === 0,
                admins
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load setup status' })
    }
})

app.post('/api/admin/setup', async (req: any, res: any) => {
    try {
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to create WABA admin' })
        }

        const email = extractAdminEmail(req)
        const password = extractAdminPassword(req)
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' })
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
        }

        const admins = await countWabaAdminUsers()
        if (admins > 0) {
            return res.status(409).json({ success: false, error: 'Setup is already closed. WABA admin already exists.' })
        }

        const created = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                waba_admin: true
            }
        } as any)

        if (created.error || !created.data?.user?.id) {
            const message = created.error?.message || 'Failed to create WABA admin'
            const isConflict = /already|exists|registered/i.test(message)
            return res.status(isConflict ? 409 : 500).json({ success: false, error: message })
        }

        return res.json({
            success: true,
            data: {
                userId: created.data.user.id,
                email
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to create WABA admin' })
    }
})

app.post('/api/admin/login', async (req: any, res: any) => {
    try {
        const email = extractAdminEmail(req)
        const password = extractAdminPassword(req)
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' })
        }

        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error || !data?.user || !data?.session) {
            return res.status(401).json({ success: false, error: error?.message || 'Invalid email or password' })
        }

        if (!isWabaAdminUser(data.user)) {
            return res.status(403).json({ success: false, error: 'WABA admin access required' })
        }

        return res.json({
            success: true,
            data: {
                email: data.user.email || email,
                accessToken: data.session.access_token,
                refreshToken: data.session.refresh_token,
                expiresAt: data.session.expires_at || null
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Login failed' })
    }
})

app.get('/api/admin/summary', async (req: any, res: any) => {
    try {
        const access = await resolveWabaAdminAccess(req, res)
        if (!access) return
        const payload = await buildAdminSummaryPayload()
        return res.json({ success: true, ...payload })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load admin summary' })
    }
})

// Backward-compatible JSON endpoint
app.get('/my', async (req: any, res: any) => {
    try {
        const access = await resolveWabaAdminAccess(req, res)
        if (!access) return
        const payload = await buildAdminSummaryPayload()
        return res.json({ success: true, ...payload })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load admin summary' })
    }
})

function escapeHtml(value: string) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderPublicInfoPage(payload: {
    title: string
    subtitle: string
    paragraphs: string[]
}) {
    const paragraphs = payload.paragraphs
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('')
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.title)} · 2fast</title>
  <style>
    :root { --bg:#f5f7f8; --card:#fff; --line:#d9e2e6; --text:#111b21; --muted:#54656f; --brand:#00a884; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width: 900px; margin: 0 auto; padding: 28px 18px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    .sub { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
    p { color: #1f2937; line-height: 1.65; margin: 0 0 12px; font-size: 15px; }
    a { color: #0f766e; text-decoration: none; font-weight: 700; }
    a:hover { text-decoration: underline; }
    .nav { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
    .pill { background: #eef6f4; border: 1px solid #d3e8e3; border-radius: 999px; padding: 7px 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(payload.title)}</h1>
      <p class="sub">${escapeHtml(payload.subtitle)}</p>
      ${paragraphs}
      <div class="nav">
        <a class="pill" href="/support">Support</a>
        <a class="pill" href="/privacy-policy">Privacy Policy</a>
        <a class="pill" href="/terms-and-conditions">Terms & Conditions</a>
        <a class="pill" href="/">Back to Login</a>
      </div>
    </div>
  </div>
</body>
</html>`
}

registerPublicInfoRoutes(app, { renderPublicInfoPage })

app.get('/myadmin', (_req: any, res: any) => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyAdmin Company Monitor</title>
  <style>
    :root { --bg:#f4f7f8; --card:#ffffff; --line:#d9e2e6; --text:#111b21; --muted:#54656f; --brand:#00a884; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
    .login { max-width: 440px; margin: 80px auto; padding: 20px; display: grid; gap: 10px; }
    .panel-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 16px; margin-bottom: 16px; }
    .inline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    input, button { font: inherit; }
    input { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
    .btn-primary { background: var(--brand); color: #fff; }
    .btn-secondary { background: #eaf4f2; color: #0b6f59; }
    .status { padding: 12px 16px; margin-bottom: 16px; color: var(--muted); }
    .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 16px; margin-bottom: 16px; }
    .metric { padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #fcfdfd; }
    .metric b { display: block; font-size: 20px; margin-top: 4px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; white-space: nowrap; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .mono { font-family: Menlo, Consolas, monospace; }
    .right { text-align: right; }
    .hidden { display: none; }
    .title { margin: 0; font-size: 18px; font-weight: 700; }
    .hint { color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="loginPanel" class="card login">
      <h1 class="title">MyAdmin Login</h1>
      <div class="hint">Use WABA admin credentials to monitor all companies.</div>
      <input id="adminIdInput" type="email" placeholder="Admin email" />
      <input id="adminPasswordInput" type="password" placeholder="Password" />
      <button id="setupBtn" class="btn-secondary hidden">Create First WABA Admin</button>
      <button id="loginBtn" class="btn-primary">Login</button>
      <div id="loginStatus" class="hint"></div>
    </div>

    <div id="monitorPanel" class="hidden">
      <div class="card panel-head">
        <div class="inline">
          <h2 class="title">MyAdmin Company Monitor</h2>
          <span id="adminBadge" class="hint"></span>
        </div>
        <div class="inline">
          <button id="refreshBtn" class="btn-primary">Refresh</button>
          <button id="logoutBtn" class="btn-secondary">Logout</button>
        </div>
      </div>

      <div id="status" class="card status">Ready.</div>
      <div id="totals" class="card totals" style="display:none"></div>

      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Company ID</th>
              <th>Name</th>
              <th>Email</th>
              <th class="right">Profiles</th>
              <th class="right">Contacts</th>
              <th class="right">Workflows</th>
              <th class="right">WABA</th>
              <th class="right">WABA On</th>
              <th class="right">Messages</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="companyRows"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const STORAGE_KEY_EMAIL = 'myadmin_email';
    const STORAGE_KEY_TOKEN = 'myadmin_token';

    const loginPanel = document.getElementById('loginPanel');
    const monitorPanel = document.getElementById('monitorPanel');
    const adminEmailInput = document.getElementById('adminIdInput');
    const adminPasswordInput = document.getElementById('adminPasswordInput');
    const setupBtn = document.getElementById('setupBtn');
    const loginBtn = document.getElementById('loginBtn');
    const loginStatus = document.getElementById('loginStatus');
    const adminBadge = document.getElementById('adminBadge');
    const refreshBtn = document.getElementById('refreshBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const statusEl = document.getElementById('status');
    const totalsEl = document.getElementById('totals');
    const rowsEl = document.getElementById('companyRows');

    function setStatus(message, isError) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? '#b42318' : '#54656f';
    }

    function showLogin(message, isError) {
      loginPanel.classList.remove('hidden');
      monitorPanel.classList.add('hidden');
      loginStatus.textContent = message || '';
      loginStatus.style.color = isError ? '#b42318' : '#54656f';
    }

    function showMonitor(adminEmail) {
      adminBadge.textContent = adminEmail ? 'Signed in as ' + adminEmail : '';
      loginPanel.classList.add('hidden');
      monitorPanel.classList.remove('hidden');
      loginStatus.textContent = '';
    }

    function readStoredCreds() {
      return {
        email: sessionStorage.getItem(STORAGE_KEY_EMAIL) || '',
        token: sessionStorage.getItem(STORAGE_KEY_TOKEN) || ''
      };
    }

    function saveCreds(email, token) {
      sessionStorage.setItem(STORAGE_KEY_EMAIL, email);
      sessionStorage.setItem(STORAGE_KEY_TOKEN, token);
    }

    function clearCreds() {
      sessionStorage.removeItem(STORAGE_KEY_EMAIL);
      sessionStorage.removeItem(STORAGE_KEY_TOKEN);
    }

    async function fetchSetupStatus() {
      const res = await fetch('/api/admin/setup-status');
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to load setup status');
      }
      return data.data || { setupOpen: false, admins: 0 };
    }

    async function createFirstAdmin(email, password) {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to create WABA admin');
      }
      return data;
    }

    async function login(email, password) {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Login failed');
      }
      return data.data || {};
    }

    function renderTotals(totals) {
      totalsEl.innerHTML = '';
      totalsEl.style.display = 'grid';
      const keys = ['companies', 'profiles', 'contacts', 'workflows', 'waba_configs', 'waba_enabled', 'messages'];
      keys.forEach(function(key) {
        const box = document.createElement('div');
        box.className = 'metric';
        const label = document.createElement('span');
        label.textContent = key.replace('_', ' ');
        const value = document.createElement('b');
        value.textContent = String(totals[key] || 0);
        box.appendChild(label);
        box.appendChild(value);
        totalsEl.appendChild(box);
      });
    }

    function renderRows(companies) {
      rowsEl.innerHTML = '';
      companies.forEach(function(company) {
        const tr = document.createElement('tr');
        const values = [
          { v: company.id, mono: true },
          { v: company.name || '-' },
          { v: company.email || '-' },
          { v: company.counts && company.counts.profiles, right: true },
          { v: company.counts && company.counts.contacts, right: true },
          { v: company.counts && company.counts.workflows, right: true },
          { v: company.counts && company.counts.waba_configs, right: true },
          { v: company.counts && company.counts.waba_enabled, right: true },
          { v: company.counts && company.counts.messages, right: true },
          { v: company.created_at ? new Date(company.created_at).toLocaleString() : '-' }
        ];
        values.forEach(function(item) {
          const td = document.createElement('td');
          td.textContent = item.v == null ? '-' : String(item.v);
          if (item.mono) td.className = 'mono';
          if (item.right) td.className = (td.className ? td.className + ' ' : '') + 'right';
          tr.appendChild(td);
        });
        rowsEl.appendChild(tr);
      });
    }

    async function loadSummary() {
      const creds = readStoredCreds();
      if (!creds.token) {
        showLogin('Please login first.', true);
        return;
      }
      setStatus('Loading company monitor...', false);
      refreshBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/summary', {
          headers: {
            'Authorization': 'Bearer ' + creds.token
          }
        });
        const data = await res.json().catch(function() { return null; });
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'Failed to load admin summary');
        }
        renderTotals(data.totals || {});
        renderRows(Array.isArray(data.companies) ? data.companies : []);
        setStatus('Loaded ' + String((data.totals && data.totals.companies) || 0) + ' companies.', false);
      } catch (err) {
        clearCreds();
        showLogin(err && err.message ? err.message : 'Session expired. Please login again.', true);
      } finally {
        refreshBtn.disabled = false;
      }
    }

    async function refreshSetupControls() {
      try {
        const setup = await fetchSetupStatus();
        if (setup.setupOpen) {
          setupBtn.classList.remove('hidden');
          if (!loginStatus.textContent) {
            showLogin('Setup is open. Create the first WABA admin account.', false);
          }
        } else {
          setupBtn.classList.add('hidden');
        }
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Failed to load setup status.', true);
      }
    }

    loginBtn.addEventListener('click', async function() {
      const email = (adminEmailInput.value || '').trim().toLowerCase();
      const password = adminPasswordInput.value || '';
      if (!email || !password) {
        showLogin('Enter admin email and password.', true);
        return;
      }
      loginBtn.disabled = true;
      try {
        const data = await login(email, password);
        if (!data.accessToken) throw new Error('Missing access token');
        saveCreds(data.email || email, data.accessToken);
        showMonitor(data.email || email);
        await loadSummary();
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Login failed.', true);
      } finally {
        loginBtn.disabled = false;
      }
    });

    setupBtn.addEventListener('click', async function() {
      const email = (adminEmailInput.value || '').trim().toLowerCase();
      const password = adminPasswordInput.value || '';
      if (!email || !password) {
        showLogin('Enter admin email and password first.', true);
        return;
      }
      setupBtn.disabled = true;
      try {
        await createFirstAdmin(email, password);
        const data = await login(email, password);
        if (!data.accessToken) throw new Error('Missing access token');
        saveCreds(data.email || email, data.accessToken);
        showMonitor(data.email || email);
        await loadSummary();
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Failed to create admin.', true);
      } finally {
        setupBtn.disabled = false;
        await refreshSetupControls();
      }
    });

    adminPasswordInput.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') loginBtn.click();
    });

    refreshBtn.addEventListener('click', loadSummary);
    logoutBtn.addEventListener('click', function() {
      clearCreds();
      totalsEl.style.display = 'none';
      totalsEl.innerHTML = '';
      rowsEl.innerHTML = '';
      adminPasswordInput.value = '';
      showLogin('Logged out.', false);
    });

    async function init() {
      await refreshSetupControls();
      const stored = readStoredCreds();
      if (stored.email && stored.token) {
        adminEmailInput.value = stored.email;
        showMonitor(stored.email);
        await loadSummary();
      } else {
        showLogin('', false);
      }
    }

    init();
  </script>
</body>
</html>`

    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.send(html)
})

const getClient = async (profileId: string) => wabaRegistry.getClientByProfile(profileId)
app.use(
    '/addon',
    addon.createAddonRouter(
        getClient,
        getCompanyIdForProfile,
        workflowEngine,
        verifyApiKey,
        { resolveProfileAccess }
    )
)

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
            mediaId: content.media_id,
            url: content.image_url || content.payload?.media?.link || content.payload?.image_url
        }
    } else if (type === 'document') {
        message.documentMessage = {
            caption: content.caption,
            fileName: content.filename || content.payload?.media?.filename,
            fileLength: content.file_size,
            mediaId: content.media_id,
            mimetype: content.mimetype || content.payload?.mimetype,
            url: content.document_url || content.payload?.media?.link || content.payload?.document_url
        }
    } else if (type === 'audio') {
        message.audioMessage = {
            mediaId: content.media_id
        }
    } else if (type === 'video') {
        message.videoMessage = {
            caption: content.caption,
            mediaId: content.media_id,
            url: content.video_url || content.payload?.media?.link || content.payload?.video_url
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
        message,
        agent: content.agent || content.payload?.agent || null,
        workflowState: record.workflow_state || null
    }
}

function isAiAutoReplyInboundType(type: string) {
    const normalized = (type || '').toLowerCase()
    return normalized === 'text' || normalized === 'interactive' || normalized === 'button' || normalized === 'request_welcome'
}

function decryptAiApiKey(storedValue: string | null | undefined): string {
    if (!storedValue) return ''
    if (!storedValue.startsWith('enc:v1:')) return storedValue
    try {
        return decryptToken(storedValue)
    } catch {
        return ''
    }
}

async function maybeSendAutoAiReply(params: {
    companyId: string
    profileId: string
    client: any
    user: WaStoreUser | null
    phoneNumber: string
    inboundType: string
    inboundText: string
    workflowHandled: boolean
}): Promise<{ sent: boolean; reason?: string }> {
    if (params.workflowHandled) return { sent: false, reason: 'workflow_handled' }
    if (!params.user) return { sent: false, reason: 'missing_user' }
    if (hasHumanTakeover(params.user)) return { sent: false, reason: 'human_takeover' }
    if (!isAiAutoReplyInboundType(params.inboundType)) return { sent: false, reason: 'unsupported_inbound_type' }

    const inboundText = (params.inboundText || '').trim()
    if (!inboundText) return { sent: false, reason: 'empty_inbound_text' }

    const settings = await getCompanyAiSettings(supabase, params.companyId)
    if (!settings.enabled) return { sent: false, reason: 'ai_disabled' }

    const apiKey = decryptAiApiKey(settings.api_key)
    if (!apiKey) return { sent: false, reason: 'missing_api_key' }

    const memoryMessages = settings.memory_enabled
        ? await loadOpenAiMemoryForUser(supabase, params.user.id, settings.memory_messages)
        : []

    const promptMessages: OpenAiChatMessage[] = []
    const systemPrompt = (settings.system_prompt || '').trim()
    if (systemPrompt) {
        promptMessages.push({
            role: 'system',
            content: systemPrompt
        })
    }
    promptMessages.push(...memoryMessages)

    const lastMemoryMessage = promptMessages[promptMessages.length - 1]
    const duplicateUserInput =
        lastMemoryMessage?.role === 'user' &&
        typeof lastMemoryMessage.content === 'string' &&
        lastMemoryMessage.content.trim() === inboundText

    if (!duplicateUserInput) {
        promptMessages.push({
            role: 'user',
            content: inboundText
        })
    }

    const completion = await requestOpenAiCompletion({
        apiKey,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        messages: promptMessages,
        timeoutMs: 45000
    })

    const reply = (completion.reply || '').trim()
    if (!reply) {
        return { sent: false, reason: 'empty_ai_reply' }
    }

    await sendWhatsAppMessage({
        client: params.client,
        userId: params.user.id,
        to: params.phoneNumber,
        type: 'text',
        content: {
            text: reply
        },
        workflowState: null
    })

    return { sent: true }
}

async function handleInboundMessage(config: WabaConfig, inbound: WabaInboundMessage) {
    const { syntheticMsg, remoteJid, text } = buildSyntheticMessage(inbound)
    const profileId = config.profileId
    const profileCompanyId = await getCompanyIdForProfile(profileId)
    const companyId = profileCompanyId || await resolveCompanyId(config.companyId || profileId)
    const phoneNumber = remoteJid.replace(/@s\\.whatsapp\\.net$/, '')

    const client = await wabaRegistry.getClientByProfile(profileId)
    if (!client || !companyId) {
        console.warn(`[${profileId}] Missing WABA client or companyId.`)
        return
    }

    const baseUser = await findOrCreateUser(companyId, phoneNumber)
    const humanTakeoverActive = hasHumanTakeover(baseUser)

    const workflowResult = await workflowEngine.processInbound({
        companyId,
        profileId,
        client,
        phoneNumber,
        automationDisabled: humanTakeoverActive,
        messageType: inbound.type,
        text,
        buttonId: inbound.buttonReplyId,
        buttonTitle: inbound.buttonReplyTitle,
        media: inbound.image || inbound.document || inbound.audio || inbound.video,
        raw: inbound.raw
    })

    const user = (await getUserByPhone(companyId, phoneNumber)) || baseUser
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
        const room = getCompanyRoom(companyId)
        const { data: companyProfiles } = await supabase
            .from('profiles')
            .select('*')
            .eq('company_id', companyId)
            .order('created_at', { ascending: true })
        io.to(room).emit('profiles.update', companyProfiles || [])
    }

    if (profile && workflowResult?.error) {
        io.to(getCompanyRoom(companyId)).emit('profile.error', { message: `Workflow error: ${workflowResult.error}` })
    }

    if (user) {
        try {
            const aiResult = await maybeSendAutoAiReply({
                companyId,
                profileId,
                client,
                user,
                phoneNumber,
                inboundType: inbound.type,
                inboundText: text || '',
                workflowHandled: Boolean(workflowResult?.handled && workflowResult?.replied)
            })
            if (aiResult.sent) {
                console.log(`[${profileId}] Auto AI reply sent to ${phoneNumber}`)
            } else if (aiResult.reason) {
                console.log(`[${profileId}] Auto AI skipped (${aiResult.reason}) for ${phoneNumber}`)
            }
        } catch (error: any) {
            console.warn(`[${profileId}] Auto AI reply skipped:`, error?.message || error)
        }
    }

    if (profile) {
        const inboundAt = inbound.timestamp ? new Date(Number(inbound.timestamp) * 1000).toISOString() : null
        const contact = user
            ? {
                ...buildContactPayload(user),
                id: remoteJid,
                lastInboundAt: inboundAt
            }
            : {
                id: remoteJid,
                name: inbound.contactName || phoneNumber,
                lastInboundAt: inboundAt,
                tags: [],
                assigneeUserId: null,
                assigneeName: null,
                assigneeColor: null,
                ctaReferralAt: null,
                ctaFreeWindowStartedAt: null,
                ctaFreeWindowExpiresAt: null
            }
        io.to(getCompanyRoom(companyId)).emit('contacts.update', {
            profileId,
            contacts: [contact]
        })
    }

    const buttonReply = inbound.buttonReplyId
        ? {
            id: inbound.buttonReplyId,
            title: inbound.buttonReplyTitle,
            description: inbound.buttonReplyDescription
        }
        : null

    webhookStore.send(profileId, 'message', {
        message: syntheticMsg,
        sender: {
            jid: remoteJid,
            name: inbound.contactName || null
        },
        referral: inbound.referral || null,
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
        referral: inbound.referral || null,
        button_reply: buttonReply,
        interactive: inbound.interactive || null,
        raw: inbound.raw
    })

    if (profile) {
        io.to(getCompanyRoom(companyId)).emit('messages.upsert', { profileId, messages: [syntheticMsg], type: 'notify' })
    }
}

async function handleStatusUpdate(config: WabaConfig, status: WabaStatus) {
    const profileId = config.profileId
    const companyId = await resolveCompanyId(config.companyId || profileId)
    const statusName = status.status
    let eventName: string | null = null

    if (statusName === 'delivered') eventName = 'message_delivered'
    else if (statusName === 'read') eventName = 'message_read'
    else if (statusName === 'sent') eventName = 'message_sent'
    else if (statusName === 'failed') eventName = 'message_failed'

    if (!eventName) return

    const updatedMessage = await updateMessageStatusByMessageId(status.id, statusName)

    if (statusName === 'delivered' && updatedMessage?.content?.cta_entry_candidate) {
        const deliveredAt = status.timestamp
            ? new Date(Number(status.timestamp) * 1000).toISOString()
            : new Date().toISOString()
        await activateUserCtaFreeWindow(updatedMessage.user_id, deliveredAt)
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('id', profileId)
        .maybeSingle()

    if (profile?.user_id && companyId) {
        const room = getCompanyRoom(companyId)
        io.to(room).emit('message.status', {
            profileId,
            messageId: status.id,
            status: statusName
        })

        if (statusName === 'delivered' && updatedMessage?.user_id) {
            const user = await getUserById(updatedMessage.user_id)
            if (user) {
                const contact = buildContactPayload(user)
                io.to(room).emit('contacts.update', {
                    profileId,
                    contacts: [contact]
                })
            }
        }
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

registerSocketHandlers(io, {
    supabase,
    getHostnameFromHeaders,
    resolveCompanyIdFromHostname,
    normalizeCompanyId,
    getUserCompanyId,
    ensureUserCompanyId,
    getCompanyRoom,
    lastServerStats,
    ensureCompanyRecord,
    wabaRegistry,
    getCompanyIdForProfile,
    getUsersForCompany,
    buildContactPayload,
    getMessagesForUsers,
    normalizePhoneNumber,
    recordToSyntheticMessage,
    findOrCreateUser,
    updateUserName,
    setUserTags,
    setUserHumanTakeover,
    getUserByPhone,
    readTrimmed,
    deriveAgentName,
    computeAgentColor,
    setUserAssignee,
    fs,
    resolvePath,
    assignUserToAgentIfUnassigned,
    buildAgentIdentity,
    sendWhatsAppMessage,
    workflowEngine,
    resolveCompanyId,
    hasRoleAtLeast,
    normalizeTeamRole,
    deleteMessagesForUser
})

app.use(errorHandler)

// Serve Frontend (Deployment Support)
const frontendPath = path.join(process.cwd(), 'dashboard/dist')
if (fs.existsSync(frontendPath)) {
    console.log('Serving frontend from:', frontendPath)
    const assetsPath = path.join(frontendPath, 'assets')
    if (fs.existsSync(assetsPath)) {
        app.use('/assets', express.static(assetsPath, {
            fallthrough: false,
            immutable: true,
            maxAge: '1y'
        }))
    }
    app.use(express.static(frontendPath, {
        index: false,
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache')
            }
        }
    }))
    // Express 5 + path-to-regexp v6: use regex fallback instead of '*' patterns.
    // Do not fallback requests that look like static files (e.g. *.js, *.css).
    app.get(/^(?!\/api|\/addon|\/socket\.io|\/assets\/).*/, (req: any, res: any) => {
        if (path.extname(req.path || '')) {
            return res.status(404).send('Not Found')
        }
        res.setHeader('Cache-Control', 'no-cache')
        res.sendFile(path.join(frontendPath, 'index.html'))
    })
}

const PORT = Number(process.env.PORT || 3000)
httpServer.listen(PORT, async () => {
    console.log(`Dashboard Server listening on port ${PORT}`)

    const activeProfiles = await wabaRegistry.getProfileIds()
    console.log(`[WABA] Loaded configs for ${activeProfiles.length} profile(s).`)
})
