import type { WabaClient } from '../waba/client'
import { extractCtaReferralSource, findOrCreateUser, getCompanyFallbackSettings, getLastMessage, getWorkflowById, getWorkflows, insertMessage, updateMessageWorkflowState, updateUserCtaReferral, updateUserLastInbound, updateUserTags } from '../services/wa-store'
import type { User } from '../services/wa-store'
import { sendWhatsAppMessage } from '../services/whatsapp'
import type { WorkflowAction, WorkflowState } from './types'

export type InboundContext = {
    companyId: string
    profileId: string
    client: WabaClient
    phoneNumber: string
    messageType: string
    text?: string
    buttonId?: string
    buttonTitle?: string
    media?: {
        id?: string
        mime_type?: string
        caption?: string
        filename?: string
        file_size?: number
    }
    raw?: any
}

function extractInboundReferral(raw: any): any | null {
    if (raw && typeof raw === 'object') {
        if (raw.referral && typeof raw.referral === 'object') return raw.referral
        if (raw.context && typeof raw.context === 'object' && raw.context.referral && typeof raw.context.referral === 'object') {
            return raw.context.referral
        }
    }
    return null
}

function normalizeText(text?: string) {
    return (text || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isFirstMessageTrigger(keyword: string) {
    const cleaned = normalizeText(keyword)
    return cleaned === 'first_message' || cleaned === 'first message' || cleaned === 'firstmessage'
}

function matchTrigger(keyword: string, text: string) {
    const cleanedKeyword = normalizeText(keyword)
    if (!cleanedKeyword) return false
    const normalizedText = normalizeText(text)
    if (!normalizedText) return false
    if (normalizedText === cleanedKeyword) return true
    // If the trigger is a phrase, allow substring match.
    if (cleanedKeyword.includes(' ')) {
        return normalizedText.includes(cleanedKeyword)
    }
    const tokens = normalizedText.split(' ')
    return tokens.includes(cleanedKeyword)
}

function parseActions(actions: any): WorkflowAction[] {
    if (!Array.isArray(actions)) return []
    return actions as WorkflowAction[]
}

function resolveRoute(
    routes: Record<string, number | { next_step?: number; state?: string }> | undefined,
    buttonId: string
) {
    if (!routes) return null
    const route = routes[buttonId]
    if (route === undefined) return null
    if (typeof route === 'number') {
        return { next_step: route }
    }
    return route
}

const MAX_BUTTONS = 3
const DEFAULT_FALLBACK_TEXT = process.env.WORKFLOW_FALLBACK_TEXT || 'Please choose one of the options above.'
const DEFAULT_FALLBACK_LIMIT = (() => {
    const raw = process.env.WORKFLOW_FALLBACK_LIMIT
    if (raw === undefined || raw === null || raw === '') return 3
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 3
    return Math.max(0, Math.floor(parsed))
})()

function normalizeFallbackLimit(value: number | null | undefined, fallback: number) {
    if (value === null || value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(0, Math.floor(parsed))
}

function normalizeButtons(buttons: Array<{ id: string; title: string }> = []) {
    if (buttons.length <= MAX_BUTTONS) return buttons
    console.warn(`[Workflow] Buttons capped at ${MAX_BUTTONS}; trimming ${buttons.length} -> ${MAX_BUTTONS}`)
    return buttons.slice(0, MAX_BUTTONS)
}

function extractListRowIds(
    sections: Array<{ rows: Array<{ id: string }> }> = []
): string[] {
    const ids: string[] = []
    for (const section of sections) {
        const rows = section?.rows || []
        for (const row of rows) {
            if (row?.id) ids.push(row.id)
        }
    }
    return ids
}

export class WorkflowEngine {
    public async processInbound(ctx: InboundContext): Promise<{ error?: string }> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return {}

        const inboundTimestamp = ctx.raw?.timestamp ? Number(ctx.raw.timestamp) * 1000 : null
        const inboundIso = inboundTimestamp && !Number.isNaN(inboundTimestamp)
            ? new Date(inboundTimestamp).toISOString()
            : new Date().toISOString()
        if (inboundTimestamp && !Number.isNaN(inboundTimestamp)) {
            await updateUserLastInbound(user.id, inboundIso)
        } else {
            await updateUserLastInbound(user.id)
        }

        const referral = extractInboundReferral(ctx.raw)
        if (referral) {
            const referralSource = extractCtaReferralSource(referral)
            await updateUserCtaReferral(user.id, inboundIso, referralSource)
        }

        const lastMessage = await getLastMessage(user.id)
        const currentState = (lastMessage?.workflow_state || null) as WorkflowState | null
        const isFirstMessage = !lastMessage

        const inboundRecord = await insertMessage({
            userId: user.id,
            direction: 'in',
            content: {
                type: ctx.messageType,
                text: ctx.text,
                button_id: ctx.buttonId,
                button_title: ctx.buttonTitle,
                media_id: ctx.media?.id,
                mimetype: ctx.media?.mime_type,
                caption: ctx.media?.caption,
                filename: ctx.media?.filename,
                file_size: ctx.media?.file_size,
                referral: referral || null,
                raw: ctx.raw
            },
            workflowState: currentState
        })

        let workflow = null
        let state: WorkflowState | null = currentState

        if (state?.workflow_id) {
            workflow = await getWorkflowById(state.workflow_id)
        }

        // If the saved state points past the end of actions (or to end_flow),
        // treat it as completed so new triggers can start. Keep waiting states alive.
        if (workflow) {
            const actions = parseActions(workflow.actions)
            const stepIndex = state?.step_index ?? 0
            const awaiting = state?.awaiting_buttons && state.awaiting_buttons.length > 0
            const completed =
                actions.length === 0 ||
                (!awaiting && (stepIndex >= actions.length || actions[stepIndex]?.type === 'end_flow'))
            if (completed) {
                workflow = null
                state = null
            }
        } else {
            state = null
        }

        if (state?.awaiting_buttons && state.awaiting_buttons.length > 0) {
            const awaiting = state.awaiting_buttons
            const validButton = ctx.buttonId && awaiting.includes(ctx.buttonId)
            if (!validButton) {
                const actions = workflow ? parseActions(workflow.actions) : []
                const actionIndex = Math.max(0, (state.step_index || 1) - 1)
                const action = actions[actionIndex] as any
                const companyFallback = await getCompanyFallbackSettings(ctx.companyId)
                const fallbackText =
                    action?.fallback_text ||
                    action?.fallback ||
                    companyFallback?.fallback_text ||
                    DEFAULT_FALLBACK_TEXT
                const fallbackLimit = normalizeFallbackLimit(
                    companyFallback?.fallback_limit,
                    DEFAULT_FALLBACK_LIMIT
                )

                const nextFallbackCount = (state.fallback_count || 0) + 1
                state.fallback_count = nextFallbackCount
                if (fallbackLimit > 0 && nextFallbackCount > fallbackLimit) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return {}
                }

                const trimmedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : ''
                if (!trimmedFallback) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return {}
                }

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: { text: trimmedFallback },
                        workflowState: state
                    })
                } catch (error: any) {
                    console.warn('[Workflow] fallback message failed:', error?.message || error)
                }
                return {}
            }
        }

        const canUseTrigger = !workflow || (state?.awaiting_buttons && !ctx.buttonId)
        if (canUseTrigger) {
            const workflows = await getWorkflows(ctx.companyId)
            let triggered: any = null
            let bestLen = -1
            for (const wf of workflows) {
                const key = normalizeText(wf?.trigger_keyword || '')
                if (!key) continue
                let matched = false
                if (isFirstMessage && isFirstMessageTrigger(key)) {
                    matched = true
                } else if (ctx.text) {
                    matched = matchTrigger(key, ctx.text)
                }
                if (!matched) continue
                if (key.length > bestLen) {
                    bestLen = key.length
                    triggered = wf
                }
            }
            if (triggered) {
                workflow = triggered
                state = {
                    workflow_id: triggered.id,
                    step_index: 0
                }
            }
        }

        if (!workflow || !state) {
            return {}
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    public async startWorkflow(ctx: InboundContext, workflowId: string): Promise<{ error?: string }> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return {}

        const workflow = await getWorkflowById(workflowId)
        if (!workflow) return { error: 'Workflow not found.' }
        if (workflow.company_id && workflow.company_id !== ctx.companyId) {
            return { error: 'Workflow not found for this company.' }
        }

        const state: WorkflowState = {
            workflow_id: workflow.id,
            step_index: 0
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    private async runWorkflowActions(
        ctx: InboundContext,
        user: User,
        workflow: any,
        state: WorkflowState
    ): Promise<{ error?: string }> {
        if (state.awaiting_buttons && state.awaiting_buttons.length > 0) {
            if (!ctx.buttonId) return {}
            if (!state.awaiting_buttons.includes(ctx.buttonId)) return {}
            state.fallback_count = 0

            const route = resolveRoute(state.awaiting_routes, ctx.buttonId)
            if (route?.state) {
                state.state = route.state
            }
            if (route?.next_step !== undefined) {
                state.step_index = route.next_step
            }
        }

        state.awaiting_buttons = undefined
        state.awaiting_routes = undefined

        const actions = parseActions(workflow.actions)
        let index = state.step_index || 0
        let lastError: string | null = null
        let safety = 0
        const maxSteps = Math.max(actions.length * 3, 50)

        while (index < actions.length) {
            if (safety++ > maxSteps) {
                lastError = 'Workflow aborted: too many steps without waiting for input.'
                break
            }
            const action = actions[index]

            if (action.type === 'set_tag') {
                await updateUserTags(user.id, action.tag)
                index += 1
                state.step_index = index
                continue
            }

            if (action.type === 'update_state') {
                state.state = action.state
                index += 1
                state.step_index = index
                continue
            }

            if (action.type === 'send_text') {
                state.step_index = index + 1
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: {
                            text: action.text,
                            template: action.template
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_text failed:', msg)
                    lastError = `send_text failed: ${msg}`
                    break
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number'
                        ? (action as any).next_step
                        : index + 1
                const nextAction = actions[nextIndex]
                const chainInteractive =
                    nextAction &&
                    ['send_buttons', 'send_list', 'send_cta_url'].includes(nextAction.type)
                if (chainInteractive || (nextAction && nextAction.type === 'send_text')) {
                    index = nextIndex
                    continue
                }
                break
            }

            if (action.type === 'send_buttons') {
                state.step_index = index + 1
                const buttons = normalizeButtons(action.buttons || [])
                state.awaiting_buttons = buttons.map(b => b.id)
                state.awaiting_routes = action.routes

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'buttons',
                        content: {
                            text: action.text,
                            buttons,
                            header: action.header,
                            footer: action.footer,
                            template: action.template
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_buttons failed:', msg)
                    lastError = `send_buttons failed: ${msg}`
                }

                break
            }

            if (action.type === 'send_list') {
                state.step_index = index + 1
                const rowIds = extractListRowIds(action.sections || [])
                state.awaiting_buttons = rowIds
                state.awaiting_routes = action.routes

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'list',
                        content: {
                            text: action.text,
                            button_text: action.button_text,
                            sections: action.sections,
                            header: action.header,
                            footer: action.footer,
                            template: action.template
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_list failed:', msg)
                    lastError = `send_list failed: ${msg}`
                }

                break
            }

            if (action.type === 'send_cta_url') {
                state.step_index = index + 1
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'cta_url',
                        content: {
                            body: action.body,
                            button_text: action.button_text,
                            url: action.url,
                            header: action.header,
                            footer: action.footer,
                            template: action.template
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_cta_url failed:', msg)
                    lastError = `send_cta_url failed: ${msg}`
                }
                break
            }

            if (action.type === 'end_flow') {
                state = null
                break
            }

            index += 1
            state.step_index = index
        }

        if (index >= actions.length) {
            state = null
        }

        return lastError ? { error: lastError } : {}
    }
}
