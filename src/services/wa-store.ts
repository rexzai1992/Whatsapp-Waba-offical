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
}

export type MessageRecord = {
    id: string
    user_id: string
    direction: 'in' | 'out'
    content: any
    workflow_state: any | null
    created_at: string
}

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
