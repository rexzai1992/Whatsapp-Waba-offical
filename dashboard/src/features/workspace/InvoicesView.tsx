import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';

type InvoiceStatus = 'draft' | 'generated' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled';

type InvoicePreset = {
    company_id: string;
    company_name: string;
    email: string | null;
    logo: string | null;
    registration_number: string | null;
    address: string | null;
    phone: string | null;
    default_currency: string;
    default_invoice_prefix: string;
    default_notes: string | null;
    default_payment_instructions: string | null;
    template_name: string;
};

type WebstoreSettings = {
    company_id: string;
    enabled: boolean;
    title: string | null;
    subtitle: string | null;
    brand_color: string;
};

type InvoiceListItem = {
    id: string;
    company_id: string;
    invoice_name: string;
    invoice_number: string;
    invoice_title: string | null;
    invoice_date: string;
    due_date: string | null;
    currency: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    status: InvoiceStatus;
    public_url: string | null;
    waba_document_url: string | null;
    created_at: string;
};

type DraftInvoiceItem = {
    id: string;
    product_id: string;
    item_name: string;
    description: string;
    quantity: string;
    unit_price: string;
};

type StoreProduct = {
    id: string;
    name: string;
    slug: string;
    sku: string | null;
    description: string | null;
    price: number;
    currency: string;
    stock_qty: number;
    image_url: string | null;
    is_active: boolean;
};

type GenerationOutput = {
    invoice_id: string;
    company_id: string;
    invoice_name: string;
    pdf_path: string | null;
    public_path: string;
    public_url: string;
    waba_document_url: string | null;
};

type InvoicesViewProps = {
    sessionToken: string | null;
    apiBaseUrl: string;
    profileId: string | null;
};

const createDraftItem = (): DraftInvoiceItem => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    product_id: '',
    item_name: '',
    description: '',
    quantity: '1',
    unit_price: '0'
});

const toIsoDate = (value: Date) => value.toISOString().slice(0, 10);

function parseMoney(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function formatMoney(value: number, currency: string): string {
    const code = (currency || 'USD').toUpperCase();
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: code,
            maximumFractionDigits: 2
        }).format(value);
    } catch {
        return `${code} ${value.toFixed(2)}`;
    }
}

function safeString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function normalizeHexColor(value: string, fallback = '#00a884'): string {
    const raw = value.trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) return raw;
    return fallback;
}

export default function InvoicesView({
    sessionToken,
    apiBaseUrl,
    profileId
}: InvoicesViewProps) {
    const [presetLoading, setPresetLoading] = useState(false);
    const [presetError, setPresetError] = useState<string | null>(null);
    const [preset, setPreset] = useState<InvoicePreset | null>(null);
    const [settingsError, setSettingsError] = useState<string | null>(null);
    const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
    const [invoiceSettingsSaving, setInvoiceSettingsSaving] = useState(false);
    const [webstoreSettingsLoading, setWebstoreSettingsLoading] = useState(false);
    const [webstoreSettingsSaving, setWebstoreSettingsSaving] = useState(false);

    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);

    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [formNotice, setFormNotice] = useState<string | null>(null);
    const [lastOutput, setLastOutput] = useState<GenerationOutput | null>(null);
    const [sendInvoiceId, setSendInvoiceId] = useState('');
    const [sendPhone, setSendPhone] = useState('');
    const [sendTemplateName, setSendTemplateName] = useState('send_invoice');
    const [sendLanguage, setSendLanguage] = useState('en_US');
    const [sendingTemplate, setSendingTemplate] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const [sendNotice, setSendNotice] = useState<string | null>(null);

    const [invoiceName, setInvoiceName] = useState('');
    const [invoiceTitle, setInvoiceTitle] = useState('');
    const [invoiceDate, setInvoiceDate] = useState(() => toIsoDate(new Date()));
    const [dueDate, setDueDate] = useState(() => {
        const next = new Date();
        next.setDate(next.getDate() + 7);
        return toIsoDate(next);
    });
    const [currency, setCurrency] = useState('USD');
    const [discount, setDiscount] = useState('0');
    const [tax, setTax] = useState('0');
    const [notes, setNotes] = useState('');
    const [paymentInstructions, setPaymentInstructions] = useState('');

    const [clientName, setClientName] = useState('');
    const [clientPhone, setClientPhone] = useState('');
    const [clientEmail, setClientEmail] = useState('');
    const [saveClient, setSaveClient] = useState(false);

    const [items, setItems] = useState<DraftInvoiceItem[]>([createDraftItem()]);
    const [productsLoading, setProductsLoading] = useState(false);
    const [productsError, setProductsError] = useState<string | null>(null);
    const [products, setProducts] = useState<StoreProduct[]>([]);
    const [catalogPickId, setCatalogPickId] = useState('');
    const [newProductName, setNewProductName] = useState('');
    const [newProductPrice, setNewProductPrice] = useState('0');
    const [newProductSku, setNewProductSku] = useState('');
    const [newProductDescription, setNewProductDescription] = useState('');
    const [productSubmitting, setProductSubmitting] = useState(false);

    const [invoiceSettingLogo, setInvoiceSettingLogo] = useState('');
    const [invoiceSettingRegistrationNumber, setInvoiceSettingRegistrationNumber] = useState('');
    const [invoiceSettingAddress, setInvoiceSettingAddress] = useState('');
    const [invoiceSettingEmail, setInvoiceSettingEmail] = useState('');
    const [invoiceSettingPhone, setInvoiceSettingPhone] = useState('');
    const [invoiceSettingDefaultCurrency, setInvoiceSettingDefaultCurrency] = useState('USD');
    const [invoiceSettingDefaultPrefix, setInvoiceSettingDefaultPrefix] = useState('INV');
    const [invoiceSettingDefaultNotes, setInvoiceSettingDefaultNotes] = useState('');
    const [invoiceSettingDefaultPaymentInstructions, setInvoiceSettingDefaultPaymentInstructions] = useState('');

    const [webstoreSettings, setWebstoreSettings] = useState<WebstoreSettings | null>(null);
    const [webstoreEnabled, setWebstoreEnabled] = useState(true);
    const [webstoreTitle, setWebstoreTitle] = useState('');
    const [webstoreSubtitle, setWebstoreSubtitle] = useState('');
    const [webstoreBrandColor, setWebstoreBrandColor] = useState('#00a884');

    const canUseApi = Boolean(sessionToken);

    const computedTotals = useMemo(() => {
        const normalized = items.map((item) => {
            const quantity = Math.max(0, parseMoney(item.quantity));
            const unitPrice = Math.max(0, parseMoney(item.unit_price));
            const lineTotal = Math.round((quantity * unitPrice + Number.EPSILON) * 100) / 100;
            return {
                ...item,
                quantity,
                unitPrice,
                lineTotal
            };
        });
        const subtotal = normalized.reduce((sum, item) => sum + item.lineTotal, 0);
        const discountValue = Math.max(0, Math.min(parseMoney(discount), subtotal));
        const taxValue = Math.max(0, parseMoney(tax));
        const total = Math.max(0, subtotal - discountValue + taxValue);
        return {
            normalized,
            subtotal,
            discount: discountValue,
            tax: taxValue,
            total
        };
    }, [discount, items, tax]);

    const loadPreset = useCallback(async () => {
        if (!sessionToken) return;
        setPresetLoading(true);
        setPresetError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/company/invoice-preset`, {
                headers: { authorization: `Bearer ${sessionToken}` }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to load invoice preset');
            }
            const nextPreset: InvoicePreset = {
                company_id: safeString(payload.data.company_id),
                company_name: safeString(payload.data.company_name),
                email: typeof payload.data.email === 'string' ? payload.data.email : null,
                logo: typeof payload.data.logo === 'string' ? payload.data.logo : null,
                registration_number: typeof payload.data.registration_number === 'string' ? payload.data.registration_number : null,
                address: typeof payload.data.address === 'string' ? payload.data.address : null,
                phone: typeof payload.data.phone === 'string' ? payload.data.phone : null,
                default_currency: safeString(payload.data.default_currency || 'USD'),
                default_invoice_prefix: safeString(payload.data.default_invoice_prefix || 'INV'),
                default_notes: typeof payload.data.default_notes === 'string' ? payload.data.default_notes : null,
                default_payment_instructions: typeof payload.data.default_payment_instructions === 'string'
                    ? payload.data.default_payment_instructions
                    : null,
                template_name: safeString(payload.data.template_name || 'default')
            };
            setPreset(nextPreset);
            setCurrency(nextPreset.default_currency || 'USD');
            setNotes(nextPreset.default_notes || '');
            setPaymentInstructions(nextPreset.default_payment_instructions || '');
            setInvoiceSettingLogo(nextPreset.logo || '');
            setInvoiceSettingRegistrationNumber(nextPreset.registration_number || '');
            setInvoiceSettingAddress(nextPreset.address || '');
            setInvoiceSettingEmail(nextPreset.email || '');
            setInvoiceSettingPhone(nextPreset.phone || '');
            setInvoiceSettingDefaultCurrency(nextPreset.default_currency || 'USD');
            setInvoiceSettingDefaultPrefix(nextPreset.default_invoice_prefix || 'INV');
            setInvoiceSettingDefaultNotes(nextPreset.default_notes || '');
            setInvoiceSettingDefaultPaymentInstructions(nextPreset.default_payment_instructions || '');
        } catch (error: any) {
            setPresetError(error?.message || 'Failed to load invoice preset');
        } finally {
            setPresetLoading(false);
        }
    }, [apiBaseUrl, sessionToken]);

    const loadWebstoreSettings = useCallback(async () => {
        if (!sessionToken) return;
        setWebstoreSettingsLoading(true);
        setSettingsError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/company/webstore-settings`, {
                headers: { authorization: `Bearer ${sessionToken}` }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to load webstore settings');
            }
            const mapped: WebstoreSettings = {
                company_id: safeString(payload.data.company_id),
                enabled: payload.data.enabled !== false,
                title: typeof payload.data.title === 'string' ? payload.data.title : null,
                subtitle: typeof payload.data.subtitle === 'string' ? payload.data.subtitle : null,
                brand_color: normalizeHexColor(safeString(payload.data.brand_color || '#00a884') || '#00a884')
            };
            setWebstoreSettings(mapped);
            setWebstoreEnabled(mapped.enabled);
            setWebstoreTitle(mapped.title || '');
            setWebstoreSubtitle(mapped.subtitle || '');
            setWebstoreBrandColor(mapped.brand_color || '#00a884');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to load webstore settings');
        } finally {
            setWebstoreSettingsLoading(false);
        }
    }, [apiBaseUrl, sessionToken]);

    const loadInvoices = useCallback(async () => {
        if (!sessionToken) return;
        setListLoading(true);
        setListError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/invoices?limit=40`, {
                headers: { authorization: `Bearer ${sessionToken}` }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !Array.isArray(payload?.data)) {
                throw new Error(payload?.error || 'Failed to load invoices');
            }
            const mapped: InvoiceListItem[] = payload.data.map((row: any) => ({
                id: safeString(row.id),
                company_id: safeString(row.company_id),
                invoice_name: safeString(row.invoice_name),
                invoice_number: safeString(row.invoice_number),
                invoice_title: typeof row.invoice_title === 'string' ? row.invoice_title : null,
                invoice_date: safeString(row.invoice_date),
                due_date: typeof row.due_date === 'string' ? row.due_date : null,
                currency: safeString(row.currency || 'USD'),
                subtotal: Number(row.subtotal || 0),
                discount: Number(row.discount || 0),
                tax: Number(row.tax || 0),
                total: Number(row.total || 0),
                status: safeString(row.status || 'draft') as InvoiceStatus,
                public_url: typeof row.public_url === 'string' ? row.public_url : null,
                waba_document_url: typeof row.waba_document_url === 'string' ? row.waba_document_url : null,
                created_at: safeString(row.created_at)
            }));
            setInvoices(mapped);
        } catch (error: any) {
            setListError(error?.message || 'Failed to load invoices');
        } finally {
            setListLoading(false);
        }
    }, [apiBaseUrl, sessionToken]);

    const loadProducts = useCallback(async () => {
        if (!sessionToken) return;
        setProductsLoading(true);
        setProductsError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/store/products?limit=200`, {
                headers: { authorization: `Bearer ${sessionToken}` }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !Array.isArray(payload?.data)) {
                throw new Error(payload?.error || 'Failed to load products');
            }
            const mapped: StoreProduct[] = payload.data.map((row: any) => ({
                id: safeString(row.id),
                name: safeString(row.name),
                slug: safeString(row.slug),
                sku: typeof row.sku === 'string' ? row.sku : null,
                description: typeof row.description === 'string' ? row.description : null,
                price: Number(row.price || 0),
                currency: safeString(row.currency || 'USD'),
                stock_qty: Number(row.stock_qty || 0),
                image_url: typeof row.image_url === 'string' ? row.image_url : null,
                is_active: row.is_active !== false
            }));
            setProducts(mapped);
            setCatalogPickId((prev) => (prev || mapped[0]?.id || ''));
        } catch (error: any) {
            setProductsError(error?.message || 'Failed to load products');
        } finally {
            setProductsLoading(false);
        }
    }, [apiBaseUrl, sessionToken]);

    useEffect(() => {
        loadPreset();
        loadInvoices();
        loadProducts();
        loadWebstoreSettings();
    }, [loadInvoices, loadPreset, loadProducts, loadWebstoreSettings]);

    useEffect(() => {
        if (!sendInvoiceId && invoices.length > 0) {
            setSendInvoiceId(invoices[0].id);
        }
    }, [invoices, sendInvoiceId]);

    const handleSaveInvoiceSettings = useCallback(async () => {
        if (!sessionToken) {
            setSettingsError('Please sign in first.');
            return;
        }
        setInvoiceSettingsSaving(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/company/invoice-preset`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    logo: invoiceSettingLogo.trim() || null,
                    registration_number: invoiceSettingRegistrationNumber.trim() || null,
                    address: invoiceSettingAddress.trim() || null,
                    email: invoiceSettingEmail.trim() || null,
                    phone: invoiceSettingPhone.trim() || null,
                    default_currency: invoiceSettingDefaultCurrency.trim() || 'USD',
                    default_invoice_prefix: invoiceSettingDefaultPrefix.trim() || 'INV',
                    default_notes: invoiceSettingDefaultNotes.trim() || null,
                    default_payment_instructions: invoiceSettingDefaultPaymentInstructions.trim() || null,
                    template_name: preset?.template_name || 'default'
                })
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to save invoice settings');
            }

            const nextPreset: InvoicePreset = {
                company_id: safeString(payload.data.company_id),
                company_name: safeString(payload.data.company_name),
                email: typeof payload.data.email === 'string' ? payload.data.email : null,
                logo: typeof payload.data.logo === 'string' ? payload.data.logo : null,
                registration_number: typeof payload.data.registration_number === 'string' ? payload.data.registration_number : null,
                address: typeof payload.data.address === 'string' ? payload.data.address : null,
                phone: typeof payload.data.phone === 'string' ? payload.data.phone : null,
                default_currency: safeString(payload.data.default_currency || 'USD'),
                default_invoice_prefix: safeString(payload.data.default_invoice_prefix || 'INV'),
                default_notes: typeof payload.data.default_notes === 'string' ? payload.data.default_notes : null,
                default_payment_instructions: typeof payload.data.default_payment_instructions === 'string'
                    ? payload.data.default_payment_instructions
                    : null,
                template_name: safeString(payload.data.template_name || 'default')
            };
            setPreset(nextPreset);
            setCurrency(nextPreset.default_currency || 'USD');
            setNotes(nextPreset.default_notes || '');
            setPaymentInstructions(nextPreset.default_payment_instructions || '');
            setSettingsNotice('Invoice settings saved.');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to save invoice settings');
        } finally {
            setInvoiceSettingsSaving(false);
        }
    }, [
        apiBaseUrl,
        invoiceSettingAddress,
        invoiceSettingDefaultCurrency,
        invoiceSettingDefaultNotes,
        invoiceSettingDefaultPaymentInstructions,
        invoiceSettingDefaultPrefix,
        invoiceSettingEmail,
        invoiceSettingLogo,
        invoiceSettingPhone,
        invoiceSettingRegistrationNumber,
        preset?.template_name,
        sessionToken
    ]);

    const handleSaveWebstoreSettings = useCallback(async () => {
        if (!sessionToken) {
            setSettingsError('Please sign in first.');
            return;
        }
        setWebstoreSettingsSaving(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/company/webstore-settings`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    enabled: webstoreEnabled,
                    title: webstoreTitle.trim() || null,
                    subtitle: webstoreSubtitle.trim() || null,
                    brand_color: normalizeHexColor(webstoreBrandColor, '#00a884')
                })
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to save webstore settings');
            }
            const mapped: WebstoreSettings = {
                company_id: safeString(payload.data.company_id),
                enabled: payload.data.enabled !== false,
                title: typeof payload.data.title === 'string' ? payload.data.title : null,
                subtitle: typeof payload.data.subtitle === 'string' ? payload.data.subtitle : null,
                brand_color: normalizeHexColor(safeString(payload.data.brand_color || '#00a884') || '#00a884')
            };
            setWebstoreSettings(mapped);
            setWebstoreEnabled(mapped.enabled);
            setWebstoreTitle(mapped.title || '');
            setWebstoreSubtitle(mapped.subtitle || '');
            setWebstoreBrandColor(mapped.brand_color || '#00a884');
            setSettingsNotice('Webstore settings saved.');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to save webstore settings');
        } finally {
            setWebstoreSettingsSaving(false);
        }
    }, [apiBaseUrl, sessionToken, webstoreBrandColor, webstoreEnabled, webstoreSubtitle, webstoreTitle]);

    const resetForm = useCallback(() => {
        setInvoiceName('');
        setInvoiceTitle('');
        setClientName('');
        setClientPhone('');
        setClientEmail('');
        setDiscount('0');
        setTax('0');
        setItems([createDraftItem()]);
    }, []);

    const updateItem = useCallback((itemId: string, key: keyof DraftInvoiceItem, value: string) => {
        setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, [key]: value } : item)));
    }, []);

    const applyProductToItem = useCallback((itemId: string, productId: string) => {
        setItems((prev) => prev.map((item) => {
            if (item.id !== itemId) return item;
            if (!productId) {
                return { ...item, product_id: '' };
            }
            const product = products.find((row) => row.id === productId);
            if (!product) return { ...item, product_id: '' };
            return {
                ...item,
                product_id: product.id,
                item_name: product.name,
                description: product.description || '',
                unit_price: String(product.price || 0)
            };
        }));
    }, [products]);

    const handleAddProductItem = useCallback(() => {
        const product = products.find((row) => row.id === catalogPickId);
        if (!product) {
            setFormError('Pick a product first.');
            return;
        }
        setItems((prev) => [
            ...prev,
            {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                product_id: product.id,
                item_name: product.name,
                description: product.description || '',
                quantity: '1',
                unit_price: String(product.price || 0)
            }
        ]);
        setFormError(null);
    }, [catalogPickId, products]);

    const removeItem = useCallback((itemId: string) => {
        setItems((prev) => {
            const next = prev.filter((item) => item.id !== itemId);
            return next.length > 0 ? next : [createDraftItem()];
        });
    }, []);

    const handleGenerateInvoice = useCallback(async () => {
        if (!sessionToken) {
            setFormError('Please sign in first.');
            return;
        }

        const validItems = computedTotals.normalized.filter((item) => item.item_name.trim());
        if (validItems.length === 0) {
            setFormError('Add at least one item with a name.');
            return;
        }
        if (validItems.some((item) => item.quantity <= 0)) {
            setFormError('Each item quantity must be greater than 0.');
            return;
        }

        setSubmitting(true);
        setFormError(null);
        setFormNotice(null);
        setLastOutput(null);

        try {
            const draftBody: Record<string, unknown> = {
                invoice_name: invoiceName.trim() || undefined,
                invoice_title: invoiceTitle.trim() || undefined,
                invoice_date: invoiceDate || undefined,
                due_date: dueDate || undefined,
                currency: currency.trim() || undefined,
                discount: computedTotals.discount,
                tax: computedTotals.tax,
                notes: notes.trim() || undefined,
                payment_instructions: paymentInstructions.trim() || undefined,
                items: validItems.map((item) => ({
                    product_id: item.product_id || undefined,
                    item_name: item.item_name.trim(),
                    description: item.description.trim() || undefined,
                    quantity: item.quantity,
                    unit_price: item.unitPrice
                })),
                save_client: saveClient
            };

            if (clientName.trim() || clientPhone.trim() || clientEmail.trim()) {
                draftBody.client = {
                    name: clientName.trim() || 'Client',
                    phone: clientPhone.trim() || undefined,
                    email: clientEmail.trim() || undefined
                };
            }

            const draftRes = await fetch(`${apiBaseUrl}/api/invoices/draft`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(draftBody)
            });
            const draftPayload = await draftRes.json().catch(() => null);
            if (!draftRes.ok || !draftPayload?.success || !draftPayload?.data?.invoice?.id) {
                throw new Error(draftPayload?.error || 'Failed to create invoice draft');
            }

            const invoiceId = safeString(draftPayload.data.invoice.id);
            const generateRes = await fetch(`${apiBaseUrl}/api/invoices/${encodeURIComponent(invoiceId)}/generate`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    discount: computedTotals.discount,
                    tax: computedTotals.tax
                })
            });
            const generatePayload = await generateRes.json().catch(() => null);
            if (!generateRes.ok || !generatePayload?.success || !generatePayload?.data?.outputs) {
                throw new Error(generatePayload?.error || 'Failed to generate invoice PDF');
            }

            const outputs: GenerationOutput = {
                invoice_id: safeString(generatePayload.data.invoice?.id || invoiceId),
                company_id: safeString(generatePayload.data.outputs.company_id),
                invoice_name: safeString(generatePayload.data.outputs.invoice_name),
                pdf_path: typeof generatePayload.data.outputs.pdf_path === 'string' ? generatePayload.data.outputs.pdf_path : null,
                public_path: safeString(generatePayload.data.outputs.public_path),
                public_url: safeString(generatePayload.data.outputs.public_url),
                waba_document_url: typeof generatePayload.data.outputs.waba_document_url === 'string'
                    ? generatePayload.data.outputs.waba_document_url
                    : null
            };
            setLastOutput(outputs);
            setSendInvoiceId(outputs.invoice_id);
            setFormNotice('Invoice generated and uploaded successfully.');
            resetForm();
            loadInvoices();
        } catch (error: any) {
            setFormError(error?.message || 'Failed to generate invoice');
        } finally {
            setSubmitting(false);
        }
    }, [
        apiBaseUrl,
        clientEmail,
        clientName,
        clientPhone,
        computedTotals.discount,
        computedTotals.normalized,
        computedTotals.tax,
        currency,
        dueDate,
        invoiceDate,
        invoiceName,
        invoiceTitle,
        loadInvoices,
        notes,
        paymentInstructions,
        resetForm,
        saveClient,
        sessionToken
    ]);

    const handleCreateProduct = useCallback(async () => {
        if (!sessionToken) {
            setProductsError('Please sign in first.');
            return;
        }
        if (!newProductName.trim()) {
            setProductsError('Product name is required.');
            return;
        }

        const priceValue = parseMoney(newProductPrice);
        if (!Number.isFinite(priceValue) || priceValue < 0) {
            setProductsError('Product price must be >= 0.');
            return;
        }

        setProductSubmitting(true);
        setProductsError(null);
        try {
            const res = await fetch(`${apiBaseUrl}/api/store/products`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    name: newProductName.trim(),
                    price: priceValue,
                    currency: currency.trim() || 'USD',
                    sku: newProductSku.trim() || undefined,
                    description: newProductDescription.trim() || undefined
                })
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success) {
                throw new Error(payload?.error || 'Failed to create product');
            }

            setNewProductName('');
            setNewProductPrice('0');
            setNewProductSku('');
            setNewProductDescription('');
            setFormNotice('Product added to webstore catalog.');
            loadProducts();
        } catch (error: any) {
            setProductsError(error?.message || 'Failed to create product');
        } finally {
            setProductSubmitting(false);
        }
    }, [
        apiBaseUrl,
        currency,
        loadProducts,
        newProductDescription,
        newProductName,
        newProductPrice,
        newProductSku,
        sessionToken
    ]);

    const handleSendInvoiceTemplate = useCallback(async () => {
        if (!sessionToken) {
            setSendError('Please sign in first.');
            return;
        }
        if (!profileId) {
            setSendError('Select an active WABA profile first.');
            return;
        }
        if (!sendInvoiceId) {
            setSendError('Select an invoice to send.');
            return;
        }
        if (!sendPhone.trim()) {
            setSendError('Recipient phone is required.');
            return;
        }
        if (!sendTemplateName.trim()) {
            setSendError('Template name is required.');
            return;
        }

        setSendingTemplate(true);
        setSendError(null);
        setSendNotice(null);

        try {
            const params = new URLSearchParams({ profileId });
            const res = await fetch(`${apiBaseUrl}/api/waba/templates/send?${params.toString()}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    invoice_id: sendInvoiceId,
                    to: sendPhone.trim(),
                    name: sendTemplateName.trim(),
                    language: sendLanguage.trim() || 'en_US'
                })
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data?.messageId) {
                throw new Error(payload?.error || 'Failed to send invoice template');
            }

            const warning = typeof payload.data.invoiceStatusError === 'string' && payload.data.invoiceStatusError
                ? ` Sent (messageId: ${payload.data.messageId}) but invoice status update failed: ${payload.data.invoiceStatusError}`
                : ` Sent successfully (messageId: ${payload.data.messageId}).`;
            setSendNotice(`Invoice template${warning}`);
            loadInvoices();
        } catch (error: any) {
            setSendError(error?.message || 'Failed to send invoice template');
        } finally {
            setSendingTemplate(false);
        }
    }, [
        apiBaseUrl,
        loadInvoices,
        profileId,
        sendInvoiceId,
        sendLanguage,
        sendPhone,
        sendTemplateName,
        sessionToken
    ]);

    return (
        <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                <div className="max-w-[1080px] mx-auto space-y-5">
                    <section className="bg-white border border-[#eceff1] rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] p-6">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h2 className="text-2xl font-black text-[#111b21] flex items-center gap-2">
                                    <FileText className="w-6 h-6 text-[#00a884]" />
                                    Invoice Generator
                                </h2>
                                <p className="text-sm text-[#54656f] mt-1">
                                    Create, generate, and publish invoice PDFs ready for WABA document templates.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    loadPreset();
                                    loadInvoices();
                                    loadProducts();
                                    loadWebstoreSettings();
                                }}
                                disabled={!canUseApi || presetLoading || listLoading || productsLoading || webstoreSettingsLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-xs font-bold hover:bg-[#f8f9fa] transition-all disabled:opacity-50"
                            >
                                <RefreshCw className={`w-4 h-4 ${presetLoading || listLoading || productsLoading || webstoreSettingsLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {!canUseApi && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold">
                                Sign in first to use invoice APIs.
                            </div>
                        )}
                        {presetError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {presetError}
                            </div>
                        )}
                        {formError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {formError}
                            </div>
                        )}
                        {formNotice && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                                {formNotice}
                            </div>
                        )}
                        {sendError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {sendError}
                            </div>
                        )}
                        {sendNotice && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                                {sendNotice}
                            </div>
                        )}
                        {productsError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {productsError}
                            </div>
                        )}
                        {settingsError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {settingsError}
                            </div>
                        )}
                        {settingsNotice && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                                {settingsNotice}
                            </div>
                        )}

                        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <div className="rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <h3 className="text-sm font-black uppercase tracking-widest text-[#54656f]">Invoice Settings</h3>
                                    <button
                                        type="button"
                                        onClick={handleSaveInvoiceSettings}
                                        disabled={!canUseApi || invoiceSettingsSaving}
                                        className="px-3 py-1.5 rounded-lg bg-[#111b21] text-white text-[11px] font-bold uppercase tracking-widest hover:bg-[#202c33] transition-all disabled:opacity-50"
                                    >
                                        {invoiceSettingsSaving ? 'Saving…' : 'Save'}
                                    </button>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <input
                                        value={invoiceSettingDefaultCurrency}
                                        onChange={(e) => setInvoiceSettingDefaultCurrency(e.target.value.toUpperCase())}
                                        placeholder="Default currency (USD)"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                    <input
                                        value={invoiceSettingDefaultPrefix}
                                        onChange={(e) => setInvoiceSettingDefaultPrefix(e.target.value.toUpperCase())}
                                        placeholder="Invoice prefix (INV)"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                    <input
                                        value={invoiceSettingEmail}
                                        onChange={(e) => setInvoiceSettingEmail(e.target.value)}
                                        placeholder="Company email"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                    <input
                                        value={invoiceSettingPhone}
                                        onChange={(e) => setInvoiceSettingPhone(e.target.value)}
                                        placeholder="Company phone"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                    <input
                                        value={invoiceSettingRegistrationNumber}
                                        onChange={(e) => setInvoiceSettingRegistrationNumber(e.target.value)}
                                        placeholder="Registration number"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                    <input
                                        value={invoiceSettingLogo}
                                        onChange={(e) => setInvoiceSettingLogo(e.target.value)}
                                        placeholder="Logo URL"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </div>
                                <textarea
                                    value={invoiceSettingAddress}
                                    onChange={(e) => setInvoiceSettingAddress(e.target.value)}
                                    rows={2}
                                    placeholder="Company address"
                                    className="mt-2 w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <textarea
                                    value={invoiceSettingDefaultNotes}
                                    onChange={(e) => setInvoiceSettingDefaultNotes(e.target.value)}
                                    rows={2}
                                    placeholder="Default invoice notes"
                                    className="mt-2 w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <textarea
                                    value={invoiceSettingDefaultPaymentInstructions}
                                    onChange={(e) => setInvoiceSettingDefaultPaymentInstructions(e.target.value)}
                                    rows={2}
                                    placeholder="Default payment instructions"
                                    className="mt-2 w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                            </div>

                            <div className="rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <h3 className="text-sm font-black uppercase tracking-widest text-[#54656f]">Webstore Settings</h3>
                                    <button
                                        type="button"
                                        onClick={handleSaveWebstoreSettings}
                                        disabled={!canUseApi || webstoreSettingsSaving}
                                        className="px-3 py-1.5 rounded-lg bg-[#00a884] text-white text-[11px] font-bold uppercase tracking-widest hover:bg-[#008f6f] transition-all disabled:opacity-50"
                                    >
                                        {webstoreSettingsSaving ? 'Saving…' : 'Save'}
                                    </button>
                                </div>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#334155] mb-2">
                                    <input
                                        type="checkbox"
                                        checked={webstoreEnabled}
                                        onChange={(e) => setWebstoreEnabled(e.target.checked)}
                                        className="w-4 h-4 accent-[#00a884]"
                                    />
                                    Enable public webstore
                                </label>
                                <input
                                    value={webstoreTitle}
                                    onChange={(e) => setWebstoreTitle(e.target.value)}
                                    placeholder={preset ? `${preset.company_name} Store` : 'Store title'}
                                    className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <textarea
                                    value={webstoreSubtitle}
                                    onChange={(e) => setWebstoreSubtitle(e.target.value)}
                                    rows={2}
                                    placeholder="Store subtitle shown on the public page"
                                    className="mt-2 w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <div className="mt-2 grid grid-cols-[88px_1fr] gap-2 items-center">
                                    <input
                                        type="color"
                                        value={normalizeHexColor(webstoreBrandColor, '#00a884')}
                                        onChange={(e) => setWebstoreBrandColor(e.target.value)}
                                        className="h-10 w-full rounded-lg border border-[#eceff1] bg-white px-1"
                                    />
                                    <input
                                        value={webstoreBrandColor}
                                        onChange={(e) => setWebstoreBrandColor(e.target.value)}
                                        placeholder="#00a884"
                                        className="rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </div>
                                {preset?.company_id && (
                                    <div className="mt-2 flex items-center gap-3 text-xs font-bold">
                                        <a
                                            href={`${window.location.origin}/${preset.company_id}/store`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-[#00a884] hover:underline"
                                        >
                                            Open Store
                                            <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                        <a
                                            href={`${window.location.origin}/customixie?company=${encodeURIComponent(preset.company_id)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-[#111b21] hover:underline"
                                        >
                                            Open Customixie
                                            <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                    </div>
                                )}
                                {webstoreSettings && (
                                    <div className="mt-2 text-[11px] text-[#54656f]">
                                        Current profile: {webstoreSettings.company_id}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <div className="space-y-3">
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Invoice Name</span>
                                    <input
                                        value={invoiceName}
                                        onChange={(e) => setInvoiceName(e.target.value)}
                                        placeholder={preset ? `${preset.default_invoice_prefix}-0001` : 'INV-0001'}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Invoice Title</span>
                                    <input
                                        value={invoiceTitle}
                                        onChange={(e) => setInvoiceTitle(e.target.value)}
                                        placeholder="Project invoice"
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Invoice Date</span>
                                        <input
                                            type="date"
                                            value={invoiceDate}
                                            onChange={(e) => setInvoiceDate(e.target.value)}
                                            className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </label>
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Due Date</span>
                                        <input
                                            type="date"
                                            value={dueDate}
                                            onChange={(e) => setDueDate(e.target.value)}
                                            className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </label>
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Currency</span>
                                        <input
                                            value={currency}
                                            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                                            className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </label>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Client Name</span>
                                    <input
                                        value={clientName}
                                        onChange={(e) => setClientName(e.target.value)}
                                        placeholder="Client / Company name"
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Client Phone</span>
                                        <input
                                            value={clientPhone}
                                            onChange={(e) => setClientPhone(e.target.value)}
                                            placeholder="+1..."
                                            className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </label>
                                    <label className="space-y-1 block">
                                        <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Client Email</span>
                                        <input
                                            value={clientEmail}
                                            onChange={(e) => setClientEmail(e.target.value)}
                                            placeholder="client@example.com"
                                            className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </label>
                                </div>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#334155]">
                                    <input
                                        type="checkbox"
                                        checked={saveClient}
                                        onChange={(e) => setSaveClient(e.target.checked)}
                                        className="w-4 h-4 accent-[#00a884]"
                                    />
                                    Save this client for reuse
                                </label>
                                {preset && (
                                    <div className="rounded-xl border border-[#eceff1] bg-[#f8f9fa] px-3 py-2 text-xs text-[#54656f]">
                                        <span className="font-bold text-[#111b21]">{preset.company_name}</span> preset loaded
                                        ({preset.default_currency}, prefix {preset.default_invoice_prefix}).
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mt-6 rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-black uppercase tracking-widest text-[#54656f]">Webstore Products</h3>
                                {preset?.company_id && (
                                    <div className="flex items-center gap-2">
                                        <a
                                            href={`${window.location.origin}/${preset.company_id}/store`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-[#00a884] text-xs font-bold hover:underline"
                                        >
                                            Open Store
                                            <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                        <a
                                            href={`${window.location.origin}/customixie?company=${encodeURIComponent(preset.company_id)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-[#111b21] text-xs font-bold hover:underline"
                                        >
                                            Customixie Landing
                                            <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                    </div>
                                )}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                                <input
                                    value={newProductName}
                                    onChange={(e) => setNewProductName(e.target.value)}
                                    placeholder="Product name"
                                    className="md:col-span-3 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <input
                                    value={newProductPrice}
                                    onChange={(e) => setNewProductPrice(e.target.value)}
                                    placeholder="Price"
                                    className="md:col-span-2 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <input
                                    value={newProductSku}
                                    onChange={(e) => setNewProductSku(e.target.value)}
                                    placeholder="SKU (optional)"
                                    className="md:col-span-2 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <input
                                    value={newProductDescription}
                                    onChange={(e) => setNewProductDescription(e.target.value)}
                                    placeholder="Description (optional)"
                                    className="md:col-span-4 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                />
                                <button
                                    type="button"
                                    onClick={handleCreateProduct}
                                    disabled={!canUseApi || productSubmitting}
                                    className="md:col-span-1 rounded-xl bg-[#111b21] text-white text-xs font-bold hover:bg-[#202c33] transition-all disabled:opacity-50"
                                >
                                    {productSubmitting ? 'Saving…' : 'Save'}
                                </button>
                            </div>
                            <div className="mt-2 text-xs text-[#54656f]">
                                {productsLoading ? 'Loading products…' : `${products.length} active products available for invoice items.`}
                            </div>
                        </div>

                        <div className="mt-6">
                            <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                                <h3 className="text-sm font-black uppercase tracking-widest text-[#54656f]">Invoice Items</h3>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <select
                                        value={catalogPickId}
                                        onChange={(e) => setCatalogPickId(e.target.value)}
                                        className="rounded-lg border border-[#eceff1] bg-white px-2 py-1.5 text-xs font-semibold text-[#334155]"
                                    >
                                        <option value="">Pick product</option>
                                        {products.map((product) => (
                                            <option key={product.id} value={product.id}>
                                                {product.name} ({formatMoney(product.price, product.currency)})
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={handleAddProductItem}
                                        className="px-3 py-1.5 rounded-lg border border-[#00a884]/30 text-[#00a884] text-xs font-bold hover:bg-[#00a884]/10 transition-all"
                                    >
                                        <Plus className="w-3.5 h-3.5 inline mr-1" />
                                        Add Product Item
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setItems((prev) => [...prev, createDraftItem()])}
                                        className="px-3 py-1.5 rounded-lg border border-[#00a884]/30 text-[#00a884] text-xs font-bold hover:bg-[#00a884]/10 transition-all"
                                    >
                                        <Plus className="w-3.5 h-3.5 inline mr-1" />
                                        Add Manual Item
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-2">
                                {items.map((item) => {
                                    const quantity = Math.max(0, parseMoney(item.quantity));
                                    const unitPrice = Math.max(0, parseMoney(item.unit_price));
                                    const lineTotal = quantity * unitPrice;
                                    return (
                                        <div key={item.id} className="rounded-2xl border border-[#eceff1] bg-[#fcfdfd] p-3">
                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                                                <select
                                                    value={item.product_id}
                                                    onChange={(e) => applyProductToItem(item.id, e.target.value)}
                                                    className="md:col-span-3 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                                >
                                                    <option value="">Manual item</option>
                                                    {products.map((product) => (
                                                        <option key={product.id} value={product.id}>
                                                            {product.name}
                                                        </option>
                                                    ))}
                                                </select>
                                                <input
                                                    value={item.item_name}
                                                    onChange={(e) => updateItem(item.id, 'item_name', e.target.value)}
                                                    placeholder="Item name"
                                                    className="md:col-span-3 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                                />
                                                <input
                                                    value={item.description}
                                                    onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                                                    placeholder="Description (optional)"
                                                    className="md:col-span-3 rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                                />
                                                <input
                                                    value={item.quantity}
                                                    onChange={(e) => updateItem(item.id, 'quantity', e.target.value)}
                                                    placeholder="Qty"
                                                    className="md:col-span-1 rounded-xl border border-[#eceff1] bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                                />
                                                <input
                                                    value={item.unit_price}
                                                    onChange={(e) => updateItem(item.id, 'unit_price', e.target.value)}
                                                    placeholder="Unit"
                                                    className="md:col-span-1 rounded-xl border border-[#eceff1] bg-white px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => removeItem(item.id)}
                                                    className="md:col-span-1 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 transition-all text-xs font-bold flex items-center justify-center"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                            <div className="mt-2 text-xs text-[#54656f]">
                                                Line total: <span className="font-bold text-[#111b21]">{formatMoney(lineTotal, currency)}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Notes</span>
                                    <textarea
                                        value={notes}
                                        onChange={(e) => setNotes(e.target.value)}
                                        rows={3}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Payment Instructions</span>
                                    <textarea
                                        value={paymentInstructions}
                                        onChange={(e) => setPaymentInstructions(e.target.value)}
                                        rows={3}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                            </div>
                            <div className="rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                                <h4 className="text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-3">Totals Preview</h4>
                                <div className="space-y-2 text-sm">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[#54656f]">Subtotal</span>
                                        <span className="font-bold">{formatMoney(computedTotals.subtotal, currency)}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[#54656f]">Discount</span>
                                        <input
                                            value={discount}
                                            onChange={(e) => setDiscount(e.target.value)}
                                            className="w-28 rounded-lg border border-[#eceff1] bg-white px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[#54656f]">Tax</span>
                                        <input
                                            value={tax}
                                            onChange={(e) => setTax(e.target.value)}
                                            className="w-28 rounded-lg border border-[#eceff1] bg-white px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                        />
                                    </div>
                                    <div className="h-px bg-[#e2e8f0] my-1" />
                                    <div className="flex items-center justify-between">
                                        <span className="font-black text-[#111b21]">Grand Total</span>
                                        <span className="font-black text-[#111b21]">{formatMoney(computedTotals.total, currency)}</span>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleGenerateInvoice}
                                    disabled={!canUseApi || submitting}
                                    className="mt-4 w-full px-4 py-2.5 rounded-xl bg-[#111b21] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#202c33] transition-all disabled:opacity-50"
                                >
                                    {submitting ? 'Generating…' : 'Generate Invoice PDF'}
                                </button>
                            </div>
                        </div>

                        {lastOutput && (
                            <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
                                <div className="font-black text-emerald-800 mb-1">Invoice ready for WABA</div>
                                <div className="text-emerald-900">Path: {lastOutput.pdf_path || '-'}</div>
                                <div className="text-emerald-900">Public route: {lastOutput.public_path}</div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    <a
                                        href={lastOutput.public_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-emerald-300 text-emerald-800 text-xs font-bold"
                                    >
                                        Open Public URL
                                        <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                    {lastOutput.waba_document_url && (
                                        <a
                                            href={lastOutput.waba_document_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-emerald-300 text-emerald-800 text-xs font-bold"
                                        >
                                            Open WABA Doc URL
                                            <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="mt-5 rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                            <div className="text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-3">
                                Send Via WhatsApp
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Invoice</span>
                                    <select
                                        value={sendInvoiceId}
                                        onChange={(e) => setSendInvoiceId(e.target.value)}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    >
                                        <option value="">Select invoice</option>
                                        {invoices.map((invoice) => (
                                            <option key={invoice.id} value={invoice.id}>
                                                {invoice.invoice_number} ({invoice.invoice_name})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Recipient Phone</span>
                                    <input
                                        value={sendPhone}
                                        onChange={(e) => setSendPhone(e.target.value)}
                                        placeholder="+6012..."
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Template Name</span>
                                    <input
                                        value={sendTemplateName}
                                        onChange={(e) => setSendTemplateName(e.target.value)}
                                        placeholder="send_invoice"
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <label className="space-y-1 block">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Language</span>
                                    <input
                                        value={sendLanguage}
                                        onChange={(e) => setSendLanguage(e.target.value)}
                                        placeholder="en_US"
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                            </div>
                            <div className="mt-3 flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleSendInvoiceTemplate}
                                    disabled={!canUseApi || !profileId || sendingTemplate}
                                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#00a884] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#008f6f] transition-all disabled:opacity-50"
                                >
                                    <Send className="w-3.5 h-3.5" />
                                    {sendingTemplate ? 'Sending…' : 'Send Invoice Template'}
                                </button>
                            </div>
                        </div>
                    </section>

                    <section className="bg-white border border-[#eceff1] rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] p-6">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-black text-[#111b21]">Recent Invoices</h3>
                            <button
                                type="button"
                                onClick={loadInvoices}
                                disabled={!canUseApi || listLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-xs font-bold hover:bg-[#f8f9fa] transition-all disabled:opacity-50"
                            >
                                <RefreshCw className={`w-4 h-4 ${listLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                        {listError && (
                            <div className="mb-3 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {listError}
                            </div>
                        )}
                        {invoices.length === 0 ? (
                            <div className="text-sm text-[#54656f]">No invoices yet.</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead className="text-[11px] uppercase tracking-widest text-[#54656f] border-b border-[#eceff1]">
                                        <tr>
                                            <th className="py-2 pr-3">Number</th>
                                            <th className="py-2 pr-3">Invoice Name</th>
                                            <th className="py-2 pr-3">Date</th>
                                            <th className="py-2 pr-3">Status</th>
                                            <th className="py-2 pr-3 text-right">Total</th>
                                            <th className="py-2">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#f0f2f5]">
                                        {invoices.map((invoice) => {
                                            const href = invoice.public_url
                                                || `${window.location.origin}/${invoice.company_id}/invoice/${encodeURIComponent(invoice.invoice_name)}.pdf`;
                                            return (
                                                <tr key={invoice.id}>
                                                    <td className="py-2 pr-3 font-bold">{invoice.invoice_number}</td>
                                                    <td className="py-2 pr-3">{invoice.invoice_name}</td>
                                                    <td className="py-2 pr-3">{invoice.invoice_date}</td>
                                                    <td className="py-2 pr-3">
                                                        <span className="px-2 py-1 rounded-full text-[10px] font-black uppercase bg-[#f1f5f9] text-[#334155]">
                                                            {invoice.status}
                                                        </span>
                                                    </td>
                                                    <td className="py-2 pr-3 text-right font-bold">{formatMoney(invoice.total, invoice.currency)}</td>
                                                    <td className="py-2">
                                                        <div className="flex items-center gap-3">
                                                            <a
                                                                href={href}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-1 text-[#00a884] font-bold hover:underline"
                                                            >
                                                                Open
                                                                <ExternalLink className="w-3.5 h-3.5" />
                                                            </a>
                                                            <button
                                                                type="button"
                                                                onClick={() => setSendInvoiceId(invoice.id)}
                                                                className="inline-flex items-center gap-1 text-[#111b21] font-bold hover:underline"
                                                            >
                                                                Send
                                                                <Send className="w-3.5 h-3.5" />
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
