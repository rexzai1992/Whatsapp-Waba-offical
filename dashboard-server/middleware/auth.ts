import type { NextFunction, Request, Response } from 'express'

export function createApiKeyVerifier(getKeyInfo: (apiKey: string) => any) {
    return (req: Request, res: Response, next: NextFunction) => {
        const apiKeyHeader = req.headers['x-api-key']
        const apiKey = (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader) || (req.query.apiKey as string | undefined)

        if (!apiKey) {
            return res.status(401).json({
                success: false,
                error: 'API key required. Provide via X-API-Key header or apiKey query parameter.'
            })
        }

        const keyInfo = getKeyInfo(String(apiKey))
        if (!keyInfo) {
            return res.status(403).json({
                success: false,
                error: 'Invalid API key'
            })
        }

        ;(req as any).apiKeyInfo = keyInfo
        return next()
    }
}

export function requireSupabaseUser(getUserFromRequest: (req: any, res: any) => Promise<any>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const user = await getUserFromRequest(req, res)
            if (!user) return
            ;(req as any).supabaseUser = user
            return next()
        } catch (error) {
            return next(error)
        }
    }
}
