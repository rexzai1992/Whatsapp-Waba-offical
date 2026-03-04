import type { Express } from 'express'

const COMPANY_ID_REGEX = /^[a-z0-9-]{3,63}$/
const RESERVED_COMPANY_IDS = new Set(['www', 'admin', 'myadmin'])

function readTrimmed(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function normalizeCompanyId(value: any): string {
    return readTrimmed(value).toLowerCase()
}

function isValidEmail(email: string): boolean {
    return /^\S+@\S+\.\S+$/.test(email)
}

function isConflictError(message: string): boolean {
    return /already|exists|registered|duplicate|conflict/i.test(message)
}

export function registerPublicAuthRoutes(app: Express, ctx: any) {
    const { supabase } = ctx

    app.post('/api/public/signup-company', async (req: any, res: any) => {
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({
                success: false,
                error: 'SUPABASE_SERVICE_ROLE_KEY is required to create company accounts'
            })
        }

        const companyId = normalizeCompanyId(req.body?.companyId || req.body?.company_id)
        const email = readTrimmed(req.body?.email).toLowerCase()
        const password = typeof req.body?.password === 'string' ? req.body.password : ''
        const companyNameInput = readTrimmed(req.body?.companyName || req.body?.company_name)
        const companyName = companyNameInput || companyId

        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID is required' })
        }
        if (!COMPANY_ID_REGEX.test(companyId) || companyId.startsWith('-') || companyId.endsWith('-')) {
            return res.status(400).json({
                success: false,
                error: 'Company ID must be 3-63 chars, lowercase letters/numbers/hyphen, and cannot start or end with hyphen'
            })
        }
        if (RESERVED_COMPANY_IDS.has(companyId)) {
            return res.status(400).json({ success: false, error: 'This company ID is reserved' })
        }
        if (!email || !isValidEmail(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' })
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
        }

        try {
            const { data: existingCompany, error: existingCompanyError } = await supabase
                .from('company')
                .select('id')
                .eq('id', companyId)
                .maybeSingle()
            if (existingCompanyError) {
                return res.status(500).json({ success: false, error: existingCompanyError.message })
            }
            if (existingCompany?.id) {
                return res.status(409).json({ success: false, error: 'Company ID is already registered' })
            }

            const created = await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: {
                    company_id: companyId
                }
            } as any)
            if (created.error || !created.data?.user?.id) {
                const message = created.error?.message || 'Failed to create account'
                return res.status(isConflictError(message) ? 409 : 500).json({ success: false, error: message })
            }

            const userId = created.data.user.id
            let companyInserted = false
            let profileInserted = false

            try {
                const { error: companyError } = await supabase
                    .from('company')
                    .insert({
                        id: companyId,
                        name: companyName,
                        email
                    })
                if (companyError) {
                    throw new Error(companyError.message)
                }
                companyInserted = true

                const { error: roleError } = await supabase
                    .from('user_roles')
                    .upsert(
                        {
                            user_id: userId,
                            company_id: companyId,
                            role: 'owner'
                        },
                        { onConflict: 'user_id' }
                    )
                if (roleError) {
                    throw new Error(roleError.message)
                }

                const { error: profileError } = await supabase
                    .from('profiles')
                    .insert({
                        id: companyId,
                        user_id: userId,
                        name: companyName,
                        company_id: companyId,
                        unreadCount: 0
                    })
                if (profileError) {
                    if (!isConflictError(profileError.message || '')) {
                        throw new Error(profileError.message)
                    }
                } else {
                    profileInserted = true
                }

                return res.json({
                    success: true,
                    data: {
                        userId,
                        email,
                        companyId,
                        companyName,
                        profileCreated: profileInserted
                    }
                })
            } catch (nestedError: any) {
                const message = nestedError?.message || 'Failed to complete company setup'
                try {
                    if (profileInserted) {
                        await supabase.from('profiles').delete().eq('company_id', companyId).eq('user_id', userId)
                    }
                } catch {
                    // ignore cleanup error
                }
                try {
                    await supabase.from('user_roles').delete().eq('user_id', userId)
                } catch {
                    // ignore cleanup error
                }
                try {
                    if (companyInserted) {
                        await supabase.from('company').delete().eq('id', companyId)
                    }
                } catch {
                    // ignore cleanup error
                }
                try {
                    await supabase.auth.admin.deleteUser(userId)
                } catch {
                    // ignore cleanup error
                }
                return res.status(isConflictError(message) ? 409 : 500).json({ success: false, error: message })
            }
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error?.message || 'Failed to create account' })
        }
    })
}
