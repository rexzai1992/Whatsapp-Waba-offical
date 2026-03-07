import express, { type Express } from 'express'

const COMMAND_MAX_COUNT = 30
const COMMAND_NAME_MAX_LENGTH = 32
const COMMAND_DESCRIPTION_MAX_LENGTH = 256
const COMMAND_NAME_REGEX = /^[a-z0-9_-]+$/
const EMOJI_REGEX = /\p{Extended_Pictographic}/u

type ConversationalCommand = {
    command_name: string
    command_description: string
}

function trimText(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function sanitizeCommandName(value: any): string {
    return trimText(value).replace(/^\/+/, '').toLowerCase()
}

function sanitizeConversationalCommands(rawCommands: any): ConversationalCommand[] {
    if (!Array.isArray(rawCommands)) return []

    const cleaned: ConversationalCommand[] = []
    const seen = new Set<string>()

    for (let index = 0; index < rawCommands.length; index += 1) {
        const item = rawCommands[index] || {}
        const commandName = sanitizeCommandName(item.command_name)
        const commandDescription = trimText(item.command_description)
        const label = `commands[${index}]`

        if (!commandName && !commandDescription) continue
        if (!commandName || !commandDescription) {
            throw new Error(`${label} requires both command_name and command_description`)
        }
        if (commandName.length > COMMAND_NAME_MAX_LENGTH) {
            throw new Error(`${label}.command_name must be at most ${COMMAND_NAME_MAX_LENGTH} characters`)
        }
        if (commandDescription.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
            throw new Error(`${label}.command_description must be at most ${COMMAND_DESCRIPTION_MAX_LENGTH} characters`)
        }
        if (!COMMAND_NAME_REGEX.test(commandName)) {
            throw new Error(`${label}.command_name supports lowercase letters, numbers, underscore, and hyphen only`)
        }
        if (EMOJI_REGEX.test(commandName) || EMOJI_REGEX.test(commandDescription)) {
            throw new Error(`${label} does not support emoji`)
        }
        if (seen.has(commandName)) {
            throw new Error(`Duplicate command_name "${commandName}" is not allowed`)
        }

        seen.add(commandName)
        cleaned.push({
            command_name: commandName,
            command_description: commandDescription
        })
    }

    if (cleaned.length > COMMAND_MAX_COUNT) {
        throw new Error(`commands supports up to ${COMMAND_MAX_COUNT} items`)
    }

    return cleaned
}

function sanitizeConversationalPrompts(rawPrompts: any): string[] {
    if (!Array.isArray(rawPrompts)) return []
    return rawPrompts
        .map((value) => trimText(value))
        .filter(Boolean)
}

function toHttpErrorPayload(error: any, fallback = 'Unexpected error'): {
    status: number
    payload: { success: false; error: string; details?: string[] }
} {
    const statusFromObject = Number(error?.status)
    let status = Number.isFinite(statusFromObject) ? statusFromObject : 500
    const message = trimText(error?.message) || fallback

    if (!Number.isFinite(statusFromObject)) {
        const match = /^WABA API error\s+(\d+):\s*/i.exec(message)
        if (match?.[1]) {
            const parsed = Number.parseInt(match[1], 10)
            if (Number.isFinite(parsed)) status = parsed
        }
    }

    if (!Number.isFinite(status) || status < 400 || status > 599) status = 500

    const graphMessage = trimText(error?.response?.error?.message)
    const graphType = trimText(error?.response?.error?.type)
    const graphCode = error?.response?.error?.code
    const graphSubcode = error?.response?.error?.error_subcode

    const details: string[] = []
    if (graphMessage && graphMessage !== message) details.push(graphMessage)
    if (graphType) details.push(`type=${graphType}`)
    if (graphCode !== undefined && graphCode !== null && String(graphCode).trim()) details.push(`code=${graphCode}`)
    if (graphSubcode !== undefined && graphSubcode !== null && String(graphSubcode).trim()) details.push(`subcode=${graphSubcode}`)

    return {
        status,
        payload: {
            success: false,
            error: message,
            ...(details.length > 0 ? { details } : {})
        }
    }
}

export function registerWabaRoutes(app: Express, ctx: any) {
    const {
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
    } = ctx

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

        let commands: ConversationalCommand[] = []
        let prompts: string[] = []
        try {
            commands = sanitizeConversationalCommands(req.body?.commands)
            prompts = sanitizeConversationalPrompts(req.body?.prompts)
        } catch (validationError: any) {
            return res.status(400).json({ success: false, error: validationError?.message || 'Invalid conversational components payload' })
        }

        const enableWelcomeRaw = req.body?.enable_welcome_message
        const enable_welcome_message = enableWelcomeRaw === undefined ? undefined : Boolean(enableWelcomeRaw)
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
        const normalized = toHttpErrorPayload(error, 'Failed to create utility template')
        if (normalized.status >= 500) {
            console.error('[WABA] Utility template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
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
        const normalized = toHttpErrorPayload(error, 'Failed to create marketing template')
        if (normalized.status >= 500) {
            console.error('[WABA] Marketing template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/template-media/upload-handle', express.raw({ type: () => true, limit: '100mb' }), async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        if (!config) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const appId = readTrimmed(config.appId || process.env.WABA_APP_ID || process.env.APP_ID)
        if (!appId) {
            return res.status(500).json({ success: false, error: 'Missing WABA_APP_ID/APP_ID for resumable uploads.' })
        }

        const rawFileName = req.headers?.['x-file-name']
        const rawFileType = req.headers?.['x-file-type']
        const fileName = Array.isArray(rawFileName) ? readTrimmed(rawFileName[0]) : readTrimmed(rawFileName)
        const fileType = Array.isArray(rawFileType) ? readTrimmed(rawFileType[0]) : readTrimmed(rawFileType)
        const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')

        if (!fileBuffer || fileBuffer.byteLength === 0) {
            return res.status(400).json({ success: false, error: 'File body is required (binary).' })
        }

        const mediaKind = readTrimmed(req.query?.kind || '').toLowerCase()
        if (mediaKind === 'image' && fileType && !fileType.startsWith('image/')) {
            return res.status(400).json({ success: false, error: 'Please upload an image file.' })
        }
        if (mediaKind === 'video' && fileType && !fileType.startsWith('video/')) {
            return res.status(400).json({ success: false, error: 'Please upload a video file.' })
        }

        const { sessionId, headerHandle } = await createTemplateMediaHeaderHandle({
            accessToken: config.accessToken,
            appId,
            apiVersion: config.apiVersion || process.env.WABA_API_VERSION || 'v23.0',
            fileName: fileName || `template_asset_${Date.now()}`,
            fileType: fileType || 'application/octet-stream',
            fileBuffer
        })

        res.json({
            success: true,
            data: {
                sessionId,
                headerHandle,
                fileName: fileName || null,
                fileType: fileType || null,
                size: fileBuffer.byteLength
            }
        })
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
        const normalized = toHttpErrorPayload(error, 'Failed to create authentication template')
        if (normalized.status >= 500) {
            console.error('[WABA] Authentication template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
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
        const componentErrors = validateTemplateSendComponents(components)
        if (componentErrors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid template send components', details: componentErrors })
        }

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

}
