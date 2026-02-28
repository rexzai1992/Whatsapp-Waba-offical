
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import {
    Search,
    MoreVertical,
    MessageSquare,
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
import WebhookView from './WebhookView';
import Login from './Login';
import AdminView from './AdminView';
import FlowCanvas from './FlowCanvas';
import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';


const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
const SINGLE_PROFILE_MODE = true;
const ADMIN_PASS = 'admin123';

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
    pushName?: string;
    messageTimestamp?: number;
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

const getLastInboundTs = (
    messages: Message[],
    chatId: string | null,
    contacts: Record<string, { name?: string; lastInboundAt?: string | null; tags?: string[] }>
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
    const [contacts, setContacts] = useState<Record<string, { name?: string; lastInboundAt?: string | null; tags?: string[] }>>({});
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
    const [mediaCache, setMediaCache] = useState<Record<string, MediaData>>({});
    const [showContactInfo, setShowContactInfo] = useState(false);
    const [showNewChatModal, setShowNewChatModal] = useState(false);
    const [newPhoneNumber, setNewPhoneNumber] = useState('');
    const [showMenu, setShowMenu] = useState(false);
    const [now, setNow] = useState(Date.now());

    const [activeView, setActiveView] = useState<'dashboard' | 'chatflow' | 'settings' | 'admin'>('dashboard');
    const [isAdmin, setIsAdmin] = useState(false);
    const [profiles, setProfiles] = useState<any[]>([]);


    const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
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
    const chatEndRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const profileMenuRef = useRef<HTMLDivElement>(null);
    const messageInputRef = useRef<HTMLInputElement>(null);
    const activeProfileIdRef = useRef<string | null>(null);
    const lastInboundRef = useRef<number | null>(null);
    const requestedMediaRef = useRef<Set<string>>(new Set());

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
        if (!showAnalytics) return;
        fetchAnalytics();
    }, [showAnalytics, fetchAnalytics]);


    const handleSignOut = async () => {
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
                setIsAdmin(data?.role === 'admin');
            });
    }, [session]);

    useEffect(() => {
        const statusEmoji = connectionStatus === 'open' ? '🟢' : connectionStatus === 'connecting' ? '🟡' : '🔴';
        document.title = `${statusEmoji} WhatsApp Business API`;
    }, [connectionStatus]);

    useEffect(() => {
        if (!session) {
            setSocket(null);
            return;
        }

        console.log('Connecting socket with token', session.access_token.substring(0, 10));
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
            setProfiles(data);
            // Auto-select first profile if none active
            if (data.length > 0 && !activeProfileId) {
                setActiveProfileId(data[0].id);
            }
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
                        next[c.id] = {
                            name: resolvedName || prev.name,
                            lastInboundAt: c.lastInboundAt || prev.lastInboundAt || null,
                            tags: Array.isArray(c.tags) ? c.tags : prev.tags || []
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

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [allMessages, selectedChatId]);

    // Process unique chats
    const chatsMap = new Map<string, Chat>();
    allMessages.forEach(msg => {
        const jid = msg.key.remoteJid;
        if (!jid) return;

        const existing = chatsMap.get(jid);
        const content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsMessage?.contentText ||
            msg.message?.listMessage?.description ||
            (msg.message?.buttonsMessage ? 'Buttons' : msg.message?.listMessage ? 'List' : 'Media message');

        if (!existing || (msg.messageTimestamp && msg.messageTimestamp > (existing.timestamp || 0))) {
            const cleanId = getCleanId(jid);
            let rawName = contacts[jid]?.name || msg.pushName || cleanId;
            // If the name itself is a JID, clean it
            if (rawName.includes('@')) {
                rawName = getCleanId(rawName);
            }

            chatsMap.set(jid, {
                id: jid,
                name: rawName,
                lastMessage: content,
                timestamp: msg.messageTimestamp,
                unreadCount: 0,
            });
        }
    });

    const chatList = Array.from(chatsMap.values())
        .filter(chat => chat.name.toLowerCase().includes(searchQuery.toLowerCase()))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const latestChatId = chatList[0]?.id || null;

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

    const currentChatMessages = allMessages
        .filter(msg => msg.key.remoteJid === selectedChatId)
        .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

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

    const selectedChat = selectedChatId
        ? (chatsMap.get(selectedChatId) || {
            id: selectedChatId,
            name: contacts[selectedChatId]?.name || getCleanId(selectedChatId),
            lastMessage: '',
            timestamp: 0,
            unreadCount: 0
        })
        : null;
    const lastInboundMs = getLastInboundTs(allMessages, selectedChatId, contacts);
    const windowExpiresMs = lastInboundMs ? lastInboundMs + 24 * 60 * 60 * 1000 : null;
    const windowRemainingMs = windowExpiresMs ? windowExpiresMs - now : null;
    const windowOpen = windowRemainingMs !== null && windowRemainingMs > 0;
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
        setMessageText(text);
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
        if (!socket || !selectedChatId || !messageText.trim()) return;
        socket.emit('sendMessage', { profileId: activeProfileId, jid: selectedChatId, text: messageText });
        const tempMsg: Message = {
            key: { id: Math.random().toString(), remoteJid: selectedChatId, fromMe: true },
            message: { conversation: messageText },
            messageTimestamp: Math.floor(Date.now() / 1000),
            status: 'sent',
        };
        setAllMessages(prev => [tempMsg, ...prev]);
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
    };

    const handleSwitchProfile = (id: string) => {
        setActiveProfileId(id);
        setAllMessages([]);
        setContacts({});
        setSelectedChatId(null);
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
        return <Login onLogin={() => { }} />
    }

    return (
        <div className="flex h-screen bg-[#f8f9fa] overflow-hidden text-[#111b21] font-sans">
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
                    ) : chatList.map((chat) => (
                        <div
                            key={chat.id}
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
                                <div className="flex items-center justify-between mt-0.5">
                                    <p className="truncate text-[13px] text-[#54656f] font-medium leading-tight flex-1">
                                        {chat.lastMessage}
                                    </p>
                                    {chat.id.endsWith('@g.us') && (
                                        <span className="ml-2 px-1.5 py-0.5 bg-[#f0f2f5] text-[#54656f] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight">Group</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {selectedChatId ? (
                <div className="flex-1 flex flex-col bg-[#f0f2f5] relative">
                    <div className="absolute inset-0 opacity-[0.06] pointer-events-none bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_6860a4760a595861d83d.png')] bg-repeat" />

                    <header className="h-[60px] bg-[#f0f2f5] px-3 flex items-center justify-between z-10 border-l border-[#eceff1]">
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

                    <div className="flex-1 overflow-y-auto px-16 py-6 space-y-1 custom-scrollbar z-10 flex flex-col">
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
                        {(() => {
                            let lastDateKey = '';
                            return currentChatMessages.map((msg, idx) => {
                                const msgMs = (msg.messageTimestamp || 0) * 1000;
                                const dateKey = msgMs ? new Date(msgMs).toDateString() : '';
                                const showDate = !!dateKey && dateKey !== lastDateKey;
                                if (showDate) lastDateKey = dateKey;
                                const dateLabel = showDate ? formatDateLabel(msgMs) : '';
                                const key = msg.key.id || `${msg.key.remoteJid || 'msg'}-${idx}`;
                                const buttonsMessage = msg.message?.buttonsMessage;
                                const listMessage = msg.message?.listMessage;
                                const messageText =
                                    msg.message?.conversation ||
                                    msg.message?.extendedTextMessage?.text ||
                                    buttonsMessage?.contentText ||
                                    listMessage?.description ||
                                    '';
                                const buttons = Array.isArray(buttonsMessage?.buttons) ? buttonsMessage?.buttons : [];
                                const listSections = Array.isArray(listMessage?.sections) ? listMessage?.sections : [];

                                return (
                                    <React.Fragment key={key}>
                                        {showDate && (
                                            <div className="self-center sticky top-2 z-10 px-3 py-1 rounded-full bg-[#e9edef] text-[11px] font-bold text-[#54656f] shadow-sm border border-[#d7dfe5]">
                                                {dateLabel}
                                            </div>
                                        )}
                                        <div
                                            className={`max-w-[85%] flex flex-col ${msg.key.fromMe ? 'self-end' : 'self-start'}`}
                                        >
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

                                    {/* Media Rendering */}
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
                                        </div>
                                    </React.Fragment>
                                );
                            });
                        })()}
                        <div ref={chatEndRef} />
                    </div>

                    <footer className="bg-[#f0f2f5] px-4 py-3 flex items-center gap-2 z-10 min-h-[62px]">
                        {canSendText ? (
                            <>
                                <div className="flex items-center text-[#54656f]">
                                    <div className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer"><Smile className="w-6 h-6" /></div>
                                    <div className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer"><Paperclip className="w-6 h-6 -rotate-45" /></div>
                                </div>
                                {workflowStarter}
                                <div className="flex-1 mx-2 relative">
                                    {quickReplyQuery !== null && (
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
                                        placeholder="Type a message"
                                        value={messageText}
                                        onChange={(e) => setMessageText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                if (quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                                    e.preventDefault();
                                                    handleQuickReplyPick(quickReplySuggestions[0]);
                                                    return;
                                                }
                                                handleSendMessage();
                                            }
                                            if (e.key === 'Tab' && quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                                e.preventDefault();
                                                handleQuickReplyPick(quickReplySuggestions[0]);
                                            }
                                        }}
                                        className="w-full bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-[15px] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 placeholder:text-[#54656f]/50 text-[#111b21]"
                                    />
                                </div>
                                <div className="text-[#54656f] flex items-center">
                                    {messageText.trim() ? (
                                        <div onClick={handleSendMessage} className="p-3 bg-[#00a884] shadow-sm rounded-xl cursor-pointer text-white transition-transform active:scale-95"><Send className="w-5 h-5" /></div>
                                    ) : (
                                        <div className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer"><Mic className="w-6 h-6" /></div>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex items-center gap-3">
                                <div className="px-3 py-2 rounded-xl bg-[#fff3e0] text-[#a16207] text-xs font-bold border border-[#fde68a]">
                                    24h window closed. Send a template.
                                </div>
                                <input
                                    type="text"
                                    placeholder="Template name"
                                    value={templateName}
                                    onChange={(e) => setTemplateName(e.target.value)}
                                    className="flex-1 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                />
                                <input
                                    type="text"
                                    placeholder="Language (e.g. en_US)"
                                    value={templateLanguage}
                                    onChange={(e) => setTemplateLanguage(e.target.value)}
                                    className="w-40 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                />
                                <input
                                    type="text"
                                    placeholder='Components JSON (optional)'
                                    value={templateComponents}
                                    onChange={(e) => setTemplateComponents(e.target.value)}
                                    className="flex-[1.2] bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                />
                                <div onClick={handleSendTemplate} className="p-3 bg-[#00a884] shadow-sm rounded-xl cursor-pointer text-white transition-transform active:scale-95"><Send className="w-5 h-5" /></div>
                                {workflowStarter}
                            </div>
                        )}
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
                                                            <FlowCanvas
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
                        <div className="flex-1 overflow-y-auto">
                            <WebhookView
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
    );
}
