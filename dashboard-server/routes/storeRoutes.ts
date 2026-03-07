import type { Express } from 'express'

const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,127}$/
const RESERVED_PUBLIC_SEGMENTS = new Set([
    'api',
    'assets',
    'addon',
    'socket.io',
    'auth',
    'webhook',
    'myadmin',
    'support',
    'privacy',
    'privacy-policy',
    'terms',
    'terms-and-conditions',
    'customixie'
])

function readTrimmed(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function sanitizeCompanyId(value: any): string {
    return readTrimmed(value).toLowerCase()
}

function normalizeCurrency(input: any, fallback = 'USD'): string {
    const raw = readTrimmed(input).toUpperCase()
    if (!raw) return fallback
    if (!/^[A-Z]{3,8}$/.test(raw)) return fallback
    return raw
}

function parseMoney(value: any): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    return Math.round((parsed + Number.EPSILON) * 100) / 100
}

function parseStock(value: any): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    const rounded = Math.floor(parsed)
    if (rounded < 0) return null
    return rounded
}

function normalizeSlug(input: any, fallbackInput?: string): string {
    const raw = readTrimmed(input || fallbackInput)
    if (!raw) return ''
    const slug = raw
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 128)
    if (!slug) return ''
    if (SAFE_SLUG_REGEX.test(slug)) return slug
    return ''
}

function isUniqueViolation(error: any): boolean {
    const message = String(error?.message || '')
    return error?.code === '23505' || /duplicate|unique/i.test(message)
}

function isProductsTableMissingError(error: any): boolean {
    const code = readTrimmed(error?.code).toUpperCase()
    const message = String(error?.message || '').toLowerCase()
    return (
        code === 'PGRST205' ||
        code === '42P01' ||
        (message.includes("could not find the table") && message.includes("products")) ||
        message.includes('relation "public.products" does not exist') ||
        message.includes('relation "products" does not exist')
    )
}

const PRODUCTS_TABLE_MISSING_MESSAGE =
    'Products feature is not initialized. Run migration 20260307_webstore_products.sql to create public.products.'

function toMoneyText(value: any, currency: string): string {
    const amount = Number(value || 0)
    if (Number.isFinite(amount)) {
        try {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
        } catch {
            return `${currency} ${amount.toFixed(2)}`
        }
    }
    return `${currency} 0.00`
}

function escapeHtml(value: string): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderStorePage(args: { company: any; products: any[]; companyId: string }) {
    const { company, products, companyId } = args
    const companyName = readTrimmed(company?.name || companyId) || companyId
    const defaultCurrency = normalizeCurrency(company?.default_currency || 'USD')
    const productCards = products.length === 0
        ? '<div class="empty">No products published yet.</div>'
        : products.map((product) => {
            const currency = normalizeCurrency(product.currency || defaultCurrency, defaultCurrency)
            const name = escapeHtml(product.name || 'Product')
            const description = escapeHtml(product.description || '')
            const sku = readTrimmed(product.sku)
            const image = readTrimmed(product.image_url)
            const price = escapeHtml(toMoneyText(product.price, currency))
            return `<article class="card">
    ${image ? `<img src="${escapeHtml(image)}" alt="${name}" class="img" loading="lazy" />` : '<div class="img placeholder">No image</div>'}
    <div class="body">
      <h3>${name}</h3>
      ${sku ? `<p class="sku">SKU: ${escapeHtml(sku)}</p>` : ''}
      ${description ? `<p class="desc">${description}</p>` : ''}
      <div class="price">${price}</div>
    </div>
  </article>`
        }).join('')

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(companyName)} Store</title>
  <style>
    :root { --bg:#f4f7f8; --card:#fff; --line:#d9e2e6; --text:#111b21; --muted:#54656f; --brand:#00a884; --ink:#0b141a; }
    * { box-sizing: border-box; }
    body { margin:0; background:radial-gradient(circle at 0 0, #d9f8ef 0%, #f4f7f8 45%); color:var(--ink); font-family: "Segoe UI", "Inter", sans-serif; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 18px 48px; }
    .hero { display:flex; gap:16px; align-items:center; justify-content:space-between; flex-wrap:wrap; margin-bottom:18px; }
    .title { font-size: 34px; font-weight: 900; margin:0 0 6px; letter-spacing: -0.02em; }
    .sub { margin:0; color:var(--muted); font-size:14px; }
    .chip { border:1px solid #b9e6dc; background:#e8f8f3; color:#0a7a63; border-radius:999px; padding:7px 12px; font-weight:700; font-size:12px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:14px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; overflow:hidden; box-shadow:0 12px 30px rgba(10,20,26,0.06); }
    .img { width:100%; height:170px; object-fit:cover; display:block; background:#eef2f4; }
    .img.placeholder { display:flex; align-items:center; justify-content:center; color:#7a8b93; font-size:12px; font-weight:700; }
    .body { padding:12px; }
    h3 { margin:0 0 6px; font-size:17px; line-height:1.3; }
    .sku { margin:0 0 8px; color:#6b7c84; font-size:11px; font-weight:700; letter-spacing:.02em; text-transform:uppercase; }
    .desc { margin:0 0 10px; color:#334155; font-size:13px; line-height:1.45; min-height:38px; }
    .price { font-size:18px; font-weight:900; color:var(--text); }
    .empty { border:1px dashed #bad3dc; border-radius:14px; padding:26px; color:#48616c; text-align:center; background:#f8fbfc; font-weight:700; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <h1 class="title">${escapeHtml(companyName)} Store</h1>
        <p class="sub">Browse products and pricing. Built for invoice and WhatsApp workflows.</p>
      </div>
      <div class="chip">${products.length} product${products.length === 1 ? '' : 's'}</div>
    </section>
    <section class="grid">${productCards}</section>
  </main>
</body>
</html>`
}

function renderCustomixieLanding(companyIdHint: string) {
    const storeLink = companyIdHint ? `/${encodeURIComponent(companyIdHint)}/store` : '/support'
    const storeLabel = companyIdHint ? 'Open Webstore' : 'Contact Support'
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Customixie</title>
  <style>
    :root { --ink:#0b141a; --muted:#44515a; --line:#cdd8dd; --mint:#00a884; --sand:#f8f5ef; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); font-family:"Avenir Next","Segoe UI",sans-serif; background:linear-gradient(135deg, #fff8ea 0%, #f2fff9 55%, #f1f6ff 100%); }
    .wrap { max-width: 1020px; margin: 0 auto; padding: 34px 20px 58px; }
    .hero { border:1px solid var(--line); border-radius:20px; background:rgba(255,255,255,.78); backdrop-filter: blur(4px); padding:30px; box-shadow: 0 20px 40px rgba(11,20,26,.08); }
    .eyebrow { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:#0f766e; font-weight:900; margin:0 0 10px; }
    h1 { margin:0 0 10px; font-size:46px; line-height:1; letter-spacing:-.03em; }
    p { margin:0; max-width:650px; font-size:16px; line-height:1.6; color:var(--muted); }
    .cta { margin-top:22px; display:flex; gap:12px; flex-wrap:wrap; }
    .btn { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; font-weight:800; font-size:14px; border-radius:12px; padding:12px 16px; border:1px solid transparent; }
    .btn.primary { background:var(--mint); color:#fff; }
    .btn.ghost { background:#fff; color:var(--ink); border-color:var(--line); }
    .cards { margin-top:18px; display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(220px,1fr)); }
    .card { border:1px solid var(--line); border-radius:14px; padding:14px; background:#fff; }
    .card h3 { margin:0 0 6px; font-size:15px; }
    .card p { margin:0; font-size:13px; color:#52616b; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <p class="eyebrow">Customixie</p>
      <h1>Build. Sell. Invoice.</h1>
      <p>Customixie is your product-to-invoice workflow: publish webstore products, attach them to invoices, and send invoice PDFs through WhatsApp template messages.</p>
      <div class="cta">
        <a class="btn primary" href="${storeLink}">${storeLabel}</a>
        <a class="btn ghost" href="/support">Talk to Team</a>
      </div>
      <div class="cards">
        <article class="card">
          <h3>Webstore Ready</h3>
          <p>Publish active products and expose them under a clean public company store URL.</p>
        </article>
        <article class="card">
          <h3>Invoice Linked</h3>
          <p>Select products directly in invoice builder and keep pricing consistent.</p>
        </article>
        <article class="card">
          <h3>WABA Compatible</h3>
          <p>Generated invoices remain stable document links suitable for template document sends.</p>
        </article>
      </div>
    </section>
  </main>
</body>
</html>`
}

export function registerStoreRoutes(app: Express, ctx: any) {
    const { requireSupabaseUserMiddleware, resolveCompanyAccess, supabase } = ctx

    app.get('/api/store/products', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const includeInactiveRaw = String(req.query?.include_inactive || '').toLowerCase()
            const includeInactive = includeInactiveRaw === '1' || includeInactiveRaw === 'true'
            const limitRaw = Number(req.query?.limit)
            const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 100
            const q = readTrimmed(req.query?.q)

            let query = supabase
                .from('products')
                .select('id, company_id, name, slug, sku, description, price, currency, stock_qty, image_url, is_active, created_at, updated_at')
                .eq('company_id', access.companyId)
                .order('created_at', { ascending: false })
                .limit(limit)

            if (!includeInactive) {
                query = query.eq('is_active', true)
            }
            if (q) {
                query = query.ilike('name', `%${q.replace(/[%_]/g, '')}%`)
            }

            const { data, error } = await query
            if (error) {
                if (isProductsTableMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ success: true, data: data || [] })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/store/products', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const name = readTrimmed(req.body?.name)
            const sku = readTrimmed(req.body?.sku) || null
            const description = readTrimmed(req.body?.description) || null
            const imageUrl = readTrimmed(req.body?.image_url || req.body?.imageUrl) || null
            const price = parseMoney(req.body?.price)
            const stock = parseStock(req.body?.stock_qty ?? req.body?.stockQty)
            const currency = normalizeCurrency(req.body?.currency, 'USD')
            const slug = normalizeSlug(req.body?.slug, name)

            if (!name) {
                return res.status(400).json({ success: false, error: 'name is required' })
            }
            if (!slug) {
                return res.status(400).json({ success: false, error: 'slug is invalid' })
            }
            if (price === null || price < 0) {
                return res.status(400).json({ success: false, error: 'price must be a number >= 0' })
            }
            if (stock === null) {
                return res.status(400).json({ success: false, error: 'stock_qty must be an integer >= 0' })
            }

            const { data, error } = await supabase
                .from('products')
                .insert({
                    company_id: access.companyId,
                    name: name.slice(0, 255),
                    slug,
                    sku: sku ? sku.slice(0, 120) : null,
                    description: description ? description.slice(0, 4000) : null,
                    price,
                    currency,
                    stock_qty: stock,
                    image_url: imageUrl,
                    is_active: true,
                    updated_at: new Date().toISOString()
                })
                .select('*')
                .single()

            if (error) {
                if (isProductsTableMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                if (isUniqueViolation(error)) {
                    return res.status(409).json({ success: false, error: 'Product slug already exists for this company' })
                }
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ success: true, data })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.put('/api/store/products/:productId', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const productId = readTrimmed(req.params?.productId)
            if (!productId) {
                return res.status(400).json({ success: false, error: 'productId is required' })
            }

            const { data: existing, error: existingError } = await supabase
                .from('products')
                .select('*')
                .eq('id', productId)
                .eq('company_id', access.companyId)
                .maybeSingle()
            if (existingError) {
                if (isProductsTableMissingError(existingError)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: existingError.message })
            }
            if (!existing) {
                return res.status(404).json({ success: false, error: 'Product not found' })
            }

            const updates: any = {
                updated_at: new Date().toISOString()
            }

            const name = readTrimmed(req.body?.name)
            if (name) updates.name = name.slice(0, 255)
            if (req.body?.slug !== undefined) {
                const nextSlug = normalizeSlug(req.body?.slug, name || existing.name)
                if (!nextSlug) return res.status(400).json({ success: false, error: 'slug is invalid' })
                updates.slug = nextSlug
            }
            if (req.body?.sku !== undefined) {
                const sku = readTrimmed(req.body?.sku)
                updates.sku = sku ? sku.slice(0, 120) : null
            }
            if (req.body?.description !== undefined) {
                const description = readTrimmed(req.body?.description)
                updates.description = description ? description.slice(0, 4000) : null
            }
            if (req.body?.image_url !== undefined || req.body?.imageUrl !== undefined) {
                const imageUrl = readTrimmed(req.body?.image_url || req.body?.imageUrl)
                updates.image_url = imageUrl || null
            }
            if (req.body?.price !== undefined) {
                const price = parseMoney(req.body?.price)
                if (price === null || price < 0) {
                    return res.status(400).json({ success: false, error: 'price must be a number >= 0' })
                }
                updates.price = price
            }
            if (req.body?.currency !== undefined) {
                updates.currency = normalizeCurrency(req.body?.currency, existing.currency || 'USD')
            }
            if (req.body?.stock_qty !== undefined || req.body?.stockQty !== undefined) {
                const stock = parseStock(req.body?.stock_qty ?? req.body?.stockQty)
                if (stock === null) {
                    return res.status(400).json({ success: false, error: 'stock_qty must be an integer >= 0' })
                }
                updates.stock_qty = stock
            }
            if (req.body?.is_active !== undefined) {
                const raw = req.body.is_active
                updates.is_active = raw === true || raw === 'true' || raw === 1 || raw === '1'
            }

            if (Object.keys(updates).length <= 1) {
                return res.status(400).json({ success: false, error: 'No valid update fields provided' })
            }

            const { data, error } = await supabase
                .from('products')
                .update(updates)
                .eq('id', productId)
                .eq('company_id', access.companyId)
                .select('*')
                .single()

            if (error) {
                if (isProductsTableMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                if (isUniqueViolation(error)) {
                    return res.status(409).json({ success: false, error: 'Product slug already exists for this company' })
                }
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ success: true, data })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.delete('/api/store/products/:productId', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const productId = readTrimmed(req.params?.productId)
            if (!productId) {
                return res.status(400).json({ success: false, error: 'productId is required' })
            }

            const { data, error } = await supabase
                .from('products')
                .update({
                    is_active: false,
                    updated_at: new Date().toISOString()
                })
                .eq('id', productId)
                .eq('company_id', access.companyId)
                .select('*')
                .maybeSingle()

            if (error) {
                if (isProductsTableMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Product not found' })
            }

            return res.json({ success: true, data })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/:companyId/store.json', async (req: any, res: any) => {
        try {
            const companyId = sanitizeCompanyId(req.params?.companyId)
            if (!companyId || RESERVED_PUBLIC_SEGMENTS.has(companyId)) {
                return res.status(404).json({ success: false, error: 'Store not found' })
            }

            const { data: company, error: companyError } = await supabase
                .from('company')
                .select('id, name, logo_url, address, email, phone, default_currency')
                .eq('id', companyId)
                .maybeSingle()
            if (companyError) {
                return res.status(500).json({ success: false, error: 'Failed to resolve company' })
            }
            if (!company) {
                return res.status(404).json({ success: false, error: 'Store not found' })
            }

            const { data: products, error: productsError } = await supabase
                .from('products')
                .select('id, company_id, name, slug, sku, description, price, currency, stock_qty, image_url, is_active, created_at, updated_at')
                .eq('company_id', companyId)
                .eq('is_active', true)
                .order('created_at', { ascending: false })
                .limit(120)
            if (productsError) {
                if (isProductsTableMissingError(productsError)) {
                    return res.status(503).json({
                        success: false,
                        code: 'PRODUCTS_TABLE_MISSING',
                        error: PRODUCTS_TABLE_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: productsError.message })
            }

            return res.json({
                success: true,
                data: {
                    company,
                    products: products || []
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/:companyId/store', async (req: any, res: any) => {
        try {
            const companyId = sanitizeCompanyId(req.params?.companyId)
            if (!companyId || RESERVED_PUBLIC_SEGMENTS.has(companyId)) {
                return res.status(404).send('Store not found')
            }

            const { data: company, error: companyError } = await supabase
                .from('company')
                .select('id, name, logo_url, address, email, phone, default_currency')
                .eq('id', companyId)
                .maybeSingle()
            if (companyError) {
                return res.status(500).send('Failed to resolve store')
            }
            if (!company) {
                return res.status(404).send('Store not found')
            }

            const { data: products, error: productsError } = await supabase
                .from('products')
                .select('id, name, slug, sku, description, price, currency, stock_qty, image_url')
                .eq('company_id', companyId)
                .eq('is_active', true)
                .order('created_at', { ascending: false })
                .limit(120)
            if (productsError) {
                if (isProductsTableMissingError(productsError)) {
                    return res.status(503).send(PRODUCTS_TABLE_MISSING_MESSAGE)
                }
                return res.status(500).send('Failed to load products')
            }

            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            return res.send(renderStorePage({ company, products: products || [], companyId }))
        } catch (error: any) {
            return res.status(500).send(error.message || 'Failed to load store')
        }
    })

    app.get('/customixie', (req: any, res: any) => {
        const companyId = sanitizeCompanyId(req.query?.company || req.query?.companyId || '')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.send(renderCustomixieLanding(companyId))
    })
}
