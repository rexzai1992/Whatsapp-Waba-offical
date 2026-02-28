const DEFAULT_API_VERSION = process.env.WABA_API_VERSION || 'v19.0'

export type GraphTokenResponse = {
    access_token: string
    token_type?: string
    expires_in?: number
}

export type GraphListResponse<T> = {
    data?: T[]
    paging?: any
}

type GraphError = {
    error?: {
        message?: string
        type?: string
        code?: number
        error_subcode?: number
        fbtrace_id?: string
    }
}

function buildGraphUrl(path: string, apiVersion: string, params?: Record<string, string>) {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path
    const url = new URL(`https://graph.facebook.com/${apiVersion}/${cleanPath}`)
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        })
    }
    return url.toString()
}

async function graphRequest(path: string, options: {
    apiVersion?: string
    accessToken?: string
    method?: string
    params?: Record<string, string>
    body?: any
} = {}) {
    const apiVersion = options.apiVersion || DEFAULT_API_VERSION
    const url = path.startsWith('http') ? path : buildGraphUrl(path, apiVersion, options.params)

    const headers: Record<string, string> = {}
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`
    let body: string | undefined

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(options.body)
    }

    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body
    })

    const text = await res.text()
    const data = text ? JSON.parse(text) : null

    if (!res.ok || (data as GraphError)?.error) {
        const errorMessage = (data as GraphError)?.error?.message || res.statusText || 'Graph API error'
        const errorCode = (data as GraphError)?.error?.code
        throw new Error(`Graph API error ${res.status}${errorCode ? ` (${errorCode})` : ''}: ${errorMessage}`)
    }

    return data
}

export async function exchangeCodeForToken(params: {
    appId: string
    appSecret: string
    redirectUri: string
    code: string
    apiVersion?: string
}): Promise<GraphTokenResponse> {
    const apiVersion = params.apiVersion || DEFAULT_API_VERSION
    const url = buildGraphUrl('oauth/access_token', apiVersion, {
        client_id: params.appId,
        client_secret: params.appSecret,
        redirect_uri: params.redirectUri,
        code: params.code
    })

    return graphRequest(url, { method: 'GET' })
}

export async function exchangeForLongLivedToken(params: {
    appId: string
    appSecret: string
    shortLivedToken: string
    apiVersion?: string
}): Promise<GraphTokenResponse> {
    const apiVersion = params.apiVersion || DEFAULT_API_VERSION
    const url = buildGraphUrl('oauth/access_token', apiVersion, {
        grant_type: 'fb_exchange_token',
        client_id: params.appId,
        client_secret: params.appSecret,
        fb_exchange_token: params.shortLivedToken
    })

    return graphRequest(url, { method: 'GET' })
}

export async function fetchBusinesses(accessToken: string, apiVersion?: string) {
    const response = await graphRequest('me/businesses', {
        apiVersion,
        accessToken,
        params: { fields: 'id,name' }
    }) as GraphListResponse<{ id: string; name?: string }>

    return response.data || []
}

export async function fetchOwnedWabaAccounts(businessId: string, accessToken: string, apiVersion?: string) {
    const response = await graphRequest(`${businessId}/owned_whatsapp_business_accounts`, {
        apiVersion,
        accessToken,
        params: { fields: 'id,name' }
    }) as GraphListResponse<{ id: string; name?: string }>

    return response.data || []
}

export async function fetchClientWabaAccounts(businessId: string, accessToken: string, apiVersion?: string) {
    const response = await graphRequest(`${businessId}/client_whatsapp_business_accounts`, {
        apiVersion,
        accessToken,
        params: { fields: 'id,name' }
    }) as GraphListResponse<{ id: string; name?: string }>

    return response.data || []
}

export async function fetchPhoneNumbers(wabaId: string, accessToken: string, apiVersion?: string) {
    const response = await graphRequest(`${wabaId}/phone_numbers`, {
        apiVersion,
        accessToken,
        params: { fields: 'id,display_phone_number,verified_name' }
    }) as GraphListResponse<{ id: string; display_phone_number?: string; verified_name?: string }>

    return response.data || []
}

export async function subscribeWabaApp(wabaId: string, accessToken: string, apiVersion?: string) {
    return graphRequest(`${wabaId}/subscribed_apps`, {
        apiVersion,
        accessToken,
        method: 'POST'
    })
}

export async function unsubscribeWabaApp(wabaId: string, accessToken: string, apiVersion?: string) {
    return graphRequest(`${wabaId}/subscribed_apps`, {
        apiVersion,
        accessToken,
        method: 'DELETE'
    })
}

export async function createSystemUserToken(params: {
    systemUserId: string
    accessToken: string
    scopes: string[]
    apiVersion?: string
}) {
    return graphRequest(`${params.systemUserId}/access_tokens`, {
        apiVersion: params.apiVersion,
        accessToken: params.accessToken,
        method: 'POST',
        body: {
            scope: params.scopes.join(',')
        }
    })
}
