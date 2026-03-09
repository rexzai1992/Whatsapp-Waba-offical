import React, { useEffect, useMemo, useState } from 'react';
import { getSocketUrl } from './runtimeConfig';

const SOCKET_URL = getSocketUrl();

type BroadcastTemplatesListProps = {
    profileId: string;
    sessionToken?: string | null;
    title?: string;
};

type TemplateRow = {
    id: string;
    name: string;
    status: string;
    category: string;
    language: string;
    quality: string;
    rejectedReason: string;
    parameterFormat: string;
    components: any[];
    createdTime: string;
};

const normalizeStatus = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase();
};

const statusToneClass = (status: string): string => {
    if (status === 'APPROVED') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (status === 'PENDING') return 'bg-amber-50 text-amber-700 border-amber-200';
    if (status === 'REJECTED' || status === 'DISABLED') return 'bg-rose-50 text-rose-700 border-rose-200';
    if (status === 'PAUSED') return 'bg-orange-50 text-orange-700 border-orange-200';
    return 'bg-slate-50 text-slate-700 border-slate-200';
};

const normalizeComponentType = (value: unknown): string => {
    if (typeof value !== 'string') return 'UNKNOWN';
    return value.trim().toUpperCase();
};

const summarizeComponent = (component: any): string => {
    const type = normalizeComponentType(component?.type);
    if (type === 'BODY') return typeof component?.text === 'string' ? component.text : 'Body text'
    if (type === 'FOOTER') return typeof component?.text === 'string' ? component.text : 'Footer text'
    if (type === 'HEADER') {
        const format = typeof component?.format === 'string' ? component.format.toUpperCase() : 'TEXT'
        return format === 'TEXT'
            ? (typeof component?.text === 'string' ? component.text : 'Header text')
            : `Header format: ${format}`
    }
    if (type === 'BUTTONS') {
        const count = Array.isArray(component?.buttons) ? component.buttons.length : 0
        return `${count} button${count === 1 ? '' : 's'}`
    }
    return 'Component details'
};

export default function BroadcastTemplatesList({
    profileId,
    sessionToken,
    title = 'Template Gallery'
}: BroadcastTemplatesListProps) {
    const [items, setItems] = useState<TemplateRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'APPROVED' | 'PENDING' | 'REJECTED'>('ALL');
    const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(null);

    const loadTemplates = async () => {
        if (!profileId || !sessionToken) return;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('profileId', profileId);
            params.set('limit', '100');
            params.set('fields', 'id,name,status,category,language,quality_score,rejected_reason,parameter_format,components,created_time');
            if (statusFilter !== 'ALL') params.set('status', statusFilter);
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load templates');
            }

            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const mapped: TemplateRow[] = rows.map((row: any) => ({
                id: typeof row?.id === 'string' ? row.id : '',
                name: typeof row?.name === 'string' ? row.name : '',
                status: normalizeStatus(row?.status),
                category: typeof row?.category === 'string' ? row.category : '',
                language: typeof row?.language === 'string' ? row.language : '',
                quality: typeof row?.quality_score?.score === 'string'
                    ? row.quality_score.score
                    : typeof row?.quality_score === 'string'
                        ? row.quality_score
                        : '',
                rejectedReason: typeof row?.rejected_reason === 'string' ? row.rejected_reason : '',
                parameterFormat: typeof row?.parameter_format === 'string' ? row.parameter_format : '',
                components: Array.isArray(row?.components) ? row.components : [],
                createdTime: typeof row?.created_time === 'string' ? row.created_time : ''
            }));

            const filtered = mapped.filter((item) => item.id && item.name);
            setItems(filtered);
            setSelectedTemplate((prev) => {
                if (!prev) return null;
                const next = filtered.find((item) => item.id === prev.id) || null;
                return next;
            });
        } catch (err: any) {
            setError(err?.message || 'Failed to load templates');
            setItems([]);
            setSelectedTemplate(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTemplates();
    }, [profileId, sessionToken, statusFilter]);

    const filteredItems = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((item) =>
            item.name.toLowerCase().includes(q) ||
            item.id.toLowerCase().includes(q) ||
            item.language.toLowerCase().includes(q)
        );
    }, [items, query]);

    return (
        <div className="h-full overflow-y-auto custom-scrollbar p-6">
            <div className="bg-white rounded-3xl border border-[#eceff1] shadow-[0_10px_30px_rgba(0,0,0,0.05)] p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                    <div>
                        <h2 className="text-2xl font-black text-[#111b21]">{title}</h2>
                        <p className="text-sm text-[#64748b] mt-1">View approved and pending templates on this WABA profile.</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void loadTemplates()}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                    >
                        {loading ? 'Refreshing...' : 'Refresh'}
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-4">
                    {(['ALL', 'APPROVED', 'PENDING', 'REJECTED'] as const).map((status) => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            className={`px-3 py-2 rounded-xl border text-xs font-bold ${statusFilter === status
                                ? 'bg-[#111b21] text-white border-[#111b21]'
                                : 'bg-white text-[#111b21] border-[#e5e7eb] hover:bg-[#f9fafb]'
                                }`}
                        >
                            {status}
                        </button>
                    ))}
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search name / id / language"
                        className="ml-auto min-w-[240px] flex-1 max-w-[360px] bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                    />
                </div>

                <div className="border border-[#e5e7eb] rounded-xl overflow-hidden">
                    <div className="max-h-[70vh] overflow-y-auto custom-scrollbar">
                        {loading ? (
                            <div className="px-4 py-4 text-sm text-[#6b7280]">Loading templates...</div>
                        ) : error ? (
                            <div className="px-4 py-4 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">{error}</div>
                        ) : filteredItems.length === 0 ? (
                            <div className="px-4 py-4 text-sm text-[#6b7280]">No templates found.</div>
                        ) : (
                            <table className="w-full text-left">
                                <thead className="sticky top-0 bg-[#f9fafb] border-b border-[#e5e7eb]">
                                    <tr className="text-[10px] uppercase tracking-widest text-[#6b7280] font-black">
                                        <th className="px-3 py-2">Name</th>
                                        <th className="px-3 py-2">Status</th>
                                        <th className="px-3 py-2">Category</th>
                                        <th className="px-3 py-2">Lang</th>
                                        <th className="px-3 py-2">Quality</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredItems.map((item) => (
                                        <tr
                                            key={item.id}
                                            className={`border-b border-[#f1f5f9] last:border-b-0 ${selectedTemplate?.id === item.id ? 'bg-[#f0fdfa]' : ''}`}
                                        >
                                            <td className="px-3 py-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setSelectedTemplate(item)}
                                                    className="text-left text-sm font-semibold text-[#0f172a] hover:text-[#00a884] hover:underline"
                                                >
                                                    {item.name}
                                                </button>
                                                <div className="text-[11px] text-[#64748b] font-mono">{item.id}</div>
                                                {item.rejectedReason && (
                                                    <div className="text-[11px] text-rose-600 mt-1">{item.rejectedReason}</div>
                                                )}
                                            </td>
                                            <td className="px-3 py-2">
                                                <span className={`inline-flex px-2 py-1 rounded-full border text-[10px] font-black ${statusToneClass(item.status)}`}>
                                                    {item.status || 'UNKNOWN'}
                                                </span>
                                            </td>
                                            <td className="px-3 py-2 text-xs font-semibold text-[#334155]">{item.category || '-'}</td>
                                            <td className="px-3 py-2 text-xs font-semibold text-[#334155]">{item.language || '-'}</td>
                                            <td className="px-3 py-2 text-xs font-semibold text-[#334155]">{item.quality || '-'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>

                {selectedTemplate && (
                    <div className="mt-4 rounded-2xl border border-[#e5e7eb] bg-[#f8fafc] p-4">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div>
                                <div className="text-[11px] uppercase tracking-widest font-black text-[#64748b]">Template Details</div>
                                <h3 className="text-lg font-black text-[#111b21] mt-1">{selectedTemplate.name}</h3>
                                <div className="text-xs text-[#64748b] font-mono mt-1">{selectedTemplate.id}</div>
                            </div>
                            <span className={`inline-flex px-2.5 py-1 rounded-full border text-[10px] font-black ${statusToneClass(selectedTemplate.status)}`}>
                                {selectedTemplate.status || 'UNKNOWN'}
                            </span>
                        </div>

                        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
                            <div className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                <div className="text-[#64748b] uppercase tracking-widest font-black text-[10px]">Category</div>
                                <div className="font-semibold text-[#111b21]">{selectedTemplate.category || '-'}</div>
                            </div>
                            <div className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                <div className="text-[#64748b] uppercase tracking-widest font-black text-[10px]">Language</div>
                                <div className="font-semibold text-[#111b21]">{selectedTemplate.language || '-'}</div>
                            </div>
                            <div className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                <div className="text-[#64748b] uppercase tracking-widest font-black text-[10px]">Parameter Format</div>
                                <div className="font-semibold text-[#111b21]">{selectedTemplate.parameterFormat || '-'}</div>
                            </div>
                            <div className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2">
                                <div className="text-[#64748b] uppercase tracking-widest font-black text-[10px]">Created</div>
                                <div className="font-semibold text-[#111b21]">{selectedTemplate.createdTime || '-'}</div>
                            </div>
                        </div>

                        <div className="mt-3">
                            <div className="text-[11px] uppercase tracking-widest font-black text-[#64748b] mb-2">
                                Components ({selectedTemplate.components.length})
                            </div>
                            {selectedTemplate.components.length === 0 ? (
                                <div className="text-xs text-[#64748b]">No component details returned by API.</div>
                            ) : (
                                <div className="space-y-2">
                                    {selectedTemplate.components.map((component, index) => (
                                        <div key={`${selectedTemplate.id}-${index}`} className="rounded-xl border border-[#e2e8f0] bg-white p-3">
                                            <div className="text-[10px] uppercase tracking-widest font-black text-[#64748b]">
                                                {normalizeComponentType(component?.type)}
                                            </div>
                                            <div className="mt-1 text-sm text-[#111b21] whitespace-pre-wrap break-words">
                                                {summarizeComponent(component)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
