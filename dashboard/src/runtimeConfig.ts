const LOCAL_SOCKET_FALLBACK = 'http://localhost:3000'
const ROOT_DOMAIN = '2fast.xyz'
const RESERVED_SUBDOMAINS = new Set(['www', 'admin', 'myadmin'])

export const getSocketUrl = (): string => {
    const configured = (import.meta.env.VITE_SOCKET_URL || '').trim()
    if (configured) {
        const isLocalConfigured = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured)
        const currentHost = typeof window !== 'undefined' ? (window.location.hostname || '').toLowerCase() : ''
        const isCurrentHostLocal = currentHost === 'localhost' || currentHost === '127.0.0.1'
        if (isLocalConfigured && currentHost && !isCurrentHostLocal) {
            return window.location.origin
        }
        return configured
    }
    if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
    return LOCAL_SOCKET_FALLBACK
}

export const resolveCompanyIdFromLocation = (): string | null => {
    if (typeof window === 'undefined') return null
    const host = (window.location.hostname || '').trim().toLowerCase()
    if (!host) return null
    if (host === ROOT_DOMAIN) return null
    if (host === 'localhost' || /^[0-9.]+$/.test(host)) return null

    const suffix = `.${ROOT_DOMAIN}`
    if (!host.endsWith(suffix)) return null

    const label = host.slice(0, -suffix.length)
    if (!label || label.includes('.')) return null
    if (RESERVED_SUBDOMAINS.has(label)) return null
    if (!/^[a-z0-9-]+$/.test(label)) return null
    return label
}
