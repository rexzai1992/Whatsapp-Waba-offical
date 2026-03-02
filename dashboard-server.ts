
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
import { resolveCompanyId, findOrCreateUser, getMessagesForUsers, getUsersForCompany, insertMessage, getUserByPhone, deleteMessagesForUser, normalizePhoneNumber, updateMessageStatusByMessageId, updateUserName, setUserTags, getUsersWithExpiringWindow, updateUserWindowReminder, activateUserCtaFreeWindow, getUserById, assignUserToAgentIfUnassigned, setUserAssignee } from './src/services/wa-store'
import type { MessageRecord } from './src/services/wa-store'
import { sendWhatsAppMessage, canReplyFreely } from './src/services/whatsapp'
import { WorkflowEngine } from './src/workflow/engine'
import { encryptToken, decryptToken, getTokenEncryptionKey } from './src/services/token-vault'
import { exchangeCodeForToken, exchangeForLongLivedToken, fetchBusinesses, fetchOwnedWabaAccounts, fetchClientWabaAccounts, fetchPhoneNumbers, subscribeWabaApp, createSystemUserToken, unsubscribeWabaApp, fetchClientBusinessId, fetchBusinessIntegrationSystemUserToken } from './src/services/meta-graph'

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
    const user = await getSupabaseUserFromRequest(req, res)
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
    const user = await getSupabaseUserFromRequest(req, res)
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
    if (category !== 'marketing') {
        errors.push('category must be marketing')
    }

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

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
    const bodyText = bodyComponent ? readTrimmed(bodyComponent.text) : ''
    const bodyNamedVars = bodyText ? extractNamedVars(bodyText) : []
    const bodyPositionalVars = bodyText ? extractPositionalVars(bodyText) : []
    let normalizedBodyNamedExamples: Array<{ param_name: string; example: string }> = []
    let normalizedBodyPositionalExamples: string[] = []

    if (bodyComponent) {
        if (!bodyText) {
            errors.push('BODY.text is required')
        } else {
            if (bodyText.length > 1024) errors.push('BODY.text must be <= 1024 characters')
            if (bodyNamedVars.length > 0 && bodyPositionalVars.length > 0) {
                errors.push('BODY cannot mix named and positional variables')
            }

            bodyPositionalVars.forEach((value, index) => {
                const expected = index + 1
                if (value !== expected) errors.push('BODY positional variables must be sequential like {{1}}, {{2}}, {{3}}')
            })

            bodyNamedVars.forEach((name) => {
                if (!MARKETING_NAMED_PARAM_REGEX.test(name)) {
                    errors.push(`BODY named variable "${name}" must use lowercase letters, numbers, and underscores`)
                }
            })

            if (parameterFormat === 'named' && bodyPositionalVars.length > 0) {
                errors.push('BODY uses positional variables but parameter_format is named')
            }
            if (parameterFormat === 'positional' && bodyNamedVars.length > 0) {
                errors.push('BODY uses named variables but parameter_format is positional')
            }

            const bodyExample = isObject(bodyComponent.example) ? bodyComponent.example : null
            if (parameterFormat === 'named' && bodyNamedVars.length > 0) {
                const rawNamedExamples = Array.isArray(bodyExample?.body_text_named_params) ? bodyExample?.body_text_named_params : []
                if (rawNamedExamples.length === 0) {
                    errors.push('BODY.example.body_text_named_params is required for named variables')
                }

                const seenNames = new Set<string>()
                rawNamedExamples.forEach((entry: any, index: number) => {
                    if (!isObject(entry)) {
                        errors.push(`BODY.example.body_text_named_params[${index}] must be an object`)
                        return
                    }

                    const rawParam = readTrimmed(entry.param_name)
                    const unwrapped = rawParam.replace(/^{{\s*|\s*}}$/g, '')
                    if (!unwrapped) {
                        errors.push(`BODY.example.body_text_named_params[${index}].param_name is required`)
                        return
                    }
                    if (!MARKETING_NAMED_PARAM_REGEX.test(unwrapped)) {
                        errors.push(`BODY.example.body_text_named_params[${index}].param_name must use lowercase letters, numbers, and underscores`)
                        return
                    }
                    if (seenNames.has(unwrapped)) {
                        errors.push(`BODY.example.body_text_named_params duplicate param_name: ${unwrapped}`)
                        return
                    }

                    const exampleValue = readTrimmed(entry.example)
                    if (!exampleValue) {
                        errors.push(`BODY.example.body_text_named_params[${index}].example is required`)
                        return
                    }

                    seenNames.add(unwrapped)
                    normalizedBodyNamedExamples.push({
                        param_name: unwrapped,
                        example: exampleValue
                    })
                })

                bodyNamedVars.forEach((name) => {
                    if (!seenNames.has(name)) {
                        errors.push(`BODY.example.body_text_named_params missing example for ${name}`)
                    }
                })
            }

            if (parameterFormat === 'positional' && bodyPositionalVars.length > 0) {
                const rows = Array.isArray(bodyExample?.body_text) ? bodyExample?.body_text : []
                const firstRow = Array.isArray(rows[0]) ? rows[0] : []
                if (firstRow.length === 0) {
                    errors.push('BODY.example.body_text[0] is required for positional variables')
                }
                normalizedBodyPositionalExamples = firstRow
                    .map((value: any) => readTrimmed(value))
                    .filter(Boolean)

                if (normalizedBodyPositionalExamples.length < bodyPositionalVars.length) {
                    errors.push(`BODY example count (${normalizedBodyPositionalExamples.length}) is less than positional variable count (${bodyPositionalVars.length})`)
                }
            }
        }
    }

    const headerComponent = headerComponents[0]
    const normalizedMarketingComponents: any[] = []

    if (headerComponent) {
        const format = readTrimmed(headerComponent.format).toUpperCase()
        const allowedFormats = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'])
        if (!format || !allowedFormats.has(format)) {
            errors.push('HEADER.format must be one of text, image, video, document, location')
        } else if (format === 'TEXT') {
            const text = readTrimmed(headerComponent.text)
            if (!text) errors.push('HEADER.text is required when HEADER.format is text')
            if (text.length > 60) errors.push('HEADER.text must be <= 60 characters')
            normalizedMarketingComponents.push({
                type: 'header',
                format: 'text',
                text
            })
        } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
            const handle = extractHeaderHandle(headerComponent)
            if (!handle) {
                errors.push(`HEADER.format ${format.toLowerCase()} requires example.header_handle`)
            }
            normalizedMarketingComponents.push({
                type: 'header',
                format: format.toLowerCase(),
                example: {
                    header_handle: handle ? [handle] : []
                }
            })
        } else {
            normalizedMarketingComponents.push({
                type: 'header',
                format: 'location'
            })
        }
    }

    if (bodyComponent) {
        const normalizedBody: any = {
            type: 'body',
            text: bodyText
        }

        if (parameterFormat === 'named' && bodyNamedVars.length > 0) {
            if (normalizedBodyNamedExamples.length > 0) {
                normalizedBody.example = {
                    body_text_named_params: normalizedBodyNamedExamples
                }
            }
        } else if (parameterFormat === 'positional' && bodyPositionalVars.length > 0) {
            if (normalizedBodyPositionalExamples.length > 0) {
                normalizedBody.example = {
                    body_text: [normalizedBodyPositionalExamples]
                }
            }
        }

        normalizedMarketingComponents.push(normalizedBody)
    }

    const footerComponent = footerComponents[0]
    if (footerComponent) {
        const footerText = readTrimmed(footerComponent.text)
        if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
        if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
        normalizedMarketingComponents.push({
            type: 'footer',
            text: footerText
        })
    }

    const buttonsComponent = buttonComponents[0]
    if (buttonsComponent) {
        const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : []
        if (buttons.length === 0) errors.push('BUTTONS.buttons must contain at least one button')
        if (buttons.length > 10) errors.push('BUTTONS supports up to 10 buttons')

        const normalizedButtons: any[] = []
        buttons.forEach((button: any, index: number) => {
            if (!isObject(button)) {
                errors.push(`BUTTONS.buttons[${index}] must be an object`)
                return
            }

            const rawType = readTrimmed(button.type)
            const type = rawType.toLowerCase().replace(/-/g, '_')
            if (!type) {
                errors.push(`BUTTONS.buttons[${index}].type is required`)
                return
            }

            const text = readTrimmed(button.text || button.title)
            if (text.length > 25) {
                errors.push(`BUTTONS.buttons[${index}] label must be <= 25 characters`)
            }

            if (type === 'url' || type === 'phone_number' || type === 'quick_reply') {
                if (!text) {
                    errors.push(`BUTTONS.buttons[${index}] label is required`)
                }
            }

            const nextButton: any = {
                type
            }
            if (text) nextButton.text = text

            if (type === 'url') {
                const url = readTrimmed(button.url)
                if (!url) errors.push(`BUTTONS.buttons[${index}].url is required`)
                nextButton.url = url
            }

            if (type === 'phone_number') {
                const phone = readTrimmed(button.phone_number || button.phoneNumber)
                if (!phone) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number is required`)
                } else if (phone.length > 20) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number must be <= 20 characters`)
                }
                nextButton.phone_number = phone
            }

            normalizedButtons.push(nextButton)
        })

        if (normalizedButtons.length > 0) {
            normalizedMarketingComponents.push({
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
            parameter_format: parameterFormat,
            components: normalizedMarketingComponents
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

function parseMarketingProductPolicy(value: any): 'STRICT' | 'CLOUD_API_FALLBACK' | undefined {
    const normalized = readTrimmed(value).toUpperCase()
    if (!normalized) return undefined
    if (normalized === 'STRICT' || normalized === 'CLOUD_API_FALLBACK') return normalized
    return undefined
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
    if (components) options.components = components

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

app.get('/health', (req: any, res: any) => {
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
    return {}
}

function saveApiKeys(keys: any) {
    fs.writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2))
}

let apiKeys = loadApiKeys()

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
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const client = await wabaRegistry.getClientByProfile(access.profileId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const client = await wabaRegistry.getClientByProfile(access.profileId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('waba_configs')
            .select('window_reminder_enabled, window_reminder_minutes, window_reminder_text')
            .eq('profile_id', access.profileId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data: existing, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id')
            .eq('profile_id', access.profileId)
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
            .eq('profile_id', access.profileId)

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
        const oauthMode = resolveOauthMode(configId)
        const includeScopes = oauthMode === 'user'

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
            configId: configId || undefined,
            includeScopes
        })

        res.json({ success: true, url })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Manual WABA setup (admin-only fallback before Embedded Signup permissions)
app.post('/api/waba/manual-config', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : ''
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const wabaId = typeof req.body?.wabaId === 'string' ? req.body.wabaId.trim() : ''
        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId.trim() : ''
        const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : ''
        const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : null
        const verifyToken = (typeof req.body?.verifyToken === 'string' ? req.body.verifyToken.trim() : '') || (process.env.WABA_VERIFY_TOKEN || '')
        const appId = (typeof req.body?.appId === 'string' ? req.body.appId.trim() : '') || (process.env.WABA_APP_ID || '')
        const appSecret = (typeof req.body?.appSecret === 'string' ? req.body.appSecret.trim() : '') || (process.env.WABA_APP_SECRET || '')
        const apiVersion = (typeof req.body?.apiVersion === 'string' ? req.body.apiVersion.trim() : '') || (process.env.WABA_API_VERSION || 'v19.0')

        if (!wabaId || !phoneNumberId || !accessToken) {
            return res.status(400).json({ success: false, error: 'wabaId, phoneNumberId, and accessToken are required' })
        }

        const phoneConfigConflict = await findConflictingActivePhoneNumberConfig(phoneNumberId, profileId)
        if (phoneConfigConflict) {
            return res.status(409).json({
                success: false,
                error: `phoneNumberId "${phoneNumberId}" is already connected to profile "${phoneConfigConflict.profileId}". Disconnect it first.`
            })
        }

        if (!verifyToken) {
            return res.status(400).json({ success: false, error: 'verifyToken is required (or set WABA_VERIFY_TOKEN)' })
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).json({ success: false, error: 'Missing WABA_TOKEN_ENCRYPTION_KEY' })
        }

        const nowIso = new Date().toISOString()
        const payload: any = {
            profile_id: profileId,
            company_id: companyId,
            app_id: appId || null,
            phone_number_id: phoneNumberId,
            business_id: businessId || null,
            waba_id: wabaId,
            business_account_id: wabaId,
            access_token: encryptToken(accessToken),
            access_token_type: null,
            access_token_expires_at: null,
            token_scopes: null,
            token_source: 'system_user',
            system_user_token: null,
            system_user_token_expires_at: null,
            token_last_refreshed_at: nowIso,
            verify_token: verifyToken,
            app_secret: appSecret || null,
            api_version: apiVersion,
            enabled: true,
            connected_at: nowIso
        }

        const { error: upsertError } = await supabase
            .from('waba_configs')
            .upsert(payload, { onConflict: 'profile_id' })

        if (upsertError) {
            return res.status(500).json({ success: false, error: upsertError.message })
        }

        let subscribeError: string | null = null
        try {
            await subscribeWabaApp(wabaId, accessToken, apiVersion)
        } catch (err: any) {
            subscribeError = err?.message || 'Failed to subscribe webhook'
        }

        await wabaRegistry.refresh(true)

        res.json({
            success: true,
            subscribed: !subscribeError,
            subscribeError
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

function renderOauthHtml(title: string, message: string, returnUrl?: string) {
    const link = returnUrl ? `<p><a href=\"${returnUrl}\">Return to dashboard</a></p>` : ''
    return `<!doctype html><html><head><meta charset=\"utf-8\"/><title>${title}</title></head><body style=\"font-family:Arial, sans-serif; padding:24px;\"><h2>${title}</h2><p>${message}</p>${link}</body></html>`
}

function renderBusinessChoiceHtml(payload: {
    businesses: Array<{ id: string; name?: string }>
    state: string
    returnUrl?: string
}) {
    const rows = payload.businesses.map((b) => {
        const label = `${b.name || 'Business'} (${b.id})`
        const href = `/auth/waba/callback?state=${encodeURIComponent(payload.state)}&business_id=${encodeURIComponent(b.id)}`
        return `<li style="margin:12px 0;"><a href="${href}" style="display:inline-block;padding:10px 16px;border-radius:12px;background:#111b21;color:#fff;text-decoration:none;font-weight:700;">${label}</a></li>`
    }).join('')
    const link = payload.returnUrl ? `<p><a href=\"${payload.returnUrl}\">Return to dashboard</a></p>` : ''
    return `<!doctype html><html><head><meta charset=\"utf-8\"/><title>Select Business</title></head><body style=\"font-family:Arial, sans-serif; padding:24px;\"><h2>Select Business</h2><p>Choose the business to connect:</p><ul style=\"list-style:none;padding:0;\">${rows}</ul>${link}</body></html>`
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
        const selectedBusinessId = typeof req.query?.business_id === 'string'
            ? req.query.business_id
            : typeof req.query?.businessId === 'string'
                ? req.query.businessId
                : null
        if (!state) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing state.', resolveOauthReturnUrl(req)))
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
        const configId = process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID
        const oauthMode = resolveOauthMode(configId)
        const useBusinessIntegration = oauthMode === 'business_integration'
        const redirectUri = resolveOauthRedirectUri(req)

        let accessToken: string | null = null
        let tokenType: string | undefined = undefined
        let expiresIn: number | undefined = undefined

        if (code) {
            const tokenData = await exchangeCodeForToken({
                appId,
                appSecret,
                redirectUri,
                code,
                apiVersion
            })
            accessToken = tokenData.access_token
            tokenType = tokenData.token_type
            expiresIn = tokenData.expires_in
        } else if (stateRow.access_token) {
            try {
                accessToken = decryptToken(stateRow.access_token)
                tokenType = stateRow.access_token_type || undefined
                if (stateRow.access_token_expires_at) {
                    const expiresAtMs = new Date(stateRow.access_token_expires_at).getTime()
                    if (!Number.isNaN(expiresAtMs)) {
                        expiresIn = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000))
                    }
                }
            } catch (err: any) {
                return res.status(400).send(renderOauthHtml('Session expired', 'Please restart the signup flow.'))
            }
        } else {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing code for token exchange. Please restart the signup flow.'))
        }

        if (!accessToken) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing access token. Please restart the signup flow.'))
        }
        let clientBusinessId: string | null = null
        let businessIntegrationToken: string | null = null
        let businessIntegrationExpiresAt: string | null = null

        if (useBusinessIntegration) {
            try {
                const me = await fetchClientBusinessId(accessToken, apiVersion)
                clientBusinessId = me.client_business_id || null
            } catch (err: any) {
                console.warn('[WABA] Failed to fetch client_business_id:', err?.message || err)
            }

            if (clientBusinessId) {
                try {
                    const existingToken = await fetchBusinessIntegrationSystemUserToken({
                        clientBusinessId,
                        accessToken,
                        appSecret,
                        apiVersion,
                        fetchOnly: true
                    })
                    if (existingToken?.access_token) {
                        businessIntegrationToken = existingToken.access_token
                        if (existingToken.expires_in) {
                            businessIntegrationExpiresAt = new Date(Date.now() + Number(existingToken.expires_in) * 1000).toISOString()
                        }
                    } else {
                        const createdToken = await fetchBusinessIntegrationSystemUserToken({
                            clientBusinessId,
                            accessToken,
                            appSecret,
                            apiVersion
                        })
                        if (createdToken?.access_token) {
                            businessIntegrationToken = createdToken.access_token
                            if (createdToken.expires_in) {
                                businessIntegrationExpiresAt = new Date(Date.now() + Number(createdToken.expires_in) * 1000).toISOString()
                            }
                        }
                    }
                } catch (err: any) {
                    console.warn('[WABA] Failed to fetch business integration token:', err?.message || err)
                }
            }
        } else {
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
        }

        const graphToken = businessIntegrationToken || accessToken
        let wabaId = stateRow.requested_waba_id as string | null
        let businessId = selectedBusinessId || (stateRow.requested_business_id as string | null)
        let preferredWabaIds = new Set<string>()
        let preferredBusinessIds = new Set<string>()

        if (!businessId) {
            if (useBusinessIntegration && clientBusinessId) {
                businessId = clientBusinessId
            } else {
                const businesses = await fetchBusinesses(accessToken, apiVersion)
                if (!businesses.length) {
                    return res.status(400).send(renderOauthHtml('No businesses found', 'This account has no Meta businesses available.'))
                }

                if (businesses.length > 1 && !selectedBusinessId) {
                    const accessTokenExpiresAt = expiresIn
                        ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
                        : null
                    await supabase
                        .from('waba_oauth_states')
                        .update({
                            access_token: encryptToken(accessToken),
                            access_token_type: tokenType || null,
                            access_token_expires_at: accessTokenExpiresAt,
                            client_business_id: clientBusinessId
                        })
                        .eq('id', stateRow.id)
                    return res.status(200).send(renderBusinessChoiceHtml({
                        businesses,
                        state,
                        returnUrl: stateRow.redirect_url || resolveOauthReturnUrl(req)
                    }))
                }

                try {
                    const { data: existingConfigs } = await supabase
                        .from('waba_configs')
                        .select('business_id, waba_id')
                        .eq('company_id', stateRow.company_id)

                    ;(existingConfigs || []).forEach((row: any) => {
                        if (row.business_id) preferredBusinessIds.add(String(row.business_id))
                        if (row.waba_id) preferredWabaIds.add(String(row.waba_id))
                    })
                } catch (err: any) {
                    console.warn('[WABA] Failed to load existing configs for auto selection:', err?.message || err)
                }

                const preferredBusiness = businesses.find((b) => preferredBusinessIds.has(b.id))
                if (preferredBusiness) {
                    businessId = preferredBusiness.id
                } else if (businesses.length === 1) {
                    businessId = businesses[0].id
                } else {
                    businessId = businesses[0].id
                }
            }
        }

        
        if (!wabaId) {
            const owned = await fetchOwnedWabaAccounts(businessId, graphToken, apiVersion)
            const candidates = owned.length ? owned : await fetchClientWabaAccounts(businessId, graphToken, apiVersion)
            if (!candidates.length) {
                return res.status(400).send(renderOauthHtml('No WABA found', 'No WhatsApp Business Accounts found for this business.'))
            }
            if (candidates.length > 1) {
                const preferred = candidates.find((c) => preferredWabaIds.has(c.id))
                wabaId = preferred ? preferred.id : candidates[0].id
            } else {
                wabaId = candidates[0].id
            }
        }

        let phoneNumberId = stateRow.requested_phone_number_id as string | null
        if (!phoneNumberId) {
            const numbers = await fetchPhoneNumbers(wabaId, graphToken, apiVersion)
            if (!numbers.length) {
                return res.status(400).send(renderOauthHtml('No phone numbers found', 'No phone numbers were found for this WABA.'))
            }
            phoneNumberId = numbers[0].id
        }

        const stateProfileId = typeof stateRow.profile_id === 'string' ? stateRow.profile_id.trim() : ''
        if (!stateProfileId) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Profile information is missing in OAuth state.'))
        }

        const phoneConfigConflict = await findConflictingActivePhoneNumberConfig(phoneNumberId, stateProfileId)
        if (phoneConfigConflict) {
            return res.status(409).send(renderOauthHtml(
                'Phone number already connected',
                `phoneNumberId "${phoneNumberId}" is already connected to another profile. Disconnect it first.`,
                stateRow.redirect_url || resolveOauthReturnUrl(req)
            ))
        }

        try {
            await subscribeWabaApp(wabaId, graphToken, apiVersion)
        } catch (err: any) {
            return res.status(500).send(renderOauthHtml('Subscription failed', err?.message || 'Failed to subscribe app.'))
        }

        let systemUserToken: string | null = null
        let systemUserTokenExpiresAt: string | null = null
        const systemUserId = process.env.WABA_SYSTEM_USER_ID
        if (systemUserId && !useBusinessIntegration) {
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
        const baseTokenExpiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null
        const accessTokenExpiresAt = useBusinessIntegration
            ? (businessIntegrationToken ? businessIntegrationExpiresAt : baseTokenExpiresAt)
            : baseTokenExpiresAt

        const payload: any = {
            profile_id: stateProfileId,
            company_id: stateRow.company_id,
            app_id: appId,
            phone_number_id: phoneNumberId,
            business_id: businessId,
            client_business_id: clientBusinessId,
            waba_id: wabaId,
            business_account_id: wabaId,
            access_token: encryptToken(graphToken),
            access_token_type: tokenType || null,
            access_token_expires_at: accessTokenExpiresAt,
            token_scopes: useBusinessIntegration ? null : WABA_OAUTH_SCOPES,
            token_source: useBusinessIntegration ? 'business_integration' : (systemUserToken ? 'system_user' : 'user'),
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

        await supabase
            .from('waba_oauth_states')
            .update({
                used_at: new Date().toISOString(),
                requested_business_id: businessId,
                requested_waba_id: wabaId,
                requested_phone_number_id: phoneNumberId
            })
            .eq('id', stateRow.id)

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

// ============================================
// WABA NUMBER REGISTRATION (REQUEST/VERIFY/REGISTER)
// ============================================
app.get('/api/waba/registration/config', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        if (!config) {
            return res.status(404).json({ success: false, error: 'WABA config not found for this profile.' })
        }

        res.json({
            success: true,
            data: {
                profileId: access.profileId,
                companyId: access.companyId,
                businessId: config.businessId || null,
                clientBusinessId: config.clientBusinessId || null,
                wabaId: config.wabaId || config.businessAccountId || null,
                phoneNumberId: config.phoneNumberId || null,
                tokenSource: config.tokenSource || null,
                accessTokenExpiresAt: config.accessTokenExpiresAt || null,
                apiVersion: config.apiVersion
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/registration/phone-numbers', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const wabaId = typeof req.query?.wabaId === 'string' ? req.query.wabaId : undefined
        const data = await client.getPhoneNumbers(wabaId)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/request-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const rawMethod = typeof req.body?.codeMethod === 'string' ? req.body.codeMethod : ''
        const codeMethod = rawMethod.toUpperCase()
        const locale = typeof req.body?.locale === 'string' ? req.body.locale : 'en_US'

        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required' })
        }
        if (codeMethod !== 'SMS' && codeMethod !== 'VOICE') {
            return res.status(400).json({ success: false, error: 'codeMethod must be SMS or VOICE' })
        }

        const data = await client.requestVerificationCode(phoneNumberId, codeMethod as 'SMS' | 'VOICE', locale)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/verify-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''

        if (!phoneNumberId || !code) {
            return res.status(400).json({ success: false, error: 'phoneNumberId and code are required' })
        }

        const data = await client.verifyPhoneNumberCode(phoneNumberId, code)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/register', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : ''

        if (!phoneNumberId || !pin) {
            return res.status(400).json({ success: false, error: 'phoneNumberId and pin are required' })
        }
        if (!/^\d{6}$/.test(pin)) {
            return res.status(400).json({ success: false, error: 'pin must be 6 digits' })
        }

        const data = await client.registerPhoneNumber(phoneNumberId, pin)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/profile', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const profile = req.body?.profile

        if (!phoneNumberId || !profile || typeof profile !== 'object') {
            return res.status(400).json({ success: false, error: 'phoneNumberId and profile object are required' })
        }

        const data = await client.updateBusinessProfile(phoneNumberId, profile)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/templates', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const rawFields = req.query?.fields
        const rawStatus = req.query?.status
        const rawCategory = req.query?.category
        const rawName = req.query?.name
        const rawLimit = req.query?.limit
        const rawAfter = req.query?.after
        const rawBefore = req.query?.before

        const fields = Array.isArray(rawFields) ? rawFields.join(',') : readTrimmed(rawFields)
        const status = Array.isArray(rawStatus) ? readTrimmed(rawStatus[0]) : readTrimmed(rawStatus)
        const category = Array.isArray(rawCategory) ? readTrimmed(rawCategory[0]) : readTrimmed(rawCategory)
        const name = Array.isArray(rawName) ? readTrimmed(rawName[0]) : readTrimmed(rawName)
        const after = Array.isArray(rawAfter) ? readTrimmed(rawAfter[0]) : readTrimmed(rawAfter)
        const before = Array.isArray(rawBefore) ? readTrimmed(rawBefore[0]) : readTrimmed(rawBefore)
        const parsedLimit = Number(rawLimit)

        const data = await client.listMessageTemplates(wabaId, {
            fields: fields || ['id', 'name', 'status', 'category', 'language', 'quality_score', 'rejected_reason', 'created_time'],
            limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
            status: status || undefined,
            category: category || undefined,
            name: name || undefined,
            after: after || undefined,
            before: before || undefined
        })

        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/utility', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateUtilityTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid utility template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/marketing', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateMarketingTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid marketing template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/templates/authentication/previews', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { options, errors } = parseAuthenticationPreviewOptions(req.query || {})
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid authentication preview query', details: errors })
        }

        const data = await client.getAuthenticationTemplatePreviews(wabaId, options)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/authentication', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateAuthenticationTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid authentication template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/authentication/upsert', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateAuthenticationUpsertInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid authentication upsert payload', details: errors })
        }

        const data = await client.upsertMessageTemplates(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/templates/:templateId/status', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const templateId = readTrimmed(req.params?.templateId)
        if (!templateId) {
            return res.status(400).json({ success: false, error: 'templateId is required' })
        }

        const data = await client.getMessageTemplate(templateId, [
            'id',
            'name',
            'status',
            'category',
            'language',
            'quality_score'
        ])
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/authentication/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name)
        const language = readTrimmed(req.body?.language) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)
        const { code, error: codeError } = parseAuthenticationCode(req.body?.code ?? req.body?.otp ?? req.body?.verificationCode)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }
        if (codeError) {
            return res.status(400).json({ success: false, error: codeError })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const response = await client.sendAuthenticationTemplate(phoneNumber, name, language, code)
        const messageId = response?.messages?.[0]?.id
        if (!messageId) {
            return res.status(500).json({ success: false, error: 'Authentication template send response missing message ID', data: response })
        }

        await insertMessage({
            userId: user.id,
            direction: 'out',
            content: {
                type: 'template',
                channel: 'cloud_api',
                subcategory: 'authentication',
                to: phoneNumber,
                message_id: messageId,
                payload: {
                    name,
                    language,
                    code
                },
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name)
        const language = readTrimmed(req.body?.language) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const components = buildTemplateSendComponents(req.body || {})
        const { messageId } = await sendWhatsAppMessage({
            client,
            userId: user.id,
            to: phoneNumber,
            type: 'template',
            content: {
                name,
                language,
                components
            }
        })

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language,
                components: components || null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/marketing-messages/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name)
        const language = readTrimmed(req.body?.language) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }

        const { options, errors } = parseMarketingSendOptions(req.body || {})
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid marketing message payload', details: errors })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const response = await client.sendMarketingTemplate(phoneNumber, name, language, options)
        const messageId = response?.messages?.[0]?.id
        if (!messageId) {
            return res.status(500).json({ success: false, error: 'Marketing API response missing message ID', data: response })
        }

        await insertMessage({
            userId: user.id,
            direction: 'out',
            content: {
                type: 'template',
                channel: 'marketing_messages',
                to: phoneNumber,
                message_id: messageId,
                payload: {
                    name,
                    language,
                    ...options
                },
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language,
                product_policy: options.productPolicy || null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/clients', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        const admin = await isAdminUser(user.id, companyId || undefined)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }
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
            .select('profile_id, company_id, app_id, phone_number_id, business_id, client_business_id, waba_id, business_account_id, enabled, connected_at, access_token_expires_at, token_source, api_version')

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
        const admin = await isAdminUser(user.id, companyId || undefined)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('company')
            .select('fallback_text, fallback_limit')
            .eq('id', access.companyId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

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
            .eq('id', access.companyId)

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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, text, created_at, updated_at')
            .eq('company_id', access.companyId)
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
        const access = await resolveProfileAccess(req, res)
        if (!access) return

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
            .eq('company_id', access.companyId)

        if (deleteError) {
            return res.status(500).json({ success: false, error: deleteError.message })
        }

        if (cleaned.length > 0) {
            const { error: insertError } = await supabase
                .from('quick_replies')
                .insert(cleaned.map(item => ({
                    company_id: access.companyId,
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

// Team user management (company-level)
app.get('/api/company/team-users', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'agent')
        if (!access) return

        const { user, companyId, role } = access
        const { data: rows, error } = await supabase
            .from('user_roles')
            .select('user_id, role, company_id, created_at')
            .eq('company_id', companyId)
            .order('created_at', { ascending: true })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const users: any[] = []
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)

        for (const row of rows || []) {
            const entry: any = {
                id: row.user_id,
                role: normalizeTeamRole(row.role),
                department: 'custom' as TeamDepartment,
                customDepartment: null as string | null,
                color: computeAgentColor(row.user_id),
                createdAt: row.created_at || null
            }
            if (hasServiceRole) {
                const { data: authData, error: authError } = await supabase.auth.admin.getUserById(row.user_id)
                if (!authError && authData?.user) {
                    const authUser = authData.user
                    entry.email = authUser.email || null
                    entry.name = deriveAgentName(authUser)
                    entry.lastSignInAt = authUser.last_sign_in_at || null
                    const metadata = authUser.user_metadata || {}
                    entry.department = normalizeTeamDepartment(metadata.team_department)
                    entry.customDepartment = entry.department === 'custom'
                        ? normalizeTeamCustomDepartment(metadata.team_department_custom)
                        : null
                }
            }
            if (!entry.name) entry.name = row.user_id
            users.push(entry)
        }

        res.json({
            success: true,
            data: {
                currentUserId: user.id,
                currentUserRole: role,
                users
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/team-users/invite', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to invite users' })
        }

        const email = readTrimmed(req.body?.email).toLowerCase()
        const requestedRole = normalizeTeamRole(req.body?.role)
        const role: TeamRole = requestedRole === 'owner' ? 'admin' : requestedRole
        const password = typeof req.body?.password === 'string' ? req.body.password : ''
        const department = normalizeTeamDepartment(req.body?.department)
        const customDepartment = normalizeTeamCustomDepartment(req.body?.customDepartment)
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' })
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
        }
        if (department === 'custom' && !customDepartment) {
            return res.status(400).json({ success: false, error: 'Custom department label is required' })
        }

        const created = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                company_id: access.companyId,
                team_department: department,
                team_department_custom: department === 'custom' ? customDepartment : null
            }
        } as any)

        if (created.error || !created.data?.user?.id) {
            const message = created.error?.message || 'Failed to create user'
            const isConflict = /already|exists|registered/i.test(message)
            return res.status(isConflict ? 409 : 500).json({ success: false, error: message })
        }

        const invitedUserId = created.data.user.id
        const { error: upsertError } = await supabase
            .from('user_roles')
            .upsert({
                user_id: invitedUserId,
                company_id: access.companyId,
                role
            }, {
                onConflict: 'user_id'
            })

        if (upsertError) {
            return res.status(500).json({ success: false, error: upsertError.message })
        }

        res.json({
            success: true,
            data: {
                id: invitedUserId,
                email,
                role,
                department,
                customDepartment: department === 'custom' ? customDepartment : null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.patch('/api/company/team-users/:userId/role', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const targetUserId = readTrimmed(req.params?.userId)
        if (!targetUserId) {
            return res.status(400).json({ success: false, error: 'userId is required' })
        }

        const nextRole = normalizeTeamRole(req.body?.role)
        if (nextRole === 'owner' && access.role !== 'owner') {
            return res.status(403).json({ success: false, error: 'Only owner can grant owner role' })
        }

        const { data: targetRoleRow, error: roleError } = await supabase
            .from('user_roles')
            .select('user_id, role, company_id')
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)
            .maybeSingle()

        if (roleError) {
            return res.status(500).json({ success: false, error: roleError.message })
        }
        if (!targetRoleRow?.user_id) {
            return res.status(404).json({ success: false, error: 'Team user not found in your company' })
        }

        if (access.user.id === targetUserId && normalizeTeamRole(targetRoleRow.role) === 'owner' && nextRole !== 'owner') {
            return res.status(400).json({ success: false, error: 'Owner cannot demote self. Promote another owner first.' })
        }

        const { error: updateError } = await supabase
            .from('user_roles')
            .update({ role: nextRole, company_id: access.companyId })
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        res.json({
            success: true,
            data: {
                id: targetUserId,
                role: nextRole
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.patch('/api/company/team-users/:userId/department', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to update departments' })
        }

        const targetUserId = readTrimmed(req.params?.userId)
        if (!targetUserId) {
            return res.status(400).json({ success: false, error: 'userId is required' })
        }

        const department = normalizeTeamDepartment(req.body?.department)
        const customDepartment = normalizeTeamCustomDepartment(req.body?.customDepartment)
        if (department === 'custom' && !customDepartment) {
            return res.status(400).json({ success: false, error: 'Custom department label is required' })
        }

        const { data: targetRoleRow, error: roleError } = await supabase
            .from('user_roles')
            .select('user_id, company_id')
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)
            .maybeSingle()

        if (roleError) {
            return res.status(500).json({ success: false, error: roleError.message })
        }
        if (!targetRoleRow?.user_id) {
            return res.status(404).json({ success: false, error: 'Team user not found in your company' })
        }

        const { data: authUserData, error: authUserError } = await supabase.auth.admin.getUserById(targetUserId)
        if (authUserError || !authUserData?.user) {
            return res.status(500).json({ success: false, error: authUserError?.message || 'Failed to load target user' })
        }

        const previousMetadata = authUserData.user.user_metadata || {}
        const nextMetadata = {
            ...previousMetadata,
            company_id: access.companyId,
            team_department: department,
            team_department_custom: department === 'custom' ? customDepartment : null
        }

        const { error: updateError } = await supabase.auth.admin.updateUserById(targetUserId, {
            user_metadata: nextMetadata
        } as any)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        res.json({
            success: true,
            data: {
                id: targetUserId,
                department,
                customDepartment: department === 'custom' ? customDepartment : null
            }
        })
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
        message,
        agent: content.agent || content.payload?.agent || null,
        workflowState: record.workflow_state || null
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

    sendWebhook(profileId, 'message', {
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

// Auth Middleware for Socket.io
io.use(async (socket, next) => {
    try {
        const token = (socket.handshake.auth as any).token
        if (!token) return next(new Error('Authentication error: Token missing'))

        const { data: { user }, error } = await supabase.auth.getUser(token)
        if (error || !user) return next(new Error('Authentication error: Invalid session'))

        const requestHostname = getHostnameFromHeaders(socket.handshake.headers || {})
        const hostCompanyId = resolveCompanyIdFromHostname(requestHostname)
        const directCompanyId = normalizeCompanyId(getUserCompanyId(user))
        if (hostCompanyId && !directCompanyId) {
            return next(new Error('Authentication error: Account is not assigned to any company'))
        }
        if (hostCompanyId && directCompanyId && directCompanyId !== hostCompanyId) {
            return next(new Error('Authentication error: Company mismatch for this subdomain'))
        }

        const { user: ensuredUser, companyId } = await ensureUserCompanyId(user)
        const ensuredCompanyId = normalizeCompanyId(companyId || getUserCompanyId(ensuredUser))
        if (hostCompanyId && ensuredCompanyId !== hostCompanyId) {
            return next(new Error('Authentication error: Company mismatch for this subdomain'))
        }
        socket.data.user = ensuredUser
        if (companyId) socket.data.companyId = companyId
        next()
    } catch (e) {
        next(new Error('Internal auth error'))
    }
})

io.on('connection', async (socket) => {
    const userId = socket.data.user.id
    console.log(`User connected: ${socket.data.user.email} (${userId})`)
    const companyId = socket.data.companyId
        || socket.data.user?.user_metadata?.company_id
        || socket.data.user?.app_metadata?.company_id
    if (!companyId) {
        socket.emit('profile.error', { message: 'Company ID missing. Please log in again.' })
        socket.disconnect(true)
        return
    }
    socket.data.companyId = companyId

    // Join user-specific room for private emits
    socket.join(userId)
    socket.join(getCompanyRoom(companyId))

    if (lastServerStats) {
        socket.emit('server.stats', lastServerStats)
    }

    await ensureCompanyRecord(companyId, socket.data.user)

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

        const profileCompanyId = await getCompanyIdForProfile(profileId)
        if (!profileCompanyId) {
            socket.emit('contacts.update', { profileId, contacts: [] })
            socket.emit('messages.history', { profileId, messages: [] })
        } else {
            const users = await getUsersForCompany(profileCompanyId)
            const contacts = users.map(u => buildContactPayload(u))
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
        io.to(getCompanyRoom(currentCompanyId)).emit('profiles.update', refreshed || [])
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
        const contacts = users.map(u => buildContactPayload(u))
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
                io.to(getCompanyRoom(companyId)).emit('contacts.update', {
                    profileId,
                    contacts: [{ ...buildContactPayload(updated), id: `${phoneNumber}@s.whatsapp.net` }]
                })
            }
        } catch (err: any) {
            socket.emit('profile.error', { message: err?.message || 'Failed to update contact.' })
        }
    })

    socket.on('contact.assign', async (payload, ack) => {
        try {
            const profileId = readTrimmed(payload?.profileId)
            const jid = readTrimmed(payload?.jid)
            const assigneeUserIdRaw = payload?.assigneeUserId
            const assigneeUserId = assigneeUserIdRaw ? readTrimmed(assigneeUserIdRaw) : null

            if (!profileId || !jid) {
                const error = 'profileId and jid are required.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }
            if (jid.endsWith('@g.us')) {
                const error = 'Assigning groups is not supported.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                const error = 'Company not found.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const { data: profileCheck } = await supabase
                .from('profiles')
                .select('id')
                .eq('id', profileId)
                .eq('company_id', companyId)
                .maybeSingle()
            if (!profileCheck?.id) {
                const error = 'Profile not found for this company.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const phoneNumber = jid.replace(/@s\\.whatsapp\\.net$/, '').replace(/\\D/g, '')
            if (!phoneNumber) {
                const error = 'Invalid contact phone number.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const user = await findOrCreateUser(companyId, phoneNumber)
            if (!user) {
                const error = 'Failed to resolve contact.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            let assignee: { userId: string; name: string; color: string } | null = null
            if (assigneeUserId) {
                const { data: roleRow, error: roleError } = await supabase
                    .from('user_roles')
                    .select('user_id')
                    .eq('company_id', companyId)
                    .eq('user_id', assigneeUserId)
                    .maybeSingle()

                if (roleError) {
                    const error = roleError.message || 'Failed to validate assignee.'
                    if (typeof ack === 'function') ack({ success: false, error })
                    return
                }
                if (!roleRow?.user_id) {
                    const error = 'Selected staff is not in this company.'
                    if (typeof ack === 'function') ack({ success: false, error })
                    return
                }

                let assigneeName = assigneeUserId
                const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
                if (hasServiceRole) {
                    const { data: authData, error: authError } = await supabase.auth.admin.getUserById(assigneeUserId)
                    if (!authError && authData?.user) {
                        assigneeName = deriveAgentName(authData.user)
                    }
                }

                assignee = {
                    userId: assigneeUserId,
                    name: assigneeName,
                    color: computeAgentColor(assigneeUserId)
                }
            }

            const updated = await setUserAssignee(user.id, assignee)
            if (!updated) {
                const error = 'Failed to update assignee.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const contactPayload = { ...buildContactPayload(updated), id: `${phoneNumber}@s.whatsapp.net` }
            io.to(getCompanyRoom(companyId)).emit('contacts.update', {
                profileId,
                contacts: [contactPayload]
            })

            if (typeof ack === 'function') {
                ack({
                    success: true,
                    data: {
                        contact: contactPayload
                    }
                })
            }
        } catch (err: any) {
            const error = err?.message || 'Failed to assign contact.'
            if (typeof ack === 'function') ack({ success: false, error })
            else socket.emit('profile.error', { message: error })
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

            io.to(getCompanyRoom(companyId)).emit('messages.cleared', { profileId, jid })
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
        io.to(getCompanyRoom(currentCompanyId)).emit('profiles.update', refreshed)

        console.log(`[${userId}] Profile ${id} created. WABA config required to activate.`)
        socket.emit('profile.added', id)
    })

    socket.on('updateProfileName', async ({ profileId, name }) => {
        const currentCompanyId = socket.data.companyId || companyId
        await supabase.from('profiles').update({ name }).eq('id', profileId).eq('company_id', currentCompanyId)
        const { data: refreshed } = await supabase.from('profiles').select('*').eq('company_id', currentCompanyId).order('created_at', { ascending: true })
        io.to(getCompanyRoom(currentCompanyId)).emit('profiles.update', refreshed)
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
        io.to(getCompanyRoom(currentCompanyId)).emit('profiles.update', refreshed || [])
    })

    socket.on('logout', async (profileId) => {
        socket.emit('profile.error', { message: 'WABA Cloud API does not support logout. Disable the config in Supabase instead.' })
        const client = await wabaRegistry.getClientByProfile(profileId)
        io.to(getCompanyRoom(companyId)).emit('connection.update', { profileId, connection: client ? 'open' : 'close' })
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
            const actor = buildAgentIdentity(socket.data.user)
            await sendWhatsAppMessage({
                client,
                userId: user.id,
                to: phoneNumber,
                type: 'text',
                content: { text },
                actor
            })
            const assigned = await assignUserToAgentIfUnassigned(user.id, {
                userId: actor.user_id,
                name: actor.name,
                color: actor.color
            })
            if (assigned) {
                io.to(getCompanyRoom(companyId)).emit('contacts.update', {
                    profileId,
                    contacts: [{ ...buildContactPayload(assigned), id: `${phoneNumber}@s.whatsapp.net` }]
                })
            }
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
            const actor = buildAgentIdentity(socket.data.user)

            await sendWhatsAppMessage({
                client,
                userId: user.id,
                to: phoneNumber,
                type: 'template',
                content: {
                    name,
                    language: language || 'en_US',
                    components: Array.isArray(components) && components.length > 0 ? components : undefined
                },
                actor
            })
            const assigned = await assignUserToAgentIfUnassigned(user.id, {
                userId: actor.user_id,
                name: actor.name,
                color: actor.color
            })
            if (assigned) {
                io.to(getCompanyRoom(companyId)).emit('contacts.update', {
                    profileId,
                    contacts: [{ ...buildContactPayload(assigned), id: `${phoneNumber}@s.whatsapp.net` }]
                })
            }
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
        const role = userRole?.role ? normalizeTeamRole(userRole.role) : null
        if (!role || !hasRoleAtLeast(role, 'admin')) {
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
        const role = userRole?.role ? normalizeTeamRole(userRole.role) : null
        if (!role || !hasRoleAtLeast(role, 'admin')) return

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
    // Express 5 + path-to-regexp v6: use regex fallback instead of '*' patterns
    app.get(/^(?!\/api|\/addon|\/socket\.io).*/, (req: any, res: any) => {
        res.sendFile(path.join(frontendPath, 'index.html'))
    })
}

const PORT = Number(process.env.PORT || 3000)
httpServer.listen(PORT, async () => {
    console.log(`Dashboard Server listening on port ${PORT}`)

    const activeProfiles = await wabaRegistry.getProfileIds()
    console.log(`[WABA] Loaded configs for ${activeProfiles.length} profile(s).`)
})
