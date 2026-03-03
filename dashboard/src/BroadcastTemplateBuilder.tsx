import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bold, Italic, PlusCircle, Save, Send, Strikethrough, Trash2 } from 'lucide-react';
import { getSocketUrl } from './runtimeConfig';

const SOCKET_URL = getSocketUrl();
const DRAFT_STORAGE_KEY = 'waba-broadcast-template-draft-v1';

type TemplateCategory = 'marketing' | 'utility';
type MarketingTemplatePreset = 'custom' | 'limited_time_offer' | 'coupon_code' | 'media_card_carousel' | 'product_card_carousel' | 'mpm';
type HeaderType = 'none' | 'text' | 'image' | 'video' | 'document';
type ParameterFormat = 'named' | 'positional';
type TemplateButtonType = 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';
type LtoHeaderFormat = 'text' | 'image' | 'video' | 'document';

type TemplateButton = {
    id: string;
    type: TemplateButtonType;
    text: string;
    url: string;
    phoneNumber: string;
};

type UploadedMediaAsset = {
    id: string;
    name: string;
    handle: string;
    kind: 'image' | 'video' | 'file';
    previewUrl: string | null;
};

type DraftState = {
    templateName: string;
    category: TemplateCategory;
    language: string;
    marketingTemplatePreset: MarketingTemplatePreset;
    presetValues: Record<string, any>;
    headerType: HeaderType;
    headerText: string;
    headerHandle: string;
    bodyText: string;
    footerText: string;
    parameterFormat: ParameterFormat;
    sampleValues: Record<string, string>;
    buttons: TemplateButton[];
};

type BroadcastTemplateBuilderProps = {
    profileId: string;
    sessionToken?: string | null;
    onClose: () => void;
    embedded?: boolean;
};

const sanitizeTemplateName = (value: string): string => {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 512);
};

const extractPositionalVars = (text: string): string[] => {
    const vars = new Set<number>();
    const regex = /{{\s*(\d+)\s*}}/g;
    let match = regex.exec(text);
    while (match) {
        const parsed = Number.parseInt(match[1] || '', 10);
        if (Number.isFinite(parsed)) vars.add(parsed);
        match = regex.exec(text);
    }
    return Array.from(vars).sort((a, b) => a - b).map(String);
};

const extractNamedVars = (text: string): string[] => {
    const vars = new Set<string>();
    const regex = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;
    let match = regex.exec(text);
    while (match) {
        const value = match[1];
        if (value) vars.add(value);
        match = regex.exec(text);
    }
    return Array.from(vars);
};

const MARKETING_NAMED_PARAM_REGEX = /^[a-z_][a-z0-9_]*$/;

const formatTemplateCreateResult = (data: any): string => {
    const id = data?.id || data?.template_id || data?.message_template_id || '';
    const status = data?.status || data?.template_status || '';
    if (id && status) return `Template submitted. id=${id}, status=${status}`;
    if (id) return `Template submitted. id=${id}`;
    if (status) return `Template submitted. status=${status}`;
    return 'Template submitted.';
};

const createTemplateButton = (type: TemplateButtonType): TemplateButton => ({
    id: `btn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    text: '',
    url: '',
    phoneNumber: ''
});

const parseDelimitedValues = (value: string): string[] => {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
};

const revokeAssetPreview = (asset: UploadedMediaAsset | null | undefined) => {
    if (!asset?.previewUrl) return;
    try {
        URL.revokeObjectURL(asset.previewUrl);
    } catch {
        // ignore preview cleanup errors
    }
};

const fillPositionalPreview = (text: string, examples: string[]): string => {
    return text.replace(/{{\s*(\d+)\s*}}/g, (_match, key: string) => {
        const index = Number.parseInt(key, 10);
        if (!Number.isFinite(index) || index < 1) return `{{${key}}}`;
        return examples[index - 1] || `{{${key}}}`;
    });
};

export default function BroadcastTemplateBuilder({
    profileId,
    sessionToken,
    onClose,
    embedded = false
}: BroadcastTemplateBuilderProps) {
    const [templateName, setTemplateName] = useState('');
    const [category, setCategory] = useState<TemplateCategory>('marketing');
    const [language, setLanguage] = useState('en_US');
    const [marketingTemplatePreset, setMarketingTemplatePreset] = useState<MarketingTemplatePreset>('custom');
    const [ltoHeaderFormat, setLtoHeaderFormat] = useState<LtoHeaderFormat>('image');
    const [ltoHeaderText, setLtoHeaderText] = useState('');
    const [ltoHeaderHandle, setLtoHeaderHandle] = useState('');
    const [ltoOfferText, setLtoOfferText] = useState('Expiring offer!');
    const [ltoHasExpiration, setLtoHasExpiration] = useState(true);
    const [ltoBodyText, setLtoBodyText] = useState('Hi {{1}}, use code {{2}} before this offer ends.');
    const [ltoBodyExamples, setLtoBodyExamples] = useState('Pablo, CARIBE25');
    const [ltoCopyCodeExample, setLtoCopyCodeExample] = useState('CARIBE25');
    const [ltoUrlButtonText, setLtoUrlButtonText] = useState('Book now');
    const [ltoUrl, setLtoUrl] = useState('https://yoursite.com/offers?code={{1}}');
    const [ltoUrlExample, setLtoUrlExample] = useState('https://yoursite.com/offers?ref=abc123');
    const [couponHeaderEnabled, setCouponHeaderEnabled] = useState(true);
    const [couponHeaderText, setCouponHeaderText] = useState('Our Winter Sale is on!');
    const [couponBodyText, setCouponBodyText] = useState('Use code {{1}} to get {{2}} off your entire order!');
    const [couponBodyExamples, setCouponBodyExamples] = useState('SAVE30, 30%');
    const [couponQuickReplyEnabled, setCouponQuickReplyEnabled] = useState(false);
    const [couponQuickReplyText, setCouponQuickReplyText] = useState('Unsubscribe');
    const [couponCodeExample, setCouponCodeExample] = useState('SAVE30');
    const [mediaCarouselBodyText, setMediaCarouselBodyText] = useState('Hi {{1}}, check out these deals.');
    const [mediaCarouselBodyExamples, setMediaCarouselBodyExamples] = useState('Pablo');
    const [mediaCarouselCardCount, setMediaCarouselCardCount] = useState(2);
    const [mediaCarouselHeaderFormat, setMediaCarouselHeaderFormat] = useState<'image' | 'video'>('image');
    const [mediaCarouselHeaderHandles, setMediaCarouselHeaderHandles] = useState('');
    const [mediaCarouselCardBodyEnabled, setMediaCarouselCardBodyEnabled] = useState(false);
    const [mediaCarouselCardBodyText, setMediaCarouselCardBodyText] = useState('Deal {{1}}');
    const [mediaCarouselCardBodyExamples, setMediaCarouselCardBodyExamples] = useState('30% OFF');
    const [mediaCarouselButtonType, setMediaCarouselButtonType] = useState<'quick_reply' | 'url' | 'phone_number'>('url');
    const [mediaCarouselButtonText, setMediaCarouselButtonText] = useState('Shop');
    const [mediaCarouselButtonUrl, setMediaCarouselButtonUrl] = useState('https://yourstore.com/products/{{1}}');
    const [mediaCarouselButtonUrlExample, setMediaCarouselButtonUrlExample] = useState('PRODUCT_CODE_1');
    const [mediaCarouselButtonPhone, setMediaCarouselButtonPhone] = useState('+15550051310');
    const [productCarouselBodyText, setProductCarouselBodyText] = useState('{{1}}, check out these products!');
    const [productCarouselBodyExamples, setProductCarouselBodyExamples] = useState('Pablo');
    const [productCarouselButtonType, setProductCarouselButtonType] = useState<'spm' | 'url'>('spm');
    const [productCarouselButtonText, setProductCarouselButtonText] = useState('View');
    const [productCarouselButtonUrl, setProductCarouselButtonUrl] = useState('https://yourstore.com/products/{{1}}');
    const [productCarouselButtonUrlExample, setProductCarouselButtonUrlExample] = useState('PRODUCT_CODE_1');
    const [mpmHeaderEnabled, setMpmHeaderEnabled] = useState(true);
    const [mpmHeaderText, setMpmHeaderText] = useState('Forget something, {{1}}?');
    const [mpmHeaderExample, setMpmHeaderExample] = useState('Pablo');
    const [mpmBodyText, setMpmBodyText] = useState('You left items in your cart! Use code {{1}} to save.');
    const [mpmBodyExamples, setMpmBodyExamples] = useState('10OFF');
    const [mpmFooterText, setMpmFooterText] = useState('Lucky Shrub, 1 Hacker Way');
    const [mpmButtonText, setMpmButtonText] = useState('View items');
    const [headerType, setHeaderType] = useState<HeaderType>('none');
    const [headerText, setHeaderText] = useState('');
    const [headerHandle, setHeaderHandle] = useState('');
    const [bodyText, setBodyText] = useState('');
    const [footerText, setFooterText] = useState('');
    const [parameterFormat, setParameterFormat] = useState<ParameterFormat>('positional');
    const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
    const [buttons, setButtons] = useState<TemplateButton[]>([]);
    const [savingDraft, setSavingDraft] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [uploadingLegacyHeader, setUploadingLegacyHeader] = useState(false);
    const [uploadingLtoHeader, setUploadingLtoHeader] = useState(false);
    const [uploadingCarouselHeaders, setUploadingCarouselHeaders] = useState(false);
    const [legacyUploadedAsset, setLegacyUploadedAsset] = useState<UploadedMediaAsset | null>(null);
    const [ltoUploadedAsset, setLtoUploadedAsset] = useState<UploadedMediaAsset | null>(null);
    const [mediaCarouselUploadedAssets, setMediaCarouselUploadedAssets] = useState<UploadedMediaAsset[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const bodyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
    const legacyHeaderFileInputRef = useRef<HTMLInputElement | null>(null);
    const ltoHeaderFileInputRef = useRef<HTMLInputElement | null>(null);
    const carouselHeaderFilesInputRef = useRef<HTMLInputElement | null>(null);
    const uploadedAssetsRef = useRef<{
        legacy: UploadedMediaAsset | null;
        lto: UploadedMediaAsset | null;
        carousel: UploadedMediaAsset[];
    }>({
        legacy: null,
        lto: null,
        carousel: []
    });

    const parsedVariables = useMemo(() => {
        const named = extractNamedVars(bodyText);
        const positional = extractPositionalVars(bodyText);
        if (named.length > 0 && positional.length > 0) {
            return { format: 'mixed' as const, keys: [] as string[] };
        }
        if (named.length > 0) {
            return { format: 'named' as const, keys: named };
        }
        if (positional.length > 0) {
            return { format: 'positional' as const, keys: positional };
        }
        return { format: parameterFormat as 'named' | 'positional', keys: [] as string[] };
    }, [bodyText, parameterFormat]);
    const variableKeys = parsedVariables.keys;

    useEffect(() => {
        uploadedAssetsRef.current = {
            legacy: legacyUploadedAsset,
            lto: ltoUploadedAsset,
            carousel: mediaCarouselUploadedAssets
        };
    }, [legacyUploadedAsset, ltoUploadedAsset, mediaCarouselUploadedAssets]);

    useEffect(() => {
        return () => {
            const assets = uploadedAssetsRef.current;
            revokeAssetPreview(assets.legacy);
            revokeAssetPreview(assets.lto);
            assets.carousel.forEach((asset) => revokeAssetPreview(asset));
        };
    }, []);

    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as DraftState;
            if (!parsed || typeof parsed !== 'object') return;

            setTemplateName(typeof parsed.templateName === 'string' ? parsed.templateName : '');
            setCategory(parsed.category === 'utility' ? 'utility' : 'marketing');
            setLanguage(typeof parsed.language === 'string' && parsed.language ? parsed.language : 'en_US');
            const preset = parsed.marketingTemplatePreset;
            setMarketingTemplatePreset(
                preset === 'limited_time_offer' || preset === 'coupon_code' || preset === 'media_card_carousel' || preset === 'product_card_carousel' || preset === 'mpm'
                    ? preset
                    : 'custom'
            );
            const presetValues = parsed.presetValues && typeof parsed.presetValues === 'object' ? parsed.presetValues as Record<string, any> : {};
            if (
                typeof presetValues.ltoHeaderFormat === 'string' &&
                (presetValues.ltoHeaderFormat === 'text' || presetValues.ltoHeaderFormat === 'image' || presetValues.ltoHeaderFormat === 'video' || presetValues.ltoHeaderFormat === 'document')
            ) {
                setLtoHeaderFormat(presetValues.ltoHeaderFormat);
            }
            if (typeof presetValues.ltoHeaderText === 'string') setLtoHeaderText(presetValues.ltoHeaderText);
            if (typeof presetValues.ltoHeaderHandle === 'string') setLtoHeaderHandle(presetValues.ltoHeaderHandle);
            if (typeof presetValues.ltoOfferText === 'string') setLtoOfferText(presetValues.ltoOfferText);
            if (typeof presetValues.ltoHasExpiration === 'boolean') setLtoHasExpiration(presetValues.ltoHasExpiration);
            if (typeof presetValues.ltoBodyText === 'string') setLtoBodyText(presetValues.ltoBodyText);
            if (typeof presetValues.ltoBodyExamples === 'string') setLtoBodyExamples(presetValues.ltoBodyExamples);
            if (typeof presetValues.ltoCopyCodeExample === 'string') setLtoCopyCodeExample(presetValues.ltoCopyCodeExample);
            if (typeof presetValues.ltoUrlButtonText === 'string') setLtoUrlButtonText(presetValues.ltoUrlButtonText);
            if (typeof presetValues.ltoUrl === 'string') setLtoUrl(presetValues.ltoUrl);
            if (typeof presetValues.ltoUrlExample === 'string') setLtoUrlExample(presetValues.ltoUrlExample);
            if (typeof presetValues.couponHeaderEnabled === 'boolean') setCouponHeaderEnabled(presetValues.couponHeaderEnabled);
            if (typeof presetValues.couponHeaderText === 'string') setCouponHeaderText(presetValues.couponHeaderText);
            if (typeof presetValues.couponBodyText === 'string') setCouponBodyText(presetValues.couponBodyText);
            if (typeof presetValues.couponBodyExamples === 'string') setCouponBodyExamples(presetValues.couponBodyExamples);
            if (typeof presetValues.couponQuickReplyEnabled === 'boolean') setCouponQuickReplyEnabled(presetValues.couponQuickReplyEnabled);
            if (typeof presetValues.couponQuickReplyText === 'string') setCouponQuickReplyText(presetValues.couponQuickReplyText);
            if (typeof presetValues.couponCodeExample === 'string') setCouponCodeExample(presetValues.couponCodeExample);
            if (typeof presetValues.mediaCarouselBodyText === 'string') setMediaCarouselBodyText(presetValues.mediaCarouselBodyText);
            if (typeof presetValues.mediaCarouselBodyExamples === 'string') setMediaCarouselBodyExamples(presetValues.mediaCarouselBodyExamples);
            if (typeof presetValues.mediaCarouselCardCount === 'number' && Number.isFinite(presetValues.mediaCarouselCardCount)) {
                setMediaCarouselCardCount(Math.max(2, Math.min(10, Math.floor(presetValues.mediaCarouselCardCount))));
            }
            if (typeof presetValues.mediaCarouselHeaderFormat === 'string' && (presetValues.mediaCarouselHeaderFormat === 'image' || presetValues.mediaCarouselHeaderFormat === 'video')) {
                setMediaCarouselHeaderFormat(presetValues.mediaCarouselHeaderFormat);
            }
            if (typeof presetValues.mediaCarouselHeaderHandles === 'string') setMediaCarouselHeaderHandles(presetValues.mediaCarouselHeaderHandles);
            if (typeof presetValues.mediaCarouselCardBodyEnabled === 'boolean') setMediaCarouselCardBodyEnabled(presetValues.mediaCarouselCardBodyEnabled);
            if (typeof presetValues.mediaCarouselCardBodyText === 'string') setMediaCarouselCardBodyText(presetValues.mediaCarouselCardBodyText);
            if (typeof presetValues.mediaCarouselCardBodyExamples === 'string') setMediaCarouselCardBodyExamples(presetValues.mediaCarouselCardBodyExamples);
            if (typeof presetValues.mediaCarouselButtonType === 'string' && (presetValues.mediaCarouselButtonType === 'quick_reply' || presetValues.mediaCarouselButtonType === 'url' || presetValues.mediaCarouselButtonType === 'phone_number')) {
                setMediaCarouselButtonType(presetValues.mediaCarouselButtonType);
            }
            if (typeof presetValues.mediaCarouselButtonText === 'string') setMediaCarouselButtonText(presetValues.mediaCarouselButtonText);
            if (typeof presetValues.mediaCarouselButtonUrl === 'string') setMediaCarouselButtonUrl(presetValues.mediaCarouselButtonUrl);
            if (typeof presetValues.mediaCarouselButtonUrlExample === 'string') setMediaCarouselButtonUrlExample(presetValues.mediaCarouselButtonUrlExample);
            if (typeof presetValues.mediaCarouselButtonPhone === 'string') setMediaCarouselButtonPhone(presetValues.mediaCarouselButtonPhone);
            if (typeof presetValues.productCarouselBodyText === 'string') setProductCarouselBodyText(presetValues.productCarouselBodyText);
            if (typeof presetValues.productCarouselBodyExamples === 'string') setProductCarouselBodyExamples(presetValues.productCarouselBodyExamples);
            if (typeof presetValues.productCarouselButtonType === 'string' && (presetValues.productCarouselButtonType === 'spm' || presetValues.productCarouselButtonType === 'url')) {
                setProductCarouselButtonType(presetValues.productCarouselButtonType);
            }
            if (typeof presetValues.productCarouselButtonText === 'string') setProductCarouselButtonText(presetValues.productCarouselButtonText);
            if (typeof presetValues.productCarouselButtonUrl === 'string') setProductCarouselButtonUrl(presetValues.productCarouselButtonUrl);
            if (typeof presetValues.productCarouselButtonUrlExample === 'string') setProductCarouselButtonUrlExample(presetValues.productCarouselButtonUrlExample);
            if (typeof presetValues.mpmHeaderEnabled === 'boolean') setMpmHeaderEnabled(presetValues.mpmHeaderEnabled);
            if (typeof presetValues.mpmHeaderText === 'string') setMpmHeaderText(presetValues.mpmHeaderText);
            if (typeof presetValues.mpmHeaderExample === 'string') setMpmHeaderExample(presetValues.mpmHeaderExample);
            if (typeof presetValues.mpmBodyText === 'string') setMpmBodyText(presetValues.mpmBodyText);
            if (typeof presetValues.mpmBodyExamples === 'string') setMpmBodyExamples(presetValues.mpmBodyExamples);
            if (typeof presetValues.mpmFooterText === 'string') setMpmFooterText(presetValues.mpmFooterText);
            if (typeof presetValues.mpmButtonText === 'string') setMpmButtonText(presetValues.mpmButtonText);
            setHeaderType(
                parsed.headerType === 'text' || parsed.headerType === 'image' || parsed.headerType === 'video' || parsed.headerType === 'document'
                    ? parsed.headerType
                    : 'none'
            );
            setHeaderText(typeof parsed.headerText === 'string' ? parsed.headerText : '');
            setHeaderHandle(typeof parsed.headerHandle === 'string' ? parsed.headerHandle : '');
            setBodyText(typeof parsed.bodyText === 'string' ? parsed.bodyText : '');
            setFooterText(typeof parsed.footerText === 'string' ? parsed.footerText : '');
            setParameterFormat(parsed.parameterFormat === 'named' ? 'named' : 'positional');
            setSampleValues(parsed.sampleValues && typeof parsed.sampleValues === 'object' ? parsed.sampleValues : {});
            if (Array.isArray(parsed.buttons)) {
                const loaded = parsed.buttons
                    .filter((item) => item && typeof item === 'object')
                    .map((item: any, index: number) => ({
                        id: typeof item.id === 'string' && item.id ? item.id : `btn-loaded-${index}`,
                        type: item.type === 'PHONE_NUMBER' || item.type === 'QUICK_REPLY' ? item.type : 'URL',
                        text: typeof item.text === 'string' ? item.text : '',
                        url: typeof item.url === 'string' ? item.url : '',
                        phoneNumber: typeof item.phoneNumber === 'string' ? item.phoneNumber : ''
                    }));
                setButtons(loaded.slice(0, 10));
            }
        } catch {
            // ignore bad local draft values
        }
    }, []);

    useEffect(() => {
        setSampleValues((prev) => {
            const next: Record<string, string> = {};
            variableKeys.forEach((key, index) => {
                if (typeof prev[key] === 'string' && prev[key].trim()) {
                    next[key] = prev[key];
                    return;
                }
                next[key] = parameterFormat === 'named' ? `sample_${key}` : `sample_${index + 1}`;
            });

            const prevKeys = Object.keys(prev);
            const nextKeys = Object.keys(next);
            const same =
                prevKeys.length === nextKeys.length &&
                nextKeys.every((key) => prev[key] === next[key]);
            return same ? prev : next;
        });
    }, [variableKeys, parameterFormat]);

    const previewBody = useMemo(() => {
        const raw = bodyText || 'Template message...';
        const withNamed = raw.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_match, key: string) => {
            return sampleValues[key] || `{{${key}}}`;
        });
        return withNamed.replace(/{{\s*(\d+)\s*}}/g, (_match, key: string) => {
            return sampleValues[key] || `{{${key}}}`;
        });
    }, [bodyText, sampleValues]);

    const previewConfig = useMemo(() => {
        if (category !== 'marketing' || marketingTemplatePreset === 'custom') {
            return {
                headerMode: headerType,
                headerText: headerText.trim(),
                body: previewBody,
                footer: footerText.trim(),
                buttons: buttons.map((button) => button.text.trim()).filter(Boolean),
                headerMediaUrl: legacyUploadedAsset?.previewUrl || null,
                headerMediaKind: legacyUploadedAsset?.kind || null,
                headerMediaName: legacyUploadedAsset?.name || '',
                uploadedMedia: [] as UploadedMediaAsset[]
            };
        }

        if (marketingTemplatePreset === 'limited_time_offer') {
            return {
                headerMode: ltoHeaderFormat as HeaderType,
                headerText: ltoHeaderFormat === 'text' ? ltoHeaderText.trim() : '',
                body: fillPositionalPreview(ltoBodyText || 'Limited-time offer message...', parseDelimitedValues(ltoBodyExamples)),
                footer: '',
                buttons: [ltoUrlButtonText || 'Book now', `Copy code: ${ltoCopyCodeExample || 'CODE'}`],
                headerMediaUrl: ltoHeaderFormat === 'image' || ltoHeaderFormat === 'video' ? ltoUploadedAsset?.previewUrl || null : null,
                headerMediaKind: ltoHeaderFormat === 'image' || ltoHeaderFormat === 'video' ? ltoUploadedAsset?.kind || null : null,
                headerMediaName: ltoHeaderFormat === 'image' || ltoHeaderFormat === 'video' ? ltoUploadedAsset?.name || '' : '',
                uploadedMedia: [] as UploadedMediaAsset[]
            };
        }

        if (marketingTemplatePreset === 'coupon_code') {
            return {
                headerMode: couponHeaderEnabled ? 'text' as HeaderType : 'none' as HeaderType,
                headerText: couponHeaderText.trim(),
                body: fillPositionalPreview(couponBodyText || 'Coupon message...', parseDelimitedValues(couponBodyExamples)),
                footer: '',
                buttons: [
                    ...(couponQuickReplyEnabled ? [couponQuickReplyText || 'Quick reply'] : []),
                    `Copy code: ${couponCodeExample || 'SAVE'}`
                ],
                headerMediaUrl: null,
                headerMediaKind: null,
                headerMediaName: '',
                uploadedMedia: [] as UploadedMediaAsset[]
            };
        }

        if (marketingTemplatePreset === 'media_card_carousel') {
            return {
                headerMode: 'none' as HeaderType,
                headerText: '',
                body: fillPositionalPreview(mediaCarouselBodyText || 'Carousel message...', parseDelimitedValues(mediaCarouselBodyExamples)),
                footer: '',
                buttons: [`${mediaCarouselButtonType.replace('_', ' ')}: ${mediaCarouselButtonText || 'Action'}`],
                headerMediaUrl: null,
                headerMediaKind: null,
                headerMediaName: '',
                uploadedMedia: mediaCarouselUploadedAssets
            };
        }

        if (marketingTemplatePreset === 'product_card_carousel') {
            return {
                headerMode: 'none' as HeaderType,
                headerText: '',
                body: fillPositionalPreview(productCarouselBodyText || 'Product carousel...', parseDelimitedValues(productCarouselBodyExamples)),
                footer: '',
                buttons: [productCarouselButtonText || (productCarouselButtonType === 'spm' ? 'View' : 'Open')],
                headerMediaUrl: null,
                headerMediaKind: null,
                headerMediaName: '',
                uploadedMedia: [] as UploadedMediaAsset[]
            };
        }

        return {
            headerMode: mpmHeaderEnabled ? 'text' as HeaderType : 'none' as HeaderType,
            headerText: fillPositionalPreview(mpmHeaderText || '', [mpmHeaderExample]),
            body: fillPositionalPreview(mpmBodyText || 'MPM message...', parseDelimitedValues(mpmBodyExamples)),
            footer: mpmFooterText.trim(),
            buttons: [mpmButtonText || 'View items'],
            headerMediaUrl: null,
            headerMediaKind: null,
            headerMediaName: '',
            uploadedMedia: [] as UploadedMediaAsset[]
        };
    }, [
        category,
        marketingTemplatePreset,
        headerType,
        headerText,
        previewBody,
        footerText,
        buttons,
        legacyUploadedAsset,
        ltoHeaderFormat,
        ltoHeaderText,
        ltoBodyText,
        ltoBodyExamples,
        ltoUrlButtonText,
        ltoCopyCodeExample,
        ltoUploadedAsset,
        couponHeaderEnabled,
        couponHeaderText,
        couponBodyText,
        couponBodyExamples,
        couponQuickReplyEnabled,
        couponQuickReplyText,
        couponCodeExample,
        mediaCarouselBodyText,
        mediaCarouselBodyExamples,
        mediaCarouselButtonType,
        mediaCarouselButtonText,
        mediaCarouselUploadedAssets,
        productCarouselBodyText,
        productCarouselBodyExamples,
        productCarouselButtonText,
        productCarouselButtonType,
        mpmHeaderEnabled,
        mpmHeaderText,
        mpmHeaderExample,
        mpmBodyText,
        mpmBodyExamples,
        mpmFooterText,
        mpmButtonText
    ]);

    const applyBodyFormat = (wrapper: '*' | '_' | '~') => {
        const textArea = bodyTextAreaRef.current;
        if (!textArea) return;

        const start = textArea.selectionStart || 0;
        const end = textArea.selectionEnd || start;
        const selected = bodyText.slice(start, end);
        const content = selected || 'text';
        const token = `${wrapper}${content}${wrapper}`;
        const next = `${bodyText.slice(0, start)}${token}${bodyText.slice(end)}`;

        setBodyText(next);
        setError(null);

        requestAnimationFrame(() => {
            textArea.focus();
            const caretStart = start + wrapper.length;
            const caretEnd = caretStart + content.length;
            textArea.setSelectionRange(caretStart, caretEnd);
        });
    };

    const addVariable = () => {
        const token = (() => {
            if (parameterFormat === 'named') {
                let candidate = 'first_name';
                let suffix = 1;
                while (variableKeys.includes(candidate)) {
                    candidate = `var_${suffix}`;
                    suffix += 1;
                }
                return `{{${candidate}}}`;
            }

            const numeric = variableKeys
                .map((key) => Number.parseInt(key, 10))
                .filter((value) => Number.isFinite(value));
            const nextValue = numeric.length > 0 ? Math.max(...numeric) + 1 : 1;
            return `{{${nextValue}}}`;
        })();

        setBodyText((prev) => {
            const spacer = prev && !/\s$/.test(prev) ? ' ' : '';
            return `${prev}${spacer}${token}`;
        });
        setError(null);
    };

    const addButton = (type: TemplateButtonType) => {
        setButtons((prev) => {
            if (prev.length >= 10) return prev;
            return [...prev, createTemplateButton(type)];
        });
        setError(null);
    };

    const removeButton = (id: string) => {
        setButtons((prev) => prev.filter((button) => button.id !== id));
        setError(null);
    };

    const updateButton = (id: string, patch: Partial<TemplateButton>) => {
        setButtons((prev) =>
            prev.map((button) => (button.id === id ? { ...button, ...patch } : button))
        );
        setError(null);
    };

    const uploadTemplateHeaderHandle = async (file: File, kind: 'image' | 'video' | 'auto' = 'auto'): Promise<string> => {
        if (!profileId) {
            throw new Error('Select a profile before uploading media.');
        }
        if (!sessionToken) {
            throw new Error('You must be logged in to upload media.');
        }

        const params = new URLSearchParams();
        params.set('profileId', profileId);
        if (kind === 'image' || kind === 'video') {
            params.set('kind', kind);
        }

        const res = await fetch(`${SOCKET_URL}/api/waba/template-media/upload-handle?${params.toString()}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/octet-stream',
                'x-file-name': file.name || 'template_asset',
                'x-file-type': file.type || 'application/octet-stream'
            },
            body: file
        });

        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
            throw new Error(data?.error || 'Failed to upload media');
        }

        const handle = typeof data?.data?.headerHandle === 'string' ? data.data.headerHandle.trim() : '';
        if (!handle) {
            throw new Error('Upload finished but no header handle was returned.');
        }
        return handle;
    };

    const buildUploadedMediaAsset = (
        file: File,
        handle: string,
        fallbackKind: 'image' | 'video' | 'file'
    ): UploadedMediaAsset => {
        const mime = (file.type || '').toLowerCase();
        const kind: UploadedMediaAsset['kind'] =
            mime.startsWith('image/')
                ? 'image'
                : mime.startsWith('video/')
                    ? 'video'
                    : fallbackKind;
        const previewUrl = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null;
        return {
            id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name: file.name || 'uploaded_file',
            handle,
            kind,
            previewUrl
        };
    };

    const replaceLegacyUploadedAsset = (next: UploadedMediaAsset | null) => {
        setLegacyUploadedAsset((prev) => {
            if (prev?.previewUrl && prev.previewUrl !== next?.previewUrl) {
                revokeAssetPreview(prev);
            }
            return next;
        });
    };

    const replaceLtoUploadedAsset = (next: UploadedMediaAsset | null) => {
        setLtoUploadedAsset((prev) => {
            if (prev?.previewUrl && prev.previewUrl !== next?.previewUrl) {
                revokeAssetPreview(prev);
            }
            return next;
        });
    };

    const removeLegacyUploadedAsset = () => {
        replaceLegacyUploadedAsset(null);
        setHeaderHandle('');
        setError(null);
    };

    const removeLtoUploadedAsset = () => {
        replaceLtoUploadedAsset(null);
        setLtoHeaderHandle('');
        setError(null);
    };

    const removeCarouselUploadedAsset = (assetId: string) => {
        const target = mediaCarouselUploadedAssets.find((asset) => asset.id === assetId);
        if (!target) return;

        revokeAssetPreview(target);
        setMediaCarouselUploadedAssets((prev) => prev.filter((asset) => asset.id !== assetId));
        setMediaCarouselHeaderHandles((prev) => {
            const handles = parseDelimitedValues(prev);
            const removeIndex = handles.findIndex((value) => value === target.handle);
            if (removeIndex >= 0) {
                handles.splice(removeIndex, 1);
            }
            return handles.join('\n');
        });
        setError(null);
        setResult(`Removed ${target.name} from uploaded media list.`);
    };

    const handleLegacyHeaderUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        const expectedKind: 'image' | 'video' | 'auto' =
            headerType === 'video'
                ? 'video'
                : headerType === 'image'
                    ? 'image'
                    : 'auto';

        setUploadingLegacyHeader(true);
        setError(null);
        try {
            const handle = await uploadTemplateHeaderHandle(file, expectedKind);
            setHeaderHandle(handle);
            replaceLegacyUploadedAsset(
                buildUploadedMediaAsset(file, handle, expectedKind === 'auto' ? 'file' : expectedKind)
            );
            setResult('Header media uploaded.');
        } catch (err: any) {
            setError(err?.message || 'Failed to upload header media');
        } finally {
            setUploadingLegacyHeader(false);
        }
    };

    const handleLtoHeaderUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const expectedKind: 'image' | 'video' | 'auto' =
            ltoHeaderFormat === 'image'
                ? 'image'
                : ltoHeaderFormat === 'video'
                    ? 'video'
                    : 'auto';

        setUploadingLtoHeader(true);
        setError(null);
        try {
            const handle = await uploadTemplateHeaderHandle(file, expectedKind);
            setLtoHeaderHandle(handle);
            replaceLtoUploadedAsset(buildUploadedMediaAsset(file, handle, expectedKind === 'auto' ? 'file' : expectedKind));
            setResult('Limited-time offer media uploaded.');
        } catch (err: any) {
            setError(err?.message || 'Failed to upload limited-time header media');
        } finally {
            setUploadingLtoHeader(false);
        }
    };

    const handleCarouselHeadersUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files ? Array.from(event.target.files) : [];
        event.target.value = '';
        if (files.length === 0) return;

        setUploadingCarouselHeaders(true);
        setError(null);
        const uploadedAssets: UploadedMediaAsset[] = [];
        try {
            const uploadedHandles: string[] = [];
            for (const file of files) {
                const handle = await uploadTemplateHeaderHandle(file, mediaCarouselHeaderFormat);
                uploadedHandles.push(handle);
                uploadedAssets.push(buildUploadedMediaAsset(file, handle, mediaCarouselHeaderFormat));
            }
            setMediaCarouselHeaderHandles((prev) => {
                const current = parseDelimitedValues(prev);
                return [...current, ...uploadedHandles].join('\n');
            });
            setMediaCarouselUploadedAssets((prev) => [...prev, ...uploadedAssets]);
            setResult(`Uploaded ${uploadedHandles.length} file(s) in order.`);
        } catch (err: any) {
            uploadedAssets.forEach((asset) => revokeAssetPreview(asset));
            setError(err?.message || 'Failed to upload carousel media');
        } finally {
            setUploadingCarouselHeaders(false);
        }
    };

    const appendNextPositionalVariable = (current: string, maxVariables?: number): string => {
        const numeric = extractPositionalVars(current)
            .map((key) => Number.parseInt(key, 10))
            .filter((value) => Number.isFinite(value));
        if (typeof maxVariables === 'number' && maxVariables > 0 && numeric.length >= maxVariables) {
            return current;
        }

        const nextValue = numeric.length > 0 ? Math.max(...numeric) + 1 : 1;
        const spacer = current && !/\s$/.test(current) ? ' ' : '';
        return `${current}${spacer}{{${nextValue}}}`;
    };

    const addPresetVariable = (
        target: 'ltoBody' | 'couponBody' | 'mediaBody' | 'mediaCardBody' | 'productBody' | 'mpmHeader' | 'mpmBody'
    ) => {
        setError(null);
        if (target === 'ltoBody') {
            setLtoBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }
        if (target === 'couponBody') {
            setCouponBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }
        if (target === 'mediaBody') {
            setMediaCarouselBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }
        if (target === 'mediaCardBody') {
            setMediaCarouselCardBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }
        if (target === 'productBody') {
            setProductCarouselBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }
        if (target === 'mpmBody') {
            setMpmBodyText((prev) => appendNextPositionalVariable(prev));
            return;
        }

        const existing = extractPositionalVars(mpmHeaderText);
        if (existing.length >= 1) {
            setError('MPM header supports only one variable: {{1}}.');
            return;
        }
        setMpmHeaderText((prev) => appendNextPositionalVariable(prev, 1));
    };

    const buildPayload = () => {
        const sanitizedName = sanitizeTemplateName(templateName);
        if (!sanitizedName) {
            throw new Error('Template name is required. Use lowercase letters, numbers, and underscores.');
        }

        const isMarketing = category === 'marketing';
        const toComponentType = (value: string) => (isMarketing ? value.toLowerCase() : value.toUpperCase());
        const toHeaderFormat = (value: string) => (isMarketing ? value.toLowerCase() : value.toUpperCase());
        const toButtonType = (value: TemplateButtonType) => {
            if (value === 'PHONE_NUMBER') return isMarketing ? 'phone_number' : 'PHONE_NUMBER';
            if (value === 'QUICK_REPLY') return isMarketing ? 'quick_reply' : 'QUICK_REPLY';
            return isMarketing ? 'url' : 'URL';
        };

        const cleanLanguage = language.trim() || 'en_US';
        const buildPositionalExample = (text: string, examplesRaw: string, label: string): string[] => {
            const keys = extractPositionalVars(text);
            const values = parseDelimitedValues(examplesRaw);
            if (keys.length === 0) return [];
            keys.forEach((value, index) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed) || parsed !== index + 1) {
                    throw new Error(`${label} uses positional variables. Keep them sequential like {{1}}, {{2}}, {{3}}.`);
                }
            });
            if (values.length < keys.length) {
                throw new Error(`${label} requires ${keys.length} example value(s).`);
            }
            return values.slice(0, keys.length);
        };

        if (isMarketing && marketingTemplatePreset !== 'custom') {
            if (marketingTemplatePreset === 'limited_time_offer') {
                const cleanHeaderText = ltoHeaderText.trim();
                const cleanHeaderHandle = ltoHeaderHandle.trim();
                const cleanOfferText = ltoOfferText.trim();
                const cleanBody = ltoBodyText.trim();
                const cleanCopyCode = ltoCopyCodeExample.trim();
                const cleanUrlButtonText = ltoUrlButtonText.trim();
                const cleanUrl = ltoUrl.trim();
                const cleanUrlExample = ltoUrlExample.trim();

                if (ltoHeaderFormat === 'text') {
                    if (!cleanHeaderText) throw new Error('Limited-time offer: header text is required.');
                    if (cleanHeaderText.length > 60) throw new Error('Limited-time offer: header text must be 60 characters or less.');
                } else {
                    if (!cleanHeaderHandle) throw new Error('Limited-time offer: upload header media first.');
                }
                if (!cleanOfferText) throw new Error('Limited-time offer: offer text is required.');
                if (cleanOfferText.length > 16) throw new Error('Limited-time offer: offer text must be 16 characters or less.');
                if (!cleanBody) throw new Error('Limited-time offer: body is required.');
                if (cleanBody.length > 600) throw new Error('Limited-time offer: body must be 600 characters or less.');
                if (!cleanCopyCode) throw new Error('Limited-time offer: copy code example is required.');
                if (cleanCopyCode.length > 15) throw new Error('Limited-time offer: copy code example must be 15 characters or less.');
                if (!cleanUrlButtonText) throw new Error('Limited-time offer: URL button text is required.');
                if (!cleanUrl) throw new Error('Limited-time offer: URL is required.');
                if (!cleanUrlExample) throw new Error('Limited-time offer: URL example is required.');

                const bodyExampleValues = buildPositionalExample(cleanBody, ltoBodyExamples, 'Limited-time offer body');
                const headerComponent =
                    ltoHeaderFormat === 'text'
                        ? {
                            type: 'header',
                            format: 'text',
                            text: cleanHeaderText
                        }
                        : {
                            type: 'header',
                            format: ltoHeaderFormat,
                            example: { header_handle: [cleanHeaderHandle] }
                        };

                return {
                    name: sanitizedName,
                    category: 'marketing',
                    language: cleanLanguage,
                    parameter_format: 'positional',
                    components: [
                        headerComponent,
                        {
                            type: 'limited_time_offer',
                            limited_time_offer: {
                                text: cleanOfferText,
                                has_expiration: ltoHasExpiration
                            }
                        },
                        {
                            type: 'body',
                            text: cleanBody,
                            ...(bodyExampleValues.length > 0 ? { example: { body_text: [bodyExampleValues] } } : {})
                        },
                        {
                            type: 'buttons',
                            buttons: [
                                {
                                    type: 'copy_code',
                                    example: cleanCopyCode
                                },
                                {
                                    type: 'url',
                                    text: cleanUrlButtonText,
                                    url: cleanUrl,
                                    example: [cleanUrlExample]
                                }
                            ]
                        }
                    ]
                };
            }

            if (marketingTemplatePreset === 'coupon_code') {
                const cleanHeaderText = couponHeaderText.trim();
                const cleanBody = couponBodyText.trim();
                const cleanQuickReplyText = couponQuickReplyText.trim();
                const cleanCode = couponCodeExample.trim();
                if (couponHeaderEnabled) {
                    if (!cleanHeaderText) throw new Error('Coupon code: header text is required.');
                    if (cleanHeaderText.length > 60) throw new Error('Coupon code: header text must be 60 characters or less.');
                }
                if (!cleanBody) throw new Error('Coupon code: body is required.');
                if (cleanBody.length > 1024) throw new Error('Coupon code: body must be 1024 characters or less.');
                if (!cleanCode) throw new Error('Coupon code: copy code example is required.');
                if (cleanCode.length > 20) throw new Error('Coupon code: copy code example must be 20 characters or less.');
                if (couponQuickReplyEnabled) {
                    if (!cleanQuickReplyText) throw new Error('Coupon code: quick reply text is required.');
                    if (cleanQuickReplyText.length > 25) throw new Error('Coupon code: quick reply text must be 25 characters or less.');
                }

                const bodyExampleValues = buildPositionalExample(cleanBody, couponBodyExamples, 'Coupon body');
                const components: any[] = [];
                if (couponHeaderEnabled) {
                    components.push({
                        type: 'header',
                        format: 'text',
                        text: cleanHeaderText
                    });
                }
                components.push({
                    type: 'body',
                    text: cleanBody,
                    ...(bodyExampleValues.length > 0 ? { example: { body_text: [bodyExampleValues] } } : {})
                });
                const couponButtons: any[] = [];
                if (couponQuickReplyEnabled) {
                    couponButtons.push({
                        type: 'quick_reply',
                        text: cleanQuickReplyText
                    });
                }
                couponButtons.push({
                    type: 'copy_code',
                    example: cleanCode
                });
                components.push({
                    type: 'buttons',
                    buttons: couponButtons
                });

                return {
                    name: sanitizedName,
                    category: 'marketing',
                    language: cleanLanguage,
                    parameter_format: 'positional',
                    components
                };
            }

            if (marketingTemplatePreset === 'media_card_carousel') {
                const cleanBody = mediaCarouselBodyText.trim();
                if (!cleanBody) throw new Error('Media carousel: top body is required.');
                if (cleanBody.length > 1024) throw new Error('Media carousel: top body must be 1024 characters or less.');

                const cardCount = Math.max(2, Math.min(10, Math.floor(mediaCarouselCardCount || 2)));
                const handles = parseDelimitedValues(mediaCarouselHeaderHandles);
                if (handles.length < cardCount) {
                    throw new Error(`Media carousel: provide at least ${cardCount} media header handles.`);
                }

                const topBodyExamples = buildPositionalExample(cleanBody, mediaCarouselBodyExamples, 'Media carousel top body');
                const cleanCardBody = mediaCarouselCardBodyText.trim();
                const cardBodyExamples = mediaCarouselCardBodyEnabled
                    ? buildPositionalExample(cleanCardBody, mediaCarouselCardBodyExamples, 'Media carousel card body')
                    : [];
                if (mediaCarouselCardBodyEnabled) {
                    if (!cleanCardBody) throw new Error('Media carousel: card body is required when card body is enabled.');
                    if (cleanCardBody.length > 160) throw new Error('Media carousel: card body must be 160 characters or less.');
                }

                const cleanButtonText = mediaCarouselButtonText.trim();
                if (!cleanButtonText) throw new Error('Media carousel: button text is required.');
                if (cleanButtonText.length > 25) throw new Error('Media carousel: button text must be 25 characters or less.');

                const cleanButtonUrl = mediaCarouselButtonUrl.trim();
                const cleanButtonUrlExample = mediaCarouselButtonUrlExample.trim();
                const cleanButtonPhone = mediaCarouselButtonPhone.trim();

                const cardButtons = (() => {
                    if (mediaCarouselButtonType === 'url') {
                        if (!cleanButtonUrl) throw new Error('Media carousel: button URL is required.');
                        if (!cleanButtonUrlExample) throw new Error('Media carousel: button URL example is required.');
                        return [{
                            type: 'url',
                            text: cleanButtonText,
                            url: cleanButtonUrl,
                            example: [cleanButtonUrlExample]
                        }];
                    }
                    if (mediaCarouselButtonType === 'phone_number') {
                        if (!cleanButtonPhone) throw new Error('Media carousel: phone number is required.');
                        return [{
                            type: 'phone_number',
                            text: cleanButtonText,
                            phone_number: cleanButtonPhone
                        }];
                    }
                    return [{
                        type: 'quick_reply',
                        text: cleanButtonText
                    }];
                })();

                const cards = Array.from({ length: cardCount }, (_, index) => {
                    const cardComponents: any[] = [
                        {
                            type: 'header',
                            format: mediaCarouselHeaderFormat,
                            example: { header_handle: [handles[index]] }
                        }
                    ];
                    if (mediaCarouselCardBodyEnabled) {
                        cardComponents.push({
                            type: 'body',
                            text: cleanCardBody,
                            ...(cardBodyExamples.length > 0 ? { example: { body_text: [cardBodyExamples] } } : {})
                        });
                    }
                    cardComponents.push({
                        type: 'buttons',
                        buttons: cardButtons
                    });
                    return { components: cardComponents };
                });

                return {
                    name: sanitizedName,
                    category: 'marketing',
                    language: cleanLanguage,
                    parameter_format: 'positional',
                    components: [
                        {
                            type: 'body',
                            text: cleanBody,
                            ...(topBodyExamples.length > 0 ? { example: { body_text: [topBodyExamples] } } : {})
                        },
                        {
                            type: 'carousel',
                            cards
                        }
                    ]
                };
            }

            if (marketingTemplatePreset === 'product_card_carousel') {
                const cleanBody = productCarouselBodyText.trim();
                if (!cleanBody) throw new Error('Product carousel: top body is required.');
                if (cleanBody.length > 1024) throw new Error('Product carousel: top body must be 1024 characters or less.');
                const topBodyExamples = buildPositionalExample(cleanBody, productCarouselBodyExamples, 'Product carousel top body');
                const cleanButtonText = productCarouselButtonText.trim() || (productCarouselButtonType === 'spm' ? 'View' : '');
                if (!cleanButtonText) throw new Error('Product carousel: button text is required.');
                if (cleanButtonText.length > 25) throw new Error('Product carousel: button text must be 25 characters or less.');
                const cleanButtonUrl = productCarouselButtonUrl.trim();
                const cleanButtonUrlExample = productCarouselButtonUrlExample.trim();
                const cardButton = productCarouselButtonType === 'url'
                    ? (() => {
                        if (!cleanButtonUrl) throw new Error('Product carousel: URL button requires URL.');
                        if (!cleanButtonUrlExample) throw new Error('Product carousel: URL button requires example value.');
                        return {
                            type: 'url',
                            text: cleanButtonText,
                            url: cleanButtonUrl,
                            example: [cleanButtonUrlExample]
                        };
                    })()
                    : {
                        type: 'spm',
                        text: cleanButtonText
                    };

                return {
                    name: sanitizedName,
                    category: 'marketing',
                    language: cleanLanguage,
                    parameter_format: 'positional',
                    components: [
                        {
                            type: 'body',
                            text: cleanBody,
                            ...(topBodyExamples.length > 0 ? { example: { body_text: [topBodyExamples] } } : {})
                        },
                        {
                            type: 'carousel',
                            cards: [
                                {
                                    components: [
                                        { type: 'header', format: 'product' },
                                        { type: 'buttons', buttons: [cardButton] }
                                    ]
                                },
                                {
                                    components: [
                                        { type: 'header', format: 'product' },
                                        { type: 'buttons', buttons: [cardButton] }
                                    ]
                                }
                            ]
                        }
                    ]
                };
            }

            if (marketingTemplatePreset === 'mpm') {
                const cleanHeader = mpmHeaderText.trim();
                const cleanHeaderExample = mpmHeaderExample.trim();
                const cleanBody = mpmBodyText.trim();
                const cleanFooter = mpmFooterText.trim();
                const cleanButtonText = mpmButtonText.trim();

                if (mpmHeaderEnabled) {
                    if (!cleanHeader) throw new Error('MPM: header text is required.');
                    if (cleanHeader.length > 60) throw new Error('MPM: header text must be 60 characters or less.');
                    const headerVars = extractPositionalVars(cleanHeader);
                    if (headerVars.length > 1) throw new Error('MPM: header supports at most one variable ({{1}}).');
                    if (headerVars.length > 0 && !cleanHeaderExample) {
                        throw new Error('MPM: header example is required when header has a variable.');
                    }
                }
                if (!cleanBody) throw new Error('MPM: body is required.');
                if (cleanBody.length > 1024) throw new Error('MPM: body must be 1024 characters or less.');
                if (cleanFooter.length > 60) throw new Error('MPM: footer must be 60 characters or less.');
                if (!cleanButtonText) throw new Error('MPM: button text is required.');
                if (cleanButtonText.length > 25) throw new Error('MPM: button text must be 25 characters or less.');

                const bodyExamples = buildPositionalExample(cleanBody, mpmBodyExamples, 'MPM body');
                const components: any[] = [];
                if (mpmHeaderEnabled) {
                    const headerComponent: any = {
                        type: 'header',
                        format: 'text',
                        text: cleanHeader
                    };
                    if (extractPositionalVars(cleanHeader).length > 0 && cleanHeaderExample) {
                        headerComponent.example = { header_text: [cleanHeaderExample] };
                    }
                    components.push(headerComponent);
                }
                components.push({
                    type: 'body',
                    text: cleanBody,
                    ...(bodyExamples.length > 0 ? { example: { body_text: [bodyExamples] } } : {})
                });
                if (cleanFooter) {
                    components.push({ type: 'footer', text: cleanFooter });
                }
                components.push({
                    type: 'buttons',
                    buttons: [{ type: 'mpm', text: cleanButtonText }]
                });

                return {
                    name: sanitizedName,
                    category: 'marketing',
                    language: cleanLanguage,
                    parameter_format: 'positional',
                    components
                };
            }
        }

        const cleanBody = bodyText.trim();
        if (!cleanBody) {
            throw new Error('Body is required.');
        }
        if (cleanBody.length > 1024) {
            throw new Error('Body must be 1024 characters or less.');
        }

        const bodyNamedVars = extractNamedVars(cleanBody);
        const bodyPositionalVars = extractPositionalVars(cleanBody);
        if (bodyNamedVars.length > 0 && bodyPositionalVars.length > 0) {
            throw new Error('Use only one variable format in body: either named {{name}} or positional {{1}}.');
        }

        bodyPositionalVars.forEach((value, index) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed !== index + 1) {
                throw new Error('Positional variables must be sequential: {{1}}, {{2}}, {{3}}.');
            }
        });

        const effectiveParameterFormat: ParameterFormat =
            bodyNamedVars.length > 0 ? 'named' : bodyPositionalVars.length > 0 ? 'positional' : parameterFormat;
        const effectiveVariableKeys = effectiveParameterFormat === 'named' ? bodyNamedVars : bodyPositionalVars;

        if (isMarketing && effectiveParameterFormat === 'named') {
            const invalidNamed = bodyNamedVars.find((key) => !MARKETING_NAMED_PARAM_REGEX.test(key));
            if (invalidNamed) {
                throw new Error(`Marketing named parameters must be lowercase and underscores only: {{${invalidNamed}}}`);
            }
        }

        const components: any[] = [];

        if (headerType === 'text') {
            const cleanHeader = headerText.trim();
            if (!cleanHeader) throw new Error('Header text is required when header type is text.');
            if (cleanHeader.length > 60) throw new Error('Header text must be 60 characters or less.');
            components.push({ type: toComponentType('HEADER'), format: toHeaderFormat('TEXT'), text: cleanHeader });
        }

        if (headerType === 'image' || headerType === 'video' || headerType === 'document') {
            const cleanHandle = headerHandle.trim();
            if (!cleanHandle) throw new Error('Header handle is required for media headers.');
            components.push({
                type: toComponentType('HEADER'),
                format: toHeaderFormat(headerType),
                example: {
                    header_handle: [cleanHandle]
                }
            });
        }

        const bodyComponent: any = { type: toComponentType('BODY'), text: cleanBody };
        if (effectiveVariableKeys.length > 0) {
            if (effectiveParameterFormat === 'named') {
                bodyComponent.example = {
                    body_text_named_params: effectiveVariableKeys.map((key) => ({
                        param_name: key,
                        example: sampleValues[key] || `sample_${key}`
                    }))
                };
            } else {
                bodyComponent.example = {
                    body_text: [
                        effectiveVariableKeys.map((key, index) => sampleValues[key] || `sample_${index + 1}`)
                    ]
                };
            }
        }
        components.push(bodyComponent);

        const cleanFooter = footerText.trim();
        if (cleanFooter) {
            if (cleanFooter.length > 60) throw new Error('Footer text must be 60 characters or less.');
            components.push({ type: toComponentType('FOOTER'), text: cleanFooter });
        }

        if (buttons.length > 10) {
            throw new Error('Buttons limit is 10.');
        }

        const cleanButtons = buttons.map((button, index) => {
            const text = button.text.trim();
            if (!text) {
                throw new Error(`Button ${index + 1} label is required.`);
            }
            if (text.length > 25) {
                throw new Error(`Button ${index + 1} label must be 25 characters or less.`);
            }

            if (button.type === 'URL') {
                const url = button.url.trim();
                if (!url) throw new Error(`Button ${index + 1} URL is required.`);
                return {
                    type: toButtonType('URL'),
                    text,
                    url
                };
            }

            if (button.type === 'PHONE_NUMBER') {
                const phone = button.phoneNumber.trim();
                if (!phone) throw new Error(`Button ${index + 1} phone number is required.`);
                if (phone.length > 20) throw new Error(`Button ${index + 1} phone number must be 20 characters or less.`);
                return {
                    type: toButtonType('PHONE_NUMBER'),
                    text,
                    phone_number: phone
                };
            }

            return {
                type: toButtonType('QUICK_REPLY'),
                text
            };
        });

        if (cleanButtons.length > 0) {
            components.push({
                type: toComponentType('BUTTONS'),
                buttons: cleanButtons
            });
        }

        return {
            name: sanitizedName,
            category,
            language: cleanLanguage,
            parameter_format: effectiveParameterFormat,
            components
        };
    };

    const handleSaveDraft = () => {
        setSavingDraft(true);
        setError(null);
        setResult(null);
        try {
            const payload: DraftState = {
                templateName,
                category,
                language,
                marketingTemplatePreset,
                presetValues: {
                    ltoHeaderFormat,
                    ltoHeaderText,
                    ltoHeaderHandle,
                    ltoOfferText,
                    ltoHasExpiration,
                    ltoBodyText,
                    ltoBodyExamples,
                    ltoCopyCodeExample,
                    ltoUrlButtonText,
                    ltoUrl,
                    ltoUrlExample,
                    couponHeaderEnabled,
                    couponHeaderText,
                    couponBodyText,
                    couponBodyExamples,
                    couponQuickReplyEnabled,
                    couponQuickReplyText,
                    couponCodeExample,
                    mediaCarouselBodyText,
                    mediaCarouselBodyExamples,
                    mediaCarouselCardCount,
                    mediaCarouselHeaderFormat,
                    mediaCarouselHeaderHandles,
                    mediaCarouselCardBodyEnabled,
                    mediaCarouselCardBodyText,
                    mediaCarouselCardBodyExamples,
                    mediaCarouselButtonType,
                    mediaCarouselButtonText,
                    mediaCarouselButtonUrl,
                    mediaCarouselButtonUrlExample,
                    mediaCarouselButtonPhone,
                    productCarouselBodyText,
                    productCarouselBodyExamples,
                    productCarouselButtonType,
                    productCarouselButtonText,
                    productCarouselButtonUrl,
                    productCarouselButtonUrlExample,
                    mpmHeaderEnabled,
                    mpmHeaderText,
                    mpmHeaderExample,
                    mpmBodyText,
                    mpmBodyExamples,
                    mpmFooterText,
                    mpmButtonText
                },
                headerType,
                headerText,
                headerHandle,
                bodyText,
                footerText,
                parameterFormat,
                sampleValues,
                buttons
            };
            window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
            setResult('Draft saved locally.');
        } catch (err: any) {
            setError(err?.message || 'Failed to save draft.');
        } finally {
            setSavingDraft(false);
        }
    };

    const handleSubmitTemplate = async () => {
        if (!profileId) {
            setError('Select a profile before creating templates.');
            return;
        }
        if (!sessionToken) {
            setError('You must be logged in to create templates.');
            return;
        }

        let payload: any;
        try {
            payload = buildPayload();
        } catch (err: any) {
            setError(err?.message || 'Template form is incomplete.');
            return;
        }

        const endpoint = category === 'marketing' ? 'marketing' : 'utility';

        setSubmitting(true);
        setError(null);
        setResult(null);

        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/templates/${endpoint}?profileId=${encodeURIComponent(profileId)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                const details = Array.isArray(data?.details) ? ` (${data.details.join('; ')})` : '';
                throw new Error((data?.error || 'Template creation failed') + details);
            }

            setResult(formatTemplateCreateResult(data?.data));
        } catch (err: any) {
            setError(err?.message || 'Template creation failed');
        } finally {
            setSubmitting(false);
        }
    };

    const saveDisabled = savingDraft || submitting;
    const submitDisabled = submitting || !sessionToken;
    const bodyChars = bodyText.length;
    const showLegacyBuilder = category !== 'marketing' || marketingTemplatePreset === 'custom';

    return (
        <div className={embedded ? 'h-full bg-[#f1f3f6] flex flex-col' : 'fixed inset-0 z-[220] bg-[#f1f3f6] flex flex-col'}>
            <header className="h-[76px] px-6 bg-white border-b border-[#e5e7eb] flex items-center justify-between">
                <button
                    onClick={onClose}
                    className="flex items-center gap-3 text-[#111b21] hover:text-[#00a884] transition-colors"
                >
                    <ArrowLeft className="w-5 h-5" />
                    <span className="text-3xl font-black tracking-tight">Create Template</span>
                </button>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleSaveDraft}
                        disabled={saveDisabled}
                        className="px-5 py-3 rounded-xl border border-[#22a34a] text-[#22a34a] text-sm font-bold hover:bg-[#ebfff1] disabled:opacity-50 flex items-center gap-2"
                    >
                        <Save className="w-4 h-4" />
                        Save as draft
                    </button>
                    <button
                        onClick={handleSubmitTemplate}
                        disabled={submitDisabled}
                        className="px-5 py-3 rounded-xl bg-[#22a34a] text-white text-sm font-bold hover:bg-[#1c8c3f] disabled:opacity-50 flex items-center gap-2"
                    >
                        <Send className="w-4 h-4" />
                        {submitting ? 'Submitting...' : 'Save and submit'}
                    </button>
                </div>
            </header>

            <div className="flex-1 overflow-hidden p-5">
                <div className="h-full grid grid-cols-1 lg:grid-cols-[1fr_460px] gap-5">
                    <section className="bg-white rounded-2xl border border-[#e5e7eb] p-6 overflow-y-auto custom-scrollbar">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-bold text-[#1f2937] mb-2">Template Name</label>
                                <input
                                    value={templateName}
                                    onChange={(e) => {
                                        setTemplateName(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="template_name"
                                    className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                />
                                <p className="mt-1 text-[11px] text-[#6b7280]">
                                    Saved as: <code>{sanitizeTemplateName(templateName) || 'template_name'}</code>
                                </p>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-[#1f2937] mb-2">Category</label>
                                <select
                                    value={category}
                                    onChange={(e) => {
                                        setCategory(e.target.value === 'utility' ? 'utility' : 'marketing');
                                        setError(null);
                                    }}
                                    className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                >
                                    <option value="marketing">Marketing</option>
                                    <option value="utility">Utility</option>
                                </select>
                                {category === 'marketing' && (
                                    <p className="mt-1 text-[11px] text-[#6b7280]">
                                        Choose a template type preset, then just fill the fields.
                                    </p>
                                )}
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-[#1f2937] mb-2">Language</label>
                                <input
                                    value={language}
                                    onChange={(e) => {
                                        setLanguage(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="en_US"
                                    className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                />
                            </div>
                        </div>

                        {category === 'marketing' && (
                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className={marketingTemplatePreset === 'custom' ? 'md:col-span-2' : ''}>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Marketing Template Type</label>
                                    <select
                                        value={marketingTemplatePreset}
                                        onChange={(e) => {
                                            const value = e.target.value as MarketingTemplatePreset;
                                            setMarketingTemplatePreset(value);
                                            setError(null);
                                        }}
                                        className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                    >
                                        <option value="custom">Custom Marketing</option>
                                        <option value="limited_time_offer">Limited-Time Offer</option>
                                        <option value="coupon_code">Coupon Code</option>
                                        <option value="media_card_carousel">Media Card Carousel</option>
                                        <option value="product_card_carousel">Product Card Carousel</option>
                                        <option value="mpm">Multi-Product Message (MPM)</option>
                                    </select>
                                </div>
                                {marketingTemplatePreset !== 'custom' && (
                                    <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl px-4 py-3 text-xs text-[#4b5563] font-semibold">
                                        {marketingTemplatePreset === 'limited_time_offer' && 'Limited-Time Offer: text/image/video/document header + offer block + body + copy code + URL.'}
                                        {marketingTemplatePreset === 'coupon_code' && 'Coupon Code: optional header + body + copy code button (quick reply optional).'}
                                        {marketingTemplatePreset === 'media_card_carousel' && 'Media Carousel: top body + 2-10 cards with media and buttons.'}
                                        {marketingTemplatePreset === 'product_card_carousel' && 'Product Carousel: top body + product cards (catalog-based).'}
                                        {marketingTemplatePreset === 'mpm' && 'MPM: optional header + body + optional footer + MPM button.'}
                                    </div>
                                )}
                            </div>
                        )}

                        {category === 'marketing' && marketingTemplatePreset === 'limited_time_offer' && (
                            <div className="mt-8 pt-6 border-t border-[#e5e7eb] space-y-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Limited-Time Offer</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Header Format</label>
                                        <div className="mt-1 flex flex-wrap gap-4">
                                            {([
                                                { id: 'text', label: 'Text' },
                                                { id: 'image', label: 'Image' },
                                                { id: 'video', label: 'Video' },
                                                { id: 'document', label: 'Document' }
                                            ] as Array<{ id: LtoHeaderFormat; label: string }>).map((option) => (
                                                <label key={option.id} className="inline-flex items-center gap-2 text-base font-bold text-[#1f2937] cursor-pointer">
                                                    <input
                                                        type="radio"
                                                        checked={ltoHeaderFormat === option.id}
                                                        onChange={() => {
                                                            setLtoHeaderFormat(option.id);
                                                            setError(null);
                                                        }}
                                                        className="accent-[#22a34a] w-4 h-4"
                                                    />
                                                    <span>{option.label}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                        {ltoHeaderFormat === 'text' ? (
                                            <>
                                                <label className="block text-sm font-bold text-[#1f2937] mb-2">Header Text</label>
                                                <div className="relative">
                                                    <input
                                                        value={ltoHeaderText}
                                                        onChange={(e) => {
                                                            setLtoHeaderText(e.target.value);
                                                            setError(null);
                                                        }}
                                                        placeholder="Header text"
                                                        className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 pr-16 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                    />
                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[#9ca3af]">
                                                        {ltoHeaderText.length}/60
                                                    </span>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <label className="block text-sm font-bold text-[#1f2937] mb-2">Header Media</label>
                                                <div className="flex flex-col sm:flex-row gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => ltoHeaderFileInputRef.current?.click()}
                                                        disabled={uploadingLtoHeader}
                                                        className="px-4 py-3 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                                    >
                                                        {uploadingLtoHeader ? 'Uploading...' : `Upload ${ltoHeaderFormat === 'document' ? 'document' : ltoHeaderFormat}`}
                                                    </button>
                                                    <input
                                                        ref={ltoHeaderFileInputRef}
                                                        type="file"
                                                        accept={ltoHeaderFormat === 'video' ? 'video/*' : ltoHeaderFormat === 'image' ? 'image/*' : '*/*'}
                                                        onChange={handleLtoHeaderUpload}
                                                        className="hidden"
                                                    />
                                                </div>
                                                <p className="mt-2 text-[11px] text-[#6b7280]">
                                                    Upload one {ltoHeaderFormat === 'document' ? 'document file' : ltoHeaderFormat} for this header.
                                                </p>
                                                {!ltoUploadedAsset && Boolean(ltoHeaderHandle) && (
                                                    <p className="mt-2 text-[11px] text-[#6b7280]">
                                                        Media attached from draft.
                                                    </p>
                                                )}
                                                {ltoUploadedAsset && (
                                                    <div className="mt-3 bg-[#f9fafb] border border-[#e5e7eb] rounded-xl p-3">
                                                        <div className="flex items-start gap-3">
                                                            <span className="shrink-0 mt-0.5 text-[11px] font-black uppercase tracking-wider text-[#6b7280]">#1</span>
                                                            <div className="flex-1 min-w-0 space-y-2">
                                                                <p className="text-xs font-bold text-[#111b21] truncate">{ltoUploadedAsset.name}</p>
                                                                {ltoUploadedAsset.previewUrl && ltoUploadedAsset.kind === 'image' && (
                                                                    <img src={ltoUploadedAsset.previewUrl} alt={ltoUploadedAsset.name} className="w-full h-28 object-cover rounded-lg border border-[#e5e7eb]" />
                                                                )}
                                                                {ltoUploadedAsset.previewUrl && ltoUploadedAsset.kind === 'video' && (
                                                                    <video src={ltoUploadedAsset.previewUrl} className="w-full h-28 object-cover rounded-lg border border-[#e5e7eb]" muted loop playsInline controls />
                                                                )}
                                                                {!ltoUploadedAsset.previewUrl && (
                                                                    <div className="rounded-lg border border-dashed border-[#d1d5db] bg-white px-3 py-2 text-xs font-semibold text-[#6b7280]">
                                                                        Document uploaded
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={removeLtoUploadedAsset}
                                                                className="shrink-0 w-7 h-7 rounded-full border border-[#fecaca] text-rose-600 text-xs font-black hover:bg-rose-50"
                                                                aria-label="Remove uploaded media"
                                                            >
                                                                X
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Offer Text (max 16)</label>
                                        <input value={ltoOfferText} onChange={(e) => setLtoOfferText(e.target.value)} placeholder="Expiring offer!" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                    <label className="inline-flex items-center gap-2 mt-8 text-sm font-semibold text-[#1f2937]">
                                        <input type="checkbox" checked={ltoHasExpiration} onChange={(e) => setLtoHasExpiration(e.target.checked)} className="accent-[#22a34a] w-4 h-4" />
                                        Countdown Enabled
                                    </label>
                                </div>
                                <div>
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <label className="block text-sm font-bold text-[#1f2937]">Body (max 600)</label>
                                        <button
                                            type="button"
                                            onClick={() => addPresetVariable('ltoBody')}
                                            className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Add Variable
                                        </button>
                                    </div>
                                    <textarea value={ltoBodyText} onChange={(e) => setLtoBodyText(e.target.value)} placeholder="Hi {{1}}, use code {{2}} today!" className="w-full min-h-[120px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Body Example Values (comma/newline)</label>
                                    <input value={ltoBodyExamples} onChange={(e) => setLtoBodyExamples(e.target.value)} placeholder="Pablo, CARIBE25" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Copy Code Example (max 15)</label>
                                        <input value={ltoCopyCodeExample} onChange={(e) => setLtoCopyCodeExample(e.target.value)} placeholder="CARIBE25" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">URL Button Text</label>
                                        <input value={ltoUrlButtonText} onChange={(e) => setLtoUrlButtonText(e.target.value)} placeholder="Book now" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">URL</label>
                                        <input value={ltoUrl} onChange={(e) => setLtoUrl(e.target.value)} placeholder="https://yoursite.com/offers?code={{1}}" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">URL Example</label>
                                        <input value={ltoUrlExample} onChange={(e) => setLtoUrlExample(e.target.value)} placeholder="https://yoursite.com/offers?ref=abc123" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                </div>
                            </div>
                        )}

                        {category === 'marketing' && marketingTemplatePreset === 'coupon_code' && (
                            <div className="mt-8 pt-6 border-t border-[#e5e7eb] space-y-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Coupon Code</h3>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f2937]">
                                    <input type="checkbox" checked={couponHeaderEnabled} onChange={(e) => setCouponHeaderEnabled(e.target.checked)} className="accent-[#22a34a] w-4 h-4" />
                                    Include Header
                                </label>
                                {couponHeaderEnabled && (
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Header Text (max 60)</label>
                                        <input value={couponHeaderText} onChange={(e) => setCouponHeaderText(e.target.value)} placeholder="Our Winter Sale is on!" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                )}
                                <div>
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <label className="block text-sm font-bold text-[#1f2937]">Body</label>
                                        <button
                                            type="button"
                                            onClick={() => addPresetVariable('couponBody')}
                                            className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Add Variable
                                        </button>
                                    </div>
                                    <textarea value={couponBodyText} onChange={(e) => setCouponBodyText(e.target.value)} placeholder="Use code {{1}} to get {{2}} off!" className="w-full min-h-[120px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Body Example Values (comma/newline)</label>
                                    <input value={couponBodyExamples} onChange={(e) => setCouponBodyExamples(e.target.value)} placeholder="SAVE30, 30%" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f2937]">
                                    <input type="checkbox" checked={couponQuickReplyEnabled} onChange={(e) => setCouponQuickReplyEnabled(e.target.checked)} className="accent-[#22a34a] w-4 h-4" />
                                    Add Quick Reply Button before Copy Code
                                </label>
                                {couponQuickReplyEnabled && (
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Quick Reply Text</label>
                                        <input value={couponQuickReplyText} onChange={(e) => setCouponQuickReplyText(e.target.value)} placeholder="Unsubscribe" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                )}
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Copy Code Example (max 20)</label>
                                    <input value={couponCodeExample} onChange={(e) => setCouponCodeExample(e.target.value)} placeholder="SAVE30" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                            </div>
                        )}

                        {category === 'marketing' && marketingTemplatePreset === 'media_card_carousel' && (
                            <div className="mt-8 pt-6 border-t border-[#e5e7eb] space-y-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Media Card Carousel</h3>
                                <div>
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <label className="block text-sm font-bold text-[#1f2937]">Top Body</label>
                                        <button
                                            type="button"
                                            onClick={() => addPresetVariable('mediaBody')}
                                            className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Add Variable
                                        </button>
                                    </div>
                                    <textarea value={mediaCarouselBodyText} onChange={(e) => setMediaCarouselBodyText(e.target.value)} placeholder="Hi {{1}}, check out these deals." className="w-full min-h-[110px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Top Body Example Values (comma/newline)</label>
                                    <input value={mediaCarouselBodyExamples} onChange={(e) => setMediaCarouselBodyExamples(e.target.value)} placeholder="Pablo" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Card Count (2-10)</label>
                                        <input type="number" min={2} max={10} value={mediaCarouselCardCount} onChange={(e) => setMediaCarouselCardCount(Number.parseInt(e.target.value || '2', 10))} className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Card Header Format</label>
                                        <select value={mediaCarouselHeaderFormat} onChange={(e) => setMediaCarouselHeaderFormat(e.target.value === 'video' ? 'video' : 'image')} className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]">
                                            <option value="image">Image</option>
                                            <option value="video">Video</option>
                                        </select>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Card Media Uploads</label>
                                    <div>
                                        <button
                                            type="button"
                                            onClick={() => carouselHeaderFilesInputRef.current?.click()}
                                            disabled={uploadingCarouselHeaders}
                                            className="px-4 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                        >
                                            {uploadingCarouselHeaders ? 'Uploading...' : `Upload ${mediaCarouselHeaderFormat} files`}
                                        </button>
                                        <input
                                            ref={carouselHeaderFilesInputRef}
                                            type="file"
                                            multiple
                                            accept={mediaCarouselHeaderFormat === 'video' ? 'video/*' : 'image/*'}
                                            onChange={handleCarouselHeadersUpload}
                                            className="hidden"
                                        />
                                    </div>
                                    <p className="mt-2 text-[11px] text-[#6b7280]">
                                        Upload at least {Math.max(2, Math.min(10, Math.floor(mediaCarouselCardCount || 2)))} file(s). Order is used for card 1, 2, 3...
                                    </p>
                                    {mediaCarouselUploadedAssets.length === 0 && Boolean(mediaCarouselHeaderHandles.trim()) && (
                                        <p className="mt-2 text-[11px] text-[#6b7280]">
                                            Media attached from draft.
                                        </p>
                                    )}
                                    {mediaCarouselUploadedAssets.length > 0 && (
                                        <div className="mt-3 space-y-2">
                                            {mediaCarouselUploadedAssets.map((asset, index) => (
                                                <div key={asset.id} className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl p-3">
                                                    <div className="flex items-start gap-3">
                                                        <span className="shrink-0 mt-0.5 text-[11px] font-black uppercase tracking-wider text-[#6b7280]">#{index + 1}</span>
                                                        <div className="flex-1 min-w-0 space-y-2">
                                                            <p className="text-xs font-bold text-[#111b21] truncate">{asset.name}</p>
                                                            {asset.previewUrl && asset.kind === 'image' && (
                                                                <img src={asset.previewUrl} alt={asset.name} className="w-full h-24 object-cover rounded-lg border border-[#e5e7eb]" />
                                                            )}
                                                            {asset.previewUrl && asset.kind === 'video' && (
                                                                <video src={asset.previewUrl} className="w-full h-24 object-cover rounded-lg border border-[#e5e7eb]" muted loop playsInline controls />
                                                            )}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeCarouselUploadedAsset(asset.id)}
                                                            className="shrink-0 w-7 h-7 rounded-full border border-[#fecaca] text-rose-600 text-xs font-black hover:bg-rose-50"
                                                            aria-label={`Remove uploaded media ${index + 1}`}
                                                        >
                                                            X
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f2937]">
                                    <input type="checkbox" checked={mediaCarouselCardBodyEnabled} onChange={(e) => setMediaCarouselCardBodyEnabled(e.target.checked)} className="accent-[#22a34a] w-4 h-4" />
                                    Add Body to each Card
                                </label>
                                {mediaCarouselCardBodyEnabled && (
                                    <>
                                        <div>
                                            <div className="flex items-center justify-between gap-3 mb-2">
                                                <label className="block text-sm font-bold text-[#1f2937]">Card Body (max 160)</label>
                                                <button
                                                    type="button"
                                                    onClick={() => addPresetVariable('mediaCardBody')}
                                                    className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                                >
                                                    <PlusCircle className="w-4 h-4" />
                                                    Add Variable
                                                </button>
                                            </div>
                                            <textarea value={mediaCarouselCardBodyText} onChange={(e) => setMediaCarouselCardBodyText(e.target.value)} placeholder="Deal {{1}}" className="w-full min-h-[90px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">Card Body Example Values (comma/newline)</label>
                                            <input value={mediaCarouselCardBodyExamples} onChange={(e) => setMediaCarouselCardBodyExamples(e.target.value)} placeholder="30% OFF" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                    </>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Card Button Type</label>
                                        <select value={mediaCarouselButtonType} onChange={(e) => setMediaCarouselButtonType(e.target.value as any)} className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]">
                                            <option value="url">URL</option>
                                            <option value="quick_reply">Quick Reply</option>
                                            <option value="phone_number">Phone Number</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Button Text</label>
                                        <input value={mediaCarouselButtonText} onChange={(e) => setMediaCarouselButtonText(e.target.value)} placeholder="Shop" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                </div>
                                {mediaCarouselButtonType === 'url' && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">Button URL</label>
                                            <input value={mediaCarouselButtonUrl} onChange={(e) => setMediaCarouselButtonUrl(e.target.value)} placeholder="https://yourstore.com/products/{{1}}" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">URL Example</label>
                                            <input value={mediaCarouselButtonUrlExample} onChange={(e) => setMediaCarouselButtonUrlExample(e.target.value)} placeholder="PRODUCT_CODE_1" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                    </div>
                                )}
                                {mediaCarouselButtonType === 'phone_number' && (
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Phone Number</label>
                                        <input value={mediaCarouselButtonPhone} onChange={(e) => setMediaCarouselButtonPhone(e.target.value)} placeholder="+15550051310" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                )}
                            </div>
                        )}

                        {category === 'marketing' && marketingTemplatePreset === 'product_card_carousel' && (
                            <div className="mt-8 pt-6 border-t border-[#e5e7eb] space-y-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Product Card Carousel</h3>
                                <div>
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <label className="block text-sm font-bold text-[#1f2937]">Top Body</label>
                                        <button
                                            type="button"
                                            onClick={() => addPresetVariable('productBody')}
                                            className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Add Variable
                                        </button>
                                    </div>
                                    <textarea value={productCarouselBodyText} onChange={(e) => setProductCarouselBodyText(e.target.value)} placeholder="{{1}}, check out these products!" className="w-full min-h-[110px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Top Body Example Values (comma/newline)</label>
                                    <input value={productCarouselBodyExamples} onChange={(e) => setProductCarouselBodyExamples(e.target.value)} placeholder="Pablo" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Button Type</label>
                                        <select value={productCarouselButtonType} onChange={(e) => setProductCarouselButtonType(e.target.value === 'url' ? 'url' : 'spm')} className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]">
                                            <option value="spm">View (SPM)</option>
                                            <option value="url">URL</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-[#1f2937] mb-2">Button Text</label>
                                        <input value={productCarouselButtonText} onChange={(e) => setProductCarouselButtonText(e.target.value)} placeholder="View" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                    </div>
                                </div>
                                {productCarouselButtonType === 'url' && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">Button URL</label>
                                            <input value={productCarouselButtonUrl} onChange={(e) => setProductCarouselButtonUrl(e.target.value)} placeholder="https://yourstore.com/products/{{1}}" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">URL Example</label>
                                            <input value={productCarouselButtonUrlExample} onChange={(e) => setProductCarouselButtonUrlExample(e.target.value)} placeholder="PRODUCT_CODE_1" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {category === 'marketing' && marketingTemplatePreset === 'mpm' && (
                            <div className="mt-8 pt-6 border-t border-[#e5e7eb] space-y-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Multi-Product Message (MPM)</h3>
                                <label className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f2937]">
                                    <input type="checkbox" checked={mpmHeaderEnabled} onChange={(e) => setMpmHeaderEnabled(e.target.checked)} className="accent-[#22a34a] w-4 h-4" />
                                    Include Header
                                </label>
                                {mpmHeaderEnabled && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <div className="flex items-center justify-between gap-3 mb-2">
                                                <label className="block text-sm font-bold text-[#1f2937]">Header Text</label>
                                                <button
                                                    type="button"
                                                    onClick={() => addPresetVariable('mpmHeader')}
                                                    className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                                >
                                                    <PlusCircle className="w-4 h-4" />
                                                    Add Variable
                                                </button>
                                            </div>
                                            <input value={mpmHeaderText} onChange={(e) => setMpmHeaderText(e.target.value)} placeholder="Forget something, {{1}}?" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-[#1f2937] mb-2">Header Example</label>
                                            <input value={mpmHeaderExample} onChange={(e) => setMpmHeaderExample(e.target.value)} placeholder="Pablo" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <label className="block text-sm font-bold text-[#1f2937]">Body</label>
                                        <button
                                            type="button"
                                            onClick={() => addPresetVariable('mpmBody')}
                                            className="inline-flex items-center gap-1 text-xs font-bold text-[#22a34a] hover:text-[#1c8c3f]"
                                        >
                                            <PlusCircle className="w-4 h-4" />
                                            Add Variable
                                        </button>
                                    </div>
                                    <textarea value={mpmBodyText} onChange={(e) => setMpmBodyText(e.target.value)} placeholder="Use code {{1}} to get 10% off!" className="w-full min-h-[110px] resize-y bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Body Example Values (comma/newline)</label>
                                    <input value={mpmBodyExamples} onChange={(e) => setMpmBodyExamples(e.target.value)} placeholder="10OFF" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Footer (Optional)</label>
                                    <input value={mpmFooterText} onChange={(e) => setMpmFooterText(e.target.value)} placeholder="Lucky Shrub, 1 Hacker Way" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">MPM Button Text</label>
                                    <input value={mpmButtonText} onChange={(e) => setMpmButtonText(e.target.value)} placeholder="View items" className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]" />
                                </div>
                            </div>
                        )}

                        {showLegacyBuilder && (
                        <>
                        <div className="mt-8 pt-6 border-t border-[#e5e7eb]">
                            <h3 className="text-2xl font-black text-[#111b21]">Broadcast title <span className="text-[#6b7280] font-semibold">(Optional)</span></h3>
                            <p className="text-[#4b5563] mt-2 font-medium">Highlight your brand here, use images or videos to stand out.</p>
                            <div className="mt-4 flex flex-wrap gap-4">
                                {([
                                    { id: 'none', label: 'None' },
                                    { id: 'text', label: 'Text' },
                                    { id: 'image', label: 'Image' },
                                    { id: 'video', label: 'Video' },
                                    { id: 'document', label: 'Document' }
                                ] as Array<{ id: HeaderType; label: string }>).map((option) => (
                                    <label key={option.id} className="inline-flex items-center gap-2 text-lg font-bold text-[#1f2937] cursor-pointer">
                                        <input
                                            type="radio"
                                            checked={headerType === option.id}
                                            onChange={() => {
                                                setHeaderType(option.id);
                                                setError(null);
                                            }}
                                            className="accent-[#22a34a] w-4 h-4"
                                        />
                                        <span>{option.label}</span>
                                    </label>
                                ))}
                            </div>
                            {headerType === 'text' && (
                                <input
                                    value={headerText}
                                    onChange={(e) => {
                                        setHeaderText(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="Header text (max 60 chars)"
                                    className="mt-4 w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                />
                            )}
                            {(headerType === 'image' || headerType === 'video' || headerType === 'document') && (
                                <div className="mt-4">
                                    <div className="flex flex-col sm:flex-row gap-2">
                                        <button
                                            type="button"
                                            onClick={() => legacyHeaderFileInputRef.current?.click()}
                                            disabled={uploadingLegacyHeader}
                                            className="px-4 py-3 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                        >
                                            {uploadingLegacyHeader ? 'Uploading...' : `Upload ${headerType === 'video' ? 'video' : headerType === 'document' ? 'file' : 'image'}`}
                                        </button>
                                        <input
                                            ref={legacyHeaderFileInputRef}
                                            type="file"
                                            accept={headerType === 'video' ? 'video/*' : headerType === 'image' ? 'image/*' : '*/*'}
                                            onChange={handleLegacyHeaderUpload}
                                            className="hidden"
                                        />
                                    </div>
                                    <p className="mt-2 text-[11px] text-[#6b7280]">
                                        Upload one {headerType === 'video' ? 'video' : headerType === 'document' ? 'file' : 'image'} for this header.
                                    </p>
                                    {!legacyUploadedAsset && Boolean(headerHandle) && (
                                        <p className="mt-2 text-[11px] text-[#6b7280]">
                                            Media attached from draft.
                                        </p>
                                    )}
                                    {legacyUploadedAsset && (
                                        <div className="mt-3 bg-[#f9fafb] border border-[#e5e7eb] rounded-xl p-3">
                                            <div className="flex items-start gap-3">
                                                <span className="shrink-0 mt-0.5 text-[11px] font-black uppercase tracking-wider text-[#6b7280]">#1</span>
                                                <div className="flex-1 min-w-0 space-y-2">
                                                    <p className="text-xs font-bold text-[#111b21] truncate">{legacyUploadedAsset.name}</p>
                                                    {legacyUploadedAsset.previewUrl && legacyUploadedAsset.kind === 'image' && (
                                                        <img src={legacyUploadedAsset.previewUrl} alt={legacyUploadedAsset.name} className="w-full h-28 object-cover rounded-lg border border-[#e5e7eb]" />
                                                    )}
                                                    {legacyUploadedAsset.previewUrl && legacyUploadedAsset.kind === 'video' && (
                                                        <video src={legacyUploadedAsset.previewUrl} className="w-full h-28 object-cover rounded-lg border border-[#e5e7eb]" muted loop playsInline controls />
                                                    )}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={removeLegacyUploadedAsset}
                                                    className="shrink-0 w-7 h-7 rounded-full border border-[#fecaca] text-rose-600 text-xs font-black hover:bg-rose-50"
                                                    aria-label="Remove uploaded media"
                                                >
                                                    X
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="mt-8 pt-6 border-t border-[#e5e7eb]">
                            <div className="flex items-center justify-between gap-4">
                                <h3 className="text-2xl font-black text-[#111b21]">Body</h3>
                                <button
                                    onClick={addVariable}
                                    className="inline-flex items-center gap-2 text-[#22a34a] font-black text-2xl hover:text-[#1c8c3f]"
                                >
                                    <PlusCircle className="w-5 h-5" />
                                    Add Variable
                                </button>
                            </div>
                            <p className="text-[#4b5563] mt-2 font-medium">
                                Make messages personal using variables like <span className="text-[#22a34a] font-bold">{'{{name}}'}</span>.
                            </p>

                            <div className="mt-4 border border-[#e5e7eb] rounded-xl overflow-hidden">
                                <div className="px-4 py-2 bg-[#f9fafb] border-b border-[#e5e7eb] flex items-center justify-between">
                                    <div className="flex items-center gap-3 text-[#6b7280]">
                                        <button onClick={() => applyBodyFormat('*')} className="hover:text-[#111b21]"><Bold className="w-4 h-4" /></button>
                                        <button onClick={() => applyBodyFormat('_')} className="hover:text-[#111b21]"><Italic className="w-4 h-4" /></button>
                                        <button onClick={() => applyBodyFormat('~')} className="hover:text-[#111b21]"><Strikethrough className="w-4 h-4" /></button>
                                    </div>
                                    <span className="text-sm font-bold text-[#6b7280]">{bodyChars}/1024</span>
                                </div>
                                <textarea
                                    ref={bodyTextAreaRef}
                                    value={bodyText}
                                    onChange={(e) => {
                                        setBodyText(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="Template message..."
                                    className="w-full min-h-[220px] resize-y bg-[#f3f4f6] px-4 py-3 text-[15px] text-[#111b21] focus:outline-none"
                                />
                            </div>

                            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-[#1f2937] mb-2">Parameter format</label>
                                    <select
                                        value={parameterFormat}
                                        onChange={(e) => {
                                            setParameterFormat(e.target.value === 'named' ? 'named' : 'positional');
                                            setError(null);
                                        }}
                                        className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                    >
                                        <option value="positional">{'Positional ({{1}}, {{2}})'}</option>
                                        <option value="named">{'Named ({{name}})'}</option>
                                    </select>
                                    {parsedVariables.format === 'mixed' && (
                                        <p className="mt-2 text-xs font-semibold text-rose-600">
                                            Mixed variables detected in body. Use only one style: named or positional.
                                        </p>
                                    )}
                                    {parsedVariables.format !== 'mixed' && variableKeys.length > 0 && parsedVariables.format !== parameterFormat && (
                                        <p className="mt-2 text-xs font-semibold text-amber-700">
                                            Body uses {parsedVariables.format} variables. Submit will use {parsedVariables.format} format automatically.
                                        </p>
                                    )}
                                </div>
                            </div>

                            {variableKeys.length > 0 && (
                                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {variableKeys.map((key, index) => (
                                        <div key={`${key}-${index}`}>
                                            <label className="block text-xs font-black uppercase tracking-widest text-[#6b7280] mb-2">Example for {`{{${key}}}`}</label>
                                            <input
                                                value={sampleValues[key] || ''}
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    setSampleValues((prev) => ({ ...prev, [key]: value }));
                                                }}
                                                placeholder={`Sample value for {{${key}}}`}
                                                className="w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="mt-8 pt-6 border-t border-[#e5e7eb]">
                            <h3 className="text-2xl font-black text-[#111b21]">Footer <span className="text-[#6b7280] font-semibold">(Optional)</span></h3>
                            <p className="text-[#4b5563] mt-2 font-medium">Great for disclaimers or expiry notes.</p>
                            <input
                                value={footerText}
                                onChange={(e) => {
                                    setFooterText(e.target.value);
                                    setError(null);
                                }}
                                placeholder="Footer text (max 60 chars)"
                                className="mt-4 w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                            />
                        </div>

                        <div className="mt-8 pt-6 border-t border-[#e5e7eb]">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <h3 className="text-2xl font-black text-[#111b21]">Buttons <span className="text-[#6b7280] font-semibold">(Optional)</span></h3>
                                <span className="text-xs font-black uppercase tracking-widest text-[#6b7280]">{buttons.length}/10</span>
                            </div>
                            <p className="text-[#4b5563] mt-2 font-medium">Add call-to-action and quick reply buttons.</p>

                            <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => addButton('URL')}
                                    disabled={buttons.length >= 10}
                                    className="px-3 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                >
                                    + CTA URL
                                </button>
                                <button
                                    type="button"
                                    onClick={() => addButton('PHONE_NUMBER')}
                                    disabled={buttons.length >= 10}
                                    className="px-3 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                >
                                    + CTA Call
                                </button>
                                <button
                                    type="button"
                                    onClick={() => addButton('QUICK_REPLY')}
                                    disabled={buttons.length >= 10}
                                    className="px-3 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                >
                                    + Quick Reply
                                </button>
                            </div>

	                            {buttons.length > 0 && (
	                                <div className="mt-4 space-y-3">
                                    {buttons.map((button, index) => (
                                        <div key={button.id} className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl p-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black uppercase tracking-widest text-[#6b7280]">Button {index + 1}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => removeButton(button.id)}
                                                    className="ml-auto text-[#9ca3af] hover:text-rose-600"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                                                <select
                                                    value={button.type}
                                                    onChange={(e) =>
                                                        updateButton(button.id, {
                                                            type: e.target.value === 'PHONE_NUMBER' ? 'PHONE_NUMBER' : e.target.value === 'QUICK_REPLY' ? 'QUICK_REPLY' : 'URL'
                                                        })
                                                    }
                                                    className="bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                >
                                                    <option value="URL">CTA URL</option>
                                                    <option value="PHONE_NUMBER">CTA Call</option>
                                                    <option value="QUICK_REPLY">Quick Reply</option>
                                                </select>
                                                <input
                                                    value={button.text}
                                                    onChange={(e) => updateButton(button.id, { text: e.target.value })}
                                                    placeholder="Button label"
                                                    className="bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                />
                                                {button.type === 'URL' && (
                                                    <input
                                                        value={button.url}
                                                        onChange={(e) => updateButton(button.id, { url: e.target.value })}
                                                        placeholder="https://example.com"
                                                        className="bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                    />
                                                )}
                                                {button.type === 'PHONE_NUMBER' && (
                                                    <input
                                                        value={button.phoneNumber}
                                                        onChange={(e) => updateButton(button.id, { phoneNumber: e.target.value })}
                                                        placeholder="+14155550000"
                                                        className="bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                    />
                                                )}
                                                {button.type === 'QUICK_REPLY' && (
                                                    <div className="bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-xs text-[#6b7280] font-semibold flex items-center">
                                                        Quick reply button will send user tap text back to webhook.
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
	                                </div>
	                            )}
	                        </div>
                        </>
                        )}

	                        {(error || result) && (
	                            <div className={`mt-6 rounded-xl px-4 py-3 text-sm font-semibold ${error ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
                                {error || result}
                            </div>
                        )}
                    </section>

                    <aside className="hidden lg:flex bg-[#eeeff3] rounded-2xl border border-[#d8dbe2] p-6 flex-col items-center justify-start overflow-y-auto custom-scrollbar">
                        <h3 className="text-5xl font-black text-[#111b21] mb-4">Preview</h3>
                        <div className="w-[325px] max-w-full bg-white rounded-[42px] p-3 border border-[#dfe3ea] shadow-[0_20px_60px_rgba(0,0,0,0.16)]">
                            <div className="rounded-[34px] overflow-hidden border border-[#dfe3ea] bg-[#e9ddd0]">
                                <div className="h-10 bg-[#075e54]" />
                                <div className="p-4 min-h-[560px] bg-[linear-gradient(180deg,#e9ddd0_0%,#e9ddd0_70%,#e8dbcf_100%)] relative">
                                    <div className="bg-[#e7f5f4] text-[#4b5563] rounded-lg px-3 py-2 text-xs mb-4">
                                        This business uses a secure service to manage this chat.
                                    </div>
                                    <div className="bg-[#dcf8c6] rounded-xl shadow-[0_1px_0.5px_rgba(0,0,0,0.2)] px-3 py-2 max-w-[95%] ml-auto">
                                        {previewConfig.headerMode !== 'none' && (
                                            <div className="mb-2">
                                                {previewConfig.headerMode === 'text' ? (
                                                    <p className="text-[13px] font-bold text-[#1f2937] break-words">
                                                        {previewConfig.headerText || 'Header text'}
                                                    </p>
                                                ) : previewConfig.headerMediaUrl && previewConfig.headerMediaKind === 'image' ? (
                                                    <img
                                                        src={previewConfig.headerMediaUrl}
                                                        alt={previewConfig.headerMediaName || 'Uploaded header image'}
                                                        className="w-full h-28 object-cover rounded-lg border border-[#d0e7d4]"
                                                    />
                                                ) : previewConfig.headerMediaUrl && previewConfig.headerMediaKind === 'video' ? (
                                                    <video
                                                        src={previewConfig.headerMediaUrl}
                                                        className="w-full h-28 object-cover rounded-lg border border-[#d0e7d4]"
                                                        muted
                                                        loop
                                                        playsInline
                                                        controls
                                                    />
                                                ) : (
                                                    <div className="h-20 rounded-lg border border-dashed border-[#8ca6a1] bg-[#c2ddd9] flex items-center justify-center text-xs font-black text-[#215a50] uppercase">
                                                        {previewConfig.headerMode}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <p className="text-[14px] text-[#111b21] whitespace-pre-wrap break-words">
                                            {previewConfig.body}
                                        </p>
                                        {previewConfig.footer && (
                                            <p className="mt-2 text-[11px] text-[#6b7280] break-words">
                                                {previewConfig.footer}
                                            </p>
                                        )}
                                        <div className="text-[11px] text-[#6b7280] text-right mt-1">06:38</div>
                                    </div>
                                    {previewConfig.buttons.length > 0 && (
                                        <div className="mt-1 space-y-0.5">
                                            {previewConfig.buttons.map((label, index) => (
                                                <div key={`preview-${index}`} className="bg-white rounded-lg px-3 py-2 border border-[#e5e7eb] text-center">
                                                    <span className="text-[#1d4ed8] text-[13px] font-bold break-words">
                                                        {label}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {previewConfig.uploadedMedia.length > 0 && (
                                        <div className="mt-3 bg-white/70 rounded-xl border border-[#d7ded8] p-2 space-y-1.5">
                                            <p className="text-[10px] uppercase tracking-widest font-black text-[#6b7280] px-1">Uploaded media order</p>
                                            {previewConfig.uploadedMedia.map((asset, index) => (
                                                <div key={`preview-upload-${asset.id}`} className="rounded-lg bg-white border border-[#e5e7eb] px-2 py-1.5 text-[11px]">
                                                    <div className="font-bold text-[#111b21] truncate">#{index + 1} {asset.name}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </aside>
                </div>
            </div>
        </div>
    );
}
