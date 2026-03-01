import { supabase } from '../supabase'

export type Company = {
    id: string
    name?: string
    email?: string
    fallback_text?: string | null
    fallback_limit?: number | null
}

export type User = {
    id: string
    company_id: string
    phone_number: string
    name?: string | null
    tags?: string[] | null
    last_inbound_at?: string | null
    last_window_reminder_at?: string | null
    assigned_to_user_id?: string | null
    assigned_to_name?: string | null
    assigned_to_color?: string | null
    assigned_at?: string | null
    cta_referral_at?: string | null
    cta_referral_source?: string | null
    cta_free_window_started_at?: string | null
    cta_free_window_expires_at?: string | null
}

export type MessageRecord = {
    id: string
    user_id: string
    direction: 'in' | 'out'
    content: any
    workflow_state: any | null
    created_at: string
}

const CTA_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
const CTA_FREE_WINDOW_MS = 72 * 60 * 60 * 1000

export function normalizePhoneNumber(input: string | null | undefined): string {
    if (!input) return ''
    return input.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '')
}

export async function getDefaultCompanyId(): Promise<string | null> {
    const { data, error } = await supabase
        .from('company')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load default company:', error.message)
        return null
    }

    return data?.id || null
}

export async function resolveCompanyId(companyId?: string | null): Promise<string | null> {
    if (companyId) {
        const { data, error } = await supabase
            .from('company')
            .select('id')
            .eq('id', companyId)
            .maybeSingle()

        if (!error && data?.id) return data.id
    }
    return getDefaultCompanyId()
}

export async function getCompanyFallbackSettings(companyId: string): Promise<{
    fallback_text?: string | null
    fallback_limit?: number | null
} | null> {
    if (!companyId) return null
    const { data, error } = await supabase
        .from('company')
        .select('fallback_text, fallback_limit')
        .eq('id', companyId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load fallback settings:', error.message)
        return null
    }

    return data || null
}

export async function updateCompanyFallbackSettings(
    companyId: string,
    settings: { fallback_text?: string | null; fallback_limit?: number | null }
): Promise<boolean> {
    if (!companyId) return false
    const { error } = await supabase
        .from('company')
        .update({
            fallback_text: settings.fallback_text ?? null,
            fallback_limit: settings.fallback_limit ?? null
        })
        .eq('id', companyId)

    if (error) {
        console.warn('[DB] Failed to update fallback settings:', error.message)
        return false
    }

    return true
}

export async function findOrCreateUser(companyId: string, phoneNumber: string): Promise<User | null> {
    const normalized = normalizePhoneNumber(phoneNumber)
    if (!normalized) {
        console.warn('[DB] Invalid phone number for user lookup:', phoneNumber)
        return null
    }

    const legacy = `${normalized}@s.whatsapp.net`
    const candidates = legacy === normalized ? [normalized] : [normalized, legacy]

    const { data: existing, error: fetchError } = await supabase
        .from('users')
        .select('*')
        .eq('company_id', companyId)
        .in('phone_number', candidates)
        .limit(2)

    if (fetchError) {
        console.warn('[DB] Failed to fetch user:', fetchError.message)
    }

    if (existing && existing.length > 0) {
        const exact = existing.find((row: any) => row.phone_number === normalized) || existing[0]
        if (exact && exact.phone_number !== normalized) {
            const { error: updateError } = await supabase
                .from('users')
                .update({ phone_number: normalized })
                .eq('id', exact.id)
            if (updateError) {
                console.warn('[DB] Failed to normalize user phone_number:', updateError.message)
            } else {
                exact.phone_number = normalized
            }
        }
        return exact as User
    }

    const { data: created, error: createError } = await supabase
        .from('users')
        .insert({ company_id: companyId, phone_number: normalized, tags: [] })
        .select('*')
        .single()

    if (createError) {
        console.warn('[DB] Failed to create user:', createError.message)
        return null
    }

    return created as User
}

export async function getUserByPhone(companyId: string, phoneNumber: string): Promise<User | null> {
    const normalized = normalizePhoneNumber(phoneNumber)
    if (!normalized) return null
    const legacy = `${normalized}@s.whatsapp.net`
    const candidates = legacy === normalized ? [normalized] : [normalized, legacy]

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('company_id', companyId)
        .in('phone_number', candidates)
        .limit(2)

    if (error) {
        console.warn('[DB] Failed to fetch user by phone:', error.message)
        return null
    }

    if (!data || data.length === 0) return null
    const exact = data.find((row: any) => row.phone_number === normalized) || data[0]
    if (exact && exact.phone_number !== normalized) {
        const { error: updateError } = await supabase
            .from('users')
            .update({ phone_number: normalized })
            .eq('id', exact.id)
        if (updateError) {
            console.warn('[DB] Failed to normalize user phone_number:', updateError.message)
        } else {
            exact.phone_number = normalized
        }
    }
    return exact as User
}

export async function getUserById(userId: string): Promise<User | null> {
    if (!userId) return null
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to fetch user by id:', error.message)
        return null
    }

    return (data || null) as User | null
}

function toIsoOrNow(value?: string | null): string {
    if (!value) return new Date().toISOString()
    const parsed = new Date(value).getTime()
    if (Number.isNaN(parsed)) return new Date().toISOString()
    return new Date(parsed).toISOString()
}

export function extractCtaReferralSource(referral: any): string | null {
    if (!referral || typeof referral !== 'object') return null
    const sourceId = typeof referral.source_id === 'string' ? referral.source_id.trim() : ''
    const sourceType = typeof referral.source_type === 'string' ? referral.source_type.trim() : ''
    const ctwaClid = typeof referral.ctwa_clid === 'string' ? referral.ctwa_clid.trim() : ''
    if (sourceType && sourceId) return `${sourceType}:${sourceId}`
    if (sourceId) return sourceId
    if (ctwaClid) return ctwaClid
    return sourceType || null
}

export async function updateUserCtaReferral(
    userId: string,
    referralAt?: string | null,
    referralSource?: string | null
): Promise<void> {
    if (!userId) return
    const timestamp = toIsoOrNow(referralAt)
    const { error } = await supabase
        .from('users')
        .update({
            cta_referral_at: timestamp,
            cta_referral_source: referralSource || null,
            cta_free_window_started_at: null,
            cta_free_window_expires_at: null
        })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update CTA referral state:', error.message)
    }
}

export async function shouldMarkCtaReplyCandidate(userId: string, sentAt?: string | null): Promise<boolean> {
    if (!userId) return false
    const user = await getUserById(userId)
    if (!user?.cta_referral_at) return false

    const sentTime = new Date(toIsoOrNow(sentAt)).getTime()
    const referralTime = new Date(user.cta_referral_at).getTime()
    if (Number.isNaN(sentTime) || Number.isNaN(referralTime)) return false

    // If free window already started for this referral, no need to mark again.
    if (user.cta_free_window_started_at) {
        const started = new Date(user.cta_free_window_started_at).getTime()
        if (!Number.isNaN(started) && started >= referralTime) {
            return false
        }
    }

    return sentTime <= referralTime + CTA_REPLY_WINDOW_MS
}

export async function activateUserCtaFreeWindow(
    userId: string,
    deliveredAt?: string | null
): Promise<{ startedAt: string; expiresAt: string } | null> {
    if (!userId) return null
    const user = await getUserById(userId)
    if (!user?.cta_referral_at) return null

    const startedAt = toIsoOrNow(deliveredAt)
    const startedMs = new Date(startedAt).getTime()
    const referralMs = new Date(user.cta_referral_at).getTime()
    if (Number.isNaN(startedMs) || Number.isNaN(referralMs)) return null

    // Keep idempotent for the same referral cycle.
    if (user.cta_free_window_started_at) {
        const existingStartedMs = new Date(user.cta_free_window_started_at).getTime()
        if (!Number.isNaN(existingStartedMs) && existingStartedMs >= referralMs) {
            const existingExpires = user.cta_free_window_expires_at || new Date(existingStartedMs + CTA_FREE_WINDOW_MS).toISOString()
            return {
                startedAt: user.cta_free_window_started_at,
                expiresAt: existingExpires
            }
        }
    }

    const expiresAt = new Date(startedMs + CTA_FREE_WINDOW_MS).toISOString()
    const { error } = await supabase
        .from('users')
        .update({
            cta_free_window_started_at: startedAt,
            cta_free_window_expires_at: expiresAt
        })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to activate CTA free window:', error.message)
        return null
    }

    return { startedAt, expiresAt }
}

export async function getCtaFreeWindowExpiresAt(userId: string): Promise<string | null> {
    const user = await getUserById(userId)
    if (!user?.cta_free_window_expires_at) return null
    const expiresMs = new Date(user.cta_free_window_expires_at).getTime()
    if (Number.isNaN(expiresMs)) return null
    if (expiresMs <= Date.now()) return null
    return user.cta_free_window_expires_at
}

export async function deleteMessagesForUser(userId: string): Promise<boolean> {
    const { error } = await supabase
        .from('messages')
        .delete({ count: 'exact' })
        .eq('user_id', userId)

    if (error) {
        console.warn('[DB] Failed to delete messages:', error.message)
        return false
    }

    return true
}

export async function updateUserTags(userId: string, tag: string): Promise<void> {
    const { data: existing, error } = await supabase
        .from('users')
        .select('tags')
        .eq('id', userId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load user tags:', error.message)
        return
    }

    const tags = Array.isArray(existing?.tags) ? existing?.tags : []
    if (tags.includes(tag)) return

    const nextTags = [...tags, tag]
    const { error: updateError } = await supabase
        .from('users')
        .update({ tags: nextTags })
        .eq('id', userId)

    if (updateError) {
        console.warn('[DB] Failed to update user tags:', updateError.message)
    }
}

export async function setUserTags(userId: string, tags: string[]): Promise<void> {
    const nextTags = Array.from(new Set((tags || []).map(t => t.trim()).filter(Boolean)))
    const { error } = await supabase
        .from('users')
        .update({ tags: nextTags })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to set user tags:', error.message)
    }
}

export async function updateUserName(userId: string, name: string): Promise<void> {
    const nextName = (name || '').trim()
    if (!nextName) return

    const { error } = await supabase
        .from('users')
        .update({ name: nextName })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update user name:', error.message)
    }
}

export async function assignUserToAgentIfUnassigned(
    userId: string,
    agent: { userId: string; name: string; color: string }
): Promise<User | null> {
    if (!userId || !agent?.userId) return getUserById(userId)
    const agentName = (agent.name || '').trim() || agent.userId
    const agentColor = (agent.color || '').trim() || '#6b7280'
    const assignedAt = new Date().toISOString()

    const { data, error } = await supabase
        .from('users')
        .update({
            assigned_to_user_id: agent.userId,
            assigned_to_name: agentName,
            assigned_to_color: agentColor,
            assigned_at: assignedAt
        })
        .eq('id', userId)
        .is('assigned_to_user_id', null)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to assign user to agent:', error.message)
        return null
    }

    if (data) return data as User
    return getUserById(userId)
}

export async function setUserAssignee(
    userId: string,
    agent: { userId: string; name?: string; color?: string } | null
): Promise<User | null> {
    if (!userId) return null

    const updates = agent?.userId
        ? {
            assigned_to_user_id: agent.userId,
            assigned_to_name: (agent.name || '').trim() || agent.userId,
            assigned_to_color: (agent.color || '').trim() || '#6b7280',
            assigned_at: new Date().toISOString()
        }
        : {
            assigned_to_user_id: null,
            assigned_to_name: null,
            assigned_to_color: null,
            assigned_at: null
        }

    const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to set user assignee:', error.message)
        return null
    }

    if (data) return data as User
    return getUserById(userId)
}

export async function insertMessage(record: {
    userId: string
    direction: 'in' | 'out'
    content: any
    workflowState?: any | null
}): Promise<MessageRecord | null> {
    const { data, error } = await supabase
        .from('messages')
        .insert({
            user_id: record.userId,
            direction: record.direction,
            content: record.content,
            workflow_state: record.workflowState ?? null
        })
        .select('*')
        .single()

    if (error) {
        console.warn('[DB] Failed to insert message:', error.message)
        return null
    }

    return data as MessageRecord
}

export async function getLastMessage(userId: string): Promise<MessageRecord | null> {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load last message:', error.message)
        return null
    }

    return data as MessageRecord | null
}

export async function getLastInboundTimestamp(userId: string): Promise<string | null> {
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('last_inbound_at')
        .eq('id', userId)
        .maybeSingle()

    if (userError) {
        console.warn('[DB] Failed to load user last_inbound_at:', userError.message)
    } else if (userData?.last_inbound_at) {
        return userData.last_inbound_at
    }

    const { data, error } = await supabase
        .from('messages')
        .select('created_at')
        .eq('user_id', userId)
        .eq('direction', 'in')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load last inbound timestamp:', error.message)
        return null
    }

    return data?.created_at || null
}

export async function updateUserLastInbound(userId: string, inboundAt?: string | null): Promise<void> {
    const timestamp = inboundAt || new Date().toISOString()
    const { error } = await supabase
        .from('users')
        .update({ last_inbound_at: timestamp })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update last_inbound_at:', error.message)
    }
}

export async function updateMessageStatusByMessageId(messageId: string, status: string): Promise<MessageRecord | null> {
    if (!messageId) return null

    const { data: existing, error: fetchError } = await supabase
        .from('messages')
        .select('id, content')
        .eq('content->>message_id', messageId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (fetchError) {
        console.warn('[DB] Failed to lookup message by message_id:', fetchError.message)
        return null
    }

    if (!existing) return null

    const nextContent = {
        ...(existing.content || {}),
        status
    }

    const { data, error } = await supabase
        .from('messages')
        .update({ content: nextContent })
        .eq('id', existing.id)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to update message status:', error.message)
        return null
    }

    return data as MessageRecord | null
}

export async function updateMessageWorkflowState(messageId: string, workflowState: any): Promise<MessageRecord | null> {
    if (!messageId) return null

    const { data, error } = await supabase
        .from('messages')
        .update({ workflow_state: workflowState ?? null })
        .eq('id', messageId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to update message workflow_state:', error.message)
        return null
    }

    return data as MessageRecord | null
}

const WINDOW_MS = 24 * 60 * 60 * 1000

export async function getUsersWithExpiringWindow(companyId: string, minutes: number): Promise<User[]> {
    if (!minutes || minutes <= 0) return []
    const thresholdMs = minutes * 60 * 1000
    const earliestInbound = new Date(Date.now() - WINDOW_MS).toISOString()

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('company_id', companyId)
        .not('last_inbound_at', 'is', null)
        .gte('last_inbound_at', earliestInbound)

    if (error) {
        console.warn('[DB] Failed to load users for window reminder:', error.message)
        return []
    }

    const now = Date.now()
    return (data || []).filter((u: any) => {
        if (!u.last_inbound_at) return false
        const lastInboundMs = new Date(u.last_inbound_at).getTime()
        if (Number.isNaN(lastInboundMs)) return false
        const remaining = lastInboundMs + WINDOW_MS - now
        if (remaining <= 0 || remaining > thresholdMs) return false
        if (u.last_window_reminder_at) {
            const lastReminderMs = new Date(u.last_window_reminder_at).getTime()
            if (!Number.isNaN(lastReminderMs) && lastReminderMs >= lastInboundMs) {
                return false
            }
        }
        return true
    }) as User[]
}

export async function updateUserWindowReminder(userId: string, timestamp?: string | null): Promise<void> {
    const value = timestamp || new Date().toISOString()
    const { error } = await supabase
        .from('users')
        .update({ last_window_reminder_at: value })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update last_window_reminder_at:', error.message)
    }
}

export async function getWorkflows(companyId: string): Promise<any[]> {
    const { data, error } = await supabase
        .from('workflows')
        .select('*')
        .eq('company_id', companyId)

    if (error) {
        console.warn('[DB] Failed to load workflows:', error.message)
        return []
    }

    return data || []
}

export async function getWorkflowById(workflowId: string): Promise<any | null> {
    const { data, error } = await supabase
        .from('workflows')
        .select('*')
        .eq('id', workflowId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load workflow:', error.message)
        return null
    }

    return data
}

export async function getUsersForCompany(companyId: string): Promise<User[]> {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('company_id', companyId)

    if (error) {
        console.warn('[DB] Failed to load users:', error.message)
        return []
    }

    return (data || []) as User[]
}

export async function getMessagesForUsers(userIds: string[], limit = 500): Promise<MessageRecord[]> {
    if (userIds.length === 0) return []

    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .in('user_id', userIds)
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) {
        console.warn('[DB] Failed to load messages:', error.message)
        return []
    }

    return (data || []) as MessageRecord[]
}
