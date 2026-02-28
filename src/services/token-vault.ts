import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const TOKEN_PREFIX = 'enc:v1:'
const AAD = Buffer.from('waba-token', 'utf8')

function deriveKey(raw: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, 'hex')
    }

    try {
        const decoded = Buffer.from(raw, 'base64')
        if (decoded.length === 32) return decoded
    } catch (_) {
        // fall through
    }

    return createHash('sha256').update(raw).digest()
}

export function getTokenEncryptionKey(): Buffer | null {
    const raw = process.env.WABA_TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY
    if (!raw) return null
    return deriveKey(raw)
}

export function encryptToken(plaintext: string): string {
    const key = getTokenEncryptionKey()
    if (!key) throw new Error('Missing WABA_TOKEN_ENCRYPTION_KEY')

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(AAD)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return `${TOKEN_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptToken(value: string): string {
    if (!value) return value
    if (!value.startsWith(TOKEN_PREFIX)) return value

    const key = getTokenEncryptionKey()
    if (!key) throw new Error('Missing WABA_TOKEN_ENCRYPTION_KEY')

    const raw = value.slice(TOKEN_PREFIX.length)
    const parts = raw.split(':')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')

    const [ivB64, tagB64, dataB64] = parts
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const data = Buffer.from(dataB64, 'base64')

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()])
    return plaintext.toString('utf8')
}

export function isEncryptedToken(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX)
}
