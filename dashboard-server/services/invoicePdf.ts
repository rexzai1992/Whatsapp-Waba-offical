import PDFDocument from 'pdfkit'

type InvoicePdfCompany = {
    logoUrl?: string | null
    name: string
    registrationNumber?: string | null
    address?: string | null
    email?: string | null
    phone?: string | null
}

type InvoicePdfClient = {
    name: string
    email?: string | null
    phone?: string | null
}

type InvoicePdfItem = {
    itemName: string
    description?: string | null
    quantity: number
    unitPrice: number
    lineTotal: number
}

export type InvoicePdfPayload = {
    invoiceTitle: string
    invoiceName: string
    invoiceNumber: string
    invoiceDate: string
    dueDate?: string | null
    currency: string
    company: InvoicePdfCompany
    client: InvoicePdfClient
    items: InvoicePdfItem[]
    subtotal: number
    discount: number
    tax: number
    total: number
    notes?: string | null
    paymentInstructions?: string | null
}

const BRAND_COLOR = '#0f172a'
const MUTED_COLOR = '#64748b'
const BORDER_COLOR = '#e2e8f0'
const HEADER_FILL = '#f8fafc'

function escapePdfText(value: string): string {
    return value.replace(/\r?\n/g, '\n')
}

function toDateLabel(value?: string | null): string {
    if (!value) return '-'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toISOString().slice(0, 10)
}

function formatMoney(value: number, currency: string): string {
    const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : 'USD'
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: code,
            maximumFractionDigits: 2
        }).format(value)
    } catch {
        return `${code} ${value.toFixed(2)}`
    }
}

async function loadLogoBuffer(url?: string | null): Promise<Buffer | null> {
    if (!url) return null
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 4000)
        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeout)
        if (!response.ok) return null
        const arrayBuffer = await response.arrayBuffer()
        if (!arrayBuffer.byteLength) return null
        return Buffer.from(arrayBuffer)
    } catch {
        return null
    }
}

function drawLabelValue(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    y: number,
    width: number
) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED_COLOR).text(label, x, y, { width })
    doc.font('Helvetica').fontSize(10).fillColor(BRAND_COLOR).text(value, x, y + 12, { width })
}

function drawItemsHeader(doc: PDFKit.PDFDocument, y: number, left: number, width: number) {
    doc.save()
    doc.rect(left, y, width, 22).fill(HEADER_FILL)
    doc.restore()
    doc.strokeColor(BORDER_COLOR).lineWidth(1).rect(left, y, width, 22).stroke()

    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED_COLOR)
    doc.text('Item', left + 10, y + 7, { width: 250 })
    doc.text('Qty', left + 264, y + 7, { width: 55, align: 'right' })
    doc.text('Unit Price', left + 325, y + 7, { width: 95, align: 'right' })
    doc.text('Total', left + 424, y + 7, { width: 95, align: 'right' })
}

function clampBottomY(doc: PDFKit.PDFDocument, marginBottom: number): number {
    return doc.page.height - marginBottom
}

export async function buildInvoicePdf(payload: InvoicePdfPayload): Promise<Buffer> {
    const marginLeft = 48
    const marginRight = 48
    const marginTop = 46
    const marginBottom = 50
    const pageWidth = 595.28
    const contentWidth = pageWidth - marginLeft - marginRight
    const logoBuffer = await loadLogoBuffer(payload.company.logoUrl)

    return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const doc = new PDFDocument({
            size: 'A4',
            margins: {
                top: marginTop,
                left: marginLeft,
                right: marginRight,
                bottom: marginBottom
            }
        })

        doc.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        doc.on('error', reject)
        doc.on('end', () => resolve(Buffer.concat(chunks)))

        let cursorY = marginTop
        const rightBlockWidth = 210
        const rightBlockX = marginLeft + contentWidth - rightBlockWidth

        if (logoBuffer) {
            try {
                doc.image(logoBuffer, marginLeft, cursorY, { fit: [100, 56] })
            } catch {
                // Ignore malformed logo images and continue with text-only header.
            }
        }

        const companyBlockX = logoBuffer ? marginLeft + 112 : marginLeft
        doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND_COLOR).text(escapePdfText(payload.company.name), companyBlockX, cursorY, {
            width: contentWidth - rightBlockWidth - 16
        })

        let companyMetaY = cursorY + 22
        const companyMeta = [
            payload.company.registrationNumber ? `Reg No: ${payload.company.registrationNumber}` : '',
            payload.company.address || '',
            payload.company.email || '',
            payload.company.phone || ''
        ].filter(Boolean)

        doc.font('Helvetica').fontSize(9).fillColor(MUTED_COLOR)
        companyMeta.forEach((line) => {
            doc.text(escapePdfText(line), companyBlockX, companyMetaY, {
                width: contentWidth - rightBlockWidth - 16
            })
            companyMetaY += 12
        })

        doc.font('Helvetica-Bold').fontSize(24).fillColor(BRAND_COLOR).text('INVOICE', rightBlockX, cursorY, {
            width: rightBlockWidth,
            align: 'right'
        })
        doc.font('Helvetica').fontSize(10).fillColor(MUTED_COLOR)
        doc.text(escapePdfText(payload.invoiceNumber), rightBlockX, cursorY + 28, { width: rightBlockWidth, align: 'right' })
        doc.text(escapePdfText(payload.invoiceTitle || payload.invoiceName), rightBlockX, cursorY + 44, { width: rightBlockWidth, align: 'right' })

        cursorY = Math.max(companyMetaY + 10, cursorY + 76)
        doc.strokeColor(BORDER_COLOR).lineWidth(1).moveTo(marginLeft, cursorY).lineTo(marginLeft + contentWidth, cursorY).stroke()
        cursorY += 16

        drawLabelValue(doc, 'Invoice Date', toDateLabel(payload.invoiceDate), marginLeft, cursorY, 150)
        drawLabelValue(doc, 'Due Date', toDateLabel(payload.dueDate), marginLeft + 160, cursorY, 140)
        drawLabelValue(doc, 'Currency', payload.currency.toUpperCase(), marginLeft + 310, cursorY, 80)
        drawLabelValue(doc, 'Status', 'Generated', marginLeft + 400, cursorY, 90)
        cursorY += 34

        doc.strokeColor(BORDER_COLOR).lineWidth(1).moveTo(marginLeft, cursorY).lineTo(marginLeft + contentWidth, cursorY).stroke()
        cursorY += 14

        doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED_COLOR).text('Bill To', marginLeft, cursorY)
        cursorY += 14
        doc.font('Helvetica').fontSize(11).fillColor(BRAND_COLOR).text(escapePdfText(payload.client.name || 'Client'), marginLeft, cursorY)
        cursorY += 14
        if (payload.client.email) {
            doc.font('Helvetica').fontSize(9).fillColor(MUTED_COLOR).text(escapePdfText(payload.client.email), marginLeft, cursorY)
            cursorY += 12
        }
        if (payload.client.phone) {
            doc.font('Helvetica').fontSize(9).fillColor(MUTED_COLOR).text(escapePdfText(payload.client.phone), marginLeft, cursorY)
            cursorY += 12
        }

        cursorY += 10
        const tableLeft = marginLeft
        const tableWidth = contentWidth
        drawItemsHeader(doc, cursorY, tableLeft, tableWidth)
        cursorY += 22

        for (const item of payload.items) {
            const itemTitle = item.description
                ? `${item.itemName}\n${item.description}`
                : item.itemName
            const itemText = escapePdfText(itemTitle)
            doc.font('Helvetica').fontSize(10)
            const itemHeight = doc.heightOfString(itemText, { width: 250 })
            const rowHeight = Math.max(24, itemHeight + 8)
            const pageBottom = clampBottomY(doc, marginBottom)

            if (cursorY + rowHeight > pageBottom - 140) {
                doc.addPage()
                cursorY = marginTop
                drawItemsHeader(doc, cursorY, tableLeft, tableWidth)
                cursorY += 22
            }

            doc.strokeColor(BORDER_COLOR).lineWidth(1).rect(tableLeft, cursorY, tableWidth, rowHeight).stroke()
            doc.font('Helvetica').fontSize(10).fillColor(BRAND_COLOR).text(itemText, tableLeft + 10, cursorY + 5, { width: 250 })
            doc.text(item.quantity.toString(), tableLeft + 264, cursorY + 5, { width: 55, align: 'right' })
            doc.text(formatMoney(item.unitPrice, payload.currency), tableLeft + 325, cursorY + 5, { width: 95, align: 'right' })
            doc.font('Helvetica-Bold').text(formatMoney(item.lineTotal, payload.currency), tableLeft + 424, cursorY + 5, { width: 95, align: 'right' })
            cursorY += rowHeight
        }

        cursorY += 16
        const summaryWidth = 210
        const summaryX = marginLeft + contentWidth - summaryWidth

        const ensureSummarySpace = () => {
            const pageBottom = clampBottomY(doc, marginBottom)
            if (cursorY + 120 > pageBottom - 40) {
                doc.addPage()
                cursorY = marginTop
            }
        }
        ensureSummarySpace()

        doc.save()
        doc.roundedRect(summaryX, cursorY, summaryWidth, 92, 8).fill('#f8fafc')
        doc.restore()
        doc.roundedRect(summaryX, cursorY, summaryWidth, 92, 8).strokeColor(BORDER_COLOR).lineWidth(1).stroke()

        let summaryY = cursorY + 10
        const drawSummaryRow = (label: string, value: number, bold = false) => {
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(bold ? BRAND_COLOR : MUTED_COLOR)
            doc.text(label, summaryX + 12, summaryY, { width: 100 })
            doc.text(formatMoney(value, payload.currency), summaryX + 110, summaryY, { width: 86, align: 'right' })
            summaryY += 18
        }

        drawSummaryRow('Subtotal', payload.subtotal)
        drawSummaryRow('Discount', payload.discount)
        drawSummaryRow('Tax', payload.tax)
        drawSummaryRow('Grand Total', payload.total, true)

        cursorY += 104
        const notesBlockWidth = contentWidth - summaryWidth - 16

        if (payload.notes) {
            doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED_COLOR).text('Notes', marginLeft, cursorY, { width: notesBlockWidth })
            cursorY += 14
            doc.font('Helvetica').fontSize(9).fillColor(BRAND_COLOR).text(escapePdfText(payload.notes), marginLeft, cursorY, {
                width: notesBlockWidth
            })
            cursorY += doc.heightOfString(payload.notes, { width: notesBlockWidth, align: 'left' }) + 8
        }

        if (payload.paymentInstructions) {
            doc.font('Helvetica-Bold').fontSize(10).fillColor(MUTED_COLOR).text('Payment Instructions', marginLeft, cursorY, {
                width: notesBlockWidth
            })
            cursorY += 14
            doc.font('Helvetica').fontSize(9).fillColor(BRAND_COLOR).text(escapePdfText(payload.paymentInstructions), marginLeft, cursorY, {
                width: notesBlockWidth
            })
            cursorY += doc.heightOfString(payload.paymentInstructions, { width: notesBlockWidth }) + 8
        }

        const footerY = Math.max(cursorY + 8, doc.page.height - marginBottom + 12)
        doc.strokeColor(BORDER_COLOR).lineWidth(1).moveTo(marginLeft, footerY - 8).lineTo(marginLeft + contentWidth, footerY - 8).stroke()
        doc.font('Helvetica').fontSize(8).fillColor(MUTED_COLOR).text(`Invoice: ${payload.invoiceName}`, marginLeft, footerY, {
            width: contentWidth,
            align: 'left'
        })

        doc.end()
    })
}
