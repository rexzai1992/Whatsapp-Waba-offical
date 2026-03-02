import { supabase } from '../supabase'
import { decryptToken } from '../services/token-vault'
import type { WabaConfig } from './types'
import { WabaClient } from './client'

const DEFAULT_API_VERSION = process.env.WABA_API_VERSION || 'v19.0'

type WabaConfigRow = {
    profile_id?: string
    company_id?: string
    app_id?: string | null
    phone_number_id?: string
    business_id?: string | null
    client_business_id?: string | null
    waba_id?: string | null
    business_account_id?: string | null
    access_token?: string
    access_token_type?: string | null
    access_token_expires_at?: string | null
    token_source?: string | null
    system_user_token?: string | null
    verify_token?: string
    app_secret?: string | null
    api_version?: string | null
    enabled?: boolean | null
    window_reminder_enabled?: boolean | null
    window_reminder_minutes?: number | null
    window_reminder_text?: string | null
}

function rowToConfig(row: WabaConfigRow | null): WabaConfig | null {
    if (!row) return null
    const verifyToken = row.verify_token || process.env.WABA_VERIFY_TOKEN
    const appId = row.app_id || process.env.WABA_APP_ID
    const appSecret = row.app_secret || process.env.WABA_APP_SECRET
    const apiVersion = row.api_version || DEFAULT_API_VERSION
    const wabaId = row.waba_id || row.business_account_id || undefined
    const rawToken = row.system_user_token || row.access_token
    const tokenSource = row.system_user_token
        ? ((row.token_source as WabaConfig['tokenSource'] | null) || 'system_user')
        : ((row.token_source as WabaConfig['tokenSource'] | null) || 'user')

    if (!row.phone_number_id || !rawToken || !verifyToken) return null

    let accessToken: string
    try {
        accessToken = decryptToken(rawToken)
    } catch (err: any) {
        console.warn('[WABA] Failed to decrypt access token for profile', row.profile_id || row.phone_number_id, err?.message || err)
        return null
    }

    return {
        profileId: row.profile_id || row.phone_number_id,
        companyId: row.company_id || row.profile_id || undefined,
        appId: appId || undefined,
        phoneNumberId: row.phone_number_id,
        businessId: row.business_id || undefined,
        clientBusinessId: row.client_business_id || undefined,
        wabaId,
        businessAccountId: wabaId,
        accessToken,
        accessTokenType: row.access_token_type || undefined,
        accessTokenExpiresAt: row.access_token_expires_at || null,
        tokenSource,
        verifyToken,
        appSecret: appSecret || undefined,
        apiVersion,
        windowReminderEnabled: row.window_reminder_enabled ?? false,
        windowReminderMinutes: row.window_reminder_minutes ?? undefined,
        windowReminderText: row.window_reminder_text ?? undefined
    }
}

function envToConfig(): WabaConfig | null {
    const phoneNumberId = process.env.WABA_PHONE_NUMBER_ID
    const accessToken = process.env.WABA_ACCESS_TOKEN || process.env.WABA_TOKEN
    const verifyToken = process.env.WABA_VERIFY_TOKEN

    if (!phoneNumberId || !accessToken || !verifyToken) return null

    return {
        profileId: process.env.WABA_PROFILE_ID || 'default',
        companyId: process.env.WABA_COMPANY_ID || process.env.WABA_PROFILE_ID || 'default',
        appId: process.env.WABA_APP_ID,
        phoneNumberId,
        businessAccountId: process.env.WABA_BUSINESS_ACCOUNT_ID,
        accessToken,
        verifyToken,
        appSecret: process.env.WABA_APP_SECRET,
        apiVersion: process.env.WABA_API_VERSION || DEFAULT_API_VERSION
    }
}

export class WabaRegistry {
    private configsByProfile = new Map<string, WabaConfig>()
    private configsByPhoneNumber = new Map<string, WabaConfig>()
    private clientsByProfile = new Map<string, WabaClient>()
    private lastLoadedAt = 0
    private loading?: Promise<void>
    private loggedDbError = false

    constructor(private refreshIntervalMs = 60_000) {}

    private isStale() {
        return Date.now() - this.lastLoadedAt > this.refreshIntervalMs
    }

    public async refresh(force = false) {
        if (!force && !this.isStale()) return
        if (this.loading) return this.loading

        this.loading = (async () => {
            const configs: WabaConfig[] = []

            try {
                const { data, error } = await supabase
                    .from('waba_configs')
                    .select('*')
                    .eq('enabled', true)

                if (error) {
                    if (!this.loggedDbError) {
                        console.warn('[WABA] Failed to load waba_configs from Supabase:', error.message)
                        this.loggedDbError = true
                    }
                } else if (data && Array.isArray(data)) {
                    data.forEach((row: any) => {
                        const config = rowToConfig(row as WabaConfigRow)
                        if (config) configs.push(config)
                    })
                }
            } catch (err: any) {
                if (!this.loggedDbError) {
                    console.warn('[WABA] Supabase waba_configs unavailable, falling back to env:', err?.message || err)
                    this.loggedDbError = true
                }
            }

            if (configs.length === 0) {
                const envConfig = envToConfig()
                if (envConfig) configs.push(envConfig)
            }

            this.configsByProfile.clear()
            this.configsByPhoneNumber.clear()
            this.clientsByProfile.clear()

            configs.forEach(config => {
                this.configsByProfile.set(config.profileId, config)
                const existingPhoneConfig = this.configsByPhoneNumber.get(config.phoneNumberId)
                if (existingPhoneConfig && existingPhoneConfig.profileId !== config.profileId) {
                    console.warn(
                        `[WABA] Duplicate enabled phone_number_id "${config.phoneNumberId}" found for profiles "${existingPhoneConfig.profileId}" and "${config.profileId}". Keeping "${existingPhoneConfig.profileId}".`
                    )
                } else {
                    this.configsByPhoneNumber.set(config.phoneNumberId, config)
                }
                this.clientsByProfile.set(config.profileId, new WabaClient(config))
            })

            this.lastLoadedAt = Date.now()
        })()

        await this.loading
        this.loading = undefined
    }

    public async getClientByProfile(profileId: string): Promise<WabaClient | null> {
        await this.refresh()
        return this.clientsByProfile.get(profileId) || null
    }

    public async getConfigByProfile(profileId: string): Promise<WabaConfig | null> {
        await this.refresh()
        return this.configsByProfile.get(profileId) || null
    }

    public async getConfigByPhoneNumberId(phoneNumberId: string | undefined | null): Promise<WabaConfig | null> {
        if (!phoneNumberId) return null
        await this.refresh()
        return this.configsByPhoneNumber.get(phoneNumberId) || null
    }

    public async getVerifyTokens(): Promise<string[]> {
        await this.refresh()
        return Array.from(new Set(Array.from(this.configsByProfile.values()).map(c => c.verifyToken)))
    }

    public async getAppSecrets(): Promise<string[]> {
        await this.refresh()
        return Array.from(new Set(Array.from(this.configsByProfile.values()).map(c => c.appSecret).filter(Boolean) as string[]))
    }

    public async getProfileIds(): Promise<string[]> {
        await this.refresh()
        return Array.from(this.configsByProfile.keys())
    }
}
