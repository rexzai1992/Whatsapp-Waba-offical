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
                <span className="font-black text-[10px] uppercase tracking-widest text-blue-500">Auto Message</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <textarea
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl p-3 text-xs h-24 resize-none focus:outline-none focus:border-blue-400 font-medium placeholder-[#aebac1]"
                value={props.data.content}
                onChange={(e) => props.data.onChange(props.id, { content: e.target.value })}
                placeholder="Type automated response..."
            />
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-blue-500 border-2 border-white" />
        </div>
    ),
    QUESTION: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-72 text-[#111b21] group hover:border-purple-500/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-purple-50 flex items-center justify-center text-purple-500">
                    <HelpCircle className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-purple-500">Step Prompt</span>
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
                <p className="text-[10px] text-[#54656f] uppercase font-black px-1 tracking-widest">Defined Responses</p>
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
                        onClick={() => props.data.onChange(props.id, { options: [...(props.data.options || []), 'New option'] })}
                        className="text-[10px] text-purple-500 font-bold px-3 py-2 border border-dashed border-purple-200 rounded-xl mt-1 bg-purple-50/50 hover:bg-purple-50 transition-all flex items-center justify-center gap-2"
                    >
                        <Plus className="w-3.5 h-3.5" /> Add Response
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
                                        const next = sections.map((s: any, idx: number) => {
                                            if (idx !== sIdx) return s;
                                            const rows = [...(s.rows || []), { title: 'New option', description: '', id: '' }];
                                            return { ...s, rows };
                                        });
                                        updateSections(next);
                                    }}
                                    className="text-[10px] text-sky-600 font-bold px-3 py-2 border border-dashed border-sky-200 rounded-xl bg-white/60 hover:bg-white transition-all flex items-center justify-center gap-2"
                                >
                                    <Plus className="w-3.5 h-3.5" /> Add Row
                                </button>
                            </div>
                        </div>
                    ))}
                    <button
                        onClick={() => updateSections([...sections, { title: '', rows: [{ title: 'New option', description: '', id: '' }] }])}
                        className="text-[10px] text-sky-600 font-bold px-3 py-2 border border-dashed border-sky-200 rounded-xl bg-sky-50/50 hover:bg-sky-50 transition-all flex items-center justify-center gap-2"
                    >
                        <Plus className="w-3.5 h-3.5" /> Add Section
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
                <span className="font-black text-[10px] uppercase tracking-widest text-orange-500">Asset Display</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <input
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-3 text-[10px] mb-3 focus:outline-none focus:border-orange-400 font-mono"
                value={props.data.imageUrl}
                onChange={(e) => props.data.onChange(props.id, { imageUrl: e.target.value })}
                placeholder="Image URL (Public)..."
            />
            <input
                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-3 text-[10px] focus:outline-none focus:border-orange-400 font-bold"
                value={props.data.caption}
                onChange={(e) => props.data.onChange(props.id, { caption: e.target.value })}
                placeholder="Message Caption..."
            />
            <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-orange-500 border-2 border-white" />
        </div>
    ),
    CONDITION: (props: any) => (
        <div className="bg-white border border-[#eceff1] p-5 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)] w-64 text-[#111b21] group hover:border-yellow-500/30 transition-all">
            <Handle type="target" position={Position.Top} className="w-3 h-3 bg-[#aebac1] border-2 border-white" />
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-yellow-50 flex items-center justify-center text-yellow-500">
                    <Activity className="w-4 h-4" />
                </div>
                <span className="font-black text-[10px] uppercase tracking-widest text-yellow-500">Decision</span>
                <button onClick={() => props.data.onDelete(props.id)} className="ml-auto opacity-0 group-hover:opacity-100 text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            <p className="text-[10px] text-[#54656f] mb-4 font-bold uppercase tracking-tight">Evaluate business logic</p>
            <div className="flex justify-between items-center px-4 py-3 bg-[#f8fae5] rounded-xl border border-yellow-200">
                <span className="text-[10px] text-[#854d0e] font-black uppercase tracking-widest">Confirmed</span>
                <Handle type="source" position={Position.Right} id="true" className="w-3 h-6 bg-[#06d755] rounded-full border-2 border-white" />
            </div>
            <div className="flex justify-between items-center px-4 py-3 bg-rose-50 rounded-xl border border-rose-100 mt-2">
                <span className="text-[10px] text-rose-700 font-black uppercase tracking-widest">Rejected</span>
                <Handle type="source" position={Position.Left} id="false" className="w-3 h-6 bg-rose-500 rounded-full border-2 border-white" />
            </div>
        </div>
    ),
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

export default function FlowCanvas({ flow, onSave }: { flow: any, onSave: (flow: any) => void }) {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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
                onDelete: handleNodeDelete
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

    const handleNodeDelete = useCallback((id: string) => {
        setNodes((nds) => nds.filter((node) => node.id !== id));
        setEdges((eds) => eds.filter((edge) => edge.source !== id && edge.target !== id));
    }, []);

    const onConnect = useCallback((params: Connection) => {
        setEdges((eds) => addEdge({
            ...params,
            animated: true,
            className: 'stroke-[#00a884] stroke-2'
        }, eds));
    }, []);

    const handleSave = () => {
        const updatedNodes = nodes.map((n) => {
            const nodeData = { ...n.data };
            delete nodeData.onChange;
            delete nodeData.onDelete;

            // Convert edges back to nextId/connections
            const sourceEdges = edges.filter(e => e.source === n.id);

            if (n.type === 'QUESTION') {
                const connections: any = {};
                sourceEdges.forEach(e => {
                    if (e.sourceHandle) {
                        if (e.sourceHandle.startsWith('opt-')) {
                            const optIndex = parseInt(e.sourceHandle.replace('opt-', ''));
                            const optLabel = (nodeData as any).options[optIndex];
                            if (optLabel) connections[optLabel] = e.target;
                        } else {
                            connections[e.sourceHandle] = e.target;
                        }
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

        onSave({ ...flow, nodes: updatedNodes });
    };

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
            },
        };
        setNodes((nds) => nds.concat(newNode));
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-[#fcfdfd]">
            <div className="h-16 bg-white border-b border-[#eceff1] flex items-center justify-between px-8 z-20 shadow-sm">
            <div className="flex items-center gap-3">
                <span className="text-[#aebac1] text-[10px] font-black uppercase tracking-widest mr-2">Components</span>
                <button onClick={() => addNode('MESSAGE')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                    <MessageSquare className="w-4 h-4 text-blue-500" /> Response
                </button>
                <button onClick={() => addNode('QUESTION')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                    <HelpCircle className="w-4 h-4 text-purple-500" /> Prompt
                </button>
                <button onClick={() => addNode('LIST')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                    <List className="w-4 h-4 text-sky-500" /> List
                </button>
                <button onClick={() => addNode('CONDITION')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                    <Activity className="w-4 h-4 text-yellow-500" /> Logic
                </button>
                    <button onClick={() => addNode('IMAGE')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                        <ImageIcon className="w-4 h-4 text-orange-500" /> Media
                    </button>
                    <button onClick={() => addNode('CTA_URL')} className="px-4 py-2 bg-white hover:bg-[#00a884]/5 text-[#111b21] text-xs font-bold border border-[#eceff1] rounded-xl transition-all flex items-center gap-2 shadow-sm">
                        <LinkIcon className="w-4 h-4 text-emerald-600" /> CTA URL
                    </button>
                    <button onClick={() => addNode('END')} className="px-4 py-2 bg-white hover:bg-rose-50 text-rose-500 text-xs font-bold border border-rose-100 rounded-xl transition-all flex items-center gap-2 shadow-sm">
                        <Square className="w-4 h-4" /> End
                    </button>
                </div>
                <button
                    onClick={handleSave}
                    className="bg-[#111b21] hover:bg-[#202c33] text-white px-6 py-2.5 rounded-2xl text-xs font-black shadow-lg transition-all flex items-center gap-3 uppercase tracking-widest"
                >
                    <Save className="w-4 h-4" /> Save
                </button>
            </div>

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
                            if (n.type === 'CTA_URL') return '#10b981';
                            if (n.type === 'LIST') return '#0ea5e9';
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
