import React, { useCallback, useMemo, useState, useEffect } from 'react';
import {
    ReactFlow,
    MiniMap,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    addEdge,
    Handle,
    Position,
    BackgroundVariant,
    Panel,
} from '@xyflow/react';
import type { Connection, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
    MessageSquare,
    Image as ImageIcon,
    HelpCircle,
    List,
    FileText,
    Tags,
    UserCheck,
    GitBranch as GitBranchIcon,
    Webhook,
    Settings,
    Play,
    Square,
    Activity,
    Plus,
    Trash2,
    Save,
    X,
    Link as LinkIcon
} from 'lucide-react';

const nodeTypes = {
    START: (props: any) => (
        <div className="bg-white border-l-4 border-[#00a884] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-52 text-[#111b21] border border-[#eceff1]">
            <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 rounded-full bg-[#00a884]/10 flex items-center justify-center">
                    <Play className="w-4 h-4 text-[#00a884]" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-[#00a884]">Entry Point</span>
            </div>
            <p className="text-[11px] text-[#54656f] font-medium font-sans">Sequence starts here</p>
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-[#00a884] border-x border-white" />
        </div>
    ),
    MESSAGE: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-64 text-[#111b21] group hover:border-[#3b82f6]/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-blue-500">
                    <MessageSquare className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-blue-500">Send Message</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <textarea
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-24 resize-none focus:outline-none focus:border-blue-400 font-medium placeholder-[#aebac1]"
                value={props.data.content}
                onChange={(e) => props.data.onChange(props.id, { content: e.target.value })}
                placeholder="Type message..."
            />
            <div className="mt-3 grid grid-cols-1 gap-2">
                <select
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-blue-400"
                    value={props.data.mediaType || 'none'}
                    onChange={(e) => props.data.onChange(props.id, { mediaType: e.target.value })}
                >
                    <option value="none">No media</option>
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                    <option value="document">Document</option>
                </select>
                {props.data.mediaType && props.data.mediaType !== 'none' && (
                    <>
                        <input
                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-blue-400 font-mono"
                            value={props.data.mediaUrl || ''}
                            onChange={(e) => props.data.onChange(props.id, { mediaUrl: e.target.value })}
                            placeholder={`${props.data.mediaType} URL (https://...)`}
                        />
                        {props.data.mediaType === 'document' && (
                            <input
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-blue-400 font-medium"
                                value={props.data.mediaFilename || ''}
                                onChange={(e) => props.data.onChange(props.id, { mediaFilename: e.target.value })}
                                placeholder="Document filename (optional)"
                            />
                        )}
                    </>
                )}
            </div>
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-blue-500 border-2 border-white" />
        </div>
    ),
    ASK: (props: any) => {
        const variableOptions = Array.isArray(props.data.variableOptions) ? props.data.variableOptions : [];
        const listId = `ask-vars-${props.id}`;
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-violet-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center text-violet-600">
                        <HelpCircle className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-violet-600">Ask Question</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <textarea
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-20 resize-none focus:outline-none focus:border-violet-400 font-medium"
                    value={props.data.question || ''}
                    onChange={(e) => props.data.onChange(props.id, { question: e.target.value })}
                    placeholder="Ask anything to the user..."
                />
                <div className="mt-3 grid grid-cols-1 gap-2">
                    <input
                        list={listId}
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-violet-400"
                        value={props.data.saveAs || ''}
                        onChange={(e) => props.data.onChange(props.id, { saveAs: e.target.value })}
                        placeholder="Save answer as (e.g. customer_name)"
                    />
                    <datalist id={listId}>
                        {variableOptions.map((name: string) => (
                            <option key={`${listId}-${name}`} value={name} />
                        ))}
                    </datalist>
                    <input
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-violet-400"
                        value={props.data.fallbackText || ''}
                        onChange={(e) => props.data.onChange(props.id, { fallbackText: e.target.value })}
                        placeholder="Fallback if user sends empty input (optional)"
                    />
                    <input
                        type="number"
                        min={1}
                        max={10}
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-violet-400"
                        value={props.data.retryLimit ?? 3}
                        onChange={(e) => props.data.onChange(props.id, { retryLimit: Number(e.target.value || 3) })}
                        placeholder="Retry limit"
                    />
                </div>
                <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-violet-600 border-2 border-white" />
            </div>
        );
    },
    QUESTION: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-purple-500/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-purple-50 flex items-center justify-center text-purple-500">
                    <HelpCircle className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-purple-500">Question</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <textarea
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-16 mb-3 resize-none focus:outline-none focus:border-purple-400 font-medium"
                value={props.data.content}
                onChange={(e) => props.data.onChange(props.id, { content: e.target.value })}
                placeholder="Ask user for input..."
            />
            <div className="space-y-2">
                <p className="text-[10px] text-[#54656f] uppercase font-black px-1 tracking-widest">Choices</p>
                <div className="flex flex-col gap-2">
                    {(props.data.options || []).map((opt: string, i: number) => (
                        <div key={i} className="flex items-center gap-2 group/opt relative">
                            <input
                                className="bg-[#fcfdfd] border border-[#eceff1] rounded-xl px-3 py-2 text-xs flex-1 focus:border-purple-400 focus:outline-none font-bold"
                                value={opt}
                                onChange={(e) => {
                                    const newOpts = [...props.data.options];
                                    newOpts[i] = e.target.value;
                                    props.data.onChange(props.id, { options: newOpts });
                                }}
                            />
                            <button
                                onClick={() => {
                                    const newOpts = props.data.options.filter((_: any, idx: number) => idx !== i);
                                    props.data.onChange(props.id, { options: newOpts });
                                }}
                                className="opacity-0 group-hover/opt:opacity-100 text-rose-500 hover:bg-rose-50 p-1 rounded-lg transition-all"
                            >
                                <X className="w-3 h-3" />
                            </button>
                            <Handle
                                type="source"
                                position={Position.Right}
                                id={`opt-${i}`}
                                className="w-2.5 h-5 bg-purple-500 rounded-sm border-none shadow-sm"
                            />
                        </div>
                    ))}
                    <button
                        onClick={() => {
                            const options = Array.isArray(props.data.options) ? props.data.options : [];
                            if (options.length >= 3) return;
                            props.data.onChange(props.id, { options: [...options, `Option ${options.length + 1}`] });
                        }}
                        disabled={(props.data.options || []).length >= 3}
                        className="text-[10px] text-purple-500 font-bold px-3 py-2 border border-dashed border-purple-200 rounded-xl mt-1 bg-purple-50/50 hover:bg-purple-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-3.5 h-3.5" /> Add Button ({(props.data.options || []).length}/3)
                    </button>
                </div>
            </div>
            <div className="mt-4">
                <p className="text-[10px] text-[#54656f] uppercase font-black px-1 tracking-widest">Fallback Reply</p>
                <input
                    className="w-full bg-[#fcfdfd] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-medium focus:outline-none focus:border-purple-400"
                    value={props.data.fallbackText || ''}
                    onChange={(e) => props.data.onChange(props.id, { fallbackText: e.target.value })}
                    placeholder="Message when user sends something else"
                />
            </div>
            <Handle type="source" position={Position.Bottom} id="default" className="w-3 h-3 bg-purple-500 border-2 border-white" />
        </div>
    ),
    LIST: (props: any) => {
        const sections = Array.isArray(props.data.sections) ? props.data.sections : [];
        const totalRows = sections.reduce((sum: number, section: any) => {
            const rows = Array.isArray(section?.rows) ? section.rows.length : 0;
            return sum + rows;
        }, 0);
        const updateSections = (next: any[]) => props.data.onChange(props.id, { sections: next });
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-[360px] text-[#111b21] group hover:border-sky-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-sky-50 flex items-center justify-center text-sky-500">
                        <List className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-sky-500">List Message</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <textarea
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-20 resize-none focus:outline-none focus:border-sky-400 font-medium"
                    value={props.data.body || ''}
                    onChange={(e) => props.data.onChange(props.id, { body: e.target.value })}
                    placeholder="Body text..."
                />
                <div className="grid grid-cols-1 gap-2 mt-3">
                    <input
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-bold"
                        value={props.data.buttonText || ''}
                        onChange={(e) => props.data.onChange(props.id, { buttonText: e.target.value })}
                        placeholder="Button label (e.g. View options)"
                    />
                    <input
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-sky-400 font-medium"
                        value={props.data.headerText || ''}
                        onChange={(e) => props.data.onChange(props.id, { headerText: e.target.value })}
                        placeholder="Header text (optional)"
                    />
                    <input
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-sky-400 font-medium"
                        value={props.data.footerText || ''}
                        onChange={(e) => props.data.onChange(props.id, { footerText: e.target.value })}
                        placeholder="Footer text (optional)"
                    />
                    <input
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-sky-400 font-medium"
                        value={props.data.fallbackText || ''}
                        onChange={(e) => props.data.onChange(props.id, { fallbackText: e.target.value })}
                        placeholder="Fallback reply (optional)"
                    />
                </div>
                <div className="mt-4 space-y-3">
                    <p className="text-[10px] text-[#54656f] uppercase font-black px-1 tracking-widest">Sections</p>
                    {sections.map((section: any, sIdx: number) => (
                        <div key={sIdx} className="border border-dashed border-sky-100 rounded-xl p-3 bg-sky-50/40">
                            <div className="flex items-center gap-2 mb-2">
                                <input
                                    className="flex-1 bg-white border border-[#eceff1] rounded-lg px-2 py-1 text-[10px] font-bold focus:outline-none focus:border-sky-400"
                                    value={section.title || ''}
                                    onChange={(e) => {
                                        const next = sections.map((s: any, idx: number) => idx === sIdx ? { ...s, title: e.target.value } : s);
                                        updateSections(next);
                                    }}
                                    placeholder="Section title"
                                />
                                <button
                                    onClick={() => {
                                        const next = sections.filter((_: any, idx: number) => idx !== sIdx);
                                        updateSections(next);
                                    }}
                                    className="text-rose-500 hover:bg-rose-50 p-1 rounded-lg transition-all"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                            <div className="space-y-2">
                                {(section.rows || []).map((row: any, rIdx: number) => (
                                    <div key={rIdx} className="bg-white border border-[#eceff1] rounded-lg p-2 relative">
                                        <div className="grid grid-cols-1 gap-2">
                                            <input
                                                className="bg-[#fcfdfd] border border-[#eceff1] rounded-lg px-2 py-1 text-[10px] font-bold focus:outline-none focus:border-sky-400"
                                                value={row.title || ''}
                                                onChange={(e) => {
                                                    const next = sections.map((s: any, idx: number) => {
                                                        if (idx !== sIdx) return s;
                                                        const rows = (s.rows || []).map((r: any, i: number) => i === rIdx ? { ...r, title: e.target.value } : r);
                                                        return { ...s, rows };
                                                    });
                                                    updateSections(next);
                                                }}
                                                placeholder="Row title"
                                            />
                                            <input
                                                className="bg-[#fcfdfd] border border-[#eceff1] rounded-lg px-2 py-1 text-[10px] focus:outline-none focus:border-sky-400"
                                                value={row.description || ''}
                                                onChange={(e) => {
                                                    const next = sections.map((s: any, idx: number) => {
                                                        if (idx !== sIdx) return s;
                                                        const rows = (s.rows || []).map((r: any, i: number) => i === rIdx ? { ...r, description: e.target.value } : r);
                                                        return { ...s, rows };
                                                    });
                                                    updateSections(next);
                                                }}
                                                placeholder="Row description (optional)"
                                            />
                                            <input
                                                className="bg-[#fcfdfd] border border-[#eceff1] rounded-lg px-2 py-1 text-[10px] font-mono focus:outline-none focus:border-sky-400"
                                                value={row.id || ''}
                                                onChange={(e) => {
                                                    const next = sections.map((s: any, idx: number) => {
                                                        if (idx !== sIdx) return s;
                                                        const rows = (s.rows || []).map((r: any, i: number) => i === rIdx ? { ...r, id: e.target.value } : r);
                                                        return { ...s, rows };
                                                    });
                                                    updateSections(next);
                                                }}
                                                placeholder="Row ID (optional)"
                                            />
                                        </div>
                                        <button
                                            onClick={() => {
                                                const next = sections.map((s: any, idx: number) => {
                                                    if (idx !== sIdx) return s;
                                                    const rows = (s.rows || []).filter((_: any, i: number) => i !== rIdx);
                                                    return { ...s, rows };
                                                });
                                                updateSections(next);
                                            }}
                                            className="absolute top-2 right-2 text-rose-500 hover:bg-rose-50 p-1 rounded-lg transition-all"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                        <Handle
                                            type="source"
                                            position={Position.Right}
                                            id={`row-${sIdx}-${rIdx}`}
                                            className="w-2.5 h-5 bg-sky-500 rounded-sm border-none shadow-sm"
                                        />
                                    </div>
                                ))}
                                <button
                                    onClick={() => {
                                        if (totalRows >= 10) return;
                                        const next = sections.map((s: any, idx: number) => {
                                            if (idx !== sIdx) return s;
                                            const rows = [...(s.rows || []), { title: 'New option', description: '', id: '' }];
                                            return { ...s, rows };
                                        });
                                        updateSections(next);
                                    }}
                                    disabled={totalRows >= 10}
                                    className="text-[10px] text-sky-600 font-bold px-3 py-2 border border-dashed border-sky-200 rounded-xl bg-white/60 hover:bg-white transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Plus className="w-3.5 h-3.5" /> Add Row
                                </button>
                            </div>
                        </div>
                    ))}
                    <button
                        onClick={() => {
                            if (totalRows >= 10) return;
                            updateSections([...sections, { title: '', rows: [{ title: 'New option', description: '', id: '' }] }]);
                        }}
                        disabled={totalRows >= 10}
                        className="text-[10px] text-sky-600 font-bold px-3 py-2 border border-dashed border-sky-200 rounded-xl bg-sky-50/50 hover:bg-sky-50 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-3.5 h-3.5" /> Add Section ({totalRows}/10)
                    </button>
                </div>
            </div>
        );
    },
    CTA_URL: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-emerald-500/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
                    <LinkIcon className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-emerald-600">CTA URL</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <textarea
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-20 resize-none focus:outline-none focus:border-emerald-400 font-medium"
                value={props.data.body}
                onChange={(e) => props.data.onChange(props.id, { body: e.target.value })}
                placeholder="Body text..."
            />
            <div className="grid grid-cols-1 gap-2 mt-3">
                <input
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] focus:outline-none focus:border-emerald-400 font-bold"
                    value={props.data.buttonText}
                    onChange={(e) => props.data.onChange(props.id, { buttonText: e.target.value })}
                    placeholder="Button label (e.g. See Dates)"
                />
                <input
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-emerald-400 font-mono"
                    value={props.data.url}
                    onChange={(e) => props.data.onChange(props.id, { url: e.target.value })}
                    placeholder="https://example.com"
                />
                <input
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-emerald-400 font-medium"
                    value={props.data.headerText || ''}
                    onChange={(e) => props.data.onChange(props.id, { headerText: e.target.value })}
                    placeholder="Header text (optional)"
                />
                <input
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[10px] focus:outline-none focus:border-emerald-400 font-medium"
                    value={props.data.footerText || ''}
                    onChange={(e) => props.data.onChange(props.id, { footerText: e.target.value })}
                    placeholder="Footer text (optional)"
                />
            </div>
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-emerald-500 border-2 border-white" />
        </div>
    ),
    IMAGE: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-64 text-[#111b21] group hover:border-orange-500/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-orange-50 flex items-center justify-center text-orange-500">
                    <ImageIcon className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-orange-500">Media Message</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <select
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] mb-3 focus:outline-none focus:border-orange-400 font-bold"
                value={props.data.mediaType || 'image'}
                onChange={(e) => props.data.onChange(props.id, { mediaType: e.target.value })}
            >
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="document">Document</option>
            </select>
            <input
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-3 text-[10px] mb-3 focus:outline-none focus:border-orange-400 font-mono"
                value={props.data.mediaUrl || props.data.imageUrl || ''}
                onChange={(e) => props.data.onChange(props.id, { mediaUrl: e.target.value, imageUrl: e.target.value })}
                placeholder={`${props.data.mediaType || 'image'} URL (Public)...`}
            />
            {(props.data.mediaType || 'image') === 'document' && (
                <input
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-3 text-[10px] mb-3 focus:outline-none focus:border-orange-400 font-medium"
                    value={props.data.mediaFilename || ''}
                    onChange={(e) => props.data.onChange(props.id, { mediaFilename: e.target.value })}
                    placeholder="Document filename (optional)"
                />
            )}
            <input
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-3 text-[10px] focus:outline-none focus:border-orange-400 font-bold"
                value={props.data.caption}
                onChange={(e) => props.data.onChange(props.id, { caption: e.target.value })}
                placeholder="Message Caption..."
            />
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-orange-500 border-2 border-white" />
        </div>
    ),
    TAG: (props: any) => {
        const tags = Array.isArray(props.data.tags) ? props.data.tags : [];
        const options = Array.isArray(props.data.availableTags) ? props.data.availableTags : [];
        const draft = props.data.tagDraft || '';
        const listId = `tag-options-${props.id}`;
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-fuchsia-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-fuchsia-50 flex items-center justify-center text-fuchsia-600">
                        <Tags className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-fuchsia-600">Add Tags</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <div className="flex gap-2">
                    <input
                        list={listId}
                        className="flex-1 bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-fuchsia-400"
                        value={draft}
                        onChange={(e) => props.data.onChange(props.id, { tagDraft: e.target.value })}
                        placeholder="Tag name"
                    />
                    <datalist id={listId}>
                        {options.map((tag: string) => (
                            <option key={`${listId}-${tag}`} value={tag} />
                        ))}
                    </datalist>
                    <button
                        onClick={() => {
                            const value = String(draft || '').trim();
                            if (!value) return;
                            const next = Array.from(new Set([...(tags || []), value]));
                            props.data.onChange(props.id, { tags: next, tagDraft: '' });
                        }}
                        className="px-3 py-2 bg-fuchsia-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider hover:bg-fuchsia-700"
                    >
                        Add
                    </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    {tags.length === 0 && (
                        <span className="text-[10px] text-[#8696a0] font-bold">No tags selected</span>
                    )}
                    {tags.map((tag: string) => (
                        <span key={`${props.id}-tag-${tag}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-fuchsia-50 border border-fuchsia-200 text-[10px] font-bold text-fuchsia-700">
                            {tag}
                            <button
                                onClick={() => props.data.onChange(props.id, { tags: tags.filter((t: string) => t !== tag) })}
                                className="text-fuchsia-700 hover:text-rose-600"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
                <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-fuchsia-600 border-2 border-white" />
            </div>
        );
    },
    ASSIGN: (props: any) => {
        const staffOptions = Array.isArray(props.data.staffOptions) ? props.data.staffOptions : [];
        const selected = typeof props.data.assigneeUserId === 'string' ? props.data.assigneeUserId : '';
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-emerald-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
                        <UserCheck className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-emerald-600">Assign Staff</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <select
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-emerald-400"
                    value={selected}
                    onChange={(e) => {
                        const value = e.target.value;
                        if (!value) {
                            props.data.onChange(props.id, { assigneeUserId: '', assigneeName: '', assigneeColor: '' });
                            return;
                        }
                        const picked = staffOptions.find((member: any) => member.id === value);
                        props.data.onChange(props.id, {
                            assigneeUserId: value,
                            assigneeName: picked?.name || value,
                            assigneeColor: picked?.color || '#6b7280'
                        });
                    }}
                >
                    <option value="">Unassign</option>
                    {staffOptions.map((member: any) => (
                        <option key={`${props.id}-staff-${member.id}`} value={member.id}>
                            {member.name || member.id}
                        </option>
                    ))}
                </select>
                <p className="mt-2 text-[10px] text-[#54656f] font-bold uppercase tracking-wider">
                    {selected ? `Assigned to ${props.data.assigneeName || selected}` : 'No assignee (unassign)'}
                </p>
                <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-emerald-600 border-2 border-white" />
            </div>
        );
    },
    WORKFLOW_TRIGGER: (props: any) => {
        const workflowOptions = Array.isArray(props.data.workflowOptions) ? props.data.workflowOptions : [];
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-indigo-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
                        <GitBranchIcon className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-indigo-600">Trigger Workflow</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <select
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-indigo-400"
                    value={props.data.targetWorkflowId || ''}
                    onChange={(e) => props.data.onChange(props.id, { targetWorkflowId: e.target.value })}
                >
                    <option value="">Select workflow</option>
                    {workflowOptions.map((wf: any) => (
                        <option key={`${props.id}-wf-${wf.id}`} value={wf.id}>
                            {wf.name || wf.id}
                        </option>
                    ))}
                </select>
                <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-indigo-600 border-2 border-white" />
            </div>
        );
    },
    TEMPLATE: (props: any) => {
        const templateOptions = Array.isArray(props.data.templateOptions) ? props.data.templateOptions : [];
        const selectedName = props.data.templateName || '';
        const selectedLanguage = props.data.templateLanguage || 'en_US';
        const optionValueFor = (tpl: any) => tpl.id || `${tpl.name}::${tpl.language || 'en_US'}`;
        const selectedOption = templateOptions.find(
            (tpl: any) => tpl.name === selectedName && (tpl.language || 'en_US') === selectedLanguage
        );
        const selectedOptionValue = selectedOption ? optionValueFor(selectedOption) : '';
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-80 text-[#111b21] group hover:border-cyan-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-cyan-50 flex items-center justify-center text-cyan-600">
                        <FileText className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-cyan-600">Send Template</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <select
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-cyan-400"
                    value={selectedOptionValue}
                    onChange={(e) => {
                        const value = e.target.value;
                        const picked = templateOptions.find((tpl: any) => optionValueFor(tpl) === value);
                        props.data.onChange(props.id, {
                            templateName: picked?.name || '',
                            templateComponents: '',
                            templateLanguage: picked?.language || props.data.templateLanguage || 'en_US'
                        });
                    }}
                >
                    <option value="">Select template</option>
                    {templateOptions.map((tpl: any, idx: number) => (
                        <option key={`${props.id}-tpl-${tpl.id || tpl.name || idx}`} value={optionValueFor(tpl)}>
                            {tpl.name}{tpl.language ? ` (${tpl.language})` : ''}
                        </option>
                    ))}
                </select>
                <input
                    className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-cyan-400"
                    value={props.data.templateLanguage || 'en_US'}
                    onChange={(e) => props.data.onChange(props.id, { templateLanguage: e.target.value })}
                    placeholder="Language (en_US)"
                />
                <p className="mt-2 text-[10px] text-[#54656f] font-medium">
                    {templateOptions.length > 0
                        ? 'Pick from approved templates in Template Gallery, then set language if needed.'
                        : 'No approved templates found on this profile yet.'}
                </p>
                <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-cyan-600 border-2 border-white" />
            </div>
        );
    },
    CONDITION: (props: any) => {
        const variableOptions = Array.isArray(props.data.variableOptions) ? props.data.variableOptions : [];
        const listId = `condition-vars-${props.id}`;
        const operator = props.data.operator || 'contains';
        return (
            <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-yellow-500/30 transition-all">
                <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-yellow-50 flex items-center justify-center text-yellow-500">
                        <Activity className="w-4 h-4" />
                    </div>
                    <span className="font-black text-[10px] uppercase tracking-widest text-yellow-600">Set Condition</span>
                    <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
                <div className="grid grid-cols-1 gap-2 mb-3">
                    <input
                        list={listId}
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:border-yellow-400"
                        value={props.data.source || ''}
                        onChange={(e) => props.data.onChange(props.id, { source: e.target.value })}
                        placeholder="Variable (e.g. customer_name or vars.customer_name)"
                    />
                    <datalist id={listId}>
                        {variableOptions.map((name: string) => (
                            <option key={`${listId}-${name}`} value={name} />
                        ))}
                    </datalist>
                    <select
                        className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-yellow-400"
                        value={operator}
                        onChange={(e) => props.data.onChange(props.id, { operator: e.target.value })}
                    >
                        <option value="contains">Contains</option>
                        <option value="equals">Equals</option>
                        <option value="not_equals">Not equals</option>
                        <option value="starts_with">Starts with</option>
                        <option value="exists">Exists</option>
                        <option value="greater_than">Greater than</option>
                        <option value="less_than">Less than</option>
                    </select>
                    {operator !== 'exists' && (
                        <input
                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] focus:outline-none focus:border-yellow-400"
                            value={props.data.value ?? ''}
                            onChange={(e) => props.data.onChange(props.id, { value: e.target.value })}
                            placeholder="Compare value"
                        />
                    )}
                </div>
                <div className="flex justify-between items-center px-4 py-3 bg-[#f8fae5] rounded-xl border border-yellow-200">
                    <span className="text-[10px] text-[#854d0e] font-black uppercase tracking-widest">True</span>
                    <Handle type="source" position={Position.Right} id="true" className="w-3 h-6 bg-[#06d755] rounded-full border-2 border-white" />
                </div>
                <div className="flex justify-between items-center px-4 py-3 bg-rose-50 rounded-xl border border-rose-100 mt-2">
                    <span className="text-[10px] text-rose-700 font-black uppercase tracking-widest">False</span>
                    <Handle type="source" position={Position.Left} id="false" className="w-3 h-6 bg-rose-500 rounded-full border-2 border-white" />
                </div>
            </div>
        );
    },
    END: (props: any) => (
        <div className="bg-white border-l-4 border-rose-500 p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-52 text-[#111b21] border border-[#eceff1] group">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-rose-50 flex items-center justify-center text-rose-500">
                    <Square className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-rose-500">Termination</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <textarea
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-16 resize-none focus:outline-none focus:border-rose-400 font-medium"
                value={props.data.content}
                onChange={(e) => props.data.onChange(props.id, { content: e.target.value })}
                placeholder="Final message to send..."
            />
        </div>
    ),
};

type FlowCanvasProps = {
    flow: any
    onSave: (flow: any) => void
    tagOptions?: string[]
    variableOptions?: string[]
    staffOptions?: Array<{ id: string; name: string; color?: string }>
    workflowOptions?: Array<{ id: string; name?: string }>
    templateOptions?: Array<{ id?: string; name: string; language?: string }>
}

export default function FlowCanvas({
    flow,
    onSave,
    tagOptions = [],
    variableOptions = [],
    staffOptions = [],
    workflowOptions = [],
    templateOptions = []
}: FlowCanvasProps) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const nodesRef = React.useRef<Node[]>([]);
    const edgesRef = React.useRef<Edge[]>([]);

    useEffect(() => {
        nodesRef.current = nodes;
    }, [nodes]);

    useEffect(() => {
        edgesRef.current = edges;
    }, [edges]);

    // Initialize nodes and edges from flow data
    useEffect(() => {
        if (!flow || !flow.nodes) return;

        const initialNodes: Node[] = flow.nodes.map((n: any, i: number) => ({
            id: n.id,
            type: n.type,
            position: n.position || { x: i * 300, y: 100 },
            data: {
                ...n,
                onChange: handleNodeDataChange,
                onDelete: handleNodeDelete,
                availableTags: tagOptions,
                variableOptions,
                staffOptions,
                workflowOptions,
                templateOptions
            },
        }));

        const initialEdges: Edge[] = [];
        flow.nodes.forEach((n: any) => {
            if (n.nextId) {
                initialEdges.push({
                    id: `e-${n.id}-${n.nextId}`,
                    source: n.id,
                    target: n.nextId,
                    className: 'stroke-[#00a884] stroke-2',
                    animated: true,
                });
            }
            if (n.connections) {
                Object.entries(n.connections).forEach(([key, targetId]) => {
                    if (targetId) {
                        let label = key !== 'default' ? key : '';
                        if (n.type === 'QUESTION' && key.startsWith('opt-')) {
                            const optIndex = Number(key.replace('opt-', ''));
                            const optionLabel = Array.isArray(n.options) ? n.options[optIndex] : '';
                            if (optionLabel) label = optionLabel;
                        }
                        if (n.type === 'LIST' && key.startsWith('row-')) {
                            const parts = key.split('-');
                            const sectionIdx = Number(parts[1]);
                            const rowIdx = Number(parts[2]);
                            const section = Array.isArray(n.sections) ? n.sections[sectionIdx] : null;
                            const row = section && Array.isArray(section.rows) ? section.rows[rowIdx] : null;
                            if (row?.title) label = row.title;
                        }
                        initialEdges.push({
                            id: `e-${n.id}-${key}-${targetId}`,
                            source: n.id,
                            target: targetId as string,
                            sourceHandle: key === 'default' ? 'default' : key,
                            className: 'stroke-[#00a884] stroke-2',
                            style: { strokeDasharray: '5,5' },
                            label,
                            labelStyle: { fill: '#8696a0', fontSize: 10, background: '#111b21', padding: 2 },
                            animated: true,
                        });
                    }
                });
            }
        });

        setNodes(initialNodes);
        setEdges(initialEdges);
    }, [flow?.id, flow?.nodes]);

    useEffect(() => {
        setNodes((nds) =>
            nds.map((node) => ({
                ...node,
                data: {
                    ...node.data,
                    availableTags: tagOptions,
                    variableOptions,
                    staffOptions,
                    workflowOptions,
                    templateOptions
                }
            }))
        );
    }, [setNodes, tagOptions, variableOptions, staffOptions, workflowOptions, templateOptions]);

    const handleNodeDataChange = useCallback((id: string, newData: any) => {
        setNodes((nds) =>
            nds.map((node) => {
                if (node.id === id) {
                    return { ...node, data: { ...node.data, ...newData } };
                }
                return node;
            })
        );
    }, []);

    const buildFlowPayload = useCallback((inputNodes: Node[], inputEdges: Edge[]) => {
        const updatedNodes = inputNodes.map((n) => {
            const nodeData = { ...n.data };
            delete nodeData.onChange;
            delete nodeData.onDelete;

            // Convert edges back to nextId/connections
            const sourceEdges = inputEdges.filter(e => e.source === n.id);

            if (n.type === 'QUESTION') {
                const connections: any = {};
                sourceEdges.forEach(e => {
                    if (e.sourceHandle) {
                        connections[e.sourceHandle] = e.target;
                    }
                });
                return { ...nodeData, type: n.type, position: n.position, connections };
            } else if (n.type === 'LIST') {
                const connections: any = {};
                sourceEdges.forEach(e => {
                    if (e.sourceHandle) connections[e.sourceHandle] = e.target;
                });
                return { ...nodeData, type: n.type, position: n.position, connections };
            } else if (n.type === 'CONDITION') {
                const connections: any = {};
                sourceEdges.forEach(e => {
                    if (e.sourceHandle) connections[e.sourceHandle] = e.target;
                });
                return { ...nodeData, type: n.type, position: n.position, connections };
            } else {
                const nextEdge = sourceEdges.find(e => !e.sourceHandle);
                return { ...nodeData, type: n.type, position: n.position, nextId: nextEdge?.target || '' };
            }
        });
        return { ...flow, nodes: updatedNodes };
    }, [flow]);

    const handleNodeDelete = useCallback((id: string) => {
        const nextNodes = nodesRef.current.filter((node) => node.id !== id);
        const nextEdges = edgesRef.current.filter((edge) => edge.source !== id && edge.target !== id);
        setNodes(nextNodes);
        setEdges(nextEdges);
        onSave(buildFlowPayload(nextNodes, nextEdges));
    }, [onSave, buildFlowPayload]);

    const onConnect = useCallback((params: Connection) => {
        setEdges((eds) => addEdge({
            ...params,
            animated: true,
            className: 'stroke-[#00a884] stroke-2'
        }, eds));
    }, []);

    const handleSave = useCallback(() => {
        onSave(buildFlowPayload(nodesRef.current, edgesRef.current));
    }, [onSave, buildFlowPayload]);

    const addNode = (type: string) => {
        const id = `node-${Date.now()}`;
        const newNode: Node = {
            id,
            type,
            position: { x: Math.random() * 400 + 100, y: Math.random() * 400 + 100 },
            data: {
                id,
                type,
                content: '',
                onChange: handleNodeDataChange,
                onDelete: handleNodeDelete,
                options: type === 'QUESTION' ? ['View Menu', 'Support'] : [],
                sections: type === 'LIST' ? [{ title: '', rows: [{ title: 'New option', description: '', id: '' }] }] : [],
                body: type === 'CTA_URL' ? 'Tap below to continue.' : (type === 'LIST' ? 'Please choose an option:' : ''),
                buttonText: type === 'CTA_URL' ? 'Open' : (type === 'LIST' ? 'View options' : ''),
                url: type === 'CTA_URL' ? 'https://example.com' : '',
                headerText: '',
                footerText: '',
                fallbackText: '',
                mediaType: type === 'IMAGE' ? 'image' : 'none',
                mediaUrl: '',
                mediaFilename: '',
                question: type === 'ASK' ? 'What is your answer?' : '',
                saveAs: type === 'ASK' ? '' : '',
                retryLimit: type === 'ASK' ? 3 : undefined,
                tags: type === 'TAG' ? [] : undefined,
                tagDraft: '',
                assigneeUserId: '',
                assigneeName: '',
                assigneeColor: '',
                targetWorkflowId: '',
                source: type === 'CONDITION' ? '' : '',
                operator: type === 'CONDITION' ? 'contains' : '',
                value: type === 'CONDITION' ? '' : '',
                templateName: '',
                templateLanguage: 'en_US',
                templateComponents: '',
                availableTags: tagOptions,
                variableOptions,
                staffOptions,
                workflowOptions,
                templateOptions
            },
        };
        setNodes((nds) => nds.concat(newNode));
    };

    return (
        <div className="flex-1 flex h-full bg-[#fcfdfd]">
            <aside className="w-64 bg-white border-r border-[#eceff1] flex flex-col">
                <div className="px-4 py-4 border-b border-[#eceff1]">
                    <span className="text-[#8696a0] text-[10px] font-black uppercase tracking-widest">Components</span>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3 space-y-2">
                    <button onClick={() => addNode('MESSAGE')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-blue-500" /> Send Message
                    </button>
                    <button onClick={() => addNode('ASK')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-violet-600" /> Ask Question
                    </button>
                    <button onClick={() => addNode('QUESTION')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-purple-500" /> Question
                    </button>
                    <button onClick={() => addNode('LIST')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <List className="w-4 h-4 text-sky-500" /> List
                    </button>
                    <button onClick={() => addNode('TEMPLATE')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <FileText className="w-4 h-4 text-cyan-600" /> Template
                    </button>
                    <button onClick={() => addNode('CONDITION')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <Activity className="w-4 h-4 text-yellow-500" /> Condition
                    </button>
                    <button onClick={() => addNode('TAG')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <Tags className="w-4 h-4 text-fuchsia-600" /> Tags
                    </button>
                    <button onClick={() => addNode('ASSIGN')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <UserCheck className="w-4 h-4 text-emerald-600" /> Assign
                    </button>
                    <button onClick={() => addNode('WORKFLOW_TRIGGER')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <GitBranchIcon className="w-4 h-4 text-indigo-600" /> Trigger
                    </button>
                    <button onClick={() => addNode('IMAGE')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <ImageIcon className="w-4 h-4 text-orange-500" /> Media
                    </button>
                    <button onClick={() => addNode('CTA_URL')} className="w-full px-3 py-2.5 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2">
                        <LinkIcon className="w-4 h-4 text-emerald-600" /> CTA URL
                    </button>
                    <button onClick={() => addNode('END')} className="w-full px-3 py-2.5 bg-white hover:bg-rose-50 text-rose-500 text-xs font-bold border border-rose-100 rounded-xl transition-all flex items-center gap-2">
                        <Square className="w-4 h-4" /> End
                    </button>
                </div>
                <div className="p-3 border-t border-[#eceff1]">
                    <button
                        onClick={handleSave}
                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white px-4 py-2.5 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-2 uppercase tracking-widest"
                    >
                        <Save className="w-4 h-4" /> Save
                    </button>
                </div>
            </aside>

            <div className="flex-1 relative">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    fitView
                    style={{ background: '#fcfdfd' }}
                    colorMode="light"
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#e2e8f0" />
                    <Controls className="bg-white border-[#eceff1] fill-[#111b21] shadow-xl rounded-xl" />
                    <MiniMap
                        nodeColor={(n) => {
                            if (n.type === 'START') return '#00a884';
                            if (n.type === 'END') return '#ef4444';
                            if (n.type === 'QUESTION') return '#a855f7';
                            if (n.type === 'ASK') return '#7c3aed';
                            if (n.type === 'CTA_URL') return '#10b981';
                            if (n.type === 'LIST') return '#0ea5e9';
                            if (n.type === 'CONDITION') return '#eab308';
                            if (n.type === 'TAG') return '#c026d3';
                            if (n.type === 'ASSIGN') return '#059669';
                            if (n.type === 'WORKFLOW_TRIGGER') return '#4f46e5';
                            if (n.type === 'TEMPLATE') return '#0891b2';
                            if (n.type === 'IMAGE') return '#f97316';
                            return '#3b82f6';
                        }}
                        maskColor="rgba(255, 255, 255, 0.6)"
                        className="bg-white border-[#eceff1] shadow-2xl rounded-2xl"
                    />
                </ReactFlow>
            </div>
        </div>
    );
}
