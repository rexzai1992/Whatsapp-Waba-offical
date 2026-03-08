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

function isWebstoreSettingsMissingError(error: any): boolean {
    const code = readTrimmed(error?.code).toUpperCase()
    const message = String(error?.message || '').toLowerCase()
    return code === '42703' && message.includes('webstore_')
}

const WEBSTORE_SETTINGS_MISSING_MESSAGE =
    'Webstore settings columns are missing. Run migrations 20260307_company_webstore_settings.sql and 20260308_webstore_design_settings.sql.'

function normalizeHexColor(input: any, fallback = '#00a884'): string {
    const raw = readTrimmed(input).toLowerCase()
    if (/^#[0-9a-f]{3}$/.test(raw) || /^#[0-9a-f]{6}$/.test(raw)) return raw
    return fallback
}

function parseBoolean(value: any, fallback = true): boolean {
    if (value === null || value === undefined || value === '') return fallback
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    const normalized = readTrimmed(value).toLowerCase()
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    return fallback
}

function normalizeTheme(input: any, fallback = 'editorial'): 'editorial' | 'midnight' | 'sunrise' {
    const raw = readTrimmed(input).toLowerCase()
    if (raw === 'midnight' || raw === 'sunrise' || raw === 'editorial') return raw
    return fallback as 'editorial' | 'midnight' | 'sunrise'
}

function themePalette(theme: 'editorial' | 'midnight' | 'sunrise') {
    if (theme === 'midnight') {
        return {
            bg: 'linear-gradient(160deg, #090b1a 0%, #101428 42%, #1a2040 100%)',
            surface: '#10172a',
            text: '#f8fafc',
            muted: '#cbd5e1',
            line: '#223056'
        }
    }
    if (theme === 'sunrise') {
        return {
            bg: 'linear-gradient(135deg, #fff7ed 0%, #fef3c7 50%, #fef9c3 100%)',
            surface: '#ffffff',
            text: '#1f2937',
            muted: '#6b7280',
            line: '#fcd34d'
        }
    }
    return {
        bg: 'radial-gradient(circle at 0 0, #d9f8ef 0%, #f4f7f8 45%)',
        surface: '#ffffff',
        text: '#0f172a',
        muted: '#475569',
        line: '#d9e2e6'
    }
}

function buildDemoProducts(companyId: string, currency: string) {
    const now = new Date().toISOString()
    const code = normalizeCurrency(currency, 'USD')
    return [
        {
            company_id: companyId,
            name: 'Aero Bottle 750ml',
            slug: 'aero-bottle-750',
            sku: 'DEMO-BTL-750',
            description: 'Insulated steel bottle for daily carry.',
            price: 29.9,
            currency: code,
            stock_qty: 48,
            image_url: 'https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=900&q=80',
            is_active: true,
            updated_at: now
        },
        {
            company_id: companyId,
            name: 'Canvas Daily Tote',
            slug: 'canvas-daily-tote',
            sku: 'DEMO-TOTE-01',
            description: 'Minimal canvas tote with reinforced handle.',
            price: 24.5,
            currency: code,
            stock_qty: 72,
            image_url: 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=900&q=80',
            is_active: true,
            updated_at: now
        },
        {
            company_id: companyId,
            name: 'Desk Dock Charger',
            slug: 'desk-dock-charger',
            sku: 'DEMO-DOCK-02',
            description: 'Fast wireless charging dock for office desk.',
            price: 49.0,
            currency: code,
            stock_qty: 36,
            image_url: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=900&q=80',
            is_active: true,
            updated_at: now
        },
        {
            company_id: companyId,
            name: 'Flex Hoodie',
            slug: 'flex-hoodie',
            sku: 'DEMO-HOODIE-03',
            description: 'Soft heavyweight hoodie with clean branding.',
            price: 59.0,
            currency: code,
            stock_qty: 54,
            image_url: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80',
            is_active: true,
            updated_at: now
        },
        {
            company_id: companyId,
            name: 'Field Notebook Set',
            slug: 'field-notebook-set',
            sku: 'DEMO-NOTE-04',
            description: 'Set of 3 dotted notebooks for product planning.',
            price: 18.0,
            currency: code,
            stock_qty: 120,
            image_url: 'https://images.unsplash.com/photo-1531346680769-a1d79b57de5c?auto=format&fit=crop&w=900&q=80',
            is_active: true,
            updated_at: now
        }
    ]
}

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
    const storeTitle = readTrimmed(company?.webstore_title) || `${companyName} Store`
    const storeSubtitle = readTrimmed(company?.webstore_subtitle) || 'Browse products and pricing. Built for invoice and WhatsApp workflows.'
    const brandColor = normalizeHexColor(company?.webstore_brand_color, '#00a884')
    const theme = normalizeTheme(company?.webstore_theme, 'editorial')
    const showLogo = parseBoolean(company?.webstore_show_logo, true)
    const heroBadge = readTrimmed(company?.webstore_hero_badge) || 'Webstore'
    const palette = themePalette(theme)
    const defaultCurrency = normalizeCurrency(company?.default_currency || 'USD')
    const logoUrl = readTrimmed(company?.logo_url)
    const contactLine = [readTrimmed(company?.email), readTrimmed(company?.phone), readTrimmed(company?.address)]
        .filter(Boolean)
        .map((part) => escapeHtml(part))
        .join(' • ')
    const productCards = products.length === 0
        ? '<div class="empty">No products published yet. Add products from Product Settings.</div>'
        : products.map((product) => {
            const currency = normalizeCurrency(product.currency || defaultCurrency, defaultCurrency)
            const name = escapeHtml(product.name || 'Product')
            const description = escapeHtml(product.description || '')
            const sku = readTrimmed(product.sku)
            const image = readTrimmed(product.image_url)
            const price = escapeHtml(toMoneyText(product.price, currency))
            const stockQty = Number(product.stock_qty || 0)
            const stockLabel = stockQty > 0 ? `${stockQty} in stock` : 'Out of stock'
            return `<article class="card">
    ${image ? `<img src="${escapeHtml(image)}" alt="${name}" class="img" loading="lazy" />` : '<div class="img placeholder">No image available</div>'}
    <div class="body">
      <div class="meta">
        ${sku ? `<p class="sku">SKU ${escapeHtml(sku)}</p>` : '<p class="sku">Featured Product</p>'}
        <span class="stock">${escapeHtml(stockLabel)}</span>
      </div>
      <h3>${name}</h3>
      ${description ? `<p class="desc">${description}</p>` : ''}
      <div class="row">
        <div class="price">${price}</div>
        <button class="cta" type="button">Enquire</button>
      </div>
    </div>
  </article>`
        }).join('')

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(storeTitle)}</title>
  <style>
    :root {
      --bg:${palette.bg};
      --card:${palette.surface};
      --line:${palette.line};
      --text:${palette.text};
      --muted:${palette.muted};
      --brand:${brandColor};
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:"Avenir Next","Segoe UI",sans-serif; }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 18px 52px; }
    .hero {
      border:1px solid color-mix(in srgb, var(--brand) 25%, var(--line) 75%);
      background:linear-gradient(110deg, color-mix(in srgb, var(--brand) 12%, var(--card) 88%) 0%, var(--card) 60%);
      border-radius:24px;
      padding:22px;
      box-shadow:0 20px 45px rgba(2,6,23,0.14);
      display:grid;
      grid-template-columns:1fr auto;
      gap:18px;
      align-items:center;
      margin-bottom:18px;
    }
    .hero-left { display:flex; gap:14px; align-items:flex-start; }
    .logo { width:56px; height:56px; border-radius:16px; object-fit:cover; border:1px solid var(--line); background:#fff; }
    .eyebrow { margin:0 0 6px; text-transform:uppercase; letter-spacing:.12em; font-size:11px; font-weight:900; color:var(--muted); }
    .title { font-size:34px; line-height:1.05; margin:0; letter-spacing:-.03em; }
    .sub { margin:8px 0 0; color:var(--muted); font-size:14px; max-width:720px; line-height:1.5; }
    .contact { margin:10px 0 0; color:var(--muted); font-size:12px; }
    .chip {
      border:1px solid color-mix(in srgb, var(--brand) 35%, var(--line) 65%);
      background:color-mix(in srgb, var(--brand) 18%, #fff 82%);
      color:color-mix(in srgb, var(--brand) 68%, #111 32%);
      border-radius:999px;
      padding:8px 12px;
      font-weight:800;
      font-size:12px;
      align-self:flex-start;
    }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap:14px; }
    .card {
      background:var(--card);
      border:1px solid var(--line);
      border-radius:18px;
      overflow:hidden;
      box-shadow:0 14px 35px rgba(2,6,23,0.12);
      display:flex;
      flex-direction:column;
    }
    .img { width:100%; height:190px; object-fit:cover; display:block; background:#eef2f4; }
    .img.placeholder { display:flex; align-items:center; justify-content:center; color:#64748b; font-size:12px; font-weight:700; }
    .body { padding:13px; display:flex; flex-direction:column; gap:8px; min-height:192px; }
    .meta { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .sku { margin:0; color:var(--muted); font-size:10px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; }
    .stock {
      display:inline-flex; align-items:center; justify-content:center;
      border:1px solid color-mix(in srgb, var(--brand) 28%, var(--line) 72%);
      border-radius:999px; padding:4px 8px; font-size:10px; font-weight:800; color:var(--muted);
    }
    h3 { margin:0; font-size:18px; line-height:1.25; letter-spacing:-.01em; }
    .desc { margin:0; color:var(--muted); font-size:13px; line-height:1.5; min-height:42px; }
    .row { margin-top:auto; display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .price { font-size:20px; font-weight:900; color:var(--text); }
    .cta {
      border:1px solid color-mix(in srgb, var(--brand) 45%, var(--line) 55%);
      background:color-mix(in srgb, var(--brand) 90%, #000 10%);
      color:#fff; font-size:11px; font-weight:800; letter-spacing:.05em; text-transform:uppercase;
      border-radius:10px; padding:8px 10px; cursor:pointer;
    }
    .empty {
      border:1px dashed var(--line);
      border-radius:16px;
      padding:32px;
      color:var(--muted);
      text-align:center;
      background:var(--card);
      font-weight:700;
    }
    @media (max-width: 900px) {
      .hero { grid-template-columns:1fr; }
      .chip { justify-self:flex-start; }
      .title { font-size:28px; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="hero-left">
        ${showLogo && logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(companyName)} logo" class="logo" loading="lazy" />` : ''}
        <div>
          <p class="eyebrow">${escapeHtml(heroBadge)}</p>
          <h1 class="title">${escapeHtml(storeTitle)}</h1>
          <p class="sub">${escapeHtml(storeSubtitle)}</p>
          ${contactLine ? `<p class="contact">${contactLine}</p>` : ''}
        </div>
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

async function fetchPublicCompanyStoreProfile(supabase: any, companyId: string): Promise<{ data: any; error: any }> {
    const fullSelect = 'id, name, logo_url, address, email, phone, default_currency, webstore_enabled, webstore_title, webstore_subtitle, webstore_brand_color, webstore_theme, webstore_show_logo, webstore_hero_badge'
    const baseSelect = 'id, name, logo_url, address, email, phone, default_currency'
    const primary = await supabase
        .from('company')
        .select(fullSelect)
        .eq('id', companyId)
        .maybeSingle()

    if (!primary.error || !isWebstoreSettingsMissingError(primary.error)) {
        return { data: primary.data, error: primary.error }
    }

    const fallback = await supabase
        .from('company')
        .select(baseSelect)
        .eq('id', companyId)
        .maybeSingle()
    if (fallback.error || !fallback.data) {
        return { data: fallback.data, error: fallback.error }
    }

    return {
        data: {
            ...fallback.data,
            webstore_enabled: true,
            webstore_title: null,
            webstore_subtitle: null,
            webstore_brand_color: '#00a884',
            webstore_theme: 'editorial',
            webstore_show_logo: true,
            webstore_hero_badge: null
        },
        error: null
    }
}

export function registerStoreRoutes(app: Express, ctx: any) {
    const { requireSupabaseUserMiddleware, resolveCompanyAccess, supabase } = ctx

    app.get('/api/company/webstore-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'agent')
            if (!access) return

            const { data, error } = await supabase
                .from('company')
                .select('id, name, webstore_enabled, webstore_title, webstore_subtitle, webstore_brand_color, webstore_theme, webstore_show_logo, webstore_hero_badge')
                .eq('id', access.companyId)
                .maybeSingle()

            if (error) {
                if (isWebstoreSettingsMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'WEBSTORE_SETTINGS_MISSING',
                        error: WEBSTORE_SETTINGS_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Company profile not found' })
            }

            return res.json({
                success: true,
                data: {
                    company_id: data.id,
                    company_name: data.name || access.companyId,
                    enabled: parseBoolean(data.webstore_enabled, true),
                    title: readTrimmed(data.webstore_title) || null,
                    subtitle: readTrimmed(data.webstore_subtitle) || null,
                    brand_color: normalizeHexColor(data.webstore_brand_color, '#00a884'),
                    theme: normalizeTheme(data.webstore_theme, 'editorial'),
                    show_logo: parseBoolean(data.webstore_show_logo, true),
                    hero_badge: readTrimmed(data.webstore_hero_badge) || null
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/company/webstore-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'admin')
            if (!access) return

            const payload = {
                webstore_enabled: parseBoolean(req.body?.enabled ?? req.body?.webstore_enabled, true),
                webstore_title: readTrimmed(req.body?.title || req.body?.webstore_title) || null,
                webstore_subtitle: readTrimmed(req.body?.subtitle || req.body?.webstore_subtitle) || null,
                webstore_brand_color: normalizeHexColor(req.body?.brand_color || req.body?.webstore_brand_color, '#00a884'),
                webstore_theme: normalizeTheme(req.body?.theme || req.body?.webstore_theme, 'editorial'),
                webstore_show_logo: parseBoolean(req.body?.show_logo ?? req.body?.webstore_show_logo, true),
                webstore_hero_badge: readTrimmed(req.body?.hero_badge || req.body?.webstore_hero_badge) || null
            }

            const { data, error } = await supabase
                .from('company')
                .update(payload)
                .eq('id', access.companyId)
                .select('id, name, webstore_enabled, webstore_title, webstore_subtitle, webstore_brand_color, webstore_theme, webstore_show_logo, webstore_hero_badge')
                .maybeSingle()

            if (error) {
                if (isWebstoreSettingsMissingError(error)) {
                    return res.status(503).json({
                        success: false,
                        code: 'WEBSTORE_SETTINGS_MISSING',
                        error: WEBSTORE_SETTINGS_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: error.message })
            }
            if (!data) {
                return res.status(404).json({ success: false, error: 'Company profile not found' })
            }

            return res.json({
                success: true,
                data: {
                    company_id: data.id,
                    company_name: data.name || access.companyId,
                    enabled: parseBoolean(data.webstore_enabled, true),
                    title: readTrimmed(data.webstore_title) || null,
                    subtitle: readTrimmed(data.webstore_subtitle) || null,
                    brand_color: normalizeHexColor(data.webstore_brand_color, '#00a884'),
                    theme: normalizeTheme(data.webstore_theme, 'editorial'),
                    show_logo: parseBoolean(data.webstore_show_logo, true),
                    hero_badge: readTrimmed(data.webstore_hero_badge) || null
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

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

    app.post('/api/store/products/demo-seed', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveCompanyAccess(req, res, 'admin')
            if (!access) return

            const { data: company, error: companyError } = await supabase
                .from('company')
                .select('id, default_currency')
                .eq('id', access.companyId)
                .maybeSingle()
            if (companyError) {
                return res.status(500).json({ success: false, error: companyError.message })
            }

            const demoProducts = buildDemoProducts(access.companyId, company?.default_currency || 'USD')
            const { data, error } = await supabase
                .from('products')
                .upsert(demoProducts, { onConflict: 'company_id,slug' })
                .select('id, name, slug, sku, description, price, currency, stock_qty, image_url, is_active')

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

            return res.json({
                success: true,
                data: data || [],
                message: 'Demo products upserted'
            })
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

            const { data: company, error: companyError } = await fetchPublicCompanyStoreProfile(supabase, companyId)
            if (companyError) {
                return res.status(500).json({ success: false, error: 'Failed to resolve company' })
            }
            if (!company) {
                return res.status(404).json({ success: false, error: 'Store not found' })
            }
            if (company.webstore_enabled === false) {
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
                    settings: {
                        enabled: parseBoolean(company.webstore_enabled, true),
                        title: readTrimmed(company.webstore_title) || null,
                        subtitle: readTrimmed(company.webstore_subtitle) || null,
                        brand_color: normalizeHexColor(company.webstore_brand_color, '#00a884'),
                        theme: normalizeTheme(company.webstore_theme, 'editorial'),
                        show_logo: parseBoolean(company.webstore_show_logo, true),
                        hero_badge: readTrimmed(company.webstore_hero_badge) || null
                    },
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

            const { data: company, error: companyError } = await fetchPublicCompanyStoreProfile(supabase, companyId)
            if (companyError) {
                return res.status(500).send('Failed to resolve store')
            }
            if (!company) {
                return res.status(404).send('Store not found')
            }
            if (company.webstore_enabled === false) {
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
