import type { Express } from 'express'
import { buildInvoicePdf } from '../services/invoicePdf'

type InvoiceStatus = 'draft' | 'generated' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled'

type NormalizedInvoiceItem = {
    item_name: string
    description: string | null
    quantity: number
    unit_price: number
    line_total: number
}

const VALID_STATUSES = new Set<InvoiceStatus>(['draft', 'generated', 'sent', 'viewed', 'paid', 'overdue', 'cancelled'])
const SAFE_INVOICE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_PUBLIC_SEGMENTS = new Set(['api', 'assets', 'addon', 'socket.io', 'auth', 'webhook'])

function readTrimmed(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100
}

function parseMoney(value: any): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    return roundMoney(parsed)
}

function parsePositiveQuantity(value: any): number | null {
    const parsed = parseMoney(value)
    if (parsed === null || parsed <= 0) return null
    return parsed
}

function normalizeCurrency(input: any, fallback = 'USD'): string {
    const raw = readTrimmed(input).toUpperCase()
    if (!raw) return fallback
    if (!/^[A-Z]{3,8}$/.test(raw)) return fallback
    return raw
}

function normalizeInvoicePrefix(input: any, fallback = 'INV'): string {
    const raw = readTrimmed(input).toUpperCase()
    if (!raw) return fallback
    const cleaned = raw.replace(/[^A-Z0-9_-]/g, '')
    return cleaned.slice(0, 16) || fallback
}

function normalizeInvoiceName(value: any): string {
    const raw = readTrimmed(value)
    if (!raw) return ''
    const slug = raw
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 128)
    if (!slug) return ''
    if (SAFE_INVOICE_NAME_REGEX.test(slug)) return slug
    return ''
}

function parseDateOnly(value: any, fallback?: string): string | null {
    const raw = readTrimmed(value)
    if (!raw) return fallback || null
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed.toISOString().slice(0, 10)
}

function buildStoragePath(companyId: string, invoiceName: string): string {
    return `${companyId}/invoice/${invoiceName}.pdf`
}

function buildPublicPath(companyId: string, invoiceName: string): string {
    return `/${companyId}/invoice/${encodeURIComponent(invoiceName)}`
}

function resolveBaseUrl(req: any): string {
    const raw = readTrimmed(process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL)
    if (raw) return raw.replace(/\/+$/, '')
    return `${req.protocol}://${req.get('host')}`
}

function isUniqueViolation(error: any): boolean {
    const message = String(error?.message || '')
    return error?.code === '23505' || /duplicate|unique/i.test(message)
}

function isObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function sanitizePathSegment(value: any): string {
    return readTrimmed(value).toLowerCase()
}

function buildCompanySnapshot(company: any) {
    return {
        logo_url: company?.logo_url || null,
        business_name: company?.name || null,
        registration_number: company?.registration_number || null,
        address: company?.address || null,
        email: company?.email || null,
        phone: company?.phone || null
    }
}

function buildClientSnapshot(client: any) {
    return {
        name: client?.name || null,
        phone: client?.phone || null,
        email: client?.email || null
    }
}

function normalizeItems(rawItems: any): { items: NormalizedInvoiceItem[]; errors: string[] } {
    if (!Array.isArray(rawItems)) {
        return { items: [], errors: ['items must be an array'] }
    }

    const items: NormalizedInvoiceItem[] = []
    const errors: string[] = []

    rawItems.forEach((item: any, index: number) => {
        const name = readTrimmed(item?.item_name || item?.itemName || item?.name)
        const descriptionRaw = readTrimmed(item?.description)
        const quantity = parsePositiveQuantity(item?.quantity)
        const unitPrice = parseMoney(item?.unit_price ?? item?.unitPrice)

        if (!name) {
            errors.push(`Item #${index + 1}: item name is required`)
            return
        }
        if (quantity === null) {
            errors.push(`Item #${index + 1}: quantity must be > 0`)
            return
        }
        if (unitPrice === null || unitPrice < 0) {
            errors.push(`Item #${index + 1}: unit price must be >= 0`)
            return
        }

        const lineTotal = roundMoney(quantity * unitPrice)
        items.push({
            item_name: name.slice(0, 255),
            description: descriptionRaw ? descriptionRaw.slice(0, 2000) : null,
            quantity,
            unit_price: unitPrice,
            line_total: lineTotal
        })
    })

    return { items, errors }
}

function computeTotals(items: NormalizedInvoiceItem[], rawDiscount: any, rawTax: any) {
    const subtotal = roundMoney(items.reduce((sum, item) => sum + item.line_total, 0))
    const discountInput = parseMoney(rawDiscount) ?? 0
    const taxInput = parseMoney(rawTax) ?? 0
    const discount = roundMoney(Math.max(0, Math.min(discountInput, subtotal)))
    const tax = roundMoney(Math.max(0, taxInput))
    const total = roundMoney(Math.max(0, subtotal - discount + tax))
    return { subtotal, discount, tax, total }
}

function normalizeClientFromBody(input: any): { name: string; phone: string | null; email: string | null } | null {
    if (!isObject(input)) return null
    const name = readTrimmed(input.name)
    if (!name) return null
    const phone = readTrimmed(input.phone)
    const email = readTrimmed(input.email).toLowerCase()
    return {
        name: name.slice(0, 255),
        phone: phone ? phone.slice(0, 64) : null,
        email: email ? email.slice(0, 255) : null
    }
}

function isOverdue(invoice: any): boolean {
    if (!invoice?.due_date) return false
    if (invoice?.status === 'paid' || invoice?.status === 'cancelled') return false
    const dueDate = new Date(`${invoice.due_date}T23:59:59.999Z`)
    if (Number.isNaN(dueDate.getTime())) return false
    return Date.now() > dueDate.getTime()
}

async function generateNextInvoiceNumber(ctx: any, companyId: string, prefixInput: string): Promise<string> {
    const prefix = normalizeInvoicePrefix(prefixInput || 'INV')
    const { supabase } = ctx
    const { data, error } = await supabase
        .from('invoices')
        .select('invoice_number')
        .eq('company_id', companyId)
        .ilike('invoice_number', `${prefix}-%`)
        .order('created_at', { ascending: false })
        .limit(200)

    if (error) {
        throw new Error(`Failed to generate invoice number: ${error.message}`)
    }

    const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]+)$`)
    let max = 0
    ;(data || []).forEach((row: any) => {
        const number = readTrimmed(row?.invoice_number)
        const match = regex.exec(number)
        if (!match?.[1]) return
        const parsed = Number.parseInt(match[1], 10)
        if (Number.isFinite(parsed)) max = Math.max(max, parsed)
    })
    return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function buildPublicInvoicePayload(req: any, invoice: any) {
    const publicPath = buildPublicPath(invoice.company_id, invoice.invoice_name)
    const publicUrl = `${resolveBaseUrl(req)}${publicPath}`
    return { publicPath, publicUrl }
}

function renderInvoicePreviewHtml(args: {
    invoice: any
    pdfUrl: string
    title: string
    companyName: string
    clientName: string
    totalText: string
}) {
    const { invoice, pdfUrl, title, companyName, clientName, totalText } = args
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
    color: #0f172a;
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 20px; }
  .card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
    overflow: hidden;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    padding: 20px;
    border-bottom: 1px solid #e2e8f0;
  }
  .kicker {
    margin: 0 0 6px;
    font-size: 12px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #64748b;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    line-height: 1.2;
  }
  .meta {
    font-size: 13px;
    color: #334155;
    line-height: 1.5;
    text-align: right;
  }
  .meta strong { color: #0f172a; }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid #e2e8f0;
    background: #f8fafc;
  }
  .btn {
    display: inline-block;
    text-decoration: none;
    padding: 10px 14px;
    border-radius: 10px;
    font-weight: 700;
    font-size: 13px;
  }
  .btn.primary { background: #0f172a; color: #fff; }
  .btn.ghost { border: 1px solid #cbd5e1; color: #0f172a; background: #fff; }
  .frame {
    width: 100%;
    height: min(74vh, 920px);
    border: 0;
    background: #fff;
  }
  @media (max-width: 700px) {
    .head { flex-direction: column; }
    .meta { text-align: left; }
    .frame { height: 68vh; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div>
          <p class="kicker">Invoice</p>
          <h1>${escapeHtml(title)}</h1>
          <p style="margin: 8px 0 0; color:#475569; font-size:14px;">
            ${escapeHtml(companyName)} to ${escapeHtml(clientName)}
          </p>
        </div>
        <div class="meta">
          <div><strong>No:</strong> ${escapeHtml(invoice.invoice_number || '-')}</div>
          <div><strong>Date:</strong> ${escapeHtml(invoice.invoice_date || '-')}</div>
          <div><strong>Status:</strong> ${escapeHtml(invoice.status || '-')}</div>
          <div><strong>Total:</strong> ${escapeHtml(totalText)}</div>
        </div>
      </div>
      <div class="actions">
        <a class="btn primary" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener noreferrer">Open PDF</a>
        <a class="btn ghost" href="?download=1">Download PDF</a>
      </div>
      <iframe class="frame" src="${escapeHtml(pdfUrl)}"></iframe>
    </div>
  </div>
</body>
</html>`
}

async function loadInvoiceWithItems(ctx: any, companyId: string, invoiceId: string) {
    const { supabase } = ctx
    const { data: invoice, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle()
    if (error) throw new Error(error.message)
    if (!invoice) return null

    const { data: items, error: itemsError } = await supabase
        .from('invoice_items')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('item_index', { ascending: true })
        .order('created_at', { ascending: true })
    if (itemsError) throw new Error(itemsError.message)

    return { invoice, items: items || [] }
}

function resolveInvoiceStatus(input: any): InvoiceStatus | null {
    const value = readTrimmed(input).toLowerCase() as InvoiceStatus
    if (!value) return null
    return VALID_STATUSES.has(value) ? value : null
}

export function registerInvoiceRoutes(app: Express, ctx: any) {
    const {
        requireSupabaseUserMiddleware,
        resolveCompanyAccess,
        supabase
    } = ctx

    app.get('/api/company/invoice-preset', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const { data, error } = await supabase
                .from('company')
                .select(`
                    id,
                    name,
                    email,
                    logo_url,
                    registration_number,
                    address,
                    phone,
                    default_currency,
                    default_invoice_prefix,
                    default_invoice_notes,
                    default_payment_instructions,
                    invoice_template_name,
                    invoice_template_config
                `)
                .eq('id', access.companyId)
                .maybeSingle()

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Company profile not found' })
            }

            res.json({
                success: true,
                data: {
                    company_id: data.id,
                    company_name: data.name,
                    email: data.email || null,
                    logo: data.logo_url || null,
                    registration_number: data.registration_number || null,
                    address: data.address || null,
                    phone: data.phone || null,
                    default_currency: normalizeCurrency(data.default_currency, 'USD'),
                    default_invoice_prefix: normalizeInvoicePrefix(data.default_invoice_prefix, 'INV'),
                    default_notes: data.default_invoice_notes || null,
                    default_payment_instructions: data.default_payment_instructions || null,
                    template_name: data.invoice_template_name || 'default',
                    template_config: data.invoice_template_config || {}
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/company/invoice-preset', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'admin')
            if (!access) return

            const payload = {
                logo_url: readTrimmed(req.body?.logo || req.body?.logo_url) || null,
                registration_number: readTrimmed(req.body?.registration_number || req.body?.registrationNumber) || null,
                address: readTrimmed(req.body?.address) || null,
                email: readTrimmed(req.body?.email).toLowerCase() || null,
                phone: readTrimmed(req.body?.phone) || null,
                default_currency: normalizeCurrency(req.body?.default_currency || req.body?.defaultCurrency || 'USD'),
                default_invoice_prefix: normalizeInvoicePrefix(req.body?.default_invoice_prefix || req.body?.defaultInvoicePrefix || 'INV'),
                default_invoice_notes: readTrimmed(req.body?.default_notes || req.body?.default_invoice_notes) || null,
                default_payment_instructions: readTrimmed(req.body?.default_payment_instructions || req.body?.defaultPaymentInstructions) || null,
                invoice_template_name: readTrimmed(req.body?.template_name || req.body?.invoice_template_name || 'default') || 'default',
                invoice_template_config: isObject(req.body?.template_config || req.body?.invoice_template_config)
                    ? (req.body.template_config || req.body.invoice_template_config)
                    : {}
            }

            const { data, error } = await supabase
                .from('company')
                .update(payload)
                .eq('id', access.companyId)
                .select(`
                    id,
                    name,
                    email,
                    logo_url,
                    registration_number,
                    address,
                    phone,
                    default_currency,
                    default_invoice_prefix,
                    default_invoice_notes,
                    default_payment_instructions,
                    invoice_template_name,
                    invoice_template_config
                `)
                .maybeSingle()

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Company profile not found' })
            }

            res.json({
                success: true,
                data: {
                    company_id: data.id,
                    company_name: data.name,
                    email: data.email || null,
                    logo: data.logo_url || null,
                    registration_number: data.registration_number || null,
                    address: data.address || null,
                    phone: data.phone || null,
                    default_currency: data.default_currency || 'USD',
                    default_invoice_prefix: data.default_invoice_prefix || 'INV',
                    default_notes: data.default_invoice_notes || null,
                    default_payment_instructions: data.default_payment_instructions || null,
                    template_name: data.invoice_template_name || 'default',
                    template_config: data.invoice_template_config || {}
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/invoices/draft', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const { data: company, error: companyError } = await supabase
                .from('company')
                .select('id, name, email, logo_url, registration_number, address, phone, default_currency, default_invoice_prefix, default_invoice_notes, default_payment_instructions')
                .eq('id', access.companyId)
                .maybeSingle()

            if (companyError) {
                return res.status(500).json({ success: false, error: companyError.message })
            }
            if (!company) {
                return res.status(400).json({ success: false, error: 'Company profile must exist before creating invoices' })
            }

            const normalized = normalizeItems(Array.isArray(req.body?.items) ? req.body.items : [])
            if (normalized.errors.length > 0) {
                return res.status(400).json({ success: false, error: normalized.errors.join('; ') })
            }
            const items = normalized.items

            const totals = computeTotals(items, req.body?.discount, req.body?.tax)
            const fallbackDate = new Date().toISOString().slice(0, 10)
            const invoiceDate = parseDateOnly(req.body?.invoice_date || req.body?.invoiceDate, fallbackDate)
            if (!invoiceDate) {
                return res.status(400).json({ success: false, error: 'invoice_date is invalid' })
            }

            const dueDate = parseDateOnly(req.body?.due_date || req.body?.dueDate, null)
            if ((req.body?.due_date || req.body?.dueDate) && !dueDate) {
                return res.status(400).json({ success: false, error: 'due_date is invalid' })
            }

            const prefix = normalizeInvoicePrefix(
                req.body?.invoice_prefix || req.body?.invoicePrefix || company.default_invoice_prefix || 'INV',
                'INV'
            )
            const providedInvoiceNumber = readTrimmed(req.body?.invoice_number || req.body?.invoiceNumber)
            const invoiceTitleInput = readTrimmed(req.body?.invoice_title || req.body?.invoiceTitle)
            const providedInvoiceName = normalizeInvoiceName(req.body?.invoice_name || req.body?.invoiceName)
            const currency = normalizeCurrency(req.body?.currency || company.default_currency || 'USD', 'USD')

            if (readTrimmed(req.body?.invoice_name || req.body?.invoiceName) && !providedInvoiceName) {
                return res.status(400).json({
                    success: false,
                    error: 'invoice_name contains unsupported characters. Use letters, numbers, dot, underscore, or hyphen.'
                })
            }

            let clientId: string | null = readTrimmed(req.body?.client_id || req.body?.clientId) || null
            let clientPayload = normalizeClientFromBody(req.body?.client)

            if (clientId) {
                const { data: existingClient, error: clientError } = await supabase
                    .from('clients')
                    .select('id, name, phone, email')
                    .eq('id', clientId)
                    .eq('company_id', access.companyId)
                    .maybeSingle()
                if (clientError) {
                    return res.status(500).json({ success: false, error: clientError.message })
                }
                if (!existingClient) {
                    return res.status(404).json({ success: false, error: 'client_id not found for this company' })
                }
                clientPayload = {
                    name: existingClient.name,
                    phone: existingClient.phone || null,
                    email: existingClient.email || null
                }
            } else if (clientPayload && req.body?.save_client === true) {
                const { data: createdClient, error: createClientError } = await supabase
                    .from('clients')
                    .insert({
                        company_id: access.companyId,
                        name: clientPayload.name,
                        phone: clientPayload.phone,
                        email: clientPayload.email
                    })
                    .select('id, name, phone, email')
                    .single()
                if (createClientError) {
                    return res.status(500).json({ success: false, error: createClientError.message })
                }
                clientId = createdClient.id
            }

            if (!clientPayload) {
                clientPayload = {
                    name: 'Client',
                    phone: null,
                    email: null
                }
            }

            let createdInvoice: any = null
            let invoiceInsertError: any = null
            const attempts = 5
            const notes = readTrimmed(req.body?.notes || company.default_invoice_notes || '')
            const paymentInstructions = readTrimmed(
                req.body?.payment_instructions || req.body?.paymentInstructions || company.default_payment_instructions || ''
            )

            for (let i = 0; i < attempts; i += 1) {
                const generatedInvoiceNumber = providedInvoiceNumber || await generateNextInvoiceNumber(ctx, access.companyId, prefix)
                const invoiceName = providedInvoiceName || normalizeInvoiceName(generatedInvoiceNumber)
                if (!invoiceName) {
                    return res.status(400).json({ success: false, error: 'Unable to derive invoice_name from invoice number' })
                }

                const invoiceTitle = invoiceTitleInput || invoiceName
                const publicData = buildPublicInvoicePayload(req, { company_id: access.companyId, invoice_name: invoiceName })
                const insertPayload = {
                    company_id: access.companyId,
                    client_id: clientId,
                    invoice_name: invoiceName,
                    invoice_number: generatedInvoiceNumber,
                    invoice_title: invoiceTitle,
                    invoice_date: invoiceDate,
                    due_date: dueDate,
                    currency,
                    company_snapshot: buildCompanySnapshot(company),
                    client_snapshot: buildClientSnapshot(clientPayload),
                    subtotal: totals.subtotal,
                    discount: totals.discount,
                    tax: totals.tax,
                    total: totals.total,
                    notes: notes || null,
                    payment_instructions: paymentInstructions || null,
                    public_path: publicData.publicPath,
                    public_url: publicData.publicUrl,
                    status: 'draft',
                    updated_at: new Date().toISOString()
                }

                const { data: inserted, error: insertError } = await supabase
                    .from('invoices')
                    .insert(insertPayload)
                    .select('*')
                    .single()

                if (!insertError && inserted) {
                    createdInvoice = inserted
                    invoiceInsertError = null
                    break
                }

                invoiceInsertError = insertError
                if (!isUniqueViolation(insertError)) break
                const message = String(insertError?.message || '').toLowerCase()
                if (message.includes('invoice_name')) {
                    return res.status(409).json({
                        success: false,
                        error: 'invoice_name already exists for this company'
                    })
                }
                if (providedInvoiceNumber || !message.includes('invoice_number')) {
                    return res.status(409).json({
                        success: false,
                        error: 'invoice_number already exists for this company'
                    })
                }
            }

            if (!createdInvoice) {
                return res.status(500).json({
                    success: false,
                    error: invoiceInsertError?.message || 'Failed to create invoice draft'
                })
            }

            if (items.length > 0) {
                const { error: itemsInsertError } = await supabase
                    .from('invoice_items')
                    .insert(items.map((item, index) => ({
                        invoice_id: createdInvoice.id,
                        item_index: index,
                        item_name: item.item_name,
                        description: item.description,
                        quantity: item.quantity,
                        unit_price: item.unit_price,
                        line_total: item.line_total
                    })))

                if (itemsInsertError) {
                    await supabase.from('invoices').delete().eq('id', createdInvoice.id)
                    return res.status(500).json({ success: false, error: itemsInsertError.message })
                }
            }

            const readyForWabaUrl = createdInvoice.waba_document_url || createdInvoice.public_url
            res.json({
                success: true,
                data: {
                    invoice: createdInvoice,
                    items,
                    outputs: {
                        company_id: access.companyId,
                        invoice_name: createdInvoice.invoice_name,
                        pdf_path: createdInvoice.pdf_path || null,
                        public_path: createdInvoice.public_path,
                        public_url: createdInvoice.public_url,
                        waba_document_url: readyForWabaUrl
                    }
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/invoices/:invoiceId/items', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const invoiceId = readTrimmed(req.params?.invoiceId)
            if (!invoiceId) {
                return res.status(400).json({ success: false, error: 'invoiceId is required' })
            }

            const normalized = normalizeItems(req.body?.items)
            if (normalized.errors.length > 0) {
                return res.status(400).json({ success: false, error: normalized.errors.join('; ') })
            }

            const loaded = await loadInvoiceWithItems(ctx, access.companyId, invoiceId)
            if (!loaded) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }

            const totals = computeTotals(
                normalized.items,
                req.body?.discount !== undefined ? req.body.discount : loaded.invoice.discount,
                req.body?.tax !== undefined ? req.body.tax : loaded.invoice.tax
            )

            const { error: deleteError } = await supabase
                .from('invoice_items')
                .delete()
                .eq('invoice_id', invoiceId)
            if (deleteError) {
                return res.status(500).json({ success: false, error: deleteError.message })
            }

            if (normalized.items.length > 0) {
                const { error: insertError } = await supabase
                    .from('invoice_items')
                    .insert(normalized.items.map((item, index) => ({
                        invoice_id: invoiceId,
                        item_index: index,
                        item_name: item.item_name,
                        description: item.description,
                        quantity: item.quantity,
                        unit_price: item.unit_price,
                        line_total: item.line_total
                    })))
                if (insertError) {
                    return res.status(500).json({ success: false, error: insertError.message })
                }
            }

            const nextStatus = isOverdue(loaded.invoice) ? 'overdue' : loaded.invoice.status
            const { data: updatedInvoice, error: updateError } = await supabase
                .from('invoices')
                .update({
                    subtotal: totals.subtotal,
                    discount: totals.discount,
                    tax: totals.tax,
                    total: totals.total,
                    status: nextStatus,
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoiceId)
                .eq('company_id', access.companyId)
                .select('*')
                .single()
            if (updateError) {
                return res.status(500).json({ success: false, error: updateError.message })
            }

            res.json({
                success: true,
                data: {
                    invoice: updatedInvoice,
                    items: normalized.items
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/invoices/:invoiceId/generate', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const invoiceId = readTrimmed(req.params?.invoiceId)
            if (!invoiceId) {
                return res.status(400).json({ success: false, error: 'invoiceId is required' })
            }

            const loaded = await loadInvoiceWithItems(ctx, access.companyId, invoiceId)
            if (!loaded) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }
            if (!loaded.items || loaded.items.length === 0) {
                return res.status(400).json({ success: false, error: 'Invoice cannot be generated without at least one item' })
            }

            const { data: company, error: companyError } = await supabase
                .from('company')
                .select('id, name, email, logo_url, registration_number, address, phone, default_currency, default_invoice_notes, default_payment_instructions')
                .eq('id', access.companyId)
                .maybeSingle()
            if (companyError) {
                return res.status(500).json({ success: false, error: companyError.message })
            }
            if (!company) {
                return res.status(400).json({ success: false, error: 'Company profile must exist before generating invoice' })
            }

            const rawItems: NormalizedInvoiceItem[] = loaded.items.map((item: any) => {
                const quantity = parsePositiveQuantity(item.quantity) || 1
                const unitPrice = parseMoney(item.unit_price) || 0
                return {
                    item_name: readTrimmed(item.item_name || item.name) || 'Item',
                    description: readTrimmed(item.description) || null,
                    quantity,
                    unit_price: unitPrice,
                    line_total: roundMoney(quantity * unitPrice)
                }
            })

            const totals = computeTotals(
                rawItems,
                req.body?.discount !== undefined ? req.body.discount : loaded.invoice.discount,
                req.body?.tax !== undefined ? req.body.tax : loaded.invoice.tax
            )

            const invoiceName = normalizeInvoiceName(loaded.invoice.invoice_name)
            if (!invoiceName) {
                return res.status(400).json({ success: false, error: 'Invoice name is invalid. Update invoice_name first.' })
            }

            const companySnapshot = isObject(loaded.invoice.company_snapshot) && Object.keys(loaded.invoice.company_snapshot).length > 0
                ? loaded.invoice.company_snapshot
                : buildCompanySnapshot(company)
            const clientSnapshot = isObject(loaded.invoice.client_snapshot) && Object.keys(loaded.invoice.client_snapshot).length > 0
                ? loaded.invoice.client_snapshot
                : { name: 'Client' }

            const invoiceDate = parseDateOnly(loaded.invoice.invoice_date, new Date().toISOString().slice(0, 10))
            const dueDate = parseDateOnly(loaded.invoice.due_date, null)
            if (!invoiceDate) {
                return res.status(400).json({ success: false, error: 'Invoice date is invalid' })
            }

            const currency = normalizeCurrency(loaded.invoice.currency || company.default_currency || 'USD')
            const notes = readTrimmed(loaded.invoice.notes || company.default_invoice_notes || '')
            const paymentInstructions = readTrimmed(
                loaded.invoice.payment_instructions || company.default_payment_instructions || ''
            )

            const pdfPayload = {
                invoiceTitle: readTrimmed(loaded.invoice.invoice_title) || invoiceName,
                invoiceName,
                invoiceNumber: readTrimmed(loaded.invoice.invoice_number) || invoiceName,
                invoiceDate,
                dueDate,
                currency,
                company: {
                    logoUrl: companySnapshot.logo_url || company.logo_url || null,
                    name: companySnapshot.business_name || company.name || access.companyId,
                    registrationNumber: companySnapshot.registration_number || company.registration_number || null,
                    address: companySnapshot.address || company.address || null,
                    email: companySnapshot.email || company.email || null,
                    phone: companySnapshot.phone || company.phone || null
                },
                client: {
                    name: clientSnapshot.name || 'Client',
                    phone: clientSnapshot.phone || null,
                    email: clientSnapshot.email || null
                },
                items: rawItems.map((item) => ({
                    itemName: item.item_name,
                    description: item.description,
                    quantity: item.quantity,
                    unitPrice: item.unit_price,
                    lineTotal: item.line_total
                })),
                subtotal: totals.subtotal,
                discount: totals.discount,
                tax: totals.tax,
                total: totals.total,
                notes: notes || null,
                paymentInstructions: paymentInstructions || null
            }

            const pdfBuffer = await buildInvoicePdf(pdfPayload)
            const bucket = readTrimmed(process.env.SUPABASE_INVOICE_BUCKET || 'invoices') || 'invoices'
            const pdfPath = buildStoragePath(access.companyId, invoiceName)

            const { error: uploadError } = await supabase
                .storage
                .from(bucket)
                .upload(pdfPath, pdfBuffer, {
                    contentType: 'application/pdf',
                    upsert: true,
                    cacheControl: '3600'
                })

            if (uploadError) {
                return res.status(500).json({ success: false, error: uploadError.message })
            }

            const { data: publicFileData } = supabase.storage.from(bucket).getPublicUrl(pdfPath)
            const pdfFileUrl = publicFileData?.publicUrl || null
            const publicInvoice = buildPublicInvoicePayload(req, { company_id: access.companyId, invoice_name: invoiceName })
            const wabaDocumentUrl = pdfFileUrl || publicInvoice.publicUrl

            const lockedStatus = loaded.invoice.status === 'paid' || loaded.invoice.status === 'cancelled'
                ? loaded.invoice.status
                : 'generated'

            const { data: updatedInvoice, error: updateError } = await supabase
                .from('invoices')
                .update({
                    invoice_name: invoiceName,
                    invoice_title: pdfPayload.invoiceTitle,
                    invoice_number: pdfPayload.invoiceNumber,
                    invoice_date: invoiceDate,
                    due_date: dueDate,
                    currency,
                    company_snapshot: companySnapshot,
                    client_snapshot: clientSnapshot,
                    subtotal: totals.subtotal,
                    discount: totals.discount,
                    tax: totals.tax,
                    total: totals.total,
                    notes: notes || null,
                    payment_instructions: paymentInstructions || null,
                    pdf_path: pdfPath,
                    public_path: publicInvoice.publicPath,
                    public_url: publicInvoice.publicUrl,
                    waba_document_url: wabaDocumentUrl,
                    status: lockedStatus,
                    generated_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoiceId)
                .eq('company_id', access.companyId)
                .select('*')
                .single()
            if (updateError) {
                return res.status(500).json({ success: false, error: updateError.message })
            }

            res.json({
                success: true,
                data: {
                    invoice: updatedInvoice,
                    items: rawItems,
                    outputs: {
                        company_id: access.companyId,
                        invoice_name: invoiceName,
                        pdf_path: pdfPath,
                        public_path: publicInvoice.publicPath,
                        public_url: publicInvoice.publicUrl,
                        waba_document_url: wabaDocumentUrl
                    }
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/api/invoices', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const limitRaw = Number(req.query?.limit)
            const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50
            const status = readTrimmed(req.query?.status).toLowerCase()

            let query = supabase
                .from('invoices')
                .select('id, company_id, client_id, invoice_name, invoice_number, invoice_title, invoice_date, due_date, currency, subtotal, discount, tax, total, status, pdf_path, public_path, public_url, waba_document_url, created_at, updated_at')
                .eq('company_id', access.companyId)
                .order('created_at', { ascending: false })
                .limit(limit)

            if (status && VALID_STATUSES.has(status as InvoiceStatus)) {
                query = query.eq('status', status)
            }

            const { data, error } = await query
            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }

            res.json({ success: true, data: data || [] })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/api/invoices/by-company/:companyId/by-name/:invoiceName', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const companyId = sanitizePathSegment(req.params?.companyId)
            const invoiceName = normalizeInvoiceName(req.params?.invoiceName)
            if (!companyId || !invoiceName) {
                return res.status(400).json({ success: false, error: 'companyId and invoiceName are required' })
            }
            if (companyId !== access.companyId) {
                return res.status(403).json({ success: false, error: 'Forbidden' })
            }

            const { data: invoice, error } = await supabase
                .from('invoices')
                .select('*')
                .eq('company_id', companyId)
                .eq('invoice_name', invoiceName)
                .maybeSingle()
            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!invoice) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }

            const { data: items, error: itemsError } = await supabase
                .from('invoice_items')
                .select('*')
                .eq('invoice_id', invoice.id)
                .order('item_index', { ascending: true })
                .order('created_at', { ascending: true })
            if (itemsError) {
                return res.status(500).json({ success: false, error: itemsError.message })
            }

            res.json({
                success: true,
                data: {
                    invoice,
                    items: items || []
                }
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/api/invoices/:invoiceId', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const invoiceId = readTrimmed(req.params?.invoiceId)
            if (!invoiceId) {
                return res.status(400).json({ success: false, error: 'invoiceId is required' })
            }

            const loaded = await loadInvoiceWithItems(ctx, access.companyId, invoiceId)
            if (!loaded) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }

            res.json({
                success: true,
                data: loaded
            })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/invoices/:invoiceId/status', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const invoiceId = readTrimmed(req.params?.invoiceId)
            const status = resolveInvoiceStatus(req.body?.status)
            if (!invoiceId) {
                return res.status(400).json({ success: false, error: 'invoiceId is required' })
            }
            if (!status) {
                return res.status(400).json({ success: false, error: 'Invalid status' })
            }

            const updates: any = {
                status,
                updated_at: new Date().toISOString()
            }
            if (status === 'sent') updates.sent_at = new Date().toISOString()

            const { data, error } = await supabase
                .from('invoices')
                .update(updates)
                .eq('id', invoiceId)
                .eq('company_id', access.companyId)
                .select('*')
                .maybeSingle()

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }

            res.json({ success: true, data })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/invoices/:invoiceId/mark-sent', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const invoiceId = readTrimmed(req.params?.invoiceId)
            if (!invoiceId) {
                return res.status(400).json({ success: false, error: 'invoiceId is required' })
            }

            const { data, error } = await supabase
                .from('invoices')
                .update({
                    status: 'sent',
                    sent_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', invoiceId)
                .eq('company_id', access.companyId)
                .select('*')
                .maybeSingle()

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Invoice not found' })
            }

            res.json({ success: true, data })
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/:companyId/invoice/:invoiceName', async (req: any, res: any) => {
        try {
            const companyId = sanitizePathSegment(req.params?.companyId)
            const invoiceName = normalizeInvoiceName(req.params?.invoiceName)
            if (!companyId || !invoiceName || RESERVED_PUBLIC_SEGMENTS.has(companyId)) {
                return res.status(404).send('Invoice not found')
            }

            const { data: invoice, error } = await supabase
                .from('invoices')
                .select(`
                    id,
                    company_id,
                    invoice_name,
                    invoice_number,
                    invoice_title,
                    invoice_date,
                    due_date,
                    currency,
                    total,
                    status,
                    pdf_path,
                    company_snapshot,
                    client_snapshot
                `)
                .eq('company_id', companyId)
                .eq('invoice_name', invoiceName)
                .maybeSingle()

            if (error) {
                return res.status(500).send('Failed to resolve invoice')
            }
            if (!invoice || !invoice.pdf_path) {
                return res.status(404).send('Invoice not found')
            }

            const bucket = readTrimmed(process.env.SUPABASE_INVOICE_BUCKET || 'invoices') || 'invoices'
            const { data: fileData } = supabase.storage.from(bucket).getPublicUrl(invoice.pdf_path)
            const pdfUrl = fileData?.publicUrl
            if (!pdfUrl) {
                return res.status(404).send('Invoice file not found')
            }

            const wantsPdf = String(req.query?.download || '').toLowerCase() === '1'
                || String(req.query?.raw || '').toLowerCase() === '1'
                || String(req.headers?.accept || '').includes('application/pdf')

            if (wantsPdf) {
                return res.redirect(302, pdfUrl)
            }

            const companySnapshot = isObject(invoice.company_snapshot) ? invoice.company_snapshot : {}
            const clientSnapshot = isObject(invoice.client_snapshot) ? invoice.client_snapshot : {}
            const currency = normalizeCurrency(invoice.currency, 'USD')
            const totalValue = Number(invoice.total || 0)
            const totalText = Number.isFinite(totalValue)
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(totalValue)
                : `${currency} ${invoice.total || 0}`
            const title = readTrimmed(invoice.invoice_title || invoice.invoice_name || invoice.invoice_number || 'Invoice')
            const companyName = readTrimmed(companySnapshot.business_name || companyId) || companyId
            const clientName = readTrimmed(clientSnapshot.name || 'Client') || 'Client'

            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            return res.send(renderInvoicePreviewHtml({
                invoice,
                pdfUrl,
                title,
                companyName,
                clientName,
                totalText
            }))
        } catch (error: any) {
            return res.status(500).send(error.message || 'Failed to load invoice')
        }
    })
}
