import type { WabaConfig } from './types'

const DEFAULT_TIMEOUT_MS = 15000

export class WabaClient {
    private baseUrl: string

    constructor(private config: WabaConfig) {
        this.baseUrl = `https://graph.facebook.com/${config.apiVersion}`
    }

    public get profileId() {
        return this.config.profileId
    }

    public get phoneNumberId() {
        return this.config.phoneNumberId
    }

    public get verifyToken() {
        return this.config.verifyToken
    }

    public get appSecret() {
        return this.config.appSecret
    }

    private normalizeRecipient(to: string) {
        if (!to) return ''
        const withoutDomain = to.includes('@') ? (to.split('@')[0] || '') : to
        return withoutDomain.replace(/\D/g, '')
    }

    private async request(path: string, init: RequestInit & { json?: any } = {}) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.config.accessToken}`
        }

        if (init.json !== undefined) {
            headers['Content-Type'] = 'application/json'
        }

        try {
            const res = await fetch(`${this.baseUrl}/${path}`, {
                ...init,
                body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
                headers: { ...headers, ...(init.headers || {}) },
                signal: controller.signal
            })

            const text = await res.text()
            const data = text ? JSON.parse(text) : null

            if (!res.ok) {
                const errMsg = data?.error?.message || res.statusText
                const error: any = new Error(`WABA API error ${res.status}: ${errMsg}`)
                error.status = res.status
                error.response = data || null
                throw error
            }

            if (data?.error) {
                const errMsg = data?.error?.message || 'Unknown API error'
                const error: any = new Error(`WABA API error: ${errMsg}`)
                error.status = 502
                error.response = data
                throw error
            }

            return data
        } finally {
            clearTimeout(timeout)
        }
    }

    public async sendText(to: string, body: string, previewUrl = false) {
        const payload = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'text',
            text: {
                body,
                preview_url: previewUrl
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendImage(to: string, link: string, caption?: string) {
        const payload = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'image',
            image: {
                link,
                caption: caption || undefined
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendInteractiveButtons(
        to: string,
        bodyText: string,
        buttons: Array<{ id: string; title: string }>,
        options: {
            header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; id?: string; link?: string }
            footer?: string
        } = {}
    ) {
        const interactive: any = {
            type: 'button',
            body: { text: bodyText },
            action: {
                buttons: buttons.map(button => ({
                    type: 'reply',
                    reply: { id: button.id, title: button.title }
                }))
            }
        }

        if (options.header) {
            if (options.header.type === 'text') {
                interactive.header = { type: 'text', text: options.header.text }
            } else {
                const mediaKey = options.header.type
                const payload: any = {}
                if (options.header.id) payload.id = options.header.id
                if (options.header.link) payload.link = options.header.link
                if (Object.keys(payload).length > 0) {
                    interactive.header = { type: options.header.type, [mediaKey]: payload }
                }
            }
        }

        if (options.footer) {
            interactive.footer = { text: options.footer }
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.normalizeRecipient(to),
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendInteractiveList(
        to: string,
        bodyText: string,
        buttonText: string,
        sections: Array<{
            title?: string
            rows: Array<{ id: string; title: string; description?: string }>
        }>,
        options: { header?: { type: 'text'; text: string }; footer?: string } = {}
    ) {
        const normalizedSections = (sections || []).map(section => ({
            ...(section?.title ? { title: section.title } : {}),
            rows: (section?.rows || []).map(row => ({
                id: row.id,
                title: row.title,
                ...(row.description ? { description: row.description } : {})
            }))
        }))

        const interactive: any = {
            type: 'list',
            body: { text: bodyText },
            action: {
                button: buttonText,
                sections: normalizedSections
            }
        }

        if (options.header) {
            interactive.header = { type: 'text', text: options.header.text }
        }

        if (options.footer) {
            interactive.footer = { text: options.footer }
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.normalizeRecipient(to),
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendCtaUrl(
        to: string,
        bodyText: string,
        buttonText: string,
        url: string,
        options: {
            header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; link: string }
            footer?: string
        } = {}
    ) {
        const interactive: any = {
            type: 'cta_url',
            body: { text: bodyText },
            action: {
                name: 'cta_url',
                parameters: {
                    display_text: buttonText,
                    url
                }
            }
        }

        if (options.header) {
            if (options.header.type === 'text') {
                interactive.header = { type: 'text', text: options.header.text }
            } else {
                interactive.header = {
                    type: options.header.type,
                    [options.header.type]: { link: options.header.link }
                }
            }
        }

        if (options.footer) {
            interactive.footer = { text: options.footer }
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: this.normalizeRecipient(to),
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendTemplate(
        to: string,
        name: string,
        language: string,
        components?: any[]
    ) {
        const payload: any = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'template',
            template: {
                name,
                language: { code: language }
            }
        }

        if (components && components.length > 0) {
            payload.template.components = components
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendMarketingTemplate(
        to: string,
        name: string,
        language: string,
        options: {
            components?: any[]
            productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
            messageActivitySharing?: boolean
            ttl?: number
            degreesOfFreedomSpec?: Record<string, any>
        } = {}
    ) {
        const payload: any = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'template',
            template: {
                name,
                language: { code: language }
            }
        }

        if (Array.isArray(options.components) && options.components.length > 0) {
            payload.template.components = options.components
        }

        if (options.productPolicy) payload.product_policy = options.productPolicy
        if (typeof options.messageActivitySharing === 'boolean') {
            payload.message_activity_sharing = options.messageActivitySharing
        }
        if (typeof options.ttl === 'number' && Number.isFinite(options.ttl)) {
            payload.ttl = Math.max(1, Math.floor(options.ttl))
        }
        if (options.degreesOfFreedomSpec && typeof options.degreesOfFreedomSpec === 'object') {
            payload.degrees_of_freedom_spec = options.degreesOfFreedomSpec
        }

        return this.request(`${this.config.phoneNumberId}/marketing_messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendAuthenticationTemplate(
        to: string,
        name: string,
        language: string,
        code: string
    ) {
        const payload: any = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'template',
            template: {
                name,
                language: { code: language },
                components: [
                    {
                        type: 'body',
                        parameters: [{ type: 'text', text: code }]
                    },
                    {
                        type: 'button',
                        sub_type: 'url',
                        index: '0',
                        parameters: [{ type: 'text', text: code }]
                    }
                ]
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async createMessageTemplate(
        wabaId: string,
        payload: {
            name: string
            category: string
            language: string
            parameter_format?: string
            components?: any[]
        }
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        return this.request(`${wabaId}/message_templates`, {
            method: 'POST',
            json: payload
        })
    }

    public async upsertMessageTemplates(wabaId: string, payload: Record<string, any>) {
        if (!wabaId) throw new Error('wabaId is required')
        return this.request(`${wabaId}/upsert_message_templates`, {
            method: 'POST',
            json: payload
        })
    }

    public async getAuthenticationTemplatePreviews(
        wabaId: string,
        options: {
            language?: string[] | string
            addSecurityRecommendation?: boolean
            codeExpirationMinutes?: number
        } = {}
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        const params = new URLSearchParams()
        params.set('category', 'AUTHENTICATION')
        params.set('button_types', 'OTP')
        if (options.language) {
            const language = Array.isArray(options.language) ? options.language.join(',') : options.language
            if (language.trim()) params.set('language', language)
        }
        if (typeof options.addSecurityRecommendation === 'boolean') {
            params.set('add_security_recommendation', String(options.addSecurityRecommendation))
        }
        if (typeof options.codeExpirationMinutes === 'number' && Number.isFinite(options.codeExpirationMinutes)) {
            params.set('code_expiration_minutes', String(Math.max(1, Math.min(90, Math.floor(options.codeExpirationMinutes)))))
        }
        return this.request(`${wabaId}/message_template_previews?${params.toString()}`, {
            method: 'GET'
        })
    }

    public async getMessageTemplate(
        templateId: string,
        fields: string[] = ['id', 'name', 'status', 'category', 'language']
    ) {
        if (!templateId) throw new Error('templateId is required')
        const query = new URLSearchParams()
        if (fields.length > 0) query.set('fields', fields.join(','))
        const suffix = query.toString()
        return this.request(`${templateId}${suffix ? `?${suffix}` : ''}`, {
            method: 'GET'
        })
    }

    public async listMessageTemplates(
        wabaId: string,
        options: {
            fields?: string[] | string
            limit?: number
            status?: string
            category?: string
            name?: string
            after?: string
            before?: string
        } = {}
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        const params = new URLSearchParams()
        if (options.fields) {
            params.set('fields', Array.isArray(options.fields) ? options.fields.join(',') : options.fields)
        }
        if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
            params.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit)))))
        }
        const status = typeof options.status === 'string' ? options.status.trim() : ''
        const category = typeof options.category === 'string' ? options.category.trim() : ''
        const name = typeof options.name === 'string' ? options.name.trim() : ''
        if (status) params.set('status', status)
        if (category) params.set('category', category)
        if (name) params.set('name', name)
        if (options.after) params.set('after', options.after)
        if (options.before) params.set('before', options.before)

        const query = params.toString()
        return this.request(`${wabaId}/message_templates${query ? `?${query}` : ''}`, {
            method: 'GET'
        })
    }

    public async getConversationalAutomation() {
        return this.request(`${this.config.phoneNumberId}?fields=conversational_automation`, {
            method: 'GET'
        })
    }

    public async setConversationalAutomation(payload: {
        enable_welcome_message?: boolean
        commands?: Array<{ command_name: string; command_description: string }>
        prompts?: string[]
    }) {
        return this.request(`${this.config.phoneNumberId}/conversational_automation`, {
            method: 'POST',
            json: payload
        })
    }

    public async getConnectedClientBusinesses(
        appId: string,
        options: {
            fields?: string[] | string
            limit?: number
            after?: string
            before?: string
        } = {}
    ) {
        const params = new URLSearchParams()
        if (options.fields) {
            params.set('fields', Array.isArray(options.fields) ? options.fields.join(',') : options.fields)
        }
        if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
            params.set('limit', String(Math.max(1, Math.min(100, Math.round(options.limit)))))
        }
        if (options.after) params.set('after', options.after)
        if (options.before) params.set('before', options.before)

        const query = params.toString()
        const path = `${appId}/connected_client_businesses${query ? `?${query}` : ''}`
        return this.request(path, { method: 'GET' })
    }

    public async getPhoneNumbers(wabaId?: string) {
        const targetWabaId = wabaId || this.config.wabaId || this.config.businessAccountId
        if (!targetWabaId) {
            throw new Error('WABA ID is required to fetch phone numbers')
        }
        return this.request(`${targetWabaId}/phone_numbers`, {
            method: 'GET'
        })
    }

    public async requestVerificationCode(phoneNumberId: string, codeMethod: 'SMS' | 'VOICE', locale = 'en_US') {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        return this.request(`${phoneNumberId}/request_code`, {
            method: 'POST',
            json: {
                code_method: codeMethod,
                locale
            }
        })
    }

    public async verifyPhoneNumberCode(phoneNumberId: string, code: string) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        if (!code) throw new Error('code is required')
        return this.request(`${phoneNumberId}/verify_code`, {
            method: 'POST',
            json: { code }
        })
    }

    public async registerPhoneNumber(phoneNumberId: string, pin: string) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        if (!pin) throw new Error('pin is required')
        return this.request(`${phoneNumberId}/register`, {
            method: 'POST',
            json: {
                messaging_product: 'whatsapp',
                pin
            }
        })
    }

    public async updateBusinessProfile(phoneNumberId: string, profile: Record<string, any>) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        return this.request(`${phoneNumberId}/whatsapp_business_profile`, {
            method: 'POST',
            json: {
                messaging_product: 'whatsapp',
                ...profile
            }
        })
    }

    public async sendMedia(
        to: string,
        type: 'image' | 'video' | 'audio' | 'document',
        link: string,
        options: { caption?: string; filename?: string; mimeType?: string } = {}
    ) {
        const payload: any = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type,
            [type]: {
                link
            }
        }

        if (options.caption && (type === 'image' || type === 'video' || type === 'document')) {
            payload[type].caption = options.caption
        }

        if (type === 'document' && options.filename) {
            payload[type].filename = options.filename
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async getMediaMetadata(mediaId: string) {
        return this.request(mediaId, { method: 'GET' })
    }

    public async downloadMedia(mediaId: string) {
        const metadata = await this.getMediaMetadata(mediaId)
        const url = metadata?.url
        if (!url) {
            throw new Error('Media URL not found in metadata')
        }

        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.config.accessToken}`
            }
        })

        if (!res.ok) {
            throw new Error(`Media download failed: ${res.status} ${res.statusText}`)
        }

        const arrayBuffer = await res.arrayBuffer()
        return {
            buffer: Buffer.from(arrayBuffer),
            mimeType: metadata?.mime_type || res.headers.get('content-type') || 'application/octet-stream',
            fileName: metadata?.file_name
        }
    }
}
