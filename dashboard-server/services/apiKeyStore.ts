import { createApiKeyVerifier } from '../middleware/auth'
import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type ApiKeyMeta = {
    profileId: string
    name?: string
}

export function createApiKeyStore(filePath: string) {
    let keys = readJsonFile<Record<string, ApiKeyMeta>>(filePath, {})

    const persist = () => writeJsonFile(filePath, keys)

    return {
        getAll: () => keys,
        get: (apiKey: string) => keys[apiKey],
        set: (apiKey: string, value: ApiKeyMeta) => {
            keys[apiKey] = value
            persist()
        },
        remove: (apiKey: string) => {
            delete keys[apiKey]
            persist()
        },
        middleware: createApiKeyVerifier((apiKey) => keys[apiKey])
    }
}
