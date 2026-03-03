import type { WabaClient } from '../waba/client'
import { extractCtaReferralSource, findOrCreateUser, getCompanyFallbackSettings, getLastMessage, getLatestWorkflowMemory, getWorkflowById, getWorkflows, insertMessage, setUserAssignee, updateMessageWorkflowState, updateUserCtaReferral, updateUserLastInbound, updateUserTags } from '../services/wa-store'
import type { User } from '../services/wa-store'
import { sendWhatsAppMessage } from '../services/whatsapp'
import type { WorkflowState } from './types'

export type InboundContext = {
    companyId: string
    profileId: string
    client: WabaClient
    phoneNumber: string
    automationDisabled?: boolean
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

function parseActions(actions: any): any[] {
    if (!Array.isArray(actions)) return []
    return actions as any[]
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

function normalizeVariableKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function sanitizeVars(raw: any): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {}
    const vars: Record<string, string> = {}
    Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
        const normalized = normalizeVariableKey(key)
        if (!normalized) return
        if (value === null || value === undefined) return
        vars[normalized] = String(value)
    })
    return vars
}

function sanitizeQaHistory(raw: any): Array<{ key: string; question: string; answer: string; at: string }> {
    if (!Array.isArray(raw)) return []
    return raw
        .map((entry: any) => ({
            key: normalizeVariableKey(entry?.key),
            question: typeof entry?.question === 'string' ? entry.question : '',
            answer: typeof entry?.answer === 'string' ? entry.answer : '',
            at: typeof entry?.at === 'string' ? entry.at : ''
        }))
        .filter((entry: any) => entry.key && entry.answer)
}

function getInboundAnswer(ctx: InboundContext): string {
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : ''
    if (text) return text
    const buttonTitle = typeof ctx.buttonTitle === 'string' ? ctx.buttonTitle.trim() : ''
    if (buttonTitle) return buttonTitle
    const buttonId = typeof ctx.buttonId === 'string' ? ctx.buttonId.trim() : ''
    if (buttonId) return buttonId
    const caption = typeof ctx.media?.caption === 'string' ? ctx.media.caption.trim() : ''
    if (caption) return caption
    return ''
}

function normalizeChoiceKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function resolveAwaitingButtonId(
    ctx: InboundContext,
    awaitingRaw?: string[] | null
): string | null {
    const rawId = typeof ctx.buttonId === 'string' ? ctx.buttonId.trim() : ''
    const rawTitle = typeof ctx.buttonTitle === 'string' ? ctx.buttonTitle.trim() : ''

    const awaiting = Array.isArray(awaitingRaw)
        ? awaitingRaw.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
        : []

    if (awaiting.length === 0) {
        return rawId || null
    }

    const candidates: string[] = []
    if (rawId) candidates.push(rawId)
    if (rawTitle) candidates.push(rawTitle)

    const normalizedId = normalizeChoiceKey(rawId)
    if (normalizedId && !candidates.includes(normalizedId)) candidates.push(normalizedId)
    const normalizedTitle = normalizeChoiceKey(rawTitle)
    if (normalizedTitle && !candidates.includes(normalizedTitle)) candidates.push(normalizedTitle)

    for (const candidate of candidates) {
        const exact = awaiting.find((value) => value === candidate)
        if (exact) return exact
    }

    const awaitingByLower = new Map<string, string>()
    awaiting.forEach((value) => {
        const lower = value.toLowerCase()
        if (!awaitingByLower.has(lower)) awaitingByLower.set(lower, value)
    })

    for (const candidate of candidates) {
        const match = awaitingByLower.get(candidate.toLowerCase())
        if (match) return match
    }

    if (normalizedTitle) {
        for (const value of awaiting) {
            if (normalizeChoiceKey(value) === normalizedTitle) return value
        }
    }

    return null
}

function resolveDynamicContext(state: WorkflowState, user: User, ctx: InboundContext) {
    const vars = sanitizeVars(state.vars)
    const contactName = (user.name || '').trim()
    const phone = user.phone_number || ctx.phoneNumber || ''
    const context: Record<string, string> = {
        ...vars,
        contact_name: contactName,
        name: contactName,
        phone_number: phone,
        phone,
        workflow_state: state.state || '',
        state: state.state || '',
        inbound_text: getInboundAnswer(ctx)
    }
    return context
}

function renderDynamicText(value: unknown, state: WorkflowState, user: User, ctx: InboundContext): string {
    if (typeof value !== 'string') return ''
    const map = resolveDynamicContext(state, user, ctx)
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, keyRaw) => {
        const key = normalizeVariableKey(String(keyRaw))
        if (!key) return match
        const next = map[key]
        if (next === undefined || next === null) return match
        return String(next)
    })
}

function getConditionLeftValue(action: any, state: WorkflowState, user: User, ctx: InboundContext): string {
    const rawSource = typeof action?.source === 'string' ? action.source.trim() : ''
    if (!rawSource) return ''
    const source = rawSource.toLowerCase()
    const vars = sanitizeVars(state.vars)

    if (source.startsWith('vars.')) {
        const key = normalizeVariableKey(source.slice(5))
        return vars[key] || ''
    }
    if (source.startsWith('contact.')) {
        const field = source.slice(8)
        if (field === 'name') return user.name || ''
        if (field === 'phone' || field === 'phone_number') return user.phone_number || ctx.phoneNumber || ''
        if (field === 'tags') return Array.isArray(user.tags) ? user.tags.join(',') : ''
        if (field === 'last_inbound_at') return user.last_inbound_at || ''
        return ''
    }

    const normalized = normalizeVariableKey(source)
    if (normalized && vars[normalized] !== undefined) return vars[normalized]
    if (normalized === 'contact_name' || normalized === 'name') return user.name || ''
    if (normalized === 'phone' || normalized === 'phone_number') return user.phone_number || ctx.phoneNumber || ''
    if (normalized === 'inbound_text' || normalized === 'last_message') return getInboundAnswer(ctx)
    return ''
}

function evaluateCondition(action: any, state: WorkflowState, user: User, ctx: InboundContext): boolean {
    const left = getConditionLeftValue(action, state, user, ctx)
    const operatorRaw = typeof action?.operator === 'string' ? action.operator.trim().toLowerCase() : ''
    const operator = operatorRaw || 'contains'
    const right = renderDynamicText(
        action?.value === null || action?.value === undefined ? '' : String(action.value),
        state,
        user,
        ctx
    )

    if (operator === 'exists') {
        return left.trim().length > 0
    }
    if (operator === 'equals' || operator === '==') {
        return left.trim().toLowerCase() === right.trim().toLowerCase()
    }
    if (operator === 'not_equals' || operator === '!=') {
        return left.trim().toLowerCase() !== right.trim().toLowerCase()
    }
    if (operator === 'starts_with') {
        return left.trim().toLowerCase().startsWith(right.trim().toLowerCase())
    }
    if (operator === 'greater_than' || operator === '>') {
        const leftNum = Number(left)
        const rightNum = Number(right)
        if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false
        return leftNum > rightNum
    }
    if (operator === 'less_than' || operator === '<') {
        const leftNum = Number(left)
        const rightNum = Number(right)
        if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false
        return leftNum < rightNum
    }

    return left.trim().toLowerCase().includes(right.trim().toLowerCase())
}

export class WorkflowEngine {
    public async processInbound(ctx: InboundContext): Promise<{ error?: string; handled: boolean }> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return { handled: false }

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
        let currentState = (lastMessage?.workflow_state || null) as WorkflowState | null
        const memory = await getLatestWorkflowMemory(user.id)
        if (currentState) {
            currentState.vars = {
                ...sanitizeVars(memory.vars),
                ...sanitizeVars(currentState.vars)
            }
            const existingQa = sanitizeQaHistory(currentState.qa_history)
            if (existingQa.length > 0) {
                currentState.qa_history = existingQa
            } else {
                currentState.qa_history = sanitizeQaHistory(memory.qa_history)
            }
        }
        const isFirstMessage = !lastMessage
        const matchedIncomingButtonId = resolveAwaitingButtonId(ctx, currentState?.awaiting_buttons)
        if (matchedIncomingButtonId) {
            ctx = { ...ctx, buttonId: matchedIncomingButtonId }
        }

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

        // Human takeover can pause all automation while still storing inbound messages.
        if (ctx.automationDisabled) {
            if (inboundRecord?.id && currentState) {
                await updateMessageWorkflowState(inboundRecord.id, currentState)
            }
            return { handled: false }
        }

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
            const awaiting = Boolean(
                (state?.awaiting_buttons && state.awaiting_buttons.length > 0) ||
                state?.awaiting_input?.save_as
            )
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

        if (state?.awaiting_input?.save_as) {
            const answer = getInboundAnswer(ctx)
            const companyFallback = await getCompanyFallbackSettings(ctx.companyId)
            const retryLimit = normalizeFallbackLimit(
                state.awaiting_input.retry_limit,
                normalizeFallbackLimit(companyFallback?.fallback_limit, DEFAULT_FALLBACK_LIMIT)
            )
            if (!answer) {
                const nextFallbackCount = (state.fallback_count || 0) + 1
                state.fallback_count = nextFallbackCount

                if (retryLimit > 0 && nextFallbackCount > retryLimit) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: true }
                }

                const fallbackText =
                    state.awaiting_input.fallback_text ||
                    companyFallback?.fallback_text ||
                    'Please type your answer.'
                const trimmedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : ''
                if (!trimmedFallback) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: true }
                }

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: { text: renderDynamicText(trimmedFallback, state, user, ctx) },
                        workflowState: state
                    })
                } catch (error: any) {
                    console.warn('[Workflow] ask_question fallback failed:', error?.message || error)
                }
                return { handled: true }
            }

            const key = normalizeVariableKey(state.awaiting_input.save_as)
            if (key) {
                const nextVars = {
                    ...sanitizeVars(state.vars),
                    [key]: answer
                }
                state.vars = nextVars
                const nextHistory = sanitizeQaHistory(state.qa_history)
                nextHistory.push({
                    key,
                    question: state.awaiting_input.question || '',
                    answer,
                    at: new Date().toISOString()
                })
                state.qa_history = nextHistory.slice(-100)
            }

            state.awaiting_input = undefined
            state.fallback_count = 0
            if (inboundRecord?.id) {
                await updateMessageWorkflowState(inboundRecord.id, state)
            }
        }

        if (state?.awaiting_buttons && state.awaiting_buttons.length > 0) {
            const awaiting = state.awaiting_buttons
            const matchedButtonId = resolveAwaitingButtonId(ctx, awaiting)
            if (!matchedButtonId) {
                console.warn('[Workflow] Unmatched button reply while awaiting choice', {
                    workflowId: state.workflow_id,
                    stepIndex: state.step_index,
                    incomingButtonId: ctx.buttonId || null,
                    incomingButtonTitle: ctx.buttonTitle || null,
                    awaiting
                })
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
                    return { handled: true }
                }

                const trimmedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : ''
                if (!trimmedFallback) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: true }
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
                return { handled: true }
            }
            if (matchedButtonId !== ctx.buttonId) {
                ctx = { ...ctx, buttonId: matchedButtonId }
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
                    step_index: 0,
                    vars: sanitizeVars(memory.vars),
                    qa_history: sanitizeQaHistory(memory.qa_history)
                }
            }
        }

        if (!workflow || !state) {
            return { handled: false }
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    public async startWorkflow(ctx: InboundContext, workflowId: string): Promise<{ error?: string; handled: boolean }> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return { handled: false }

        const workflow = await getWorkflowById(workflowId)
        if (!workflow) return { error: 'Workflow not found.', handled: false }
        if (workflow.company_id && workflow.company_id !== ctx.companyId) {
            return { error: 'Workflow not found for this company.', handled: false }
        }

        const memory = await getLatestWorkflowMemory(user.id)

        const state: WorkflowState = {
            workflow_id: workflow.id,
            step_index: 0,
            vars: sanitizeVars(memory.vars),
            qa_history: sanitizeQaHistory(memory.qa_history)
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    private async runWorkflowActions(
        ctx: InboundContext,
        user: User,
        workflow: any,
        state: WorkflowState
    ): Promise<{ error?: string; handled: boolean }> {
        state.vars = sanitizeVars(state.vars)
        state.qa_history = sanitizeQaHistory(state.qa_history)

        if (state.awaiting_buttons && state.awaiting_buttons.length > 0) {
            const matchedButtonId = resolveAwaitingButtonId(ctx, state.awaiting_buttons)
            if (!matchedButtonId) return { handled: true }
            state.fallback_count = 0

            const route = resolveRoute(state.awaiting_routes, matchedButtonId)
            if (route?.state) {
                state.state = route.state
            }
            if (route?.next_step !== undefined) {
                state.step_index = route.next_step
            }
        }
        if (state.awaiting_input?.save_as) {
            return { handled: true }
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
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'update_state') {
                state.state = action.state
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'condition') {
                const matched = evaluateCondition(action, state, user, ctx)
                const preferredIndex = matched ? action.true_step : action.false_step
                let nextIndex =
                    typeof preferredIndex === 'number' && preferredIndex >= 0
                        ? preferredIndex
                        : index + 1
                if (nextIndex === index) nextIndex = index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'send_text') {
                state.step_index = index + 1
                try {
                    const mediaType = (action as any)?.media?.type
                    const mediaLink = (action as any)?.media?.link
                    const mediaFilename = (action as any)?.media?.filename
                    const media =
                        (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') &&
                        typeof mediaLink === 'string' &&
                        mediaLink.trim()
                            ? {
                                type: mediaType,
                                link: mediaLink.trim(),
                                ...(mediaType === 'document' && typeof mediaFilename === 'string' && mediaFilename.trim()
                                    ? { filename: mediaFilename.trim() }
                                    : {})
                            }
                            : undefined

                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx),
                            ...(media ? { media } : {}),
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
                if (chainInteractive || (nextAction && ['send_text', 'send_template', 'add_tags', 'assign_staff', 'ask_question', 'condition', 'set_tag', 'update_state'].includes(nextAction.type))) {
                    index = nextIndex
                    continue
                }
                break
            }

            if (action.type === 'ask_question') {
                state.step_index = index + 1
                const variableKey = normalizeVariableKey(action.save_as)
                if (!variableKey) {
                    lastError = 'ask_question failed: save_as is required'
                    break
                }
                const question = renderDynamicText(action.question, state, user, ctx)
                if (!question.trim()) {
                    lastError = 'ask_question failed: question text is required'
                    break
                }
                state.awaiting_input = {
                    save_as: variableKey,
                    question,
                    fallback_text: typeof action.fallback_text === 'string' ? action.fallback_text : undefined,
                    retry_limit: normalizeFallbackLimit(action.retry_limit, DEFAULT_FALLBACK_LIMIT)
                }
                state.fallback_count = 0
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: {
                            text: question
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] ask_question failed:', msg)
                    lastError = `ask_question failed: ${msg}`
                }
                break
            }

            if (action.type === 'send_template') {
                state.step_index = index + 1
                const templateName = renderDynamicText(action.name, state, user, ctx).trim()
                if (!templateName) {
                    lastError = 'send_template failed: template name is required'
                    break
                }
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'template',
                        content: {
                            name: templateName,
                            language: renderDynamicText(
                                (typeof action.language === 'string' && action.language.trim()) ? action.language : 'en_US',
                                state,
                                user,
                                ctx
                            ) || 'en_US',
                            components: Array.isArray(action.components) ? action.components : undefined
                        },
                        workflowState: state
                    })
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_template failed:', msg)
                    lastError = `send_template failed: ${msg}`
                    break
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number'
                        ? (action as any).next_step
                        : index + 1
                if (nextIndex > index && nextIndex < actions.length) {
                    index = nextIndex
                    continue
                }
                break
            }

            if (action.type === 'add_tags') {
                const nextTags = Array.isArray(action.tags)
                    ? action.tags.map((tag: any) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean)
                    : []
                for (const tag of nextTags) {
                    await updateUserTags(user.id, tag)
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'assign_staff') {
                const assigneeUserId = typeof action.assignee_user_id === 'string' ? action.assignee_user_id.trim() : ''
                if (!assigneeUserId) {
                    await setUserAssignee(user.id, null)
                } else {
                    await setUserAssignee(user.id, {
                        userId: assigneeUserId,
                        name: typeof action.assignee_name === 'string' ? action.assignee_name.trim() : assigneeUserId,
                        color: typeof action.assignee_color === 'string' ? action.assignee_color.trim() : '#6b7280'
                    })
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'trigger_workflow') {
                const targetWorkflowId = typeof action.workflow_id === 'string' ? action.workflow_id.trim() : ''
                if (!targetWorkflowId) {
                    lastError = 'trigger_workflow failed: workflow_id is required'
                    break
                }
                if (targetWorkflowId === workflow.id) {
                    lastError = 'trigger_workflow failed: cannot trigger the same workflow.'
                    break
                }
                const targetWorkflow = await getWorkflowById(targetWorkflowId)
                if (!targetWorkflow) {
                    lastError = `trigger_workflow failed: workflow not found (${targetWorkflowId})`
                    break
                }
                if (targetWorkflow.company_id && targetWorkflow.company_id !== ctx.companyId) {
                    lastError = 'trigger_workflow failed: target workflow is outside this company.'
                    break
                }
                const targetState: WorkflowState = {
                    workflow_id: targetWorkflow.id,
                    step_index: 0,
                    vars: sanitizeVars(state.vars),
                    qa_history: sanitizeQaHistory(state.qa_history),
                    ...(state.state ? { state: state.state } : {})
                }
                return this.runWorkflowActions(ctx, user, targetWorkflow, targetState)
            }

            if (action.type === 'send_buttons') {
                state.step_index = index + 1
                const buttons = normalizeButtons(action.buttons || []).map((button: any, buttonIndex: number) => ({
                    id: typeof button?.id === 'string' && button.id.trim() ? button.id.trim() : `option_${buttonIndex + 1}`,
                    title: renderDynamicText(button?.title || '', state, user, ctx) || `Option ${buttonIndex + 1}`
                }))
                state.awaiting_buttons = buttons.map(b => b.id)
                state.awaiting_routes = action.routes
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'buttons',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx),
                            buttons,
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
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
                const sections = Array.isArray(action.sections)
                    ? action.sections.map((section: any) => ({
                        ...(section?.title ? { title: renderDynamicText(section.title, state, user, ctx) } : {}),
                        rows: Array.isArray(section?.rows)
                            ? section.rows.map((row: any, rowIndex: number) => ({
                                id: typeof row?.id === 'string' && row.id.trim() ? row.id.trim() : `row_${rowIndex + 1}`,
                                title: renderDynamicText(row?.title || '', state, user, ctx),
                                ...(row?.description
                                    ? { description: renderDynamicText(row.description, state, user, ctx) }
                                    : {})
                            }))
                            : []
                    }))
                    : []
                const rowIds = extractListRowIds(sections)
                state.awaiting_buttons = rowIds
                state.awaiting_routes = action.routes
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'list',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx),
                            button_text: renderDynamicText(action.button_text, state, user, ctx),
                            sections,
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
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
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'cta_url',
                        content: {
                            body: renderDynamicText(action.body, state, user, ctx),
                            button_text: renderDynamicText(action.button_text, state, user, ctx),
                            url: renderDynamicText(action.url, state, user, ctx),
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
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
                break
            }

            index += 1
            state.step_index = index
        }

        return lastError ? { error: lastError, handled: true } : { handled: true }
    }
}
