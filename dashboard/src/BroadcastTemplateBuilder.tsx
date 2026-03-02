import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bold, Italic, PlusCircle, Save, Send, Strikethrough, Trash2 } from 'lucide-react';
import { getSocketUrl } from './runtimeConfig';

const SOCKET_URL = getSocketUrl();
const DRAFT_STORAGE_KEY = 'waba-broadcast-template-draft-v1';

type TemplateCategory = 'marketing' | 'utility';
type HeaderType = 'none' | 'text' | 'image' | 'video' | 'document';
type ParameterFormat = 'named' | 'positional';
type TemplateButtonType = 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY';

type TemplateButton = {
    id: string;
    type: TemplateButtonType;
    text: string;
    url: string;
    phoneNumber: string;
};

type DraftState = {
    templateName: string;
    category: TemplateCategory;
    language: string;
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

export default function BroadcastTemplateBuilder({
    profileId,
    sessionToken,
    onClose,
    embedded = false
}: BroadcastTemplateBuilderProps) {
    const [templateName, setTemplateName] = useState('');
    const [category, setCategory] = useState<TemplateCategory>('marketing');
    const [language, setLanguage] = useState('en_US');
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
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const bodyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

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
        try {
            const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as DraftState;
            if (!parsed || typeof parsed !== 'object') return;

            setTemplateName(typeof parsed.templateName === 'string' ? parsed.templateName : '');
            setCategory(parsed.category === 'utility' ? 'utility' : 'marketing');
            setLanguage(typeof parsed.language === 'string' && parsed.language ? parsed.language : 'en_US');
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
                                        Marketing template: up to 1 header, 1 required body, 1 footer, and up to 10 buttons.
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
                                <input
                                    value={headerHandle}
                                    onChange={(e) => {
                                        setHeaderHandle(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="Media header handle (from resumable upload)"
                                    className="mt-4 w-full bg-[#f3f4f6] border border-[#e5e7eb] rounded-xl px-4 py-3 text-sm font-mono text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                />
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
                                        {headerType !== 'none' && (
                                            <div className="mb-2">
                                                {headerType === 'text' ? (
                                                    <p className="text-[13px] font-bold text-[#1f2937] break-words">
                                                        {headerText || 'Header text'}
                                                    </p>
                                                ) : (
                                                    <div className="h-20 rounded-lg border border-dashed border-[#8ca6a1] bg-[#c2ddd9] flex items-center justify-center text-xs font-black text-[#215a50] uppercase">
                                                        {headerType}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <p className="text-[14px] text-[#111b21] whitespace-pre-wrap break-words">
                                            {previewBody}
                                        </p>
                                        {footerText.trim() && (
                                            <p className="mt-2 text-[11px] text-[#6b7280] break-words">
                                                {footerText.trim()}
                                            </p>
                                        )}
                                        <div className="text-[11px] text-[#6b7280] text-right mt-1">06:38</div>
                                    </div>
                                    {buttons.length > 0 && (
                                        <div className="mt-1 space-y-0.5">
                                            {buttons.map((button) => (
                                                <div key={`preview-${button.id}`} className="bg-white rounded-lg px-3 py-2 border border-[#e5e7eb] text-center">
                                                    <span className="text-[#1d4ed8] text-[13px] font-bold break-words">
                                                        {button.text.trim() || (button.type === 'PHONE_NUMBER' ? 'Call now' : button.type === 'URL' ? 'Open link' : 'Quick reply')}
                                                    </span>
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
