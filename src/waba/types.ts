export type WabaConfig = {
    profileId: string
    companyId?: string
    appId?: string
    phoneNumberId: string
    businessAccountId?: string
    accessToken: string
    verifyToken: string
    appSecret?: string
    apiVersion: string
    windowReminderEnabled?: boolean
    windowReminderMinutes?: number
    windowReminderText?: string
}

export type WabaMedia = {
    id: string
    mime_type?: string
    sha256?: string
    caption?: string
    filename?: string
    file_size?: number
}

export type WabaInboundMessage = {
    phoneNumberId: string
    from: string
    id: string
    timestamp: number
    type: string
    text?: { body?: string }
    button?: { payload?: string; text?: string }
    interactive?: {
        type?: string
        button_reply?: { id?: string; title?: string }
        list_reply?: { id?: string; title?: string; description?: string }
    }
    image?: WabaMedia
    document?: WabaMedia
    audio?: WabaMedia
    video?: WabaMedia
    contactName?: string
    buttonReplyId?: string
    buttonReplyTitle?: string
    buttonReplyDescription?: string
    raw: any
}

export type WabaStatus = {
    phoneNumberId: string
    id: string
    status: string
    timestamp: number
    recipientId?: string
    conversation?: any
    pricing?: any
    raw: any
}

export type WabaWebhookParseResult = {
    messages: WabaInboundMessage[]
    statuses: WabaStatus[]
}
