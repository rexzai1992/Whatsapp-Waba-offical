import type { Express } from 'express'

export function registerCompanyRoutes(app: Express, ctx: any) {
    const {
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
    } = ctx

app.get('/api/company/fallback-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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

app.post('/api/company/fallback-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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
app.get('/api/company/quick-replies', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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

app.post('/api/company/quick-replies', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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

// Team user management (company-level)
app.get('/api/company/team-users', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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
                department: 'custom',
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

app.post('/api/company/team-users/invite', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to invite users' })
        }

        const email = readTrimmed(req.body?.email).toLowerCase()
        const requestedRole = normalizeTeamRole(req.body?.role)
        const role = requestedRole === 'owner' ? 'admin' : requestedRole
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

app.patch('/api/company/team-users/:userId/role', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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

app.patch('/api/company/team-users/:userId/department', requireSupabaseUserMiddleware, async (req: any, res: any) => {
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

}
