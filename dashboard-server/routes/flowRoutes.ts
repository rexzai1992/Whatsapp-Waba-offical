import type { Express } from 'express'

export function registerFlowRoutes(app: Express, ctx: any) {
    const { supabase, getCompanyIdForProfile, parseDateInput, toDayKey, lowerBound, WINDOW_MS } = ctx

    app.get('/health', (_req: any, res: any) => {
        res.send('Dashboard Server Running')
    })

    app.get('/api/flows', async (req: any, res: any) => {
        try {
            const profileId = req.query.profileId || 'default'
            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) return res.json({ workflows: [] })

            const { data, error } = await supabase
                .from('workflows')
                .select('*')
                .eq('company_id', companyId)

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ workflows: data || [] })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/flows', async (req: any, res: any) => {
        try {
            const profileId = req.query.profileId || 'default'
            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) return res.status(400).json({ success: false, error: 'Company not found' })

            const payload = req.body?.workflows || req.body
            if (!Array.isArray(payload)) {
                return res.status(400).json({ success: false, error: 'workflows array required' })
            }

            const toUpsert = payload.map((wf: any) => ({
                id: wf.id,
                company_id: companyId,
                trigger_keyword: wf.trigger_keyword || wf.triggerKeyword || '',
                actions: wf.actions || [],
                builder: wf.builder || null
            }))

            const { error } = await supabase.from('workflows').upsert(toUpsert, { onConflict: 'id' })
            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ success: true })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/api/analytics', async (req: any, res: any) => {
        try {
            const profileId = req.query.profileId || 'default'
            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) {
                return res.status(400).json({ success: false, error: 'Company not found' })
            }

            const now = new Date()
            const startDate = parseDateInput(req.query.start) || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
            const endDate = parseDateInput(req.query.end, true) || now
            if (startDate.getTime() > endDate.getTime()) {
                return res.status(400).json({ success: false, error: 'Invalid date range' })
            }

            const { data: users, error: userError } = await supabase
                .from('users')
                .select('id, tags')
                .eq('company_id', companyId)

            if (userError) {
                return res.status(500).json({ success: false, error: userError.message })
            }

            const allTags = new Set<string>()
            ;(users || []).forEach((u: any) => {
                const tags = Array.isArray(u.tags) ? u.tags : []
                tags.forEach((t: any) => {
                    if (typeof t === 'string' && t.trim()) allTags.add(t.trim())
                })
            })

            const tagFilter = typeof req.query.tag === 'string' ? req.query.tag.trim() : ''
            const filteredUsers = tagFilter
                ? (users || []).filter((u: any) => Array.isArray(u.tags) && u.tags.includes(tagFilter))
                : (users || [])

            const userIds = filteredUsers.map((u: any) => u.id)
            if (userIds.length === 0) {
                return res.json({
                    success: true,
                    data: {
                        totals: { messages_total: 0, messages_sent: 0, workflow_runs: 0, expired_messages: 0 },
                        per_day: [],
                        tags: Array.from(allTags).sort()
                    }
                })
            }

            const startIso = startDate.toISOString()
            const endIso = endDate.toISOString()
            const lookbackIso = new Date(startDate.getTime() - WINDOW_MS).toISOString()

            const fetchMessages = async (fromIso: string, toIso: string) => {
                const chunkSize = 200
                const rows: any[] = []
                for (let i = 0; i < userIds.length; i += chunkSize) {
                    const chunk = userIds.slice(i, i + chunkSize)
                    const { data, error } = await supabase
                        .from('messages')
                        .select('user_id, direction, created_at, workflow_state')
                        .in('user_id', chunk)
                        .gte('created_at', fromIso)
                        .lte('created_at', toIso)

                    if (error) {
                        throw new Error(error.message)
                    }
                    rows.push(...(data || []))
                }
                return rows
            }

            const messagesInRange = await fetchMessages(startIso, endIso)
            const messagesForInbound = await fetchMessages(lookbackIso, endIso)

            const totals = {
                messages_total: 0,
                messages_sent: 0,
                workflow_runs: 0,
                expired_messages: 0
            }

            const perDayMap = new Map<string, { total: number; inbound: number; sent: number }>()

            messagesInRange.forEach((msg: any) => {
                const createdAt = new Date(msg.created_at)
                const dayKey = toDayKey(createdAt)
                const row = perDayMap.get(dayKey) || { total: 0, inbound: 0, sent: 0 }
                row.total += 1
                if (msg.direction === 'out') row.sent += 1
                if (msg.direction === 'in') row.inbound += 1
                perDayMap.set(dayKey, row)

                totals.messages_total += 1
                if (msg.direction === 'out') totals.messages_sent += 1

                if (msg.direction === 'out') {
                    const wfId = msg.workflow_state?.workflow_id || msg.workflow_state?.workflowId
                    const stepIndex = Number(msg.workflow_state?.step_index)
                    if (wfId && (!Number.isFinite(stepIndex) || stepIndex <= 1)) {
                        totals.workflow_runs += 1
                    }
                }
            })

            const inboundMap = new Map<string, number[]>()
            messagesForInbound.forEach((msg: any) => {
                if (msg.direction !== 'in') return
                const arr = inboundMap.get(msg.user_id) || []
                const ts = new Date(msg.created_at).getTime()
                if (!Number.isNaN(ts)) arr.push(ts)
                inboundMap.set(msg.user_id, arr)
            })
            inboundMap.forEach((arr) => arr.sort((a, b) => a - b))

            messagesInRange.forEach((msg: any) => {
                if (msg.direction !== 'out') return
                const outTs = new Date(msg.created_at).getTime()
                if (Number.isNaN(outTs)) return
                const inboundTimes = inboundMap.get(msg.user_id) || []
                const lower = outTs - WINDOW_MS
                const idx = lowerBound(inboundTimes, lower)
                if (idx >= inboundTimes.length || inboundTimes[idx] > outTs) {
                    totals.expired_messages += 1
                }
            })

            const per_day = Array.from(perDayMap.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, row]) => ({
                    date,
                    total: row.total,
                    inbound: row.inbound,
                    sent: row.sent
                }))

            return res.json({
                success: true,
                data: {
                    totals,
                    per_day,
                    tags: Array.from(allTags).sort()
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message || 'Failed to load analytics' })
        }
    })
}
