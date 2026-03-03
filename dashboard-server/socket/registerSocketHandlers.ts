import type { Server } from 'socket.io'

export function registerSocketHandlers(io: Server, ctx: any) {
    const {
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
    } = ctx

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

    socket.on('contact.human_takeover', async (payload, ack) => {
        try {
            const profileId = readTrimmed(payload?.profileId)
            const jid = readTrimmed(payload?.jid)
            const enabled = Boolean(payload?.enabled)

            if (!profileId || !jid) {
                const error = 'profileId and jid are required.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }
            if (jid.endsWith('@g.us')) {
                const error = 'Human takeover is not supported for groups.'
                if (typeof ack === 'function') ack({ success: false, error })
                return
            }

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                const error = 'Company not found.'
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

            const updated = await setUserHumanTakeover(user.id, enabled)
            if (!updated) {
                const error = 'Failed to update human takeover.'
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
            const error = err?.message || 'Failed to update human takeover.'
            if (typeof ack === 'function') ack({ success: false, error })
            else socket.emit('profile.error', { message: error })
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
        let { profileId, jid, text, media } = data
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
            const messageText = typeof text === 'string' ? text.trim() : ''
            const mediaType = typeof media?.type === 'string' ? media.type.toLowerCase() : ''
            const mediaUrl = typeof media?.url === 'string' ? media.url.trim() : ''
            const mediaFilename = typeof media?.filename === 'string' ? media.filename.trim() : ''
            const normalizedMedia =
                (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && mediaUrl
                    ? {
                        type: mediaType,
                        link: mediaUrl,
                        ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                    }
                    : null
            if (!messageText && !normalizedMedia) {
                socket.emit('profile.error', { message: 'Type a message or attach media.' })
                return
            }
            await sendWhatsAppMessage({
                client,
                userId: user.id,
                to: phoneNumber,
                type: 'text',
                content: {
                    text: messageText,
                    ...(normalizedMedia ? { media: normalizedMedia } : {})
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

}
