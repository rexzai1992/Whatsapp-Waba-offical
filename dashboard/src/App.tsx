
import React, { Suspense, lazy, useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { List, useDynamicRowHeight, useListRef } from 'react-window';
import { io, Socket } from 'socket.io-client';
import {
    Search,
    MoreVertical,
    MessageSquare,
    FileText,
    File as FileIcon,
    Image as ImageIcon,
    Paperclip,
    Smile,
    Mic,
    Send,
    Check,
    CheckCheck,
    CircleDashed,
    Filter,
    User,
    ArrowLeft,
    Settings,
    Phone,
    Video,
    Shield,
    LogOut,
    Users,
    X,
    GitBranch,
    Play,
    Plus,
    Trash2,
    Save,

    Workflow,
    ShieldCheck,
    Bug,
    Bot
} from 'lucide-react';
import Login from './Login';
import DebugButton from './DebugButton';
import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';


const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
const SINGLE_PROFILE_MODE = true;
const ADMIN_PASS = 'admin123';

const LazyWebhookView = lazy(() => import('./WebhookView'));
const LazyBroadcastTemplateBuilder = lazy(() => import('./BroadcastTemplateBuilder'));
const LazyBroadcastTemplatesList = lazy(() => import('./BroadcastTemplatesList'));
const LazyFlowCanvas = lazy(() => import('./FlowCanvas'));

interface Message {
    key: {
        id: string;
        remoteJid: string;
        fromMe?: boolean;
    };
    status?: 'sent' | 'delivered' | 'read' | 'failed' | 'pending';
    message?: {
        conversation?: string;
        extendedTextMessage?: {
            text: string;
        };
        buttonsMessage?: {
            contentText?: string;
            footerText?: string;
            buttons?: Array<{
                buttonId?: string;
                buttonText?: {
                    displayText?: string;
                };
            }>;
        };
        listMessage?: {
            title?: string;
            description?: string;
            buttonText?: string;
            footerText?: string;
            sections?: Array<{
                title?: string;
                rows?: Array<{
                    rowId?: string;
                    title?: string;
                    description?: string;
                }>;
            }>;
        };
        imageMessage?: any;
        documentMessage?: any;
        audioMessage?: any;
        videoMessage?: any;
    };
    agent?: {
        user_id?: string;
        name?: string;
        color?: string;
    } | null;
    pushName?: string;
    messageTimestamp?: number;
    workflowState?: any | null;
}

interface Chat {
    id: string;
    name: string;
    lastMessage?: string;
    timestamp?: number;
    unreadCount: number;
}

interface MediaData {
    data: string;
    mimetype: string;
}

interface QuickReply {
    id?: string;
    shortcut: string;
    text: string;
}

type TeamUserLite = {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'agent';
    color: string;
};

type LogEntry = {
    id: string;
    ts: number;
    level: 'info' | 'error';
    message: string;
};

type ServerStats = {
    cpu?: number;
    memUsed?: number;
    memTotal?: number;
    memPct?: number;
    bandwidth?: {
        inBps?: number;
        outBps?: number;
        inBytes?: number;
        outBytes?: number;
    };
    timestamp?: number;
};

type ContactMeta = {
    name?: string;
    lastInboundAt?: string | null;
    tags?: string[];
    assigneeUserId?: string | null;
    assigneeName?: string | null;
    assigneeColor?: string | null;
    ctaReferralAt?: string | null;
    ctaFreeWindowStartedAt?: string | null;
    ctaFreeWindowExpiresAt?: string | null;
};

type MessageVirtualRow =
    | { kind: 'date'; id: string; label: string }
    | { kind: 'message'; id: string; msg: Message };

const CHAT_ROW_HEIGHT = 86;
const MESSAGE_DRAFT_STORAGE_PREFIX = 'draftMessage:';

const useElementSize = <T extends HTMLElement>() => {
    const [node, setNode] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const ref = useCallback((el: T | null) => {
        setNode(el);
    }, []);

    useLayoutEffect(() => {
        if (!node) return;

        const update = () => {
            setSize({
                width: node.clientWidth,
                height: node.clientHeight
            });
        };

        update();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }

        const observer = new ResizeObserver(() => update());
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);

    return { ref, size };
};

const getCleanId = (jid: string | undefined): string => {
    if (!jid) return '';
    // Remove any @... suffix and any :device suffix
    const clean = jid.split('@')[0].split(':')[0];
    return clean;
};

const formatPhoneNumber = (id: string): string => {
    if (!id) return id;
    // If it's a long LID (usually 14-16 digits starting with 1 or 2),
    // we can't easily format it as a PN, but we can at least make it look cleaner.
    if (id.length > 13) return id;

    // Attempt basic formatting for apparent phone numbers
    if (/^\d+$/.test(id)) {
        if (id.startsWith('60') && id.length >= 11) { // Malaysia
            return `+${id.slice(0, 2)} ${id.slice(2, 4)}-${id.slice(4, 8)} ${id.slice(8)}`;
        }
        if (id.startsWith('62') && id.length >= 11) { // Indonesia
            return `+${id.slice(0, 2)} ${id.slice(2, 5)}-${id.slice(5, 9)}-${id.slice(9)}`;
        }
        return `+${id}`;
    }
    return id;
};

const isPhoneLikeName = (name: string, jid?: string): boolean => {
    if (!name) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    const cleanJid = getCleanId(jid);
    const digitsOnly = trimmed.replace(/\D/g, '');
    const jidDigits = cleanJid.replace(/\D/g, '');
    if (jidDigits && digitsOnly === jidDigits) return true;
    if (/^\+?\d[\d\s-]{5,}$/.test(trimmed)) return true;
    return false;
};

const pickContactName = (incoming: string, prev?: string, jid?: string): string => {
    const incomingTrimmed = (incoming || '').trim();
    const prevTrimmed = (prev || '').trim();
    if (!incomingTrimmed) return prevTrimmed;
    if (prevTrimmed && !isPhoneLikeName(prevTrimmed, jid) && isPhoneLikeName(incomingTrimmed, jid)) {
        return prevTrimmed;
    }
    return incomingTrimmed;
};

const getInitials = (name?: string | null): string => {
    const value = (name || '').trim();
    if (!value) return '?';
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
};

const withHexAlpha = (color?: string | null, alpha = '22', fallback = '#e5e7eb'): string => {
    const value = (color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return `${value}${alpha}`;
    return fallback;
};

const textColor = (color?: string | null, fallback = '#374151'): string => {
    const value = (color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    return fallback;
};


const formatBytes = (value?: number): string => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Math.max(0, value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

const formatBps = (value?: number): string => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '--';
    return `${formatBytes(value)}/s`;
};

const redactSecret = (value?: string | null, visibleStart = 6, visibleEnd = 4): string | null => {
    if (!value) return null;
    const str = String(value);
    if (str.length <= visibleStart + visibleEnd + 3) return `${str} (len ${str.length})`;
    return `${str.slice(0, visibleStart)}…${str.slice(-visibleEnd)} (len ${str.length})`;
};

const getLastInboundTs = (
    messages: Message[],
    chatId: string | null,
    contacts: Record<string, ContactMeta>
): number | null => {
    if (!chatId) return null;
    let latestSeconds = 0;
    messages.forEach(msg => {
        if (msg.key?.remoteJid === chatId && !msg.key?.fromMe && msg.messageTimestamp) {
            if (msg.messageTimestamp > latestSeconds) latestSeconds = msg.messageTimestamp;
        }
    });

    const contactInbound = contacts?.[chatId]?.lastInboundAt;
    if (contactInbound) {
        const inboundMs = new Date(contactInbound).getTime();
        if (!Number.isNaN(inboundMs)) {
            const inboundSeconds = Math.floor(inboundMs / 1000);
            if (inboundSeconds > latestSeconds) latestSeconds = inboundSeconds;
        }
    }

    return latestSeconds ? latestSeconds * 1000 : null;
};

const formatRemaining = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
};

const formatDateLabel = (ms: number) => {
    if (!ms) return '';
    const date = new Date(ms);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const dateKey = date.toDateString();
    if (dateKey === today.toDateString()) return 'Today';
    if (dateKey === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const getMessagePreviewText = (msg: Message): string => {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsMessage?.contentText ||
        msg.message?.listMessage?.description ||
        ''
    );
};

const formatLogTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const renderMessageStatus = (msg: Message) => {
    if (!msg.key?.fromMe) return null;
    const status = msg.status;
    if (status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />;
    if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-[#7a8a97]" />;
    if (status === 'failed') return <X className="w-3.5 h-3.5 text-[#d93025]" />;
    if (status === 'pending') return <CircleDashed className="w-3.5 h-3.5 text-[#7a8a97]" />;
    return <Check className="w-3.5 h-3.5 text-[#7a8a97]" />;
};

const BUILDER_ACTION_NODE_TYPES = new Set(['MESSAGE', 'QUESTION', 'LIST', 'IMAGE', 'END', 'CTA_URL']);
const SUPPORTED_ACTION_TYPES = new Set(['send_text', 'send_buttons', 'send_list', 'send_cta_url', 'end_flow']);

const slugifyButtonId = (label: string, index: number) => {
    const base = (label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || `option_${index + 1}`;
};

const getNodeNextIds = (node: any) => {
    if (!node) return [];
    if (node.type === 'QUESTION' || node.type === 'LIST' || node.type === 'CONDITION') {
        return Object.values(node.connections || {}).filter(Boolean) as string[];
    }
    if (node.nextId) return [node.nextId];
    return [];
};

const pickFallbackNextId = (node: any) => {
    if (!node) return '';
    if (node.nextId) return node.nextId;
    const connections = node.connections || {};
    return connections.default || connections.true || connections.false || Object.values(connections)[0] || '';
};

const buildActionsFromBuilder = (builder: any) => {
    const nodes = Array.isArray(builder?.nodes) ? builder.nodes : [];
    if (!nodes.length) return { actions: [], warnings: [] as string[] };

    const nodesById: Record<string, any> = {};
    nodes.forEach((node: any) => {
        if (node?.id) nodesById[node.id] = node;
    });

    const startNode = nodes.find((node: any) => node.type === 'START');
    const startId = startNode?.nextId || startNode?.id || nodes[0]?.id;

    const ordered: string[] = [];
    const visited = new Set<string>();

    const visit = (nodeId?: string) => {
        if (!nodeId || visited.has(nodeId)) return;
        visited.add(nodeId);
        ordered.push(nodeId);
        const node = nodesById[nodeId];
        if (!node) return;
        const nextIds = getNodeNextIds(node);
        nextIds.forEach(visit);
    };

    if (startId) visit(startId);

    const actions: any[] = [];
    const indexByNode: Record<string, number> = {};
    const pendingQuestions: Array<{ node: any; nodeId: string; actionIndex: number; buttons: Array<{ id: string; title: string }> }> = [];
    const pendingLists: Array<{ node: any; nodeId: string; actionIndex: number; rows: Array<{ id: string; title: string; handleId: string }> }> = [];
    const warnings: string[] = [];

    ordered.forEach((nodeId) => {
        const node = nodesById[nodeId];
        if (!node || !BUILDER_ACTION_NODE_TYPES.has(node.type)) return;

        if (node.type === 'MESSAGE') {
            const actionIndex = actions.length;
            actions.push({ type: 'send_text', text: node.content || '' });
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'QUESTION') {
            const options = Array.isArray(node.options) ? node.options : [];
            const buttons = options.map((opt: string, idx: number) => ({
                id: slugifyButtonId(opt, idx),
                title: opt || `Option ${idx + 1}`
            }));
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_buttons',
                text: node.content || '',
                buttons
            };
            if (node.fallbackText) {
                action.fallback_text = node.fallbackText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            pendingQuestions.push({ node, nodeId, actionIndex, buttons });
            return;
        }

        if (node.type === 'LIST') {
            const sections = Array.isArray(node.sections) ? node.sections : [];
            const normalizedSections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> = [];
            const rowsMeta: Array<{ id: string; title: string; handleId: string }> = [];
            let globalRowIndex = 0;

            sections.forEach((section: any, sectionIdx: number) => {
                const title = section?.title || '';
                const rows = Array.isArray(section?.rows) ? section.rows : [];
                const normalizedRows = rows.map((row: any, rowIdx: number) => {
                    const rowTitle = row?.title || `Option ${globalRowIndex + 1}`;
                    let rowId = row?.id || slugifyButtonId(rowTitle, globalRowIndex);
                    if (!rowId) rowId = `option_${globalRowIndex + 1}`;
                    const handleId = `row-${sectionIdx}-${rowIdx}`;
                    rowsMeta.push({ id: rowId, title: rowTitle, handleId });
                    globalRowIndex += 1;
                    return {
                        id: rowId,
                        title: rowTitle,
                        ...(row?.description ? { description: row.description } : {})
                    };
                });
                normalizedSections.push({
                    ...(title ? { title } : {}),
                    rows: normalizedRows
                });
            });

            const actionIndex = actions.length;
            const action: any = {
                type: 'send_list',
                text: node.body || node.content || '',
                button_text: node.buttonText || node.button_text || node.button || 'View options',
                sections: normalizedSections
            };
            if (node.headerText) {
                action.header = { type: 'text', text: node.headerText };
            }
            if (node.footerText) {
                action.footer = node.footerText;
            }
            if (node.fallbackText) {
                action.fallback_text = node.fallbackText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            pendingLists.push({ node, nodeId, actionIndex, rows: rowsMeta });
            return;
        }

        if (node.type === 'CTA_URL') {
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_cta_url',
                body: node.body || '',
                button_text: node.buttonText || 'Open',
                url: node.url || ''
            };
            if (node.headerText) {
                action.header = { type: 'text', text: node.headerText };
            }
            if (node.footerText) {
                action.footer = node.footerText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'IMAGE') {
            const actionIndex = actions.length;
            const caption = node.caption || '';
            const url = node.imageUrl || '';
            const text = caption && url ? `${caption}\n${url}` : caption || url;
            actions.push({ type: 'send_text', text });
            indexByNode[nodeId] = actionIndex;
            warnings.push(`Image node ${nodeId} converted to send_text (no media support in workflow actions).`);
            return;
        }

        if (node.type === 'END') {
            const actionIndex = actions.length;
            if (node.content) {
                actions.push({ type: 'send_text', text: node.content });
                actions.push({ type: 'end_flow' });
                indexByNode[nodeId] = actionIndex;
            } else {
                actions.push({ type: 'end_flow' });
                indexByNode[nodeId] = actionIndex;
            }
            return;
        }
    });

    const resolveActionIndex = (targetId?: string) => {
        let current = targetId;
        const guard = new Set<string>();
        while (current) {
            if (indexByNode[current] !== undefined) return indexByNode[current];
            if (guard.has(current)) return undefined;
            guard.add(current);
            const node = nodesById[current];
            if (!node) return undefined;
            current = pickFallbackNextId(node);
        }
        return undefined;
    };

    pendingQuestions.forEach(({ node, actionIndex, buttons }) => {
        const routes: Record<string, number> = {};
        buttons.forEach((button, idx) => {
            const optionLabel = Array.isArray(node.options) ? node.options[idx] : button.title;
            const targetId = node.connections?.[optionLabel];
            const resolvedIndex = resolveActionIndex(targetId);
            if (resolvedIndex !== undefined) {
                routes[button.id] = resolvedIndex;
            } else if (actionIndex + 1 < actions.length) {
                routes[button.id] = actionIndex + 1;
            }
        });
        if (Object.keys(routes).length > 0) {
            (actions[actionIndex] as any).routes = routes;
        }
    });

    pendingLists.forEach(({ node, actionIndex, rows }) => {
        const routes: Record<string, number> = {};
        rows.forEach((row) => {
            const targetId = node.connections?.[row.handleId];
            const resolvedIndex = resolveActionIndex(targetId);
            if (resolvedIndex !== undefined) {
                routes[row.id] = resolvedIndex;
            } else if (actionIndex + 1 < actions.length) {
                routes[row.id] = actionIndex + 1;
            }
        });
        if (Object.keys(routes).length > 0) {
            (actions[actionIndex] as any).routes = routes;
        }
    });

    ordered.forEach((nodeId) => {
        const node = nodesById[nodeId];
        if (!node || node.type !== 'MESSAGE') return;
        const actionIndex = indexByNode[nodeId];
        if (actionIndex === undefined) return;
        const resolvedIndex = resolveActionIndex(node.nextId);
        if (resolvedIndex !== undefined && resolvedIndex !== actionIndex) {
            (actions[actionIndex] as any).next_step = resolvedIndex;
        }
    });

    return { actions, warnings };
};

const buildBuilderFromActions = (actions: any[], workflowId: string) => {
    const nodes: any[] = [];
    const startId = `node-start-${workflowId}`;
    nodes.push({
        id: startId,
        type: 'START',
        position: { x: 120, y: 80 },
        nextId: ''
    });

    const indexToNodeId: Record<number, string> = {};
    const nodeByActionIndex: Record<number, any> = {};
    let lastId = startId;
    let y = 220;

    actions.forEach((action: any, idx: number) => {
        if (!SUPPORTED_ACTION_TYPES.has(action?.type)) return;
        const nodeId = `node-${workflowId}-${idx}`;
        const base: any = {
            id: nodeId,
            position: { x: 120, y },
            nextId: ''
        };

        if (action.type === 'send_text') {
            base.type = 'MESSAGE';
            base.content = action.text || '';
        } else if (action.type === 'send_buttons') {
            base.type = 'QUESTION';
            base.content = action.text || '';
            base.options = Array.isArray(action.buttons)
                ? action.buttons.map((b: any) => b.title || b.id)
                : [];
            base.fallbackText = action.fallback_text || action.fallback || '';
        } else if (action.type === 'send_list') {
            base.type = 'LIST';
            base.body = action.text || action.body || '';
            base.buttonText = action.button_text || action.buttonText || action.button || 'View options';
            base.headerText = action.header?.text || '';
            base.footerText = action.footer || '';
            base.sections = Array.isArray(action.sections) ? action.sections : [];
            base.fallbackText = action.fallback_text || action.fallback || '';
        } else if (action.type === 'send_cta_url') {
            base.type = 'CTA_URL';
            base.body = action.body || '';
            base.buttonText = action.button_text || '';
            base.url = action.url || '';
            base.headerText = action.header?.text || '';
            base.footerText = action.footer || '';
        } else if (action.type === 'end_flow') {
            base.type = 'END';
            base.content = '';
        } else {
            return;
        }

        const prevNode = nodes.find(n => n.id === lastId);
        if (prevNode) prevNode.nextId = nodeId;

        nodes.push(base);
        indexToNodeId[idx] = nodeId;
        nodeByActionIndex[idx] = base;
        lastId = nodeId;
        y += 180;
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (node.type !== 'QUESTION' || !action) return;
        const connections: Record<string, string> = {};
        const buttons = Array.isArray(action.buttons) ? action.buttons : [];
        buttons.forEach((button: any, btnIdx: number) => {
            const route = action.routes?.[button.id];
            let targetIndex: number | undefined;
            if (typeof route === 'number') {
                targetIndex = route;
            } else if (route && route.next_step !== undefined) {
                targetIndex = route.next_step;
            } else {
                targetIndex = idx + 1;
            }
            if (targetIndex === undefined) return;
            const targetNodeId = indexToNodeId[targetIndex];
            if (targetNodeId) {
                connections[node.options?.[btnIdx] || button.title || `Option ${btnIdx + 1}`] = targetNodeId;
            }
        });
        if (Object.keys(connections).length > 0) {
            node.connections = connections;
        }
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (node.type !== 'LIST' || !action) return;
        const connections: Record<string, string> = {};
        const sections = Array.isArray(node.sections) ? node.sections : [];
        sections.forEach((section: any, sectionIdx: number) => {
            const rows = Array.isArray(section?.rows) ? section.rows : [];
            rows.forEach((row: any, rowIdx: number) => {
                const rowId = row?.id;
                if (!rowId) return;
                const route = action.routes?.[rowId];
                let targetIndex: number | undefined;
                if (typeof route === 'number') {
                    targetIndex = route;
                } else if (route && route.next_step !== undefined) {
                    targetIndex = route.next_step;
                } else {
                    targetIndex = idx + 1;
                }
                if (targetIndex === undefined) return;
                const targetNodeId = indexToNodeId[targetIndex];
                if (targetNodeId) {
                    const handleId = `row-${sectionIdx}-${rowIdx}`;
                    connections[handleId] = targetNodeId;
                }
            });
        });
        if (Object.keys(connections).length > 0) {
            node.connections = connections;
        }
    });

    return { id: workflowId, nodes };
};

export default function App() {
    // Auth State
    const [session, setSession] = useState<Session | null>(null);
    const [authChecking, setAuthChecking] = useState(true);

    const [socket, setSocket] = useState<Socket | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'close'>('connecting');
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [contacts, setContacts] = useState<Record<string, ContactMeta>>({});
    const [selectedChatId, setSelectedChatId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            return window.localStorage.getItem('lastChatId');
        } catch {
            return null;
        }
    });
    const [messageText, setMessageText] = useState('');
    const [templateName, setTemplateName] = useState('');
    const [templateLanguage, setTemplateLanguage] = useState('en_US');
    const [templateComponents, setTemplateComponents] = useState('');
    const [startWorkflowId, setStartWorkflowId] = useState('');
    const [startingWorkflow, setStartingWorkflow] = useState(false);
    const [showWorkflowStarter, setShowWorkflowStarter] = useState(false);
    const [showTemplateComposer, setShowTemplateComposer] = useState(false);
    const [forceTemplateMode, setForceTemplateMode] = useState(false);
    const [lastProfileError, setLastProfileError] = useState<string | null>(null);
    const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
    const [logOpen, setLogOpen] = useState(false);
    const [loadingChats, setLoadingChats] = useState(false);
    const [serverStats, setServerStats] = useState<ServerStats | null>(null);
    const [contactDraftName, setContactDraftName] = useState('');
    const [contactTagsDraft, setContactTagsDraft] = useState<string[]>([]);
    const [contactTagInput, setContactTagInput] = useState('');
    const [contactDirty, setContactDirty] = useState(false);
    const [showAnalytics, setShowAnalytics] = useState(false);
    const [analyticsStart, setAnalyticsStart] = useState(() => {
        const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 10);
    });
    const [analyticsEnd, setAnalyticsEnd] = useState(() => new Date().toISOString().slice(0, 10));
    const [analyticsTag, setAnalyticsTag] = useState('');
    const [analyticsData, setAnalyticsData] = useState<any | null>(null);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);
    const [analyticsError, setAnalyticsError] = useState<string | null>(null);
    const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
    const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
    const [quickRepliesSaving, setQuickRepliesSaving] = useState(false);
    const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [contactsSearchQuery, setContactsSearchQuery] = useState('');
    const [teamUsers, setTeamUsers] = useState<TeamUserLite[]>([]);
    const [teamUsersLoading, setTeamUsersLoading] = useState(false);
    const [assignMenuContactId, setAssignMenuContactId] = useState<string | null>(null);
    const [assigningContactId, setAssigningContactId] = useState<string | null>(null);
    const [mediaCache, setMediaCache] = useState<Record<string, MediaData>>({});
    const [showContactInfo, setShowContactInfo] = useState(false);
    const [showNewChatModal, setShowNewChatModal] = useState(false);
    const [newPhoneNumber, setNewPhoneNumber] = useState('');
    const [showMenu, setShowMenu] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [isOffline, setIsOffline] = useState(() => {
        if (typeof window === 'undefined') return false;
        return !window.navigator.onLine;
    });

    const [activeView, setActiveView] = useState<'dashboard' | 'chatflow' | 'settings' | 'admin'>('dashboard');
    const [workspaceSection, setWorkspaceSection] = useState<
        'team-inbox' | 'broadcast' | 'chatbots' | 'contacts' | 'ads' | 'automations' | 'more'
    >('team-inbox');
    const [broadcastSection, setBroadcastSection] = useState<
        'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts'
    >('template-library');
    const [isAdmin, setIsAdmin] = useState(false);
    const [profiles, setProfiles] = useState<any[]>([]);
    const [profilesLoaded, setProfilesLoaded] = useState(false);

    const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            return window.localStorage.getItem('lastActiveProfileId');
        } catch {
            return null;
        }
    });
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [showAddProfileModal, setShowAddProfileModal] = useState(false);
    const [showEditProfileModal, setShowEditProfileModal] = useState(false);
    const [newProfileName, setNewProfileName] = useState('');
    const [editingProfileId, setEditingProfileId] = useState('');
    const [editingProfileName, setEditingProfileName] = useState('');
    const [isCreatingProfile, setIsCreatingProfile] = useState(false);
    const [workflows, setWorkflows] = useState<any[]>([]);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
    const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, string>>({});
    const [workflowEditorMode, setWorkflowEditorMode] = useState<'visual' | 'json'>('visual');
    const menuRef = useRef<HTMLDivElement>(null);
    const profileMenuRef = useRef<HTMLDivElement>(null);
    const messageInputRef = useRef<HTMLInputElement>(null);
    const activeProfileIdRef = useRef<string | null>(null);
    const lastRecoverAtRef = useRef(0);
    const lastInboundRef = useRef<number | null>(null);
    const requestedMediaRef = useRef<Set<string>>(new Set());
    const { ref: chatListViewportRef, size: chatListViewport } = useElementSize<HTMLDivElement>();
    const { ref: messageViewportRef, size: messageViewport } = useElementSize<HTMLDivElement>();
    const messageListRef = useListRef(null);
    const messageRowHeight = useDynamicRowHeight({
        defaultRowHeight: 120,
        key: selectedChatId || 'all'
    });

    const settingsNav = [
        {
            group: 'Onboarding',
            items: [
                { id: 'settings-connect', label: 'Connect WhatsApp' },
                { id: 'settings-manual', label: 'Manual Setup' },
                { id: 'settings-register', label: 'Register Number' }
            ]
        },
        {
            group: 'Connectivity',
            items: [
                { id: 'settings-webhooks', label: 'Outgoing Webhooks' }
            ]
        },
        {
            group: 'Automation',
            items: [
                { id: 'settings-conversational', label: 'Conversational Components' },
                { id: 'settings-reminder', label: '24h Window Reminder' },
                { id: 'settings-fallback', label: 'Fallback Message' },
                { id: 'settings-quick-replies', label: 'Quick Replies' }
            ]
        },
        {
            group: 'Workspace',
            items: [
                { id: 'settings-team-users', label: 'Team Users' }
            ]
        },
        ...(isAdmin ? [{
            group: 'Admin',
            items: [
                { id: 'settings-connected-clients', label: 'Connected Clients' },
                { id: 'settings-connected-businesses', label: 'Connected Businesses' }
            ]
        }] : [])
    ];

    const scrollToSettingsSection = (id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    const pushLog = useCallback((message: string, level: 'info' | 'error' = 'error') => {
        if (!message) return;
        setLogEntries(prev => {
            const next = [
                ...prev,
                {
                    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    ts: Date.now(),
                    level,
                    message
                }
            ];
            return next.slice(-200);
        });
    }, []);

    const getDraftStorageKey = useCallback((profileId?: string | null, chatId?: string | null) => {
        if (!profileId || !chatId) return null;
        return `${MESSAGE_DRAFT_STORAGE_PREFIX}${profileId}:${chatId}`;
    }, []);

    const persistDraft = useCallback(
        (value: string, profileId?: string | null, chatId?: string | null) => {
            const key = getDraftStorageKey(profileId, chatId);
            if (!key) return;
            try {
                const trimmed = value || '';
                if (trimmed.length === 0) {
                    window.localStorage.removeItem(key);
                } else {
                    window.localStorage.setItem(key, trimmed);
                }
            } catch {
                // ignore storage errors
            }
        },
        [getDraftStorageKey]
    );

    const clearAllDrafts = useCallback(() => {
        try {
            const keysToDelete: string[] = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith(MESSAGE_DRAFT_STORAGE_PREFIX)) {
                    keysToDelete.push(key);
                }
            }
            keysToDelete.forEach((key) => window.localStorage.removeItem(key));
        } catch {
            // ignore storage errors
        }
    }, []);

    const setMessageTextWithDraft = useCallback(
        (value: string) => {
            setMessageText(value);
            persistDraft(value, activeProfileIdRef.current, selectedChatId);
        },
        [persistDraft, selectedChatId]
    );

    const fetchTeamUsers = useCallback(async () => {
        if (!session?.access_token) return;
        setTeamUsersLoading(true);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load team users');
            }
            const users = Array.isArray(data?.data?.users) ? data.data.users : [];
            setTeamUsers(
                users.map((user: any) => ({
                    id: String(user.id || ''),
                    name: String(user.name || user.email || user.id || 'Agent'),
                    role: (String(user.role || 'agent').toLowerCase() as TeamUserLite['role']),
                    color: String(user.color || '#6b7280')
                })).filter((user: TeamUserLite) => Boolean(user.id))
            );
        } catch (err) {
            console.error('Failed to load team users:', err);
            setTeamUsers([]);
        } finally {
            setTeamUsersLoading(false);
        }
    }, [session?.access_token]);

    const handleAssignContact = useCallback(
        async (jid: string, assigneeUserId: string | null) => {
            if (!socket || !activeProfileId || !jid || jid.endsWith('@g.us')) return;
            setAssigningContactId(jid);
            try {
                const response: any = await new Promise((resolve) => {
                    const timeout = window.setTimeout(() => {
                        resolve({ success: false, error: 'Assignment timed out. Please try again.' });
                    }, 8000);
                    socket.emit(
                        'contact.assign',
                        {
                            profileId: activeProfileId,
                            jid,
                            assigneeUserId
                        },
                        (ack: any) => {
                            window.clearTimeout(timeout);
                            resolve(ack);
                        }
                    );
                });

                if (!response?.success) {
                    throw new Error(response?.error || 'Failed to assign contact');
                }

                const contact = response?.data?.contact;
                if (contact?.id) {
                    setContacts(prev => ({
                        ...prev,
                        [contact.id]: {
                            ...(prev[contact.id] || {}),
                            name: contact.name || prev[contact.id]?.name || getCleanId(contact.id),
                            lastInboundAt: contact.lastInboundAt ?? prev[contact.id]?.lastInboundAt ?? null,
                            tags: Array.isArray(contact.tags) ? contact.tags : (prev[contact.id]?.tags || []),
                            assigneeUserId: contact.assigneeUserId ?? null,
                            assigneeName: contact.assigneeName ?? null,
                            assigneeColor: contact.assigneeColor ?? null,
                            ctaReferralAt: contact.ctaReferralAt ?? prev[contact.id]?.ctaReferralAt ?? null,
                            ctaFreeWindowStartedAt: contact.ctaFreeWindowStartedAt ?? prev[contact.id]?.ctaFreeWindowStartedAt ?? null,
                            ctaFreeWindowExpiresAt: contact.ctaFreeWindowExpiresAt ?? prev[contact.id]?.ctaFreeWindowExpiresAt ?? null
                        }
                    }));
                }
            } catch (err: any) {
                alert(err?.message || 'Failed to assign contact');
            } finally {
                setAssigningContactId(null);
                setAssignMenuContactId(null);
            }
        },
        [socket, activeProfileId]
    );

    const recoverSocketConnection = useCallback(
        (reason: string) => {
            const nowMs = Date.now();
            if (nowMs - lastRecoverAtRef.current < 30_000) return;
            lastRecoverAtRef.current = nowMs;
            pushLog(reason, 'error');
            setConnectionStatus('connecting');
            if (!socket) return;
            try {
                if (socket.connected) socket.disconnect();
                socket.connect();
            } catch (err: any) {
                pushLog(`Reconnect failed: ${err?.message || err}`, 'error');
            }
        },
        [pushLog, socket]
    );

    const fetchAnalytics = useCallback(() => {
        if (!activeProfileId) return;
        setAnalyticsLoading(true);
        setAnalyticsError(null);
        const params = new URLSearchParams({
            profileId: activeProfileId,
            start: analyticsStart,
            end: analyticsEnd
        });
        if (analyticsTag.trim()) params.set('tag', analyticsTag.trim());
        fetch(`${SOCKET_URL}/api/analytics?${params.toString()}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Analytics fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setAnalyticsData(data.data || null);
                } else {
                    setAnalyticsError(data?.error || 'Failed to load analytics');
                }
            })
            .catch((err) => {
                setAnalyticsError(err?.message || 'Failed to load analytics');
            })
            .finally(() => setAnalyticsLoading(false));
    }, [activeProfileId, analyticsStart, analyticsEnd, analyticsTag]);

    const normalizeQuickReplyShortcut = useCallback((value: string) => {
        if (!value) return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        const withoutSlash = trimmed.replace(/^\/+/, '');
        const token = withoutSlash.split(/\s+/)[0];
        return token.toLowerCase();
    }, []);

    const fetchQuickReplies = useCallback(() => {
        if (!activeProfileId) return;
        setQuickRepliesLoading(true);
        setQuickRepliesError(null);
        fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}&adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Quick replies fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setQuickReplies(Array.isArray(data.data) ? data.data : []);
                } else if (data?.error) {
                    setQuickRepliesError(data.error);
                }
            })
            .catch((err) => {
                setQuickRepliesError(err?.message || 'Failed to load quick replies');
            })
            .finally(() => setQuickRepliesLoading(false));
    }, [activeProfileId]);

    const saveQuickReplies = useCallback(async (items: QuickReply[]) => {
        if (!activeProfileId) return;
        setQuickRepliesSaving(true);
        setQuickRepliesError(null);

        const seen = new Set<string>();
        const cleaned: Array<{ shortcut: string; text: string }> = [];

        for (const item of items) {
            const shortcut = normalizeQuickReplyShortcut(item.shortcut);
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            if (!shortcut || !text) continue;
            if (seen.has(shortcut)) {
                setQuickRepliesError(`Duplicate shortcut: /${shortcut}`);
                setQuickRepliesSaving(false);
                return;
            }
            seen.add(shortcut);
            cleaned.push({ shortcut, text });
        }

        try {
            const res = await fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}&adminPassword=${ADMIN_PASS}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: cleaned })
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = JSON.parse(text);
            } catch {
                console.error('Quick replies save failed:', text);
            }
            if (!res.ok || !data?.success) {
                setQuickRepliesError(data?.error || 'Failed to save quick replies');
                return;
            }
            setQuickReplies(Array.isArray(data.data) ? data.data : []);
        } catch (err: any) {
            setQuickRepliesError(err?.message || 'Failed to save quick replies');
        } finally {
            setQuickRepliesSaving(false);
        }
    }, [activeProfileId, normalizeQuickReplyShortcut]);

    useEffect(() => {
        activeProfileIdRef.current = activeProfileId;
    }, [activeProfileId]);

    useEffect(() => {
        try {
            if (activeProfileId) {
                window.localStorage.setItem('lastActiveProfileId', activeProfileId);
            } else {
                window.localStorage.removeItem('lastActiveProfileId');
            }
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId]);

    useEffect(() => {
        if (!activeProfileId) {
            setQuickReplies([]);
            return;
        }
        fetchQuickReplies();
    }, [activeProfileId, fetchQuickReplies]);


    useEffect(() => {
        if (!activeProfileId) return;
        try {
            const stored = window.localStorage.getItem(`lastChatId:${activeProfileId}`);
            if (stored && !selectedChatId) {
                setSelectedChatId(stored);
            }
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId, selectedChatId]);

    useEffect(() => {
        if (!activeProfileId || !selectedChatId) {
            setMessageText('');
            return;
        }
        try {
            const key = getDraftStorageKey(activeProfileId, selectedChatId);
            if (!key) {
                setMessageText('');
                return;
            }
            const storedDraft = window.localStorage.getItem(key);
            setMessageText(storedDraft || '');
        } catch {
            setMessageText('');
        }
    }, [activeProfileId, selectedChatId, getDraftStorageKey]);

    useEffect(() => {
        if (!activeProfileId || !selectedChatId) return;
        try {
            window.localStorage.setItem(`lastChatId:${activeProfileId}`, selectedChatId);
            window.localStorage.setItem('lastChatId', selectedChatId);
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId, selectedChatId]);

    useEffect(() => {
        setShowWorkflowStarter(false);
    }, [selectedChatId, activeProfileId]);

    useEffect(() => {
        if (!selectedChatId) return;
        const contact = contacts[selectedChatId];
        setContactDraftName(contact?.name || getCleanId(selectedChatId));
        setContactTagsDraft(Array.isArray(contact?.tags) ? contact!.tags! : []);
        setContactTagInput('');
        setContactDirty(false);
    }, [selectedChatId]);

    useEffect(() => {
        if (!selectedChatId || contactDirty) return;
        const contact = contacts[selectedChatId];
        if (!contact) return;
        setContactDraftName(contact.name || getCleanId(selectedChatId));
        setContactTagsDraft(Array.isArray(contact.tags) ? contact.tags : []);
    }, [contacts, selectedChatId, contactDirty]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setShowMenu(false);
            }
            if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
                setShowProfileMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const syncOnlineState = () => setIsOffline(!window.navigator.onLine);
        syncOnlineState();
        window.addEventListener('online', syncOnlineState);
        window.addEventListener('offline', syncOnlineState);
        return () => {
            window.removeEventListener('online', syncOnlineState);
            window.removeEventListener('offline', syncOnlineState);
        };
    }, []);

    useEffect(() => {
        if (!showAnalytics) return;
        fetchAnalytics();
    }, [showAnalytics, fetchAnalytics]);

    useEffect(() => {
        if (workspaceSection !== 'contacts') return;
        fetchTeamUsers();
    }, [workspaceSection, fetchTeamUsers]);

    useEffect(() => {
        setAssignMenuContactId(null);
    }, [activeProfileId, workspaceSection]);


    const handleSignOut = async () => {
        clearAllDrafts();
        setMessageText('');
        await supabase.auth.signOut();
        setSession(null);
    };

    // Check Auth
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setAuthChecking(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setAuthChecking(false);
        });

        return () => subscription.unsubscribe();
    }, []);

    useEffect(() => {
        if (!session) {
            setIsAdmin(false);
            return;
        }

        supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', session.user.id)
            .maybeSingle()
            .then(({ data, error }) => {
                if (error) {
                    console.warn('user_roles lookup failed', error);
                    setIsAdmin(false);
                    return;
                }
                const role = typeof data?.role === 'string' ? data.role.toLowerCase() : '';
                setIsAdmin(role === 'admin' || role === 'owner');
            });
    }, [session]);

    useEffect(() => {
        const statusEmoji = connectionStatus === 'open' ? '🟢' : connectionStatus === 'connecting' ? '🟡' : '🔴';
        document.title = `${statusEmoji} WhatsApp Business API`;
    }, [connectionStatus]);

    useEffect(() => {
        if (!session) {
            setSocket(null);
            setProfiles([]);
            setProfilesLoaded(false);
            setActiveProfileId(null);
            setAllMessages([]);
            setContacts({});
            return;
        }

        console.log('Connecting socket with token', session.access_token.substring(0, 10));
        setProfilesLoaded(false);
        const newSocket = io(SOCKET_URL, {
            auth: { token: session.access_token }
        });
        setSocket(newSocket);

        newSocket.on('connect', () => {
            if (activeProfileIdRef.current) {
                newSocket.emit('switchProfile', activeProfileIdRef.current);
            }
        });

        newSocket.on('profiles.update', (data) => {
            const list = Array.isArray(data) ? data : [];
            setProfiles(list);
            setProfilesLoaded(true);
            if (list.length === 0) {
                setActiveProfileId(null);
                setLoadingChats(false);
                return;
            }

            // Keep current selection if still valid; otherwise pick persisted profile, then first.
            const current = activeProfileIdRef.current;
            if (current && list.some((p: any) => p.id === current)) return;

            let persisted: string | null = null;
            try {
                persisted = window.localStorage.getItem('lastActiveProfileId');
            } catch {
                persisted = null;
            }
            const next = (persisted && list.find((p: any) => p.id === persisted)) || list[0];
            if (next?.id) setActiveProfileId(next.id);
        });

        newSocket.on('connection.update', (update) => {
            if (update.profileId === activeProfileIdRef.current) setConnectionStatus(update.connection);
            if (update.connection === 'close') {
                pushLog('WABA connection closed.', 'info');
            }
        });

        newSocket.on('messages.upsert', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                setAllMessages((prev) => [...data.messages, ...prev]);
                setLoadingChats(false);
            }
        });

        newSocket.on('messages.history', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                setAllMessages(data.messages);
                setLoadingChats(false);
            }
        });

        newSocket.on('server.stats', (stats) => {
            setServerStats(stats);
        });

        newSocket.on('message.status', (data) => {
            if (data.profileId !== activeProfileIdRef.current) return;
            const { messageId, status } = data || {};
            if (!messageId || !status) return;
            setAllMessages(prev =>
                prev.map(msg =>
                    msg.key?.id === messageId
                        ? { ...msg, status }
                        : msg
                )
            );
        });

        newSocket.on('messages.cleared', (data) => {
            if (data.profileId !== activeProfileIdRef.current) return;
            setAllMessages(prev => prev.filter(msg => msg.key.remoteJid !== data.jid));
        });

        newSocket.on('messaging-history.set', (history) => {
            setAllMessages(prev => [...history.messages, ...prev]);
        });

        newSocket.on('contacts.update', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                setContacts(prev => {
                    const next = { ...prev };
                    data.contacts.forEach((c: any) => {
                        if (!c.id) return;
                        const prev = next[c.id] || {};
                        const incomingName = typeof c.name === 'string' ? c.name : (typeof c.notify === 'string' ? c.notify : '');
                        const resolvedName = pickContactName(incomingName, prev.name, c.id);
                        const nextLastInboundAt = c.lastInboundAt === undefined ? (prev as any).lastInboundAt || null : c.lastInboundAt;
                        const nextAssigneeUserId = c.assigneeUserId === undefined ? (prev as any).assigneeUserId || null : c.assigneeUserId;
                        const nextAssigneeName = c.assigneeName === undefined ? (prev as any).assigneeName || null : c.assigneeName;
                        const nextAssigneeColor = c.assigneeColor === undefined ? (prev as any).assigneeColor || null : c.assigneeColor;
                        const nextCtaReferralAt = c.ctaReferralAt === undefined ? (prev as any).ctaReferralAt || null : c.ctaReferralAt;
                        const nextCtaFreeWindowStartedAt = c.ctaFreeWindowStartedAt === undefined ? (prev as any).ctaFreeWindowStartedAt || null : c.ctaFreeWindowStartedAt;
                        const nextCtaFreeWindowExpiresAt = c.ctaFreeWindowExpiresAt === undefined ? (prev as any).ctaFreeWindowExpiresAt || null : c.ctaFreeWindowExpiresAt;
                        next[c.id] = {
                            name: resolvedName || prev.name,
                            lastInboundAt: nextLastInboundAt,
                            tags: Array.isArray(c.tags) ? c.tags : prev.tags || [],
                            assigneeUserId: nextAssigneeUserId,
                            assigneeName: nextAssigneeName,
                            assigneeColor: nextAssigneeColor,
                            ctaReferralAt: nextCtaReferralAt,
                            ctaFreeWindowStartedAt: nextCtaFreeWindowStartedAt,
                            ctaFreeWindowExpiresAt: nextCtaFreeWindowExpiresAt
                        };
                    });
                    return next;
                });
            }
        });

        newSocket.on('mediaDownloaded', ({ messageId, mediaId, data, mimetype }) => {
            setMediaCache(prev => ({
                ...prev,
                ...(messageId ? { [messageId]: { data, mimetype } } : {}),
                ...(mediaId ? { [mediaId]: { data, mimetype } } : {})
            }));
        });

        newSocket.on('profile.added', (id) => {
            handleSwitchProfile(id);
            setShowAddProfileModal(false);
            setNewProfileName('');
            setIsCreatingProfile(false);
        });

        newSocket.on('profile.error', (data) => {
            setStartingWorkflow(false);
            if (typeof data?.message === 'string') {
                setLastProfileError(data.message);
                pushLog(data.message, 'error');
            }
            if (typeof data?.message === 'string' && data.message.includes('Outside 24h window')) {
                setForceTemplateMode(true);
                return;
            }
            alert(data.message);
            setIsCreatingProfile(false);
            setLoadingChats(false);
        });

        newSocket.on('workflow.started', (data) => {
            setStartingWorkflow(false);
            const profileId = activeProfileIdRef.current;
            if (profileId) {
                newSocket.emit('refreshMessages', profileId);
            }
            if (data?.workflowId) {
                pushLog(`Workflow started: ${data.workflowId}`, 'info');
            }
        });

        newSocket.on('connect_error', (err: any) => {
            setProfilesLoaded(true);
            pushLog(`Socket connect error: ${err?.message || err}`, 'error');
        });

        newSocket.on('disconnect', (reason: any) => {
            pushLog(`Socket disconnected: ${reason}`, 'info');
        });

        const refreshInterval = setInterval(() => {
            if (newSocket.connected && activeProfileIdRef.current) {
                newSocket.emit('refreshMessages', activeProfileIdRef.current);
            }
        }, 10000);

        return () => {
            clearInterval(refreshInterval);
            newSocket.close();
        };
    }, [session]); // ONLY reconnect if session changes

    // Handle switching profile separately
    useEffect(() => {
        if (socket && activeProfileId) {
            console.log('Switching to profile:', activeProfileId);
            setLoadingChats(true);
            socket.emit('switchProfile', activeProfileId);
        }
    }, [socket, activeProfileId]);

    useEffect(() => {
        if (!session || profilesLoaded) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Profiles load timed out. Restarting socket connection...');
        }, 15_000);
        return () => window.clearTimeout(timer);
    }, [session, profilesLoaded, recoverSocketConnection]);

    useEffect(() => {
        if (!session || !activeProfileId || !loadingChats) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Chat sync timed out. Restarting socket connection...');
        }, 15_000);
        return () => window.clearTimeout(timer);
    }, [session, activeProfileId, loadingChats, recoverSocketConnection]);

    const applyWorkflowsFromServer = (list: any[]) => {
        setWorkflows(list);
        const nextSelected = list[0]?.id || null;
        if (!selectedWorkflowId || !list.find((f: any) => f.id === selectedWorkflowId)) {
            setSelectedWorkflowId(nextSelected);
        }
        const drafts: Record<string, string> = {};
        list.forEach((wf: any) => {
            drafts[wf.id] = JSON.stringify(wf.actions || [], null, 2);
        });
        setWorkflowDrafts(drafts);
    };

    useEffect(() => {
        if (activeView !== 'chatflow' || !activeProfileId) return;
        fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`)
            .then(res => res.json())
            .then(data => {
                const list = Array.isArray(data?.workflows) ? data.workflows : [];
                applyWorkflowsFromServer(list);
            })
            .catch(err => console.error('Failed to fetch workflows:', err));
    }, [activeView, activeProfileId]);

    useEffect(() => {
        if (activeView !== 'dashboard' || !activeProfileId) return;
        fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`)
            .then(res => res.json())
            .then(data => {
                const list = Array.isArray(data?.workflows) ? data.workflows : [];
                applyWorkflowsFromServer(list);
            })
            .catch(err => console.error('Failed to fetch workflows:', err));
    }, [activeView, activeProfileId]);

    useEffect(() => {
        if (activeView !== 'chatflow' || workflowEditorMode !== 'visual' || !selectedWorkflowId) return;
        const wf = workflows.find(item => item.id === selectedWorkflowId);
        if (!wf) return;
        if (wf.builder && Array.isArray(wf.builder.nodes)) return;
        const builder = buildBuilderFromActions(wf.actions || [], wf.id);
        setWorkflows(prev => prev.map(item => item.id === wf.id ? { ...item, builder } : item));
    }, [activeView, workflowEditorMode, selectedWorkflowId, workflows]);

    const handleSaveWorkflows = async (updatedWorkflows: any[], draftOverrides?: Record<string, string>) => {
        try {
            if (!activeProfileId) {
                alert('No active profile selected.');
                return;
            }
            // Validate JSON drafts before saving
            const drafts = draftOverrides || workflowDrafts;
            const normalized = updatedWorkflows.map(wf => {
                const draft = drafts[wf.id];
                if (typeof draft === 'string') {
                    try {
                        return { ...wf, actions: JSON.parse(draft) };
                    } catch {
                        throw new Error(`Invalid JSON in actions for workflow: ${wf.id}`);
                    }
                }
                return wf;
            });

            const res = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflows: normalized })
            });

            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(payload?.error || `Failed to save workflows (${res.status})`);
            }

            const refreshed = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`);
            const refreshedPayload = await refreshed.json().catch(() => ({}));
            const list = Array.isArray(refreshedPayload?.workflows) ? refreshedPayload.workflows : [];
            applyWorkflowsFromServer(list);

            alert('Workflows saved to Supabase!');
        } catch (err: any) {
            alert(err?.message || 'Failed to save workflows');
        }
    };

    const { chatsMap, chatList, latestChatId } = useMemo(() => {
        const nextMap = new Map<string, Chat>();
        allMessages.forEach(msg => {
            const jid = msg.key.remoteJid;
            if (!jid) return;

            const existing = nextMap.get(jid);
            const content =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.buttonsMessage?.contentText ||
                msg.message?.listMessage?.description ||
                (msg.message?.buttonsMessage ? 'Buttons' : msg.message?.listMessage ? 'List' : 'Media message');

            if (!existing || (msg.messageTimestamp && msg.messageTimestamp > (existing.timestamp || 0))) {
                const cleanId = getCleanId(jid);
                let rawName = contacts[jid]?.name || msg.pushName || cleanId;
                if (rawName.includes('@')) {
                    rawName = getCleanId(rawName);
                }

                nextMap.set(jid, {
                    id: jid,
                    name: rawName,
                    lastMessage: content,
                    timestamp: msg.messageTimestamp,
                    unreadCount: 0,
                });
            }
        });

        // Ensure contacts with no messages still appear in chat list.
        Object.entries(contacts).forEach(([jid, contact]) => {
            if (!jid || nextMap.has(jid)) return;
            const cleanId = getCleanId(jid);
            let rawName = contact?.name || cleanId;
            if (rawName.includes('@')) rawName = getCleanId(rawName);
            const lastInboundMs = contact?.lastInboundAt ? new Date(contact.lastInboundAt).getTime() : 0;
            const timestamp = Number.isFinite(lastInboundMs) && lastInboundMs > 0
                ? Math.floor(lastInboundMs / 1000)
                : 0;
            nextMap.set(jid, {
                id: jid,
                name: rawName,
                lastMessage: '',
                timestamp,
                unreadCount: 0
            });
        });

        const nextList = Array.from(nextMap.values())
            .filter(chat => chat.name.toLowerCase().includes(searchQuery.toLowerCase()))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        return {
            chatsMap: nextMap,
            chatList: nextList,
            latestChatId: nextList[0]?.id || null
        };
    }, [allMessages, contacts, searchQuery]);

    const contactsList = useMemo(() => {
        type ContactRow = {
            id: string;
            name: string;
            phone: string;
            tags: string[];
            assigneeUserId: string | null;
            assigneeName: string | null;
            assigneeColor: string | null;
            lastInboundAt: string | null;
            lastActivityTs: number;
            totalMessages: number;
        };

        const rows = new Map<string, ContactRow>();
        const ensure = (jid: string): ContactRow | null => {
            if (!jid || jid.endsWith('@g.us')) return null;
            const existing = rows.get(jid);
            if (existing) return existing;
            const meta = contacts[jid] || {};
            const fallbackName = formatPhoneNumber(getCleanId(jid));
            const row: ContactRow = {
                id: jid,
                name: meta.name || fallbackName,
                phone: formatPhoneNumber(getCleanId(jid)),
                tags: Array.isArray(meta.tags) ? meta.tags : [],
                assigneeUserId: meta.assigneeUserId || null,
                assigneeName: meta.assigneeName || null,
                assigneeColor: meta.assigneeColor || null,
                lastInboundAt: meta.lastInboundAt || null,
                lastActivityTs: meta.lastInboundAt ? new Date(meta.lastInboundAt).getTime() || 0 : 0,
                totalMessages: 0
            };
            rows.set(jid, row);
            return row;
        };

        Object.keys(contacts).forEach((jid) => {
            ensure(jid);
        });

        allMessages.forEach((msg) => {
            const jid = msg.key?.remoteJid || '';
            const row = ensure(jid);
            if (!row) return;
            row.totalMessages += 1;
            const ts = (msg.messageTimestamp || 0) * 1000;
            if (ts > row.lastActivityTs) row.lastActivityTs = ts;
            if (!msg.key.fromMe && ts > 0) {
                const inboundIso = new Date(ts).toISOString();
                if (!row.lastInboundAt || ts > new Date(row.lastInboundAt).getTime()) {
                    row.lastInboundAt = inboundIso;
                }
            }
            if (!row.name) {
                row.name = msg.pushName || row.phone;
            }
        });

        const query = contactsSearchQuery.trim().toLowerCase();
        const filtered = Array.from(rows.values()).filter((row) => {
            if (!query) return true;
            if (row.name.toLowerCase().includes(query)) return true;
            if (row.phone.toLowerCase().includes(query)) return true;
            if (row.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
            return false;
        });

        filtered.sort((a, b) => {
            const aTs = a.lastActivityTs || (a.lastInboundAt ? new Date(a.lastInboundAt).getTime() : 0);
            const bTs = b.lastActivityTs || (b.lastInboundAt ? new Date(b.lastInboundAt).getTime() : 0);
            return bTs - aTs;
        });

        return filtered;
    }, [contacts, allMessages, contactsSearchQuery]);

    useEffect(() => {
        if (activeView !== 'dashboard') return;
        if (!selectedChatId && latestChatId) {
            setSelectedChatId(latestChatId);
        }
    }, [activeView, selectedChatId, latestChatId]);

    const tagAnalytics = useMemo(() => {
        const tagCounts = new Map<string, number>();
        const tagMessageCounts = new Map<string, number>();
        const tagsByChat = new Map<string, string[]>();

        Object.entries(contacts).forEach(([jid, contact]) => {
            const tags = Array.isArray(contact.tags) ? contact.tags : [];
            if (tags.length === 0) return;
            tagsByChat.set(jid, tags);
            tags.forEach(tag => {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            });
        });

        allMessages.forEach(msg => {
            const tags = tagsByChat.get(msg.key?.remoteJid || '');
            if (!tags || tags.length === 0) return;
            tags.forEach(tag => {
                tagMessageCounts.set(tag, (tagMessageCounts.get(tag) || 0) + 1);
            });
        });

        const rows = Array.from(tagCounts.entries()).map(([tag, count]) => ({
            tag,
            contacts: count,
            messages: tagMessageCounts.get(tag) || 0
        }));
        rows.sort((a, b) => b.contacts - a.contacts);
        return rows;
    }, [contacts, allMessages]);

    const startableWorkflows = useMemo(() => {
        const list = Array.isArray(workflows) ? [...workflows] : [];
        list.sort((a, b) => {
            const aKey = (a?.trigger_keyword || a?.id || '').toString();
            const bKey = (b?.trigger_keyword || b?.id || '').toString();
            return aKey.localeCompare(bKey);
        });
        return list;
    }, [workflows]);

    useEffect(() => {
        if (startWorkflowId && !startableWorkflows.find(wf => wf.id === startWorkflowId)) {
            setStartWorkflowId('');
        }
    }, [startWorkflowId, startableWorkflows]);

    const currentChatMessages = useMemo(() => {
        return allMessages
            .filter(msg => msg.key.remoteJid === selectedChatId)
            .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
    }, [allMessages, selectedChatId]);

    const messageRows = useMemo<MessageVirtualRow[]>(() => {
        const rows: MessageVirtualRow[] = [];
        let lastDateKey = '';
        currentChatMessages.forEach((msg, idx) => {
            const msgMs = (msg.messageTimestamp || 0) * 1000;
            const dateKey = msgMs ? new Date(msgMs).toDateString() : '';
            const showDate = Boolean(dateKey && dateKey !== lastDateKey);
            if (showDate) {
                lastDateKey = dateKey;
                rows.push({
                    kind: 'date',
                    id: `date-${dateKey}-${idx}`,
                    label: formatDateLabel(msgMs)
                });
            }
            rows.push({
                kind: 'message',
                id: msg.key.id || `${msg.key.remoteJid || 'msg'}-${idx}`,
                msg
            });
        });
        return rows;
    }, [currentChatMessages]);

    useEffect(() => {
        if (!selectedChatId) return;
        if (messageRows.length === 0) return;
        requestAnimationFrame(() => {
            messageListRef.current?.scrollToRow({
                index: messageRows.length - 1,
                align: 'end'
            });
        });
    }, [selectedChatId, messageRows.length]);

    useEffect(() => {
        if (!socket || !activeProfileId) return;
        if (!selectedChatId) return;
        currentChatMessages.forEach(msg => {
            const messageId = msg.key?.id;
            const imageMediaId = msg.message?.imageMessage?.mediaId;
            const docMediaId = msg.message?.documentMessage?.mediaId;
            const docName = msg.message?.documentMessage?.fileName || '';
            const docMime = msg.message?.documentMessage?.mimetype || '';
            const docIsImage = Boolean(
                docMime.startsWith('image/') ||
                /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(docName)
            );
            const audioMediaId = msg.message?.audioMessage?.mediaId;
            const mediaId = imageMediaId || (docIsImage ? docMediaId : undefined) || audioMediaId;
            if (!mediaId) return;
            if (messageId && mediaCache[messageId]) return;
            if (mediaCache[mediaId]) return;
            const requestKey = messageId || mediaId;
            if (requestedMediaRef.current.has(requestKey)) return;
            requestedMediaRef.current.add(requestKey);
            socket.emit('downloadMedia', { profileId: activeProfileId, message: msg });
        });
    }, [socket, activeProfileId, selectedChatId, currentChatMessages, mediaCache]);

    const currentAgentName =
        (session?.user?.user_metadata as any)?.full_name ||
        (session?.user?.user_metadata as any)?.name ||
        (session?.user?.email ? String(session.user.email).split('@')[0] : 'You');

    const selectedChat = selectedChatId
        ? (chatsMap.get(selectedChatId) || {
            id: selectedChatId,
            name: contacts[selectedChatId]?.name || getCleanId(selectedChatId),
            lastMessage: '',
            timestamp: 0,
            unreadCount: 0
        })
        : null;
    const selectedContact = selectedChatId ? contacts[selectedChatId] : null;
    const selectedAssigneeName = selectedContact?.assigneeName || null;
    const selectedAssigneeColor = selectedContact?.assigneeColor || '#6b7280';
    const selectedAssigneeInitials = getInitials(selectedAssigneeName || 'Unassigned');
    const assignTargetContact = assignMenuContactId ? contacts[assignMenuContactId] : null;
    const assignTargetName = assignMenuContactId
        ? (assignTargetContact?.name || chatsMap.get(assignMenuContactId)?.name || formatPhoneNumber(getCleanId(assignMenuContactId)))
        : '';
    const assignTargetPhone = assignMenuContactId ? formatPhoneNumber(getCleanId(assignMenuContactId)) : '';
    const assignTargetAssigneeUserId = assignTargetContact?.assigneeUserId || null;
    const lastInboundMs = getLastInboundTs(allMessages, selectedChatId, contacts);
    const windowExpiresMs = lastInboundMs ? lastInboundMs + 24 * 60 * 60 * 1000 : null;
    const windowRemainingMs = windowExpiresMs ? windowExpiresMs - now : null;
    const windowOpen = windowRemainingMs !== null && windowRemainingMs > 0;
    const ctaFreeWindowExpiresMs = selectedChatId && contacts[selectedChatId]?.ctaFreeWindowExpiresAt
        ? new Date(contacts[selectedChatId]?.ctaFreeWindowExpiresAt || '').getTime()
        : null;
    const ctaFreeWindowRemainingMs =
        ctaFreeWindowExpiresMs && !Number.isNaN(ctaFreeWindowExpiresMs)
            ? ctaFreeWindowExpiresMs - now
            : null;
    const ctaFreeWindowOpen = ctaFreeWindowRemainingMs !== null && ctaFreeWindowRemainingMs > 0;
    const canSendText = windowOpen && !forceTemplateMode;
    const quickReplyQuery = useMemo(() => {
        const trimmed = messageText.trim();
        if (!trimmed.startsWith('/')) return null;
        const token = trimmed.slice(1).split(/\s+/)[0];
        return token.toLowerCase();
    }, [messageText]);

    const quickReplySuggestions = useMemo(() => {
        if (quickReplyQuery === null) return [];
        const query = quickReplyQuery;
        return quickReplies
            .filter(item => {
                const shortcut = normalizeQuickReplyShortcut(item.shortcut);
                if (!shortcut) return false;
                return query === '' || shortcut.startsWith(query);
            })
            .slice(0, 8);
    }, [quickReplies, quickReplyQuery, normalizeQuickReplyShortcut]);

    const handleQuickReplyPick = (item: QuickReply) => {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (!text) return;
        setMessageTextWithDraft(text);
        requestAnimationFrame(() => {
            if (!messageInputRef.current) return;
            messageInputRef.current.focus();
            messageInputRef.current.setSelectionRange(text.length, text.length);
        });
    };

    useEffect(() => {
        if (!lastInboundMs) return;
        if (lastInboundRef.current === null || lastInboundMs > lastInboundRef.current) {
            lastInboundRef.current = lastInboundMs;
            setForceTemplateMode(false);
        }
    }, [lastInboundMs]);

    const handleSendMessage = () => {
        if (!socket || !activeProfileId || !selectedChatId || !messageText.trim()) return;
        const outgoingText = messageText.trim();
        socket.emit('sendMessage', { profileId: activeProfileId, jid: selectedChatId, text: outgoingText });
        const tempMsg: Message = {
            key: { id: Math.random().toString(), remoteJid: selectedChatId, fromMe: true },
            message: { conversation: outgoingText },
            messageTimestamp: Math.floor(Date.now() / 1000),
            status: 'sent',
            agent: {
                user_id: session?.user?.id,
                name: currentAgentName,
                color: '#6b7280'
            }
        };
        setAllMessages(prev => [tempMsg, ...prev]);
        persistDraft('', activeProfileId, selectedChatId);
        setMessageText('');
    };

    const handleStartWorkflow = () => {
        if (!socket || !selectedChatId || !activeProfileId || !startWorkflowId) return;
        if (selectedChatId.endsWith('@g.us')) {
            alert('Workflows are not supported for groups.');
            return;
        }
        setStartingWorkflow(true);
        socket.emit('startWorkflow', { profileId: activeProfileId, jid: selectedChatId, workflowId: startWorkflowId });
        pushLog(`Starting workflow ${startWorkflowId}`, 'info');
        setShowWorkflowStarter(false);
    };

    const handleClearChat = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (selectedChatId.endsWith('@g.us')) {
            alert('Clear chat is not supported for groups.');
            return;
        }
        const ok = confirm('Clear this chat history? This cannot be undone.');
        if (!ok) return;
        socket.emit('clearChat', { profileId: activeProfileId, jid: selectedChatId });
    };

    const handleSaveContact = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (selectedChatId.endsWith('@g.us')) return;
        socket.emit('contact.update', {
            profileId: activeProfileId,
            jid: selectedChatId,
            name: contactDraftName.trim(),
            tags: contactTagsDraft
        });
        setContactDirty(false);
        pushLog('Contact saved.', 'info');
    };

    const handleAddTag = () => {
        const next = contactTagInput.trim();
        if (!next) return;
        if (contactTagsDraft.includes(next)) {
            setContactTagInput('');
            return;
        }
        setContactTagsDraft(prev => [...prev, next]);
        setContactTagInput('');
        setContactDirty(true);
    };

    const handleRemoveTag = (tag: string) => {
        setContactTagsDraft(prev => prev.filter(t => t !== tag));
        setContactDirty(true);
    };

    const handleDownloadMedia = (message: Message) => {
        const mediaId =
            message.message?.imageMessage?.mediaId ||
            message.message?.documentMessage?.mediaId ||
            message.message?.audioMessage?.mediaId ||
            message.message?.videoMessage?.mediaId;
        if (!socket) return;
        if (message.key.id && mediaCache[message.key.id]) return;
        if (mediaId && mediaCache[mediaId]) return;
        socket.emit('downloadMedia', { profileId: activeProfileId, message });
    };

    const handleSendTemplate = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (!templateName.trim()) {
            alert('Template name is required.');
            return;
        }

        let components: any[] | undefined;
        if (templateComponents.trim()) {
            try {
                const parsed = JSON.parse(templateComponents);
                if (!Array.isArray(parsed)) {
                    alert('Template components must be a JSON array.');
                    return;
                }
                components = parsed;
            } catch {
                alert('Invalid JSON in template components.');
                return;
            }
        }

        socket.emit('sendTemplate', {
            profileId: activeProfileId,
            jid: selectedChatId,
            name: templateName.trim(),
            language: templateLanguage.trim() || 'en_US',
            components
        });
        setShowTemplateComposer(false);
    };

    const handleSwitchProfile = (id: string) => {
        setActiveProfileId(id);
        setAllMessages([]);
        setContacts({});
        setSelectedChatId(null);
        setShowTemplateComposer(false);
        setConnectionStatus('connecting'); // Anticipate status update
        setLoadingChats(true);
        socket?.emit('switchProfile', id);
        setShowProfileMenu(false);
    };

    const handleAddProfile = () => {
        setShowAddProfileModal(true);
    };

    const submitAddProfile = () => {
        if (newProfileName.trim() && !isCreatingProfile) {
            setIsCreatingProfile(true);
            console.log('Submitting new profile:', newProfileName.trim());
            socket?.emit('addProfile', newProfileName.trim());
        }
    };

    const handleUpdateProfileName = (profileId: string, currentName: string) => {
        setEditingProfileId(profileId);
        setEditingProfileName(currentName);
        setShowEditProfileModal(true);
    };

    const submitUpdateProfileName = () => {
        if (editingProfileName.trim() && editingProfileName !== profiles.find(p => p.id === editingProfileId)?.name) {
            socket?.emit('updateProfileName', { profileId: editingProfileId, name: editingProfileName.trim() });
            setShowEditProfileModal(false);
        }
    };

    const handleDeleteProfile = (profileId: string, name: string) => {
        socket?.emit('deleteProfile', profileId);
        if (activeProfileId === profileId) {
            // If we deleted the active profile, switch to default or first available
            const next = profiles.find(p => p.id !== profileId);
            if (next) {
                handleSwitchProfile(next.id);
            } else {
                handleSwitchProfile('default');
            }
        }
    };

    const handleNewChat = () => {
        if (!newPhoneNumber.trim()) return;
        let cleanNumber = newPhoneNumber.replace(/\D/g, '');
        if (!cleanNumber.includes('@')) {
            cleanNumber = `${cleanNumber}@s.whatsapp.net`;
        }
        setSelectedChatId(cleanNumber);
        setShowNewChatModal(false);
        setNewPhoneNumber('');
    };

    const canStartWorkflow = Boolean(startWorkflowId) && !startingWorkflow && !selectedChatId?.endsWith('@g.us');
    const workflowStarter = (
        <div className="relative">
            <button
                onClick={() => setShowWorkflowStarter(prev => !prev)}
                className="p-2 hover:bg-white rounded-xl transition-all text-[#54656f]"
                title="Start workflow"
            >
                <Bot className="w-5 h-5" />
            </button>
            {showWorkflowStarter && (
                <div className="absolute bottom-full mb-2 left-0 bg-white border border-[#eceff1] rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.12)] p-3 z-20">
                    <div className="flex items-center gap-2">
                        <select
                            value={startWorkflowId}
                            onChange={(e) => setStartWorkflowId(e.target.value)}
                            disabled={startableWorkflows.length === 0}
                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[12px] font-bold text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 disabled:opacity-60 w-[170px]"
                        >
                            <option value="">
                                {startableWorkflows.length === 0 ? 'No workflows' : 'Choose workflow'}
                            </option>
                            {startableWorkflows.map((wf: any) => (
                                <option key={wf.id} value={wf.id}>
                                    {wf.trigger_keyword ? `${wf.trigger_keyword}` : wf.id}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={handleStartWorkflow}
                            disabled={!canStartWorkflow}
                            className="px-3 py-2 rounded-xl bg-[#111b21] text-white text-[11px] font-bold uppercase tracking-widest flex items-center gap-2 hover:bg-[#202c33] transition-all disabled:opacity-50"
                        >
                            <Play className="w-4 h-4" />
                            {startingWorkflow ? 'Starting' : 'Start'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );

    if (authChecking) {
        return <div className="h-screen flex items-center justify-center bg-white text-[#111b21] text-xl font-light">Loading SaaS Infrastructure...</div>
    }

    if (!session) {
        return (
            <Login
                onLogin={(nextSession) => {
                    setSession(nextSession);
                    setAuthChecking(false);
                }}
            />
        )
    }

    const workspaceTabs: Array<{
        id: 'team-inbox' | 'broadcast' | 'chatbots' | 'contacts' | 'ads' | 'automations' | 'more';
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        beta?: boolean;
    }> = [
            { id: 'team-inbox', label: 'Team Inbox', icon: MessageSquare },
            { id: 'broadcast', label: 'Broadcast', icon: Send },
            { id: 'chatbots', label: 'Chatbots', icon: Bot },
            { id: 'contacts', label: 'Contacts', icon: Users },
            { id: 'ads', label: 'Ads', icon: CircleDashed, beta: true },
            { id: 'automations', label: 'Automations', icon: Workflow },
            { id: 'more', label: 'More', icon: MoreVertical }
        ];

    const activeWorkspaceLabel = workspaceTabs.find(tab => tab.id === workspaceSection)?.label || 'Workspace';
    const broadcastNav: Array<{ id: 'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts'; label: string }> = [
        { id: 'template-library', label: 'Template Library' },
        { id: 'my-templates', label: 'My Templates' },
        { id: 'broadcast-history', label: 'Broadcast History' },
        { id: 'scheduled-broadcasts', label: 'Scheduled Broadcasts' }
    ];

    return (
        <>
            {isOffline && (
                <>
                    <div className="fixed top-0 inset-x-0 z-[260] bg-[#111b21] text-white border-b border-[#2f3b42]">
                        <div className="h-11 px-4 flex items-center justify-center gap-2 text-[12px] font-bold tracking-wide">
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/90 text-[10px] uppercase">Offline</span>
                            <span>No internet connection. Reconnecting…</span>
                        </div>
                    </div>
                    <div className="fixed left-1/2 -translate-x-1/2 bottom-5 z-[260] pointer-events-none">
                        <div className="offline-dino-card">
                            <div className="offline-dino-stage">
                                <div className="offline-dino-runner" role="img" aria-label="Running dinosaur">🦖</div>
                                <div className="offline-dino-ground" />
                            </div>
                            <div className="offline-dino-label">
                                Waiting for internet
                                <span className="offline-dino-dots" aria-hidden="true">
                                    <span>.</span>
                                    <span>.</span>
                                    <span>.</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </>
            )}
            <header className="fixed top-0 inset-x-0 z-[120] h-[72px] bg-white border-b border-[#eceff1]">
                <div className="h-full px-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="w-9 h-9 rounded-xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884] flex items-center justify-center">
                                <MessageSquare className="w-5 h-5" />
                            </div>
                            <div className="h-8 min-w-[96px] px-3 rounded-lg border border-[#eceff1] bg-[#f8f9fa] flex items-center justify-center">
                                <span className="text-[10px] font-black uppercase tracking-widest text-[#8696a0]">Logo</span>
                            </div>
                        </div>
                        <div className="hidden xl:block w-px h-8 bg-[#eceff1]" />
                        <nav className="flex items-center gap-1 overflow-x-auto whitespace-nowrap custom-scrollbar">
                            {workspaceTabs.map((tab) => {
                                const Icon = tab.icon;
                                const active = workspaceSection === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        onClick={() => setWorkspaceSection(tab.id)}
                                        className={`px-3 py-2 rounded-xl text-[16px] font-bold transition-all flex items-center gap-2 ${active ? 'text-[#00a884] bg-[#00a884]/10' : 'text-[#4a4a4a] hover:bg-[#f0f2f5]'}`}
                                    >
                                        <Icon className="w-4 h-4" />
                                        <span>{tab.label}</span>
                                        {tab.beta && (
                                            <span className="px-2 py-0.5 rounded-full bg-[#dcfce7] text-[#15803d] text-[10px] font-black uppercase tracking-wider">
                                                Beta
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </nav>
                    </div>
                    <div className="hidden md:flex items-center gap-3">
                        <button className="w-10 h-10 rounded-full bg-[#f3f4f6] text-[#6b7280] flex items-center justify-center">
                            <MoreVertical className="w-5 h-5" />
                        </button>
                        <button className="w-10 h-10 rounded-full bg-[#f3f4f6] text-[#6b7280] flex items-center justify-center">
                            <User className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </header>

            {workspaceSection === 'team-inbox' ? (
                <div className="flex h-screen pt-[72px] bg-[#f8f9fa] overflow-hidden text-[#111b21] font-sans">
            <div className="w-[400px] border-r border-[#eceff1] flex flex-col bg-white">
                <header className="h-[60px] bg-[#f0f2f5] px-4 flex items-center justify-between border-b border-[#eceff1]">
                    <div className="flex items-center gap-4">
                        <div className="relative" ref={profileMenuRef}>
                            <div
                                onClick={() => setShowProfileMenu(!showProfileMenu)}
                                className="w-10 h-10 rounded-full bg-white border border-[#eceff1] flex items-center justify-center overflow-hidden cursor-pointer relative shadow-sm"
                            >
                                <User className="text-[#54656f]" />
                                {profiles.some(p => p.id !== activeProfileId && p.unreadCount > 0) && (
                                    <div className="absolute top-0 right-0 w-3 h-3 bg-rose-500 rounded-full border-2 border-[#f0f2f5]" />
                                )}
                            </div>

                            {showProfileMenu && (
                                <div className="absolute left-0 mt-2 w-64 bg-white rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.1)] py-2 z-[101] border border-[#eceff1]">
                                    <div className="px-4 py-2 text-xs font-bold text-[#54656f] uppercase border-b border-[#eceff1] mb-2 tracking-wider">Switch Profile</div>
                                    <div className="max-h-[400px] overflow-y-auto custom-scrollbar">
                                        {profiles.map(p => (
                                            <div key={p.id} className="flex items-center hover:bg-[#f0f2f5] transition-colors pr-group group">
                                                <button
                                                    onClick={() => handleSwitchProfile(p.id)}
                                                    className={`flex-1 text-left px-4 py-3 flex items-center justify-between ${p.id === activeProfileId ? 'bg-[#00a884]/5' : ''}`}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-9 h-9 rounded-full bg-[#f0f2f5] flex items-center justify-center border border-[#eceff1]">
                                                            <User className="w-4 h-4 text-[#54656f]" />
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-sm font-bold text-[#111b21] truncate max-w-[120px]">{p.name}</span>
                                                            <span className="text-[10px] text-[#54656f] font-medium">{p.id === activeProfileId ? 'Active Now' : 'Click to switch'}</span>
                                                        </div>
                                                    </div>
                                                    {p.unreadCount > 0 && (
                                                        <span className="bg-[#00a884] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                                                            {p.unreadCount}
                                                        </span>
                                                    )}
                                                </button>
                                                {!SINGLE_PROFILE_MODE && (
                                                    <button
                                                        onClick={() => handleDeleteProfile(p.id, p.name)}
                                                        className="p-2 opacity-0 group-hover:opacity-100 text-[#54656f] hover:text-rose-500 transition-all"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                    {!SINGLE_PROFILE_MODE && (
                                        <button
                                            onClick={() => setShowAddProfileModal(true)}
                                            className="w-full px-4 py-3 flex items-center gap-3 text-[#00a884] font-bold hover:bg-[#f8f9fa] transition-colors border-t border-[#eceff1]"
                                        >
                                            <Plus className="w-4 h-4" />
                                            Add New Profile
                                        </button>
                                    )}
                                    <div
                                        onClick={handleSignOut}
                                        className="w-full px-4 py-3 flex items-center gap-3 text-rose-500 font-bold hover:bg-[#f8f9fa] transition-colors cursor-pointer mt-2 border-t border-[#eceff1]"
                                    >
                                        <LogOut className="w-4 h-4" />
                                        <span className="text-sm">Sign Out</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {isAdmin && (
                            <button
                                onClick={() => setActiveView('admin')}
                                className={`p-2 rounded-lg transition-colors ${activeView === 'admin' ? 'bg-[#00a884]/10 text-[#00a884]' : 'text-[#54656f] hover:bg-white hover:shadow-sm'}`}
                                title="Admin Control Center"
                            >
                                <Shield className="w-6 h-6" />
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-6 text-[#54656f] relative" ref={menuRef}>
                        <Workflow
                            className={`w-6 h-6 cursor-pointer transition-colors ${activeView === 'chatflow' ? 'text-[#00a884]' : 'hover:text-[#111b21]'}`}
                            onClick={() => setActiveView(activeView === 'chatflow' ? 'dashboard' : 'chatflow')}
                        />
                        <Settings
                            className={`w-6 h-6 cursor-pointer transition-colors ${activeView === 'settings' ? 'text-[#00a884]' : 'hover:text-[#111b21]'}`}
                            onClick={() => setActiveView(activeView === 'settings' ? 'dashboard' : 'settings')}
                        />
                        <CircleDashed
                            className={`w-6 h-6 cursor-pointer transition-colors ${showAnalytics ? 'text-[#00a884]' : 'hover:text-[#111b21]'}`}
                            onClick={() => setShowAnalytics(true)}
                        />

                        <MessageSquare className="w-6 h-6 cursor-pointer" onClick={() => setShowNewChatModal(true)} />
                        <div className="relative">
                            <MoreVertical
                                className={`w-6 h-6 cursor-pointer transition-colors ${showMenu ? 'text-[#00a884]' : 'hover:text-[#e9edef]'}`}
                                onClick={() => setShowMenu(!showMenu)}
                            />
                            {showMenu && (
                                <div className="absolute right-0 mt-2 w-72 bg-[#233138] rounded-lg shadow-2xl py-2 z-[100] border border-[#313d45]">
                                    <div className="px-4 py-3 border-b border-[#313d45]">
                                        <div className="flex items-center gap-2 mb-1">
                                            <div className={`w-2 h-2 rounded-full ${connectionStatus === 'open' ? 'bg-[#00a884]' : connectionStatus === 'connecting' ? 'bg-yellow-500' : 'bg-rose-500'}`} />
                                            <span className="text-sm font-medium text-[#e9edef]">
                                                {connectionStatus === 'open' ? 'WABA connected' : 'WABA not configured'}
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-[#8696a0] leading-snug">
                                            Configure Meta Cloud API credentials in `waba_configs` to enable messaging.
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => { setActiveView('settings'); setShowMenu(false); }}
                                        className="w-full text-left px-4 py-3 hover:bg-[#111b21] text-[#e9edef] text-[14.5px] transition-colors flex items-center gap-3"
                                    >
                                        <Settings className="w-4 h-4 text-[#00a884]" />
                                        Settings
                                    </button>
                                    <button
                                        onClick={() => setShowMenu(false)}
                                        className="w-full text-left px-4 py-3 hover:bg-[#111b21] text-[#e9edef] text-[14.5px] transition-colors flex items-center gap-3 border-t border-[#313d45]"
                                    >
                                        <Settings className="w-4 h-4 text-[#8696a0]" />
                                        Close
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </header>

                <div className="px-3 py-2 border-b border-[#f0f2f5]">
                    <div className="bg-[#f0f2f5] rounded-xl flex items-center px-4 py-2 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#00a884]/20 transition-all">
                        <Search className="w-4 h-4 text-[#54656f] mr-4" />
                        <input
                            type="text"
                            placeholder="Search or start new chat"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="bg-transparent border-none text-[15px] w-full focus:outline-none placeholder:text-[#54656f]"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {!activeProfileId ? (
                        <div className="p-4 flex flex-col items-center justify-center h-full text-center bg-white">
                            {profilesLoaded ? (
                                <>
                                    <User className="w-12 h-12 text-[#54656f] mb-4 opacity-10" />
                                    <p className="text-[#111b21] font-bold mb-2">No Profile active</p>
                                    <p className="text-sm text-[#8696a0] mb-6">
                                        {SINGLE_PROFILE_MODE
                                            ? 'Default WABA profile will appear here once created.'
                                            : 'Create or select a profile to start'}
                                    </p>
                                    {!SINGLE_PROFILE_MODE && (
                                        <button
                                            onClick={() => setShowAddProfileModal(true)}
                                            className="bg-[#00a884] text-black px-6 py-2 rounded-lg font-bold hover:bg-[#008f6f] transition-all"
                                        >
                                            Create First Profile
                                        </button>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="w-10 h-10 rounded-full border-4 border-[#e5e7eb] border-t-[#00a884] animate-spin mb-4" />
                                    <p className="text-[#111b21] font-bold mb-1">Loading profiles…</p>
                                    <p className="text-sm text-[#8696a0]">Connecting to your workspace</p>
                                </>
                            )}
                        </div>
                    ) : connectionStatus !== 'open' ? (
                        <div className="p-6 flex flex-col items-center justify-center h-full text-center">
                            <div className="bg-white p-6 rounded-2xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] max-w-md">
                                <ShieldCheck className="w-10 h-10 text-[#00a884] mx-auto mb-4" />
                                <p className="text-[#111b21] font-bold mb-2">WABA not configured for this profile</p>
                                <p className="text-sm text-[#54656f] leading-relaxed">
                                    Add your Meta Cloud API credentials in Supabase `waba_configs` and enable the config.
                                    Once saved, refresh the page and the profile will show as connected.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full overflow-hidden" ref={chatListViewportRef}>
                            {loadingChats ? (
                                <div className="h-full flex flex-col items-center justify-center text-sm text-[#8696a0] gap-3">
                                    <div className="w-8 h-8 rounded-full border-4 border-[#e5e7eb] border-t-[#00a884] animate-spin" />
                                    <span>Loading chats…</span>
                                </div>
                            ) : chatList.length === 0 ? (
                                <div className="h-full flex items-center justify-center text-sm text-[#8696a0]">
                                    No chats found.
                                </div>
                            ) : chatListViewport.height > 0 ? (
                                <List
                                    style={{
                                        height: chatListViewport.height,
                                        width: chatListViewport.width || '100%'
                                    }}
                                    rowCount={chatList.length}
                                    rowHeight={CHAT_ROW_HEIGHT}
                                    rowProps={{}}
                                    overscanCount={8}
                                    rowComponent={(props: any) => {
                                        const { index, style } = props as { index: number; style: React.CSSProperties };
                                        const chat = chatList[index];
                                        const assigneeName = contacts[chat.id]?.assigneeName || null;
                                        const assigneeColor = contacts[chat.id]?.assigneeColor || '#6b7280';
                                        return (
                                            <div style={style}>
                                                <div
                                                    onClick={() => setSelectedChatId(chat.id)}
                                                    className={`flex items-center px-3 py-2 cursor-pointer hover:bg-[#f5f6f6] transition-colors border-b border-[#fcfdfd] ${selectedChatId === chat.id ? 'bg-[#f0f2f5]' : ''}`}
                                                >
                                                    <div className="w-12 h-12 rounded-full bg-[#f0f2f5] mr-3 flex-shrink-0 flex items-center justify-center border border-[#eceff1]">
                                                        {chat.id.endsWith('@g.us') ? (
                                                            <Users className="text-[#54656f] w-5 h-5" />
                                                        ) : (
                                                            <User className="text-[#54656f] w-5 h-5" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0 border-b border-[#f5f6f6] pb-3 pt-1">
                                                        <div className="flex justify-between items-baseline mb-0.5">
                                                            <h3 className="font-bold text-[16px] truncate pr-2 text-[#111b21]">
                                                                {chat.name}
                                                            </h3>
                                                            <span className="text-[11px] font-medium text-[#54656f]">
                                                                {chat.timestamp ? new Date(chat.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                                            </span>
                                                        </div>
                                                        {(chat.id.endsWith('@s.whatsapp.net') || chat.id.endsWith('@lid')) &&
                                                            getCleanId(chat.name) !== getCleanId(chat.id) && (
                                                                <div className="text-[11px] text-[#00a884] font-bold leading-none mb-1">
                                                                    {formatPhoneNumber(getCleanId(chat.id))}
                                                                </div>
                                                            )}
                                                        <div className="flex items-center justify-between mt-0.5 gap-2">
                                                            <p className="truncate text-[13px] text-[#54656f] font-medium leading-tight flex-1">
                                                                {chat.lastMessage}
                                                            </p>
                                                            {assigneeName ? (
                                                                <div className="ml-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                                            setAssignMenuContactId(prev => (prev === chat.id ? null : chat.id));
                                                                        }}
                                                                        className="px-1.5 py-0.5 text-[9px] rounded uppercase font-bold border tracking-tight hover:opacity-85 transition-all"
                                                                        style={{
                                                                            backgroundColor: withHexAlpha(assigneeColor, '20', '#f3f4f6'),
                                                                            borderColor: withHexAlpha(assigneeColor, '66', '#d1d5db'),
                                                                            color: textColor(assigneeColor, '#374151')
                                                                        }}
                                                                    >
                                                                        {assigneeName}
                                                                    </button>
                                                                </div>
                                                            ) : chat.id.endsWith('@g.us') ? (
                                                                <span className="ml-2 px-1.5 py-0.5 bg-[#f0f2f5] text-[#54656f] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight">Group</span>
                                                            ) : (
                                                                <div className="ml-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                                            setAssignMenuContactId(prev => (prev === chat.id ? null : chat.id));
                                                                        }}
                                                                        className="px-1.5 py-0.5 bg-[#f8f9fa] text-[#9ca3af] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight hover:bg-[#f0f2f5] transition-all"
                                                                    >
                                                                        Unassigned
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                            ) : null}
                        </div>
                    )}
                </div>
            </div>

            {selectedChatId ? (
                <div className="flex-1 flex flex-col min-h-0 bg-[#f0f2f5] relative overflow-hidden">
                    <div className="absolute inset-0 opacity-[0.06] pointer-events-none bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_6860a4760a595861d83d.png')] bg-repeat" />

                    <header className="h-[60px] shrink-0 bg-[#f0f2f5] px-3 flex items-center justify-between z-10 border-l border-[#eceff1]">
                        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setShowContactInfo(true)}>
                            <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center overflow-hidden border border-[#eceff1] shadow-sm">
                                {selectedChat?.id.endsWith('@g.us') ? (
                                    <Users className="text-[#54656f] w-5 h-5" />
                                ) : (
                                    <User className="text-[#54656f] w-5 h-5" />
                                )}
                            </div>
                            <div>
                                <h2 className="font-bold text-[16px] leading-tight text-[#111b21]">
                                    {selectedChat?.name}
                                </h2>
                                <p className="text-[12px] text-[#54656f]">
                                    {selectedChat?.id.endsWith('@g.us') ? (
                                        <span className="text-[#54656f] font-medium tracking-tight uppercase text-[10px]">Group Statistics</span>
                                    ) : (
                                        <>
                                            <span className="text-[#00a884] font-bold">{formatPhoneNumber(getCleanId(selectedChat?.id))}</span>
                                            <span className="ml-2 text-[#06d755] font-bold">• active</span>
                                            {lastInboundMs ? (
                                                <span className={`ml-2 text-[11px] font-bold ${windowOpen ? 'text-[#00a884]' : 'text-rose-600'}`}>
                                                    {windowOpen ? `${formatRemaining(windowRemainingMs || 0)} left` : '24h closed'}
                                                </span>
                                            ) : (
                                                <span className="ml-2 text-[11px] font-medium text-[#8a9aa1]">24h: no inbound</span>
                                            )}
                                            {ctaFreeWindowOpen && (
                                                <span className="ml-2 text-[11px] font-bold text-[#2563eb]">
                                                    CTA free template: {formatRemaining(ctaFreeWindowRemainingMs || 0)}
                                                </span>
                                            )}
                                            <span className="ml-2 inline-block">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (!selectedChatId) return;
                                                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                        setAssignMenuContactId(prev => (prev === selectedChatId ? null : selectedChatId));
                                                    }}
                                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border hover:opacity-85 transition-all"
                                                    style={{
                                                        backgroundColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '20', '#f3f4f6')
                                                            : '#f8f9fa',
                                                        borderColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '66', '#d1d5db')
                                                            : '#eceff1',
                                                        color: selectedAssigneeName
                                                            ? textColor(selectedAssigneeColor, '#374151')
                                                            : '#9ca3af'
                                                    }}
                                                >
                                                    {selectedAssigneeInitials}
                                                    <span>{selectedAssigneeName || 'Unassigned'}</span>
                                                </button>
                                            </span>
                                        </>
                                    )}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-6 text-[#54656f]">
                            <Video className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                            <Phone className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                            <div className="w-px h-6 bg-[#eceff1] mx-1" />
                            <Search className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                            <User className="w-5 h-5 cursor-pointer hover:text-[#111b21]" onClick={() => setShowContactInfo(true)} />
                            <Trash2 className="w-5 h-5 cursor-pointer hover:text-rose-600" onClick={handleClearChat} />
                            <MoreVertical className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                        </div>
                    </header>

                    <div className="flex-1 min-h-0 px-16 py-6 z-10 flex flex-col">
                        {lastProfileError && (
                            <div className="self-center sticky top-2 z-20 mb-2 flex items-center gap-3 bg-[#fff4e5] border border-[#ffd9b3] text-[#7a4b00] px-3 py-2 rounded-xl text-[11px] font-bold shadow-sm">
                                <span className="flex-1">{lastProfileError}</span>
                                <button
                                    onClick={() => setLastProfileError(null)}
                                    className="text-[#7a4b00] hover:bg-[#ffe7cc] p-1 rounded-md transition-all"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        )}
                        <div className="flex-1 min-h-0 overflow-hidden custom-scrollbar" ref={messageViewportRef}>
                            {messageRows.length === 0 ? (
                                <div className="h-full flex items-center justify-center text-sm text-[#8696a0]">
                                    No messages yet.
                                </div>
                            ) : messageViewport.height > 0 ? (
                                <List
                                    listRef={messageListRef}
                                    style={{
                                        height: messageViewport.height,
                                        width: messageViewport.width || '100%'
                                    }}
                                    rowCount={messageRows.length}
                                    rowHeight={messageRowHeight}
                                    rowProps={{}}
                                    overscanCount={8}
                                    className="custom-scrollbar"
                                    rowComponent={(props: any) => {
                                        const { index, style } = props as { index: number; style: React.CSSProperties };
                                        const row = messageRows[index];
                                        if (!row) return null;
                                        if (row.kind === 'date') {
                                            return (
                                                <div style={style} className="flex items-center justify-center">
                                                    <div className="px-3 py-1 rounded-full bg-[#e9edef] text-[11px] font-bold text-[#54656f] shadow-sm border border-[#d7dfe5]">
                                                        {row.label}
                                                    </div>
                                                </div>
                                            );
                                        }

                                        const msg = row.msg;
                                        const key = row.id;
                                        const buttonsMessage = msg.message?.buttonsMessage;
                                        const listMessage = msg.message?.listMessage;
                                        const messageText = getMessagePreviewText(msg);
                                        const messageSenderName = msg.key.fromMe
                                            ? (msg.workflowState ? 'Automation' : (msg.agent?.name || currentAgentName || 'You'))
                                            : null;
                                        const messageSenderColor = msg.workflowState ? '#2563eb' : (msg.agent?.color || '#6b7280');
                                        const buttons = Array.isArray(buttonsMessage?.buttons) ? buttonsMessage?.buttons : [];
                                        const listSections = Array.isArray(listMessage?.sections) ? listMessage?.sections : [];

                                        return (
                                            <div style={style} className="w-full px-1">
                                                <div className={`w-full flex ${msg.key.fromMe ? 'justify-end' : 'justify-start'}`}>
                                                    <div className="max-w-[85%] flex flex-col">
                                                        <div className={`
                                                            px-3 py-1.5 rounded-xl text-[14px] shadow-[0_1px_0.5px_rgba(0,0,0,0.1)] relative mb-1 tracking-tight
                                                            ${msg.key.fromMe ? 'bg-[#d9fdd3] text-[#111b21] rounded-tr-none' : 'bg-white text-[#111b21] rounded-tl-none'}
                                                        `}>
                                                            {messageText && (
                                                                <p className="leading-relaxed whitespace-pre-wrap break-words pr-14">
                                                                    {messageText}
                                                                </p>
                                                            )}

                                                            {buttons.length > 0 && (
                                                                <div className="mt-2 space-y-1">
                                                                    {buttons.map((button: any, btnIdx: number) => (
                                                                        <div
                                                                            key={`${key}-btn-${btnIdx}`}
                                                                            className="px-3 py-2 rounded-lg border border-[#e2e8f0] bg-white/70 text-[13px] font-semibold text-[#111b21]"
                                                                        >
                                                                            {button?.buttonText?.displayText || button?.buttonId || `Button ${btnIdx + 1}`}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {buttonsMessage?.footerText && (
                                                                <div className="mt-1 text-[11px] text-[#54656f] font-medium">
                                                                    {buttonsMessage.footerText}
                                                                </div>
                                                            )}

                                                            {listMessage && (
                                                                <div className="mt-2 space-y-2">
                                                                    {listMessage.title && (
                                                                        <div className="text-[12px] font-bold text-[#111b21]">
                                                                            {listMessage.title}
                                                                        </div>
                                                                    )}
                                                                    {listMessage.buttonText && (
                                                                        <div className="px-3 py-2 rounded-lg bg-[#f0f2f5] text-[12px] font-bold text-[#111b21] border border-[#eceff1]">
                                                                            {listMessage.buttonText}
                                                                        </div>
                                                                    )}
                                                                    {listSections.map((section: any, sectionIdx: number) => {
                                                                        const rows = Array.isArray(section?.rows) ? section.rows : [];
                                                                        return (
                                                                            <div key={`${key}-section-${sectionIdx}`} className="space-y-1">
                                                                                {section?.title && (
                                                                                    <div className="text-[11px] font-bold uppercase tracking-tight text-[#54656f]">
                                                                                        {section.title}
                                                                                    </div>
                                                                                )}
                                                                                {rows.map((row: any, rowIdx: number) => (
                                                                                    <div key={`${key}-row-${sectionIdx}-${rowIdx}`} className="px-3 py-2 rounded-lg bg-white/70 border border-[#eceff1]">
                                                                                        <div className="text-[13px] font-semibold text-[#111b21]">
                                                                                            {row?.title || row?.rowId || `Option ${rowIdx + 1}`}
                                                                                        </div>
                                                                                        {row?.description && (
                                                                                            <div className="text-[11px] text-[#54656f] mt-0.5">
                                                                                                {row.description}
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        );
                                                                    })}
                                                                    {listMessage.footerText && (
                                                                        <div className="text-[11px] text-[#54656f]">
                                                                            {listMessage.footerText}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {msg.message?.imageMessage && (
                                                                <div className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden cursor-pointer bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]">
                                                                    {(() => {
                                                                        const mediaId = msg.message?.imageMessage?.mediaId;
                                                                        const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                        return cacheEntry ? (
                                                                            <img
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                                alt="WhatsApp Attachment"
                                                                                className="max-w-full h-auto block"
                                                                            />
                                                                        ) : (
                                                                            <div className="p-4 text-center" onClick={() => handleDownloadMedia(msg)}>
                                                                                <p className="text-xs text-[#54656f] font-bold">Loading image…</p>
                                                                            </div>
                                                                        );
                                                                    })()}
                                                                </div>
                                                            )}

                                                            {msg.message?.documentMessage && (() => {
                                                                const doc = msg.message.documentMessage;
                                                                const mediaId = doc.mediaId;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                const docName = doc.fileName || '';
                                                                const docMime = doc.mimetype || '';
                                                                const isImageDoc = Boolean(
                                                                    docMime.startsWith('image/') ||
                                                                    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(docName)
                                                                );

                                                                if (isImageDoc) {
                                                                    return (
                                                                        <div
                                                                            className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden cursor-pointer bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]"
                                                                            onClick={() => {
                                                                                if (!cacheEntry) {
                                                                                    handleDownloadMedia(msg);
                                                                                }
                                                                            }}
                                                                        >
                                                                            {cacheEntry ? (
                                                                                <img
                                                                                    src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                                    alt={docName || 'Image'}
                                                                                    className="max-w-full h-auto block"
                                                                                />
                                                                            ) : (
                                                                                <div className="p-4 text-center">
                                                                                    <p className="text-xs text-[#54656f] font-bold">Loading image…</p>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                }

                                                                return (
                                                                    <div
                                                                        className="mt-1 mb-1 p-3 bg-[#f8f9fa] rounded-xl flex items-center gap-3 cursor-pointer hover:bg-white transition-all border border-[#eceff1]"
                                                                        onClick={() => {
                                                                            if (cacheEntry) {
                                                                                const link = document.createElement('a');
                                                                                link.href = `data:${cacheEntry.mimetype};base64,${cacheEntry.data}`;
                                                                                link.download = doc.fileName || 'document';
                                                                                link.click();
                                                                            } else {
                                                                                handleDownloadMedia(msg);
                                                                            }
                                                                        }}
                                                                    >
                                                                        <div className="p-2 bg-[#00a884]/10 rounded-lg text-[#00a884]">
                                                                            <Paperclip className="w-5 h-5" />
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <p className="text-sm font-bold truncate text-[#111b21]">{doc.fileName || 'Document'}</p>
                                                                            <p className="text-[10px] text-[#54656f] font-bold uppercase tracking-tight">
                                                                                {Math.round((Number(doc.fileLength) || 0) / 1024)} KB • {doc.mimetype?.split('/')[1]?.toUpperCase() || 'FILE'}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}

                                                            {msg.message?.audioMessage && (() => {
                                                                const mediaId = msg.message?.audioMessage?.mediaId;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                return (
                                                                    <div className="mt-1 mb-1 p-3 bg-[#f8f9fa] rounded-xl border border-[#eceff1] w-[260px]">
                                                                        {cacheEntry ? (
                                                                            <audio
                                                                                controls
                                                                                className="w-full"
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                            />
                                                                        ) : (
                                                                            <div className="text-xs text-[#54656f] font-bold">
                                                                                Loading voice note…
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}

                                                            <div className="absolute bottom-1 right-2 flex items-center gap-1">
                                                                <span className="text-[10px] text-[#54656f]/70 font-bold">
                                                                    {msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
                                                                </span>
                                                                {renderMessageStatus(msg)}
                                                            </div>
                                                        </div>
                                                        {messageSenderName && (
                                                            <div
                                                                className="mt-0.5 px-1 text-[10px] font-medium text-right"
                                                                style={{ color: textColor(messageSenderColor, '#6b7280') }}
                                                            >
                                                                {messageSenderName}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>

                    <footer className="shrink-0 bg-[#f0f2f5] px-4 py-3 flex items-center gap-2 z-10 min-h-[62px]">
                        <div className="flex items-center text-[#54656f]">
                            <button type="button" className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer">
                                <Smile className="w-6 h-6" />
                            </button>
                            <button type="button" className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer" title="Photo">
                                <ImageIcon className="w-5 h-5" />
                            </button>
                            <button type="button" className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer" title="Document">
                                <FileIcon className="w-5 h-5" />
                            </button>
                            <button type="button" className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer" title="Attachment">
                                <Paperclip className="w-6 h-6 -rotate-45" />
                            </button>
                        </div>
                        {workflowStarter}
                        <div className="flex-1 mx-2 relative">
                            {!canSendText && (
                                <div className="absolute -top-8 left-0 px-3 py-1.5 rounded-lg bg-[#fff3e0] text-[#a16207] text-[11px] font-bold border border-[#fde68a]">
                                    24h window closed. Send a template.
                                </div>
                            )}
                            {canSendText && quickReplyQuery !== null && (
                                <div className="absolute bottom-[58px] left-0 right-0 bg-white border border-[#eceff1] rounded-2xl shadow-xl z-20 max-h-56 overflow-y-auto">
                                    {quickRepliesLoading ? (
                                        <div className="px-4 py-3 text-sm text-[#54656f]">Loading quick replies…</div>
                                    ) : quickReplySuggestions.length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-[#54656f]">No quick replies found.</div>
                                    ) : (
                                        quickReplySuggestions.map((item, idx) => (
                                            <button
                                                type="button"
                                                key={`${item.id || 'quick'}-${idx}`}
                                                onClick={() => handleQuickReplyPick(item)}
                                                className="w-full text-left px-4 py-3 hover:bg-[#f6f8f9] transition-all border-b border-[#f1f3f4] last:border-b-0"
                                            >
                                                <div className="text-xs font-bold uppercase tracking-widest text-[#00a884]">/{normalizeQuickReplyShortcut(item.shortcut)}</div>
                                                <div className="text-sm text-[#111b21] mt-1 max-h-10 overflow-hidden">
                                                    {item.text}
                                                </div>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                                <input
                                    ref={messageInputRef}
                                    type="text"
                                    placeholder={canSendText ? 'Type a message' : 'Type a message (24h closed - use template)'}
                                    value={messageText}
                                    disabled={!canSendText}
                                    onChange={(e) => setMessageTextWithDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        if (!canSendText) {
                                            e.preventDefault();
                                            setShowTemplateComposer(true);
                                            return;
                                        }
                                        if (quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                            e.preventDefault();
                                            handleQuickReplyPick(quickReplySuggestions[0]);
                                            return;
                                        }
                                        handleSendMessage();
                                    }
                                    if (canSendText && e.key === 'Tab' && quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                        e.preventDefault();
                                        handleQuickReplyPick(quickReplySuggestions[0]);
                                    }
                                }}
                                className={`w-full border border-[#eceff1] rounded-xl px-4 py-3 text-[15px] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 placeholder:text-[#54656f]/50 ${canSendText ? 'bg-white text-[#111b21]' : 'bg-[#f8f9fa] text-[#9ca3af] cursor-not-allowed'}`}
                            />
                        </div>
                        <div className="text-[#54656f] flex items-center gap-2">
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setShowTemplateComposer(prev => !prev)}
                                    className={`p-2 rounded-xl transition-all ${showTemplateComposer || !canSendText ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                    title="Send template message"
                                >
                                    <FileText className="w-5 h-5" />
                                </button>
                                {showTemplateComposer && (
                                    <div className="absolute bottom-[52px] right-0 w-[460px] max-w-[90vw] bg-white border border-[#eceff1] rounded-2xl shadow-xl z-30 p-3 space-y-2">
                                        <div className="text-[11px] font-bold uppercase tracking-widest text-[#54656f]">Send Template Message</div>
                                        <input
                                            type="text"
                                            placeholder="Template name"
                                            value={templateName}
                                            onChange={(e) => setTemplateName(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        <input
                                            type="text"
                                            placeholder="Language (e.g. en_US)"
                                            value={templateLanguage}
                                            onChange={(e) => setTemplateLanguage(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        <input
                                            type="text"
                                            placeholder='Components JSON (optional)'
                                            value={templateComponents}
                                            onChange={(e) => setTemplateComponents(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        <div className="flex justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowTemplateComposer(false)}
                                                className="px-3 py-2 rounded-xl text-xs font-bold text-[#54656f] hover:bg-[#f0f2f5]"
                                            >
                                                Close
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleSendTemplate}
                                                className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-xs font-bold hover:bg-[#008f6f]"
                                            >
                                                Send Template
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {canSendText ? (
                                messageText.trim() ? (
                                    <div onClick={handleSendMessage} className="p-3 bg-[#00a884] shadow-sm rounded-xl cursor-pointer text-white transition-transform active:scale-95"><Send className="w-5 h-5" /></div>
                                ) : (
                                    <div className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer"><Mic className="w-6 h-6" /></div>
                                )
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setShowTemplateComposer(true)}
                                    className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-xs font-bold hover:bg-[#008f6f]"
                                >
                                    Template
                                </button>
                            )}
                        </div>
                    </footer>

                    {/* Contact Info Sidebar */}
                    {showContactInfo && (
                        <div
                            className="fixed inset-0 z-[180] flex items-center justify-center bg-black/25 backdrop-blur-sm p-4"
                            onClick={() => setShowContactInfo(false)}
                        >
                            <div
                                className="w-[360px] max-w-[92vw] max-h-[90vh] bg-white border border-[#eceff1] rounded-3xl shadow-[0_18px_60px_rgba(0,0,0,0.18)] flex flex-col overflow-hidden"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <header className="h-[54px] bg-[#f0f2f5] px-4 flex items-center gap-4 text-[#111b21] border-b border-[#eceff1]">
                                    <X className="w-5 h-5 cursor-pointer hover:text-[#54656f]" onClick={() => setShowContactInfo(false)} />
                                    <h2 className="text-[14px] font-bold">Contact Info</h2>
                                </header>

                                <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col items-center py-6 px-5 space-y-6">
                                    <div className="w-32 h-32 rounded-full bg-[#f0f2f5] flex items-center justify-center border border-[#eceff1] flex-shrink-0 shadow-sm">
                                        {selectedChat?.id.endsWith('@g.us') ? (
                                            <Users className="text-[#aebac1] w-16 h-16" />
                                        ) : (
                                            <User className="text-[#aebac1] w-16 h-16" />
                                        )}
                                    </div>

                                <div className="w-full text-center space-y-2">
                                    <div className="flex flex-col items-center gap-2">
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2.5 text-[14px] font-bold text-center focus:outline-none focus:border-[#00a884]"
                                            value={contactDraftName}
                                            onChange={(e) => {
                                                setContactDraftName(e.target.value);
                                                setContactDirty(true);
                                            }}
                                            placeholder="Contact name"
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                        />
                                        <button
                                            onClick={handleSaveContact}
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${contactDirty ? 'bg-[#00a884] text-white' : 'bg-[#f0f2f5] text-[#8696a0]'} `}
                                        >
                                            Save Contact
                                        </button>
                                    </div>
                                    <p className="text-[#54656f] text-[13px] mt-1 font-medium">
                                        {selectedChat?.id.endsWith('@g.us') ? 'Shared Group' : formatPhoneNumber(getCleanId(selectedChat?.id))}
                                    </p>
                                </div>

                                <div className="w-full space-y-3 bg-[#f8f9fa] p-4 rounded-2xl border border-[#eceff1]">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Phone number</span>
                                        <span className="text-[14px] font-bold text-[#111b21]">
                                            {selectedChat?.id.endsWith('@g.us') ? 'Enterprise Group' : formatPhoneNumber(getCleanId(selectedChat?.id))}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Assignee</span>
                                        {selectedChat?.id.endsWith('@g.us') ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">Group chat</span>
                                        ) : (
                                            <div className="w-fit">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!selectedChatId) return;
                                                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                        setAssignMenuContactId(prev => (prev === selectedChatId ? null : selectedChatId));
                                                    }}
                                                    className="inline-flex w-fit items-center gap-1 px-2 py-1 rounded-full border text-[12px] font-bold hover:opacity-85 transition-all"
                                                    style={{
                                                        backgroundColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '20', '#f3f4f6')
                                                            : '#f8f9fa',
                                                        borderColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '66', '#d1d5db')
                                                            : '#eceff1',
                                                        color: selectedAssigneeName
                                                            ? textColor(selectedAssigneeColor, '#374151')
                                                            : '#9ca3af'
                                                    }}
                                                >
                                                    {selectedAssigneeInitials}
                                                    <span>{selectedAssigneeName || 'Unassigned'}</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">24h Window</span>
                                        {lastInboundMs ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">
                                                {windowOpen ? `Open (${formatRemaining(windowRemainingMs || 0)} left)` : 'Closed (template required)'}
                                            </span>
                                        ) : (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">No inbound message yet</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#2563eb] font-bold uppercase tracking-wider">CTA Free Entry</span>
                                        {ctaFreeWindowOpen ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">
                                                Active ({formatRemaining(ctaFreeWindowRemainingMs || 0)} left for free template sends)
                                            </span>
                                        ) : (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">Not active</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">WABA Info</span>
                                        <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">This conversation is handled through Meta's WhatsApp Business Cloud API.</span>
                                    </div>
                                    <div className="flex flex-col gap-2.5 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Tags</span>
                                        <div className="flex flex-wrap gap-2">
                                            {contactTagsDraft.length === 0 && (
                                                <span className="text-[11px] text-[#8696a0]">No tags yet</span>
                                            )}
                                            {contactTagsDraft.map(tag => (
                                                <span key={tag} className="flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-[#eceff1] text-[10px] font-bold text-[#111b21]">
                                                    {tag}
                                                    <button
                                                        onClick={() => handleRemoveTag(tag)}
                                                        className="text-[#a0a8af] hover:text-rose-500"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                className="flex-1 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-[#00a884]"
                                                value={contactTagInput}
                                                onChange={(e) => setContactTagInput(e.target.value)}
                                                placeholder="Add tag"
                                                onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                                            />
                                            <button
                                                onClick={handleAddTag}
                                                className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-[10px] font-bold uppercase tracking-widest"
                                            >
                                                Add
                                            </button>
                                            <button
                                                onClick={handleSaveContact}
                                                className="px-3 py-2 rounded-xl bg-[#111b21] text-white text-[10px] font-bold uppercase tracking-widest"
                                            >
                                                Save
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="w-full pt-2">
                                    <button
                                        onClick={() => {
                                            handleClearChat();
                                            setShowContactInfo(false);
                                        }}
                                        className="w-full py-3 bg-white hover:bg-rose-50 text-rose-500 font-bold rounded-2xl transition-all border border-rose-100 flex items-center justify-center gap-2 text-[12px]"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Clear History
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    )}
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-[#fcfdfd] relative">
                    <div className="absolute inset-x-0 bottom-0 h-1.5 bg-[#00a884] z-20" />
                    <div className="text-center relative z-10 px-6">
                        {loadingChats && (
                            <div className="flex flex-col items-center gap-4 mb-10">
                                <div className="w-10 h-10 rounded-full border-4 border-[#e5e7eb] border-t-[#00a884] animate-spin" />
                                <div className="text-xs font-bold uppercase tracking-widest text-[#54656f]">Loading chats…</div>
                            </div>
                        )}
                        <div className="mb-12 flex justify-center scale-110">
                            <img src="https://static.whatsapp.net/rsrc.php/v4/y6/r/wa699kaDcnU.png" className="w-[300px] opacity-80" />
                        </div>
                        <h1 className="text-[32px] font-bold text-[#111b21] mb-2 tracking-tight">Nexus WABA Console</h1>
                        <p className="text-[#54656f] text-[15px] leading-relaxed mb-12 max-w-sm mx-auto font-medium">
                            Manage WhatsApp Business API conversations in one clean dashboard.
                        </p>
                        <div className="flex items-center justify-center gap-2 text-[#54656f] text-[12px] font-bold uppercase tracking-widest bg-[#f0f2f5] py-2 px-6 rounded-full w-fit mx-auto shadow-sm">
                            <ShieldCheck className="w-4 h-4 text-[#00a884]" />
                            Enterprise Grade Security
                        </div>
                    </div>

                </div>
            )}



            {/* Add Profile Modal */}
            {
                !SINGLE_PROFILE_MODE && showAddProfileModal && (
                    <div className="fixed inset-0 bg-white/60 backdrop-blur-md flex items-center justify-center z-[200]">
                        <div className="bg-white p-8 rounded-3xl w-full max-w-md shadow-[0_20px_60px_rgba(0,0,0,0.1)] border border-[#eceff1]">
                            <h2 className="text-2xl font-bold mb-6 text-[#111b21]">Add New Profile</h2>
                            <label className="block text-sm text-[#54656f] mb-2 font-medium">Profile Name</label>
                            <input
                                type="text"
                                placeholder="e.g. Sales Account, Support Bot"
                                value={newProfileName}
                                onChange={(e) => setNewProfileName(e.target.value)}
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-4 mb-6 focus:border-[#00a884] outline-none text-[#111b21] font-medium"
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && submitAddProfile()}
                            />
                            <div className="flex justify-end gap-3">
                                <button
                                    onClick={() => setShowAddProfileModal(false)}
                                    className="px-6 py-3 text-[#54656f] font-bold hover:bg-[#f0f2f5] rounded-xl transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={submitAddProfile}
                                    disabled={isCreatingProfile || !newProfileName.trim()}
                                    className="bg-[#00a884] text-white px-8 py-3 rounded-xl font-bold shadow-[0_4px_12px_rgba(0,168,132,0.2)] hover:shadow-[0_8px_20px_rgba(0,168,132,0.3)] disabled:opacity-50 transition-all"
                                >
                                    {isCreatingProfile ? 'Creating...' : 'Create Profile'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Edit Profile Modal */}
            {
                !SINGLE_PROFILE_MODE && showEditProfileModal && (
                    <div className="fixed inset-0 bg-white/60 backdrop-blur-md flex items-center justify-center z-[200]">
                        <div className="bg-white p-8 rounded-3xl w-full max-w-md shadow-[0_20px_60px_rgba(0,0,0,0.1)] border border-[#eceff1]">
                            <h2 className="text-2xl font-bold mb-6 text-[#111b21]">Edit Profile Name</h2>
                            <label className="block text-sm text-[#54656f] mb-2 font-medium">New Name</label>
                            <input
                                type="text"
                                value={editingProfileName}
                                onChange={(e) => setEditingProfileName(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && submitUpdateProfileName()}
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-4 mb-6 focus:border-[#00a884] outline-none text-[#111b21] font-medium"
                            />
                            <div className="flex justify-end gap-3">
                                <button
                                    onClick={() => setShowEditProfileModal(false)}
                                    className="px-6 py-3 text-[#54656f] font-bold hover:bg-[#f0f2f5] rounded-xl transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={submitUpdateProfileName}
                                    className="bg-[#00a884] text-white px-8 py-3 rounded-xl font-bold shadow-[0_4px_12px_rgba(0,168,132,0.2)] hover:shadow-[0_8px_20px_rgba(0,168,132,0.3)] transition-all"
                                >
                                    Save Changes
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* New Chat Modal */}
            {
                showNewChatModal && (
                    <div className="fixed inset-0 bg-white/60 backdrop-blur-md flex items-center justify-center z-[200]">
                        <div className="bg-white p-8 rounded-3xl w-full max-w-md shadow-[0_20px_60px_rgba(0,0,0,0.1)] border border-[#eceff1]">
                            <h2 className="text-2xl font-bold mb-6 text-[#111b21]">Direct Message</h2>
                            <p className="text-[#54656f] text-sm mb-4">Enter the phone number with country code (e.g. 60123456789)</p>
                            <input
                                type="text"
                                placeholder="Phone number..."
                                value={newPhoneNumber}
                                onChange={(e) => setNewPhoneNumber(e.target.value)}
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-4 mb-6 focus:border-[#00a884] outline-none text-[#111b21] font-medium"
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && handleNewChat()}
                            />
                            <div className="flex justify-end gap-3">
                                <button
                                    onClick={() => setShowNewChatModal(false)}
                                    className="px-6 py-3 text-[#54656f] font-bold hover:bg-[#f0f2f5] rounded-xl transition-all"
                                >
                                    Close
                                </button>
                                <button
                                    onClick={handleNewChat}
                                    className="bg-[#00a884] text-white px-8 py-3 rounded-xl font-bold shadow-[0_4px_12px_rgba(0,168,132,0.2)] hover:shadow-[0_8px_20px_rgba(0,168,132,0.3)] transition-all"
                                >
                                    Open Chat
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Chat Flow Setup View */}
            {
                activeView === 'chatflow' && (
                    <div className="fixed inset-0 bg-[#f8f9fa] z-[150] flex flex-col">
                        <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                            <div className="flex items-center gap-4">
                                <Workflow className="text-[#00a884] w-8 h-8" />
                                <h1 className="text-xl font-bold text-[#111b21]">WABA Workflow Builder</h1>
                            </div>
                            <div className="flex items-center gap-4">
                                <button
                                    onClick={() => handleSaveWorkflows(workflows)}
                                    className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors shadow-sm"
                                >
                                    <Save className="w-4 h-4" /> Save Workflows
                                </button>
                                <button onClick={() => setActiveView('dashboard')} className="p-2 hover:bg-white rounded-xl transition-all"><X className="w-6 h-6 text-[#54656f]" /></button>
                            </div>
                        </header>

                        <div className="flex-1 overflow-hidden bg-white flex">
                            {/* Sidebar */}
                            <div className="w-80 border-r border-[#eceff1] flex flex-col bg-[#fcfdfd]">
                                <div className="p-6 border-b border-[#eceff1]">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs font-bold text-[#54656f] uppercase tracking-wider">Your Workflows</span>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => {
                                                    const id = `wf-${Date.now()}`
                                                    const actions = [{ type: 'send_text', text: 'Hello! How can we help you?' }]
                                                    const newWf = {
                                                        id,
                                                        trigger_keyword: 'hai',
                                                        actions,
                                                        builder: buildBuilderFromActions(actions, id)
                                                    }
                                                    setWorkflows(prev => [...prev, newWf])
                                                    setWorkflowDrafts(prev => ({
                                                        ...prev,
                                                        [id]: JSON.stringify(actions, null, 2)
                                                    }))
                                                    setSelectedWorkflowId(id)
                                                }}
                                                className="text-[#00a884] hover:bg-[#00a884]/10 p-1.5 rounded-lg transition-all"
                                                title="Create 'hai' flow"
                                            >
                                                <Plus className="w-5 h-5" />
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const id = `welcome-${Date.now()}`
                                                    const actions = [{ type: 'send_text', text: 'Welcome! How can we help you?' }]
                                                    const newWf = {
                                                        id,
                                                        trigger_keyword: 'request_welcome',
                                                        actions,
                                                        builder: buildBuilderFromActions(actions, id)
                                                    }
                                                    setWorkflows(prev => [...prev, newWf])
                                                    setWorkflowDrafts(prev => ({
                                                        ...prev,
                                                        [id]: JSON.stringify(actions, null, 2)
                                                    }))
                                                    setSelectedWorkflowId(id)
                                                }}
                                                className="text-[#00a884] hover:bg-[#00a884]/10 p-1.5 rounded-lg transition-all"
                                                title="Create welcome flow"
                                            >
                                                <MessageSquare className="w-5 h-5" />
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-[11px] text-[#8696a0] leading-relaxed">
                                        Create a quick “hai” flow or a welcome flow (request_welcome).
                                    </p>
                                </div>

                                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                                    {workflows.map((wf: any) => (
                                        <div
                                            key={wf.id}
                                            onClick={() => setSelectedWorkflowId(wf.id)}
                                            className={`group p-4 rounded-2xl cursor-pointer border-2 transition-all ${selectedWorkflowId === wf.id ? 'bg-[#00a884]/5 border-[#00a884]' : 'bg-white border-[#f0f2f5] hover:border-[#00a884]/30 hover:shadow-sm'}`}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <span className={`text-sm font-bold ${selectedWorkflowId === wf.id ? 'text-[#111b21]' : 'text-[#54656f]'}`}>{wf.id}</span>
                                                <Trash2
                                                    className="w-4 h-4 text-rose-500 opacity-0 group-hover:opacity-100 cursor-pointer hover:scale-110 transition-all"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setWorkflows(prev => prev.filter(item => item.id !== wf.id))
                                                        setWorkflowDrafts(prev => {
                                                            const next = { ...prev }
                                                            delete next[wf.id]
                                                            return next
                                                        })
                                                        if (selectedWorkflowId === wf.id) setSelectedWorkflowId(null)
                                                    }}
                                                />
                                            </div>
                                            <div className="flex gap-1.5 flex-wrap">
                                                <span className="text-[10px] bg-white text-[#00a884] px-2 py-0.5 rounded-full border border-[#00a884]/20 font-bold uppercase tracking-tight">
                                                    {wf.trigger_keyword || 'no-trigger'}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Editor */}
                            <div className="flex-1 flex flex-col">
                                {selectedWorkflowId ? (
                                    <div className="flex-1 flex flex-col p-8 gap-6 overflow-y-auto">
                                        {(() => {
                                            const wf = workflows.find(w => w.id === selectedWorkflowId)
                                            if (!wf) return null
                                            return (
                                                <>
                                                    <div className="flex flex-col gap-2">
                                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider">Trigger Keyword</label>
                                                        <input
                                                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-3 text-[#111b21] text-sm font-bold focus:outline-none focus:border-[#00a884]"
                                                            value={wf.trigger_keyword || ''}
                                                            onChange={(e) => {
                                                                const val = e.target.value
                                                                setWorkflows(prev => prev.map(item => item.id === wf.id ? { ...item, trigger_keyword: val } : item))
                                                            }}
                                                            placeholder="e.g. hai"
                                                        />
                                                        <span className="text-[11px] text-[#8696a0]">
                                                            Tip: use <code className="font-mono">first_message</code> to trigger on a user's first inbound message.
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-3 flex-wrap">
                                                        <button
                                                            onClick={() => setWorkflowEditorMode('visual')}
                                                            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${workflowEditorMode === 'visual'
                                                                ? 'bg-[#00a884]/10 border-[#00a884] text-[#00a884]'
                                                                : 'bg-white border-[#eceff1] text-[#54656f] hover:border-[#00a884]/30'
                                                                }`}
                                                        >
                                                            Visual Builder
                                                        </button>
                                                        <button
                                                            onClick={() => setWorkflowEditorMode('json')}
                                                            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${workflowEditorMode === 'json'
                                                                ? 'bg-[#00a884]/10 border-[#00a884] text-[#00a884]'
                                                                : 'bg-white border-[#eceff1] text-[#54656f] hover:border-[#00a884]/30'
                                                                }`}
                                                        >
                                                            JSON Actions
                                                        </button>
                                                        <span className="text-[11px] text-[#8696a0]">
                                                            Visual builder supports `send_text`, `send_buttons`, `send_list`, `send_cta_url`. Saving visual overwrites actions.
                                                        </span>
                                                    </div>
                                                    {workflowEditorMode === 'visual' ? (
                                                        <div className="border border-[#eceff1] rounded-2xl overflow-hidden bg-white min-h-[560px] h-[70vh]">
                                                            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[#54656f]">Loading flow editor…</div>}>
                                                                <LazyFlowCanvas
                                                                    flow={wf.builder || buildBuilderFromActions(wf.actions || [], wf.id)}
                                                                    onSave={(nextFlow) => {
                                                                        const { actions } = buildActionsFromBuilder(nextFlow);
                                                                        const nextWorkflows = workflows.map(item =>
                                                                            item.id === wf.id ? { ...item, actions, builder: nextFlow } : item
                                                                        );
                                                                        const nextDrafts = { ...workflowDrafts, [wf.id]: JSON.stringify(actions, null, 2) };
                                                                        setWorkflows(nextWorkflows);
                                                                        setWorkflowDrafts(nextDrafts);
                                                                        // Persist immediately so visual builder Save works as expected.
                                                                        handleSaveWorkflows(nextWorkflows, nextDrafts);
                                                                    }}
                                                                />
                                                            </Suspense>
                                                        </div>
                                                    ) : (
                                                        <div className="flex flex-col gap-2">
                                                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider">Actions (JSON)</label>
                                                            <textarea
                                                                className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-3 text-[#111b21] text-xs h-64 font-mono focus:outline-none focus:border-[#00a884]"
                                                                value={workflowDrafts[wf.id] || JSON.stringify(wf.actions || [], null, 2)}
                                                                onChange={(e) => {
                                                                    const next = e.target.value
                                                                    setWorkflowDrafts(prev => ({ ...prev, [wf.id]: next }))
                                                                }}
                                                            />
                                                            <p className="text-[11px] text-[#8696a0]">
                                                                Examples:
                                                                {" "}
                                                                <code className="font-mono">[{`{ "type": "send_text", "text": "Hello!" }`}]</code>
                                                                {" "}
                                                                <code className="font-mono">[{`{ "type": "send_cta_url", "body": "Tap below", "button_text": "Open", "url": "https://example.com" }`}]</code>
                                                            </p>
                                                        </div>
                                                    )}
                                                </>
                                            )
                                        })()}
                                    </div>
                                ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center text-[#8696a0] opacity-50">
                                        <GitBranch className="w-16 h-16 mb-4" />
                                        <p>Select or create a workflow to start</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Settings View */}
            {
                activeView === 'settings' && (
                    <div className="fixed inset-0 bg-[#f8f9fa] z-[150] flex flex-col">
                        <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                            <div className="flex items-center gap-4">
                                <Settings className="text-[#00a884] w-8 h-8" />
                                <h1 className="text-xl font-bold text-[#111b21]">Settings</h1>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={handleSignOut}
                                    className="px-4 py-2 rounded-xl bg-white text-rose-500 font-bold border border-[#eceff1] hover:bg-rose-50 transition-all flex items-center gap-2"
                                >
                                    <LogOut className="w-4 h-4" />
                                    Log Out
                                </button>
                                <button onClick={() => setActiveView('dashboard')} className="p-2 hover:bg-white rounded-xl transition-all">
                                    <X className="w-6 h-6 text-[#54656f]" />
                                </button>
                            </div>
                        </header>
                        <div className="flex-1 flex overflow-hidden">
                            <aside className="w-64 bg-white border-r border-[#eceff1] px-5 py-6 overflow-y-auto">
                                <p className="text-[10px] font-black uppercase tracking-widest text-[#54656f] mb-4">Settings</p>
                                <div className="space-y-6">
                                    {settingsNav.map(section => (
                                        <div key={section.group}>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-[#8696a0] mb-2">{section.group}</p>
                                            <div className="flex flex-col gap-2">
                                                {section.items.map(item => (
                                                    <button
                                                        key={item.id}
                                                        onClick={() => scrollToSettingsSection(item.id)}
                                                        className="text-left px-3 py-2 rounded-xl text-sm font-bold text-[#111b21] hover:bg-[#f0f2f5] transition-all"
                                                    >
                                                        {item.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </aside>
                            <div className="flex-1 overflow-y-auto">
                                <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading settings…</div>}>
                                    <LazyWebhookView
                                        profileId={activeProfileId || ''}
                                        sessionToken={session?.access_token || null}
                                        isAdmin={isAdmin}
                                        quickReplies={quickReplies}
                                        quickRepliesLoading={quickRepliesLoading}
                                        quickRepliesSaving={quickRepliesSaving}
                                        quickRepliesError={quickRepliesError}
                                        onRefreshQuickReplies={fetchQuickReplies}
                                        onSaveQuickReplies={saveQuickReplies}
                                    />
                                </Suspense>
                            </div>
                        </div>
                    </div>
                )
            }

            {showAnalytics && (
                <div className="fixed inset-0 bg-[#f8f9fa] z-[160] flex flex-col">
                    <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                        <div className="flex items-center gap-4">
                            <CircleDashed className="text-[#00a884] w-7 h-7" />
                            <h1 className="text-xl font-bold text-[#111b21]">Analytics</h1>
                        </div>
                        <button onClick={() => setShowAnalytics(false)} className="p-2 hover:bg-white rounded-xl transition-all">
                            <X className="w-6 h-6 text-[#54656f]" />
                        </button>
                    </header>
                    <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                        <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] mb-8">
                            <div className="flex flex-col lg:flex-row lg:items-end gap-4">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Start Date</label>
                                    <input
                                        type="date"
                                        value={analyticsStart}
                                        onChange={(e) => setAnalyticsStart(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">End Date</label>
                                    <input
                                        type="date"
                                        value={analyticsEnd}
                                        onChange={(e) => setAnalyticsEnd(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Tag</label>
                                    <select
                                        value={analyticsTag}
                                        onChange={(e) => setAnalyticsTag(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    >
                                        <option value="">All tags</option>
                                        {(analyticsData?.tags || []).map((tag: string) => (
                                            <option key={tag} value={tag}>{tag}</option>
                                        ))}
                                    </select>
                                </div>
                                <button
                                    onClick={fetchAnalytics}
                                    disabled={analyticsLoading}
                                    className="h-[42px] px-5 rounded-xl bg-[#111b21] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#202c33] transition-all disabled:opacity-50"
                                >
                                    {analyticsLoading ? 'Loading…' : 'Apply'}
                                </button>
                            </div>
                            {analyticsError && (
                                <div className="mt-4 text-sm text-rose-600 font-medium">{analyticsError}</div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Total Messages</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsData?.totals?.messages_total ?? 0}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Messages Sent</div>
                                <div className="text-3xl font-black text-[#00a884]">{analyticsData?.totals?.messages_sent ?? 0}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Workflow Runs</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsData?.totals?.workflow_runs ?? 0}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Expired Messages</div>
                                <div className="text-3xl font-black text-rose-600">{analyticsData?.totals?.expired_messages ?? 0}</div>
                            </div>
                        </div>

                        <div className="bg-white rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden">
                            <table className="w-full text-left">
                                <thead className="bg-[#fcfdfd] text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                    <tr>
                                        <th className="px-6 py-4">Date</th>
                                        <th className="px-6 py-4">Total Messages</th>
                                        <th className="px-6 py-4">Inbound</th>
                                        <th className="px-6 py-4">Sent</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#f0f2f5]">
                                    {(analyticsData?.per_day || []).length === 0 ? (
                                        <tr>
                                            <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={4}>
                                                No analytics data for this range.
                                            </td>
                                        </tr>
                                    ) : (
                                        (analyticsData?.per_day || []).map((row: any) => (
                                            <tr key={row.date} className="hover:bg-[#f8f9fa] transition-all">
                                                <td className="px-6 py-4 text-sm font-bold text-[#111b21]">{row.date}</td>
                                                <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.total}</td>
                                                <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.inbound}</td>
                                                <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.sent}</td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* Admin View is handled above - deleting redundant block if any */}

            <div className="fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-3">
                {import.meta.env.DEV && (
                    <DebugButton
                        payload={{
                            ts: new Date().toISOString(),
                            env: {
                                mode: import.meta.env.MODE,
                                socketUrl: SOCKET_URL
                            },
                            session: {
                                userId: session.user.id,
                                email: session.user.email || null,
                                companyId:
                                    (session.user.user_metadata as any)?.company_id ||
                                    (session.user.app_metadata as any)?.company_id ||
                                    null,
                                expiresAt: session.expires_at || null,
                                accessToken: redactSecret(session.access_token)
                            },
                            socket: {
                                connected: Boolean(socket?.connected),
                                id: socket?.id || null
                            },
                            state: {
                                isAdmin,
                                activeView,
                                activeProfileId: activeProfileId || null,
                                connectionStatus,
                                selectedChatId: selectedChatId || null,
                                windowOpen,
                                forceTemplateMode,
                                lastProfileError
                            },
                            counts: {
                                profiles: profiles.length,
                                chats: chatList.length,
                                messages: allMessages.length,
                                logs: logEntries.length
                            },
                            serverStats
                        }}
                    />
                )}
                {logOpen && (
                    <div className="w-[360px] max-h-[60vh] bg-white border border-[#eceff1] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] overflow-hidden">
                        <div className="px-4 py-3 border-b border-[#eceff1] flex items-center gap-2">
                            <Bug className="w-4 h-4 text-[#00a884]" />
                            <span className="text-sm font-bold text-[#111b21]">Flow Logs</span>
                            <button
                                onClick={() => setLogEntries([])}
                                className="ml-auto text-[11px] font-bold text-[#00a884] hover:text-[#008f6f]"
                            >
                                Clear
                            </button>
                            <button
                                onClick={() => setLogOpen(false)}
                                className="text-[#54656f] hover:text-[#111b21] p-1 rounded-md"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="px-4 py-3 border-b border-[#eceff1] bg-[#fcfdfd]">
                            <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">CPU</div>
                                    <div className="text-[12px] font-black text-[#111b21]">
                                        {serverStats?.cpu !== undefined ? `${serverStats.cpu}%` : '--'}
                                    </div>
                                </div>
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">RAM</div>
                                    <div className="text-[12px] font-black text-[#111b21]">
                                        {serverStats?.memUsed !== undefined && serverStats?.memTotal !== undefined
                                            ? `${formatBytes(serverStats.memUsed)} / ${formatBytes(serverStats.memTotal)}`
                                            : '--'}
                                    </div>
                                    <div className="text-[10px] font-medium text-[#54656f]">
                                        {serverStats?.memPct !== undefined ? `${serverStats.memPct}% used` : ''}
                                    </div>
                                </div>
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">Bandwidth</div>
                                    <div className="text-[11px] font-black text-[#111b21]">
                                        ↑ {formatBps(serverStats?.bandwidth?.outBps)}
                                    </div>
                                    <div className="text-[11px] font-black text-[#111b21]">
                                        ↓ {formatBps(serverStats?.bandwidth?.inBps)}
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="max-h-[50vh] overflow-y-auto custom-scrollbar">
                            {logEntries.length === 0 ? (
                                <div className="px-4 py-6 text-xs text-[#8696a0] text-center">
                                    No logs yet.
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2 px-4 py-3">
                                    {logEntries.slice().reverse().map(entry => (
                                        <div key={entry.id} className="border border-[#f0f2f5] rounded-xl px-3 py-2 bg-[#f8f9fa]">
                                            <div className="flex items-center gap-2 text-[10px] font-bold text-[#54656f]">
                                                <span>{formatLogTime(entry.ts)}</span>
                                                <span className={`px-2 py-0.5 rounded-full ${entry.level === 'error' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                                    {entry.level.toUpperCase()}
                                                </span>
                                            </div>
                                            <div className="text-[12px] text-[#111b21] mt-1 break-words">
                                                {entry.message}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
                <button
                    onClick={() => setLogOpen(prev => !prev)}
                    className="flex items-center gap-2 bg-[#111b21] text-white px-4 py-2 rounded-full shadow-lg hover:bg-[#202c33] transition-all"
                >
                    <Bug className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-widest">Logs</span>
                    {logEntries.length > 0 && (
                        <span className="ml-1 bg-[#00a884] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                            {logEntries.length}
                        </span>
                    )}
                </button>
            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
                .custom-scrollbar::-webkit-scrollbar {
                  width: 6px !important;
                }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #ced0d6; border-radius: 10px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #aebac1; }
                
                input::placeholder { color: #54656f; opacity: 0.5; }
                textarea::placeholder { color: #54656f; opacity: 0.5; }
                
                * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
            ` }} />
                </div>
            ) : workspaceSection === 'broadcast' ? (
                <div className="h-screen pt-[72px] bg-[#f1f3f6] text-[#111b21] font-sans">
                    <div className="h-full flex">
                        <aside className="w-72 bg-white border-r border-[#eceff1] p-5">
                            <div className="mb-4">
                                <h2 className="text-xl font-black text-[#111b21]">Broadcast</h2>
                                <p className="text-xs text-[#6b7280] mt-1">Campaign and template workspace</p>
                            </div>
                            <div className="space-y-2">
                                {broadcastNav.map((item) => (
                                    <button
                                        key={item.id}
                                        onClick={() => setBroadcastSection(item.id)}
                                        className={`w-full text-left px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${broadcastSection === item.id
                                            ? 'bg-[#00a884]/10 text-[#00a884]'
                                            : 'text-[#111b21] hover:bg-[#f3f4f6]'
                                            }`}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        </aside>

                        <main className="flex-1 overflow-hidden">
                            {broadcastSection === 'template-library' && (
                                <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading template builder…</div>}>
                                    <LazyBroadcastTemplateBuilder
                                        profileId={activeProfileId || ''}
                                        sessionToken={session?.access_token || null}
                                        onClose={() => setBroadcastSection('my-templates')}
                                        embedded
                                    />
                                </Suspense>
                            )}
                            {broadcastSection === 'my-templates' && (
                                <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading templates…</div>}>
                                    <LazyBroadcastTemplatesList
                                        profileId={activeProfileId || ''}
                                        sessionToken={session?.access_token || null}
                                        title="My Templates"
                                    />
                                </Suspense>
                            )}
                            {broadcastSection === 'broadcast-history' && (
                                <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                                    <div className="bg-white rounded-3xl border border-[#eceff1] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                                        <h3 className="text-2xl font-black text-[#111b21] mb-2">Broadcast History</h3>
                                        <p className="text-sm text-[#54656f]">
                                            Broadcast send logs will appear here once you start campaigns.
                                        </p>
                                    </div>
                                </div>
                            )}
                            {broadcastSection === 'scheduled-broadcasts' && (
                                <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                                    <div className="bg-white rounded-3xl border border-[#eceff1] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                                        <h3 className="text-2xl font-black text-[#111b21] mb-2">Scheduled Broadcasts</h3>
                                        <p className="text-sm text-[#54656f]">
                                            Upcoming scheduled broadcasts will appear here.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </main>
                    </div>
                </div>
            ) : workspaceSection === 'contacts' ? (
                <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
                    <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
                        <div className="bg-white border border-[#eceff1] rounded-3xl p-5 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                <div>
                                    <h2 className="text-2xl font-black text-[#111b21]">Saved Contacts</h2>
                                    <p className="text-sm text-[#54656f] mt-1">
                                        New contacts are auto-saved when messages are received or sent.
                                    </p>
                                    <p className="text-[11px] text-[#8696a0] mt-1">
                                        {teamUsersLoading ? 'Loading staff…' : `${teamUsers.length} staff available for assignment`}
                                    </p>
                                </div>
                                <div className="w-full md:w-[360px] bg-[#f0f2f5] rounded-xl flex items-center px-4 py-2.5 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#00a884]/20 transition-all">
                                    <Search className="w-4 h-4 text-[#54656f] mr-3" />
                                    <input
                                        type="text"
                                        placeholder="Search contact, phone or tag"
                                        value={contactsSearchQuery}
                                        onChange={(e) => setContactsSearchQuery(e.target.value)}
                                        className="bg-transparent border-none text-[14px] w-full focus:outline-none placeholder:text-[#54656f]"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 min-h-0 bg-white border border-[#eceff1] rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] overflow-hidden">
                            {contactsList.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-center px-6">
                                    <Users className="w-12 h-12 text-[#aebac1] mb-3" />
                                    <p className="text-[#111b21] font-bold">No saved contacts</p>
                                    <p className="text-sm text-[#8696a0] mt-1">
                                        Contacts will appear here automatically when conversations happen.
                                    </p>
                                </div>
                            ) : (
                                <div className="h-full overflow-y-auto custom-scrollbar">
                                    <div className="grid grid-cols-[minmax(260px,1.5fr)_minmax(180px,1fr)_120px_140px_190px_120px] sticky top-0 z-10 bg-[#f8f9fa] border-b border-[#eceff1] text-[10px] font-black uppercase tracking-widest text-[#54656f]">
                                        <div className="px-4 py-3">Contact</div>
                                        <div className="px-4 py-3">Tags</div>
                                        <div className="px-4 py-3">Messages</div>
                                        <div className="px-4 py-3">Assignee</div>
                                        <div className="px-4 py-3">Last Inbound</div>
                                        <div className="px-4 py-3">Action</div>
                                    </div>
                                    {contactsList.map((row) => (
                                        <div key={row.id} className="grid grid-cols-[minmax(260px,1.5fr)_minmax(180px,1fr)_120px_140px_190px_120px] border-b border-[#f0f2f5] hover:bg-[#fcfdfd] transition-colors">
                                            <div className="px-4 py-3 min-w-0">
                                                <div className="font-bold text-[#111b21] truncate">{row.name}</div>
                                                <div className="text-[12px] text-[#00a884] font-bold mt-0.5">{row.phone}</div>
                                            </div>
                                            <div className="px-4 py-3 min-w-0">
                                                {row.tags.length === 0 ? (
                                                    <span className="text-[12px] text-[#9ca3af]">-</span>
                                                ) : (
                                                    <div className="flex flex-wrap gap-1">
                                                        {row.tags.slice(0, 3).map((tag) => (
                                                            <span key={tag} className="px-2 py-0.5 rounded-full bg-[#f0f2f5] border border-[#eceff1] text-[10px] font-bold text-[#54656f]">
                                                                {tag}
                                                            </span>
                                                        ))}
                                                        {row.tags.length > 3 && (
                                                            <span className="text-[11px] text-[#8696a0] font-bold">+{row.tags.length - 3}</span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="px-4 py-3 text-[13px] font-bold text-[#111b21]">{row.totalMessages}</div>
                                            <div className="px-4 py-3 min-w-0">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                        setAssignMenuContactId(prev => (prev === row.id ? null : row.id));
                                                    }}
                                                    disabled={assigningContactId === row.id}
                                                    className="inline-flex max-w-full items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold hover:opacity-85 transition-all disabled:opacity-60"
                                                    style={{
                                                        backgroundColor: row.assigneeName
                                                            ? withHexAlpha(row.assigneeColor, '20', '#f3f4f6')
                                                            : '#f8f9fa',
                                                        borderColor: row.assigneeName
                                                            ? withHexAlpha(row.assigneeColor, '66', '#d1d5db')
                                                            : '#eceff1',
                                                        color: row.assigneeName
                                                            ? textColor(row.assigneeColor, '#374151')
                                                            : '#9ca3af'
                                                    }}
                                                >
                                                    <span>{getInitials(row.assigneeName || 'Unassigned')}</span>
                                                    <span className="truncate">{row.assigneeName || 'Unassigned'}</span>
                                                </button>
                                            </div>
                                            <div className="px-4 py-3 text-[12px] text-[#54656f] font-medium">
                                                {row.lastInboundAt ? new Date(row.lastInboundAt).toLocaleString() : '-'}
                                            </div>
                                            <div className="px-4 py-3">
                                                <button
                                                    onClick={() => {
                                                        setSelectedChatId(row.id);
                                                        setWorkspaceSection('team-inbox');
                                                    }}
                                                    className="px-3 py-1.5 rounded-lg bg-[#00a884] text-white text-[10px] font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                                                >
                                                    Open Chat
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
                    <div className="h-full flex items-center justify-center p-6">
                        <div className="w-full max-w-xl bg-white border border-[#eceff1] rounded-3xl p-8 shadow-[0_12px_40px_rgba(0,0,0,0.06)]">
                            <h2 className="text-2xl font-black text-[#111b21] mb-3">{activeWorkspaceLabel}</h2>
                            <p className="text-sm text-[#54656f] leading-relaxed mb-6">
                                This section is not enabled yet. Open Team Inbox to continue using the current interface.
                            </p>
                            <button
                                onClick={() => setWorkspaceSection('team-inbox')}
                                className="px-5 py-3 rounded-xl bg-[#00a884] text-white text-sm font-bold hover:bg-[#008f6f] transition-all"
                            >
                                Open Team Inbox
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {assignMenuContactId && !assignMenuContactId.endsWith('@g.us') && (
                <div
                    className="fixed inset-0 z-[260] bg-black/30 backdrop-blur-[1px] flex items-center justify-center p-4"
                    onClick={() => setAssignMenuContactId(null)}
                >
                    <div
                        className="w-full max-w-md bg-white border border-[#eceff1] rounded-2xl shadow-[0_18px_60px_rgba(0,0,0,0.2)] overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-4 py-3 border-b border-[#eceff1] flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-[#f0f2f5] border border-[#eceff1] flex items-center justify-center">
                                <User className="w-4 h-4 text-[#54656f]" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-[#111b21] truncate">{assignTargetName || 'Contact'}</div>
                                <div className="text-[11px] text-[#00a884] font-bold">{assignTargetPhone || '-'}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setAssignMenuContactId(null)}
                                className="p-1.5 rounded-lg text-[#8696a0] hover:bg-[#f0f2f5] hover:text-[#111b21]"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="px-4 py-3 border-b border-[#eceff1] text-[12px] text-[#54656f]">
                            Current assignee:{' '}
                            <span className="font-bold text-[#111b21]">
                                {assignTargetContact?.assigneeName || 'Unassigned'}
                            </span>
                        </div>

                        <div className="max-h-[52vh] overflow-y-auto custom-scrollbar p-2">
                            <button
                                type="button"
                                onClick={() => handleAssignContact(assignMenuContactId, null)}
                                disabled={assigningContactId === assignMenuContactId}
                                className={`w-full text-left px-3 py-2 rounded-xl text-[12px] font-bold transition-all ${!assignTargetAssigneeUserId ? 'bg-[#f8f9fa] text-[#111b21]' : 'hover:bg-[#f8f9fa] text-[#6b7280]'} disabled:opacity-60`}
                            >
                                Unassign
                            </button>
                            <div className="h-px bg-[#f0f2f5] my-2" />
                            {teamUsersLoading && teamUsers.length === 0 ? (
                                <div className="px-3 py-3 text-[12px] text-[#9ca3af]">Loading staff…</div>
                            ) : teamUsers.length === 0 ? (
                                <div className="px-3 py-3 text-[12px] text-[#9ca3af]">No staff found</div>
                            ) : (
                                teamUsers.map((member) => {
                                    const active = assignTargetAssigneeUserId === member.id;
                                    return (
                                        <button
                                            key={`assign-modal-${assignMenuContactId}-${member.id}`}
                                            type="button"
                                            onClick={() => handleAssignContact(assignMenuContactId, member.id)}
                                            disabled={assigningContactId === assignMenuContactId}
                                            className={`w-full text-left px-3 py-2 rounded-xl text-[12px] font-semibold hover:bg-[#f8f9fa] transition-all disabled:opacity-60 ${active ? 'bg-[#f0f7ff]' : ''}`}
                                        >
                                            <span
                                                className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                                                style={{ backgroundColor: member.color || '#6b7280' }}
                                            />
                                            <span className="align-middle">{member.name}</span>
                                            <span className="ml-2 text-[10px] uppercase tracking-wide text-[#9ca3af]">{member.role}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
