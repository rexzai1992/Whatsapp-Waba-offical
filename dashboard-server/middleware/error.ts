import type { NextFunction, Request, Response } from 'express'

export class HttpError extends Error {
    status: number
    expose: boolean

    constructor(status: number, message: string, expose = true) {
        super(message)
        this.name = 'HttpError'
        this.status = status
        this.expose = expose
    }
}

export const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<any>) => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(handler(req, res, next)).catch(next)
    }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
    const status = Number(err?.status) || 500
    const message = err?.message || 'Internal server error'
    const expose = typeof err?.expose === 'boolean' ? err.expose : status < 500

    if (status >= 500) {
        console.error('[HTTP ERROR]', err)
    }

    return res.status(status).json({
        success: false,
        error: expose ? message : 'Internal server error'
    })
}
