import fs from 'fs'

export function readJsonFile<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    } catch {
        return fallback
    }
}

export function writeJsonFile(filePath: string, payload: unknown) {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
}
