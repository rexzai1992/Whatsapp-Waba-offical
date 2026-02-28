
import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Key, Globe, Shield } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
const ADMIN_PASS = 'admin123';

type QuickReply = {
    id?: string;
    shortcut: string;
    text: string;
};

type WebhookViewProps = {
    profileId: string;
    sessionToken?: string | null;
    isAdmin?: boolean;
    quickReplies: QuickReply[];
    quickRepliesLoading: boolean;
    quickRepliesSaving: boolean;
    quickRepliesError: string | null;
    onRefreshQuickReplies: () => void;
    onSaveQuickReplies: (items: QuickReply[]) => void;
};

export default function WebhookView({
    profileId,
    sessionToken,
    isAdmin,
    quickReplies,
    quickRepliesLoading,
    quickRepliesSaving,
    quickRepliesError,
    onRefreshQuickReplies,
    onSaveQuickReplies
}: WebhookViewProps) {
    const [webhooks, setWebhooks] = useState<any[]>([]);
    const [apiKeys, setApiKeys] = useState<any>({});
    const [newUrl, setNewUrl] = useState('');
    const [newEvents, setNewEvents] = useState<string[]>(['message_received']);
    const [loading, setLoading] = useState(false);
    const [autoConfig, setAutoConfig] = useState<{
        enable_welcome_message: boolean;
        prompts: string[];
        commands: Array<{ command_name: string; command_description: string }>;
    }>({
        enable_welcome_message: false,
        prompts: [],
        commands: []
    });
    const [autoLoading, setAutoLoading] = useState(false);
    const [autoSaving, setAutoSaving] = useState(false);
    const [reminderConfig, setReminderConfig] = useState<{
        enabled: boolean;
        minutes: number | '';
        text: string;
    }>({
        enabled: false,
        minutes: 30,
        text: ''
    });
    const [reminderLoading, setReminderLoading] = useState(false);
    const [reminderSaving, setReminderSaving] = useState(false);
    const [fallbackConfig, setFallbackConfig] = useState<{
        text: string;
        limit: number | '';
    }>({
        text: '',
        limit: 3
    });
    const [fallbackLoading, setFallbackLoading] = useState(false);
    const [fallbackSaving, setFallbackSaving] = useState(false);
    const [fallbackError, setFallbackError] = useState<string | null>(null);
    const [connectedBusinesses, setConnectedBusinesses] = useState<any[]>([]);
    const [connectedPaging, setConnectedPaging] = useState<any | null>(null);
    const [connectedLoading, setConnectedLoading] = useState(false);
    const [connectedError, setConnectedError] = useState<string | null>(null);
    const [connectedAppId, setConnectedAppId] = useState('');
    const [quickRepliesDraft, setQuickRepliesDraft] = useState<QuickReply[]>([]);
    const [connectLoading, setConnectLoading] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [clientConnections, setClientConnections] = useState<any[]>([]);
    const [clientLoading, setClientLoading] = useState(false);
    const [clientError, setClientError] = useState<string | null>(null);

    useEffect(() => {
        if (!profileId) return;
        fetchWebhooks();
        fetchApiKeys();
        fetchAutomation();
        fetchWindowReminder();
        fetchFallbackSettings();
        if (isAdmin) {
            fetchConnectedBusinesses();
            fetchClientConnections();
        }
        onRefreshQuickReplies();
    }, [profileId, onRefreshQuickReplies, isAdmin]);

    useEffect(() => {
        setQuickRepliesDraft(quickReplies.map(item => ({ ...item })));
    }, [quickReplies]);

    const handleAddQuickReply = () => {
        setQuickRepliesDraft(prev => ([
            ...prev,
            { shortcut: '', text: '' }
        ]));
    };

    const handleUpdateQuickReply = (index: number, field: 'shortcut' | 'text', value: string) => {
        setQuickRepliesDraft(prev => {
            const next = [...prev];
            next[index] = { ...next[index], [field]: value };
            return next;
        });
    };

    const handleRemoveQuickReply = (index: number) => {
        setQuickRepliesDraft(prev => prev.filter((_, idx) => idx !== index));
    };

    const handleSaveQuickReplies = () => {
        onSaveQuickReplies(quickRepliesDraft);
    };

    const handleConnectWhatsapp = async () => {
        if (!sessionToken) {
            setConnectError('You must be logged in to connect WhatsApp.');
            return;
        }
        setConnectLoading(true);
        setConnectError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/embedded-signup/url?profileId=${encodeURIComponent(profileId)}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json();
            if (!res.ok || !data?.success || !data?.url) {
                throw new Error(data?.error || 'Failed to start embedded signup');
            }
            window.location.href = data.url;
        } catch (err: any) {
            setConnectError(err?.message || 'Failed to start embedded signup');
        } finally {
            setConnectLoading(false);
        }
    };

    const fetchClientConnections = () => {
        if (!sessionToken) {
            setClientConnections([]);
            return;
        }
        setClientLoading(true);
        setClientError(null);
        fetch(`${SOCKET_URL}/api/waba/clients`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Client connections fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setClientConnections(Array.isArray(data.data) ? data.data : []);
                    setClientError(null);
                } else {
                    setClientConnections([]);
                    setClientError(data?.error || 'Failed to load connected clients');
                }
            })
            .finally(() => setClientLoading(false));
    };

    const handleDisconnectClient = async (targetProfileId: string, revoke = false) => {
        if (!sessionToken) {
            setClientError('You must be logged in.');
            return;
        }
        if (!confirm(`Disconnect this client${revoke ? ' and revoke webhook subscription' : ''}?`)) return;
        setClientLoading(true);
        setClientError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/clients/disconnect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({ profileId: targetProfileId, revoke })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to disconnect client');
            }
            fetchClientConnections();
        } catch (err: any) {
            setClientError(err?.message || 'Failed to disconnect client');
        } finally {
            setClientLoading(false);
        }
    };

    const formatTokenExpiry = (value?: string) => {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    const fetchWebhooks = () => {
        fetch(`${SOCKET_URL}/addon/admin/webhooks?profileId=${profileId}&adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Webhook fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) setWebhooks(data.data || []);
            });
    };

    const fetchApiKeys = () => {
        fetch(`${SOCKET_URL}/api/admin/api-keys?adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('API key fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) setApiKeys(data.data || {});
            });
    };

    const handleAddWebhook = () => {
        if (!newUrl) return;
        setLoading(true);
        fetch(`${SOCKET_URL}/addon/admin/webhooks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId,
                adminPassword: ADMIN_PASS,
                url: newUrl,
                events: newEvents
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Add webhook failed:', text);
                    return null;
                }
            })
            .then(() => {
                setLoading(false);
                setNewUrl('');
                fetchWebhooks();
            });
    };

    const handleDeleteWebhook = (url: string) => {
        if (!confirm('Delete webhook?')) return;
        fetch(`${SOCKET_URL}/addon/admin/webhooks`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId,
                adminPassword: ADMIN_PASS,
                url
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Delete webhook failed:', text);
                    return null;
                }
            })
            .then(() => fetchWebhooks());
    };

    const generateApiKey = () => {
        const name = prompt('Key Name:');
        if (!name) return;
        fetch(`${SOCKET_URL}/api/admin/api-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId,
                adminPassword: ADMIN_PASS,
                name
            })
        }).then(() => fetchApiKeys());
    };

    const fetchAutomation = () => {
        setAutoLoading(true);
        fetch(`${SOCKET_URL}/api/waba/conversational-automation?profileId=${profileId}&adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational automation fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                const ca = data?.data?.conversational_automation || {};
                setAutoConfig({
                    enable_welcome_message: Boolean(ca.enable_welcome_message),
                    prompts: Array.isArray(ca.prompts) ? ca.prompts : [],
                    commands: Array.isArray(ca.commands) ? ca.commands : []
                });
            })
            .finally(() => setAutoLoading(false));
    };

    const fetchWindowReminder = () => {
        setReminderLoading(true);
        fetch(`${SOCKET_URL}/api/waba/window-reminder?profileId=${profileId}&adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Window reminder fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                const config = data?.data || {};
                setReminderConfig({
                    enabled: Boolean(config.window_reminder_enabled),
                    minutes: typeof config.window_reminder_minutes === 'number' ? config.window_reminder_minutes : '',
                    text: typeof config.window_reminder_text === 'string' ? config.window_reminder_text : ''
                });
            })
            .finally(() => setReminderLoading(false));
    };

    const handleSaveAutomation = () => {
        setAutoSaving(true);
        const payload = {
            enable_welcome_message: autoConfig.enable_welcome_message,
            prompts: (autoConfig.prompts || []).map(p => p.trim()).filter(Boolean),
            commands: (autoConfig.commands || [])
                .map(c => ({
                    command_name: (c.command_name || '').trim(),
                    command_description: (c.command_description || '').trim()
                }))
                .filter(c => c.command_name && c.command_description),
            profileId,
            adminPassword: ADMIN_PASS
        };
        fetch(`${SOCKET_URL}/api/waba/conversational-automation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational automation save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    alert('Conversational components saved.');
                } else {
                    alert(data?.error || 'Failed to save conversational components');
                }
            })
            .finally(() => setAutoSaving(false));
    };

    const handleSaveReminder = () => {
        setReminderSaving(true);
        const payload = {
            enabled: reminderConfig.enabled,
            minutes: reminderConfig.minutes === '' ? null : Number(reminderConfig.minutes),
            text: reminderConfig.text
        };
        fetch(`${SOCKET_URL}/api/waba/window-reminder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId,
                adminPassword: ADMIN_PASS,
                ...payload
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Window reminder save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    alert('Window reminder settings saved.');
                } else {
                    alert(data?.error || 'Failed to save window reminder settings');
                }
            })
            .finally(() => setReminderSaving(false));
    };

    const fetchFallbackSettings = () => {
        if (!profileId) return;
        setFallbackLoading(true);
        setFallbackError(null);
        fetch(`${SOCKET_URL}/api/company/fallback-settings?profileId=${profileId}&adminPassword=${ADMIN_PASS}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Fallback settings fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const cfg = data?.data || {};
                    setFallbackConfig({
                        text: typeof cfg.fallback_text === 'string' ? cfg.fallback_text : '',
                        limit: typeof cfg.fallback_limit === 'number' ? cfg.fallback_limit : 3
                    });
                } else {
                    setFallbackError(data?.error || 'Failed to load fallback settings');
                }
            })
            .finally(() => setFallbackLoading(false));
    };

    const handleSaveFallbackSettings = () => {
        setFallbackSaving(true);
        setFallbackError(null);
        const payload = {
            fallback_text: fallbackConfig.text,
            fallback_limit: fallbackConfig.limit === '' ? null : Number(fallbackConfig.limit)
        };
        fetch(`${SOCKET_URL}/api/company/fallback-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId,
                adminPassword: ADMIN_PASS,
                ...payload
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Fallback settings save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    alert('Fallback settings saved.');
                } else {
                    setFallbackError(data?.error || 'Failed to save fallback settings');
                }
            })
            .finally(() => setFallbackSaving(false));
    };

    const formatConnectedDate = (value?: string) => {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    const statusBadgeClass = (value?: string) => {
        const normalized = (value || '').toUpperCase();
        if (normalized === 'ACTIVE' || normalized === 'VERIFIED') {
            return 'bg-emerald-50 text-emerald-700 border-emerald-200';
        }
        if (normalized === 'PENDING' || normalized === 'PENDING_APPROVAL') {
            return 'bg-amber-50 text-amber-700 border-amber-200';
        }
        if (normalized === 'SUSPENDED' || normalized === 'REJECTED') {
            return 'bg-rose-50 text-rose-600 border-rose-200';
        }
        return 'bg-[#f0f2f5] text-[#54656f] border-[#eceff1]';
    };

    const fetchConnectedBusinesses = (opts: { after?: string; before?: string } = {}) => {
        if (!profileId) return;
        setConnectedLoading(true);
        setConnectedError(null);

        const params = new URLSearchParams();
        params.set('profileId', profileId);
        params.set('adminPassword', ADMIN_PASS);
        params.set('fields', 'id,name,verification_status,business_status,created_time,updated_time');
        params.set('limit', '50');
        if (connectedAppId.trim()) params.set('appId', connectedAppId.trim());
        if (opts.after) params.set('after', opts.after);
        if (opts.before) params.set('before', opts.before);

        fetch(`${SOCKET_URL}/api/waba/connected-client-businesses?${params.toString()}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Connected businesses fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const payload = data?.data || {};
                    setConnectedBusinesses(Array.isArray(payload.data) ? payload.data : []);
                    setConnectedPaging(payload.paging || null);
                    setConnectedError(null);
                } else {
                    setConnectedBusinesses([]);
                    setConnectedPaging(null);
                    setConnectedError(data?.error || 'Failed to load connected businesses');
                }
            })
            .finally(() => setConnectedLoading(false));
    };

    return (
        <div className="flex-1 bg-[#fcfdfd] p-10 overflow-y-auto text-[#111b21] h-screen font-sans">
            <h2 className="text-3xl font-black mb-10 flex items-center gap-4 tracking-tight">
                <Globe className="text-[#00a884] w-8 h-8" /> API & Connectivity
                <span className="text-xs bg-[#f0f2f5] px-4 py-1.5 rounded-full text-[#54656f] font-bold border border-[#eceff1] uppercase tracking-widest">Active profile: {profileId}</span>
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                {/* Embedded Signup Section */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Connect WhatsApp Business</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Link a client’s WhatsApp Business account using Meta Embedded Signup. You’ll be redirected to Facebook Login.
                    </p>
                    <button
                        onClick={handleConnectWhatsapp}
                        disabled={connectLoading || !sessionToken}
                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                    >
                        {connectLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Globe className="w-5 h-5" />}
                        Connect WhatsApp Business
                    </button>
                    {connectError && (
                        <p className="text-sm text-rose-600 mt-4 font-semibold">{connectError}</p>
                    )}
                    {!sessionToken && (
                        <p className="text-xs text-[#aebac1] mt-3">Login required to connect a client account.</p>
                    )}
                </div>

                {/* Webhooks Section */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <h3 className="text-xl mb-2 text-[#111b21] font-bold">Outgoing Webhooks</h3>
                    <p className="text-sm text-[#54656f] mb-8 font-medium">Configure endpoints to receive real-time updates from this profile.</p>

                    <div className="space-y-4 mb-8">
                        {webhooks.length === 0 && (
                            <div className="bg-[#f8f9fa] border-2 border-dashed border-[#eceff1] p-10 rounded-2xl text-center">
                                <p className="text-sm text-[#aebac1] font-bold uppercase tracking-widest italic">No endpoints configured</p>
                            </div>
                        )}
                        {webhooks.map((hook, i) => (
                            <div key={i} className="bg-[#fcfdfd] p-5 rounded-2xl flex items-start justify-between border border-[#eceff1] group hover:border-[#00a884]/30 transition-all">
                                <div className="min-w-0 pr-4">
                                    <div className="font-mono text-sm break-all mb-2 text-[#111b21] font-bold leading-relaxed">{hook.url}</div>
                                    <div className="flex gap-2 flex-wrap">
                                        {hook.events.map((e: string) => (
                                            <span key={e} className="text-[10px] bg-[#f0f2f5] px-3 py-1 rounded-full text-[#54656f] font-bold uppercase tracking-tight border border-[#eceff1]">{e}</span>
                                        ))}
                                    </div>
                                </div>
                                <button onClick={() => handleDeleteWebhook(hook.url)} className="p-2 text-[#aebac1] hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all h-fit">
                                    <Trash2 className="w-5 h-5" />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="border-t border-[#eceff1] pt-8 space-y-4">
                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Endpoint URL</label>
                        <input
                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                            placeholder="https://your-api.com/v1/webhook"
                            value={newUrl}
                            onChange={e => setNewUrl(e.target.value)}
                        />
                        <div className="flex flex-col gap-3 py-2">
                            <span className="text-[11px] font-bold text-[#54656f] uppercase tracking-widest">Select Events</span>
                            <div className="flex gap-3 flex-wrap">
                                {['message_received', 'message_sent', 'session_opened'].map(evt => (
                                    <label key={evt} className={`flex items-center gap-3 cursor-pointer px-4 py-2.5 rounded-xl border-2 transition-all font-bold text-xs uppercase tracking-tighter ${newEvents.includes(evt) ? 'bg-[#00a884]/5 border-[#00a884] text-[#00a884]' : 'bg-white border-[#eceff1] text-[#54656f] hover:border-[#aebac1]'}`}>
                                        <input
                                            type="checkbox"
                                            checked={newEvents.includes(evt)}
                                            onChange={e => {
                                                if (e.target.checked) setNewEvents([...newEvents, evt]);
                                                else setNewEvents(newEvents.filter(x => x !== evt));
                                            }}
                                            className="hidden"
                                        />
                                        {evt.replace('_', ' ')}
                                    </label>
                                ))}
                            </div>
                        </div>
                        <button
                            onClick={handleAddWebhook}
                            disabled={loading || !newUrl}
                            className="w-full bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50 active:scale-95"
                        >
                            {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Plus className="w-5 h-5" />}
                            Register Webhook
                        </button>
                    </div>
                </div>

                {/* API Keys Section */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Access Gateways</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">Manage API keys for server-side integration.</p>
                        </div>
                        <button onClick={generateApiKey} className="bg-[#111b21] text-white px-5 py-3 rounded-2xl flex items-center gap-2 font-bold hover:bg-[#202c33] transition-all shadow-lg text-xs">
                            <Plus className="w-4 h-4" /> NEW KEY
                        </button>
                    </div>

                    <div className="space-y-5 mb-10">
                        {Object.entries(apiKeys).length === 0 && (
                            <p className="text-sm text-[#aebac1] font-bold uppercase text-center italic py-4">No keys generated yet.</p>
                        )}
                        {Object.entries(apiKeys).map(([key, info]: [string, any]) => (
                            <div key={key} className="bg-[#fcfdfd] p-6 rounded-2xl border border-[#eceff1] hover:border-[#aebac1] transition-all">
                                <div className="flex justify-between items-center mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-[#00a884]/10 flex items-center justify-center">
                                            <Key className="w-4 h-4 text-[#00a884]" />
                                        </div>
                                        <span className="font-bold text-base text-[#111b21]">{info.name}</span>
                                    </div>
                                    <span className="text-[10px] text-[#54656f] bg-[#f0f2f5] px-3 py-1 rounded-full border border-[#eceff1] font-black uppercase tracking-widest">{info.profileId}</span>
                                </div>
                                <div className="flex items-center gap-3 font-mono text-sm bg-white p-4 rounded-xl border border-[#eceff1] break-all select-all cursor-text text-[#54656f] shadow-inner">
                                    <code className="flex-1 overflow-hidden text-ellipsis">{key}</code>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="p-6 bg-[#f8f9fa] rounded-3xl border border-[#eceff1]">
                        <h4 className="text-sm font-bold text-[#111b21] mb-5 flex items-center gap-2 uppercase tracking-widest">
                            <Shield className="w-5 h-5 text-[#00a884]" /> Developer Documentation
                        </h4>

                        <div className="space-y-4">
                            {/* Send Message */}
                            <div className="bg-white rounded-2xl border border-[#eceff1] overflow-hidden">
                                <div className="p-4 flex items-center justify-between bg-[#fcfdfd]">
                                    <span className="font-bold text-xs text-[#111b21]">POST <span className="text-[#00a884]">/addon/api/send-message</span></span>
                                    <span className="bg-[#00a884]/10 text-[#00a884] px-2 py-0.5 rounded-full font-black text-[9px] uppercase">Send Text</span>
                                </div>
                                <div className="p-4 border-t border-[#f0f2f5] space-y-3">
                                    <div className="text-[10px] text-[#54656f]">
                                        <p className="font-bold text-[#111b21] mb-1">HEADERS</p>
                                        <code className="block bg-[#f8f9fa] p-2 rounded">x-api-key: YOUR_KEY</code>
                                    </div>
                                    <div className="text-[10px] text-[#54656f]">
                                        <p className="font-bold text-[#111b21] mb-1">BODY (JSON)</p>
                                        <pre className="block bg-[#111b21] text-emerald-400 p-3 rounded font-mono leading-relaxed">
                                            {`{
  "to": "123456789@c.us",
  "message": "Hello from API"
}`}
                                        </pre>
                                    </div>
                                </div>
                            </div>

                            {/* Fetch Messages */}
                            <div className="bg-white rounded-2xl border border-[#eceff1] overflow-hidden">
                                <div className="p-4 flex items-center justify-between bg-[#fcfdfd]">
                                    <span className="font-bold text-xs text-[#111b21]">GET <span className="text-[#00a884]">/addon/api/messages</span></span>
                                    <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-black text-[9px] uppercase">History</span>
                                </div>
                                <div className="p-4 border-t border-[#f0f2f5] space-y-3">
                                    <div className="text-[10px] text-[#54656f]">
                                        <p className="font-bold text-[#111b21] mb-1">QUERY PARAMS</p>
                                        <code className="block bg-[#f8f9fa] p-2 rounded">?limit=50&contact=123456789@c.us</code>
                                    </div>
                                    <div className="text-[10px] text-[#54656f]">
                                        <p className="font-bold text-[#111b21] mb-1">EXAMPLE CURL</p>
                                        <pre className="block bg-[#111b21] text-emerald-400 p-3 rounded font-mono whitespace-pre-wrap break-all">
                                            curl -X GET "http://localhost:3001/addon/api/messages" -H "x-api-key: YOUR_KEY"
                                        </pre>
                                    </div>
                                </div>
                            </div>

                            {/* Webhook Info */}
                            <div className="bg-white rounded-2xl border border-[#eceff1] overflow-hidden">
                                <div className="p-4 flex items-center justify-between bg-[#fcfdfd]">
                                    <span className="font-bold text-xs text-[#111b21]">WEBHOOK <span className="text-[#00a884]">Payload Structure</span></span>
                                    <span className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-black text-[9px] uppercase">Events</span>
                                </div>
                                <div className="p-4 border-t border-[#f0f2f5]">
                                    <div className="text-[10px] text-[#54656f]">
                                        <p className="font-bold text-[#111b21] mb-1">INCOMING MESSAGE SCHEMA</p>
                                        <pre className="block bg-[#111b21] text-emerald-400 p-3 rounded font-mono leading-relaxed">
                                            {`{
  "event": "message_received",
  "data": {
    "from": "123456789@c.us",
    "body": "Hello world",
    "timestamp": 1672531200
  }
}`}
                                        </pre>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="pt-6 text-center">
                            <p className="text-[11px] font-bold text-[#111b21] bg-white border border-[#eceff1] py-3 px-4 rounded-2xl shadow-sm">
                                Use the <code className="text-[#00a884]">x-api-key</code> to authenticate external requests.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Conversational Components */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Conversational Components</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Configure welcome message, ice breakers, and commands for this phone number.
                            </p>
                        </div>
                        <button
                            onClick={fetchAutomation}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Welcome Message</span>
                                <input
                                    type="checkbox"
                                    checked={autoConfig.enable_welcome_message}
                                    onChange={(e) => setAutoConfig(prev => ({ ...prev, enable_welcome_message: e.target.checked }))}
                                    className="w-4 h-4 accent-[#00a884]"
                                />
                            </div>
                            <p className="text-[11px] text-[#8696a0] leading-relaxed">
                                When enabled, Meta sends a <code className="font-mono">request_welcome</code> webhook for first‑time chats.
                                Create a workflow with trigger keyword <code className="font-mono">request_welcome</code> to reply.
                            </p>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Ice Breakers</span>
                                <button
                                    onClick={() => {
                                        setAutoConfig(prev => ({
                                            ...prev,
                                            prompts: [...(prev.prompts || []), '']
                                        }))
                                    }}
                                    className="text-[11px] font-bold text-[#00a884] hover:underline"
                                >
                                    + Add
                                </button>
                            </div>
                            <div className="space-y-3">
                                {(autoConfig.prompts || []).map((prompt, idx) => (
                                    <div key={idx} className="flex items-center gap-2">
                                        <input
                                            className="flex-1 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={prompt}
                                            onChange={(e) => {
                                                const next = [...(autoConfig.prompts || [])];
                                                next[idx] = e.target.value;
                                                setAutoConfig(prev => ({ ...prev, prompts: next }));
                                            }}
                                            placeholder="Plan a trip"
                                        />
                                        <button
                                            onClick={() => {
                                                const next = (autoConfig.prompts || []).filter((_, i) => i !== idx);
                                                setAutoConfig(prev => ({ ...prev, prompts: next }));
                                            }}
                                            className="text-rose-500 text-xs font-bold"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                {autoConfig.prompts.length === 0 && (
                                    <p className="text-[11px] text-[#aebac1]">No ice breakers configured.</p>
                                )}
                            </div>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Commands</span>
                                <button
                                    onClick={() => {
                                        setAutoConfig(prev => ({
                                            ...prev,
                                            commands: [...(prev.commands || []), { command_name: '', command_description: '' }]
                                        }))
                                    }}
                                    className="text-[11px] font-bold text-[#00a884] hover:underline"
                                >
                                    + Add
                                </button>
                            </div>
                            <div className="space-y-3">
                                {(autoConfig.commands || []).map((cmd, idx) => (
                                    <div key={idx} className="space-y-2 bg-white p-3 rounded-xl border border-[#eceff1]">
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-lg px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={cmd.command_name}
                                            onChange={(e) => {
                                                const next = [...(autoConfig.commands || [])];
                                                next[idx] = { ...next[idx], command_name: e.target.value };
                                                setAutoConfig(prev => ({ ...prev, commands: next }));
                                            }}
                                            placeholder="tickets"
                                        />
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-lg px-3 py-2 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={cmd.command_description}
                                            onChange={(e) => {
                                                const next = [...(autoConfig.commands || [])];
                                                next[idx] = { ...next[idx], command_description: e.target.value };
                                                setAutoConfig(prev => ({ ...prev, commands: next }));
                                            }}
                                            placeholder="Book flight tickets"
                                        />
                                        <button
                                            onClick={() => {
                                                const next = (autoConfig.commands || []).filter((_, i) => i !== idx);
                                                setAutoConfig(prev => ({ ...prev, commands: next }));
                                            }}
                                            className="text-rose-500 text-[11px] font-bold"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                {autoConfig.commands.length === 0 && (
                                    <p className="text-[11px] text-[#aebac1]">No commands configured.</p>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            onClick={handleSaveAutomation}
                            disabled={autoSaving || autoLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {autoSaving ? 'Saving…' : 'Save Conversational Components'}
                        </button>
                    </div>
                </div>

                {/* 24h Window Reminder */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">24h Window Reminder</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Send a reminder message before the 24h reply window closes. Use <code className="font-mono">{'{minutes}'}</code> in the text.
                            </p>
                        </div>
                        <button
                            onClick={fetchWindowReminder}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1] flex items-center justify-between">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Enabled</span>
                            <input
                                type="checkbox"
                                checked={reminderConfig.enabled}
                                onChange={(e) => setReminderConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                                className="w-4 h-4 accent-[#00a884]"
                            />
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Minutes Before Close</span>
                            <input
                                type="number"
                                min={1}
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={reminderConfig.minutes}
                                onChange={(e) => {
                                    const next = e.target.value === '' ? '' : Number(e.target.value);
                                    setReminderConfig(prev => ({ ...prev, minutes: next }));
                                }}
                                placeholder="30"
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">Set to the number of minutes before the window ends.</p>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1] lg:col-span-1">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Reminder Text</span>
                            <textarea
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] h-24 resize-none"
                                value={reminderConfig.text}
                                onChange={(e) => setReminderConfig(prev => ({ ...prev, text: e.target.value }))}
                                placeholder="Heads up! Our 24h reply window closes in {minutes} minutes."
                            />
                        </div>
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            onClick={handleSaveReminder}
                            disabled={reminderSaving || reminderLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {reminderSaving ? 'Saving…' : 'Save Window Reminder'}
                        </button>
                    </div>
                </div>

                {/* Global Fallback Settings */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Fallback Message</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Set the default reply when a user presses an invalid button.
                            </p>
                        </div>
                        <button
                            onClick={fetchFallbackSettings}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {fallbackError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {fallbackError}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1] lg:col-span-2">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Fallback Text</span>
                            <textarea
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] h-24 resize-none"
                                value={fallbackConfig.text}
                                onChange={(e) => setFallbackConfig(prev => ({ ...prev, text: e.target.value }))}
                                placeholder="Please choose one of the options above."
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">
                                Leave empty to stop sending fallback replies.
                            </p>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Max Times</span>
                            <input
                                type="number"
                                min={0}
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={fallbackConfig.limit}
                                onChange={(e) => {
                                    const next = e.target.value === '' ? '' : Number(e.target.value);
                                    setFallbackConfig(prev => ({ ...prev, limit: next }));
                                }}
                                placeholder="3"
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">Set to <code className="font-mono">0</code> for unlimited replies.</p>
                        </div>
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            onClick={handleSaveFallbackSettings}
                            disabled={fallbackSaving || fallbackLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {fallbackSaving ? 'Saving…' : 'Save Fallback Settings'}
                        </button>
                    </div>
                </div>

                {/* Quick Replies */}
                <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Quick Replies</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Type <code className="font-mono">/shortcut</code> in chat to send the full message.
                            </p>
                        </div>
                        <button
                            onClick={onRefreshQuickReplies}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {quickRepliesError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {quickRepliesError}
                        </div>
                    )}

                    <div className="space-y-4">
                        {quickRepliesDraft.length === 0 ? (
                            <div className="bg-[#fcfdfd] border border-dashed border-[#d7dfe2] rounded-2xl p-6 text-sm text-[#8696a0]">
                                No quick replies yet. Add one below.
                            </div>
                        ) : (
                            quickRepliesDraft.map((item, index) => (
                                <div key={`${item.id || 'new'}-${index}`} className="bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-5">
                                    <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 items-start">
                                        <div className="lg:col-span-1">
                                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Shortcut</span>
                                            <input
                                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                value={item.shortcut}
                                                onChange={(e) => handleUpdateQuickReply(index, 'shortcut', e.target.value)}
                                                placeholder="/hi"
                                            />
                                        </div>
                                        <div className="lg:col-span-4">
                                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Message</span>
                                            <textarea
                                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] h-20 resize-none"
                                                value={item.text}
                                                onChange={(e) => handleUpdateQuickReply(index, 'text', e.target.value)}
                                                placeholder="Hello! How can we help you today?"
                                            />
                                        </div>
                                        <div className="lg:col-span-1 flex items-end justify-end">
                                            <button
                                                onClick={() => handleRemoveQuickReply(index)}
                                                className="mt-6 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-rose-500 hover:text-rose-600"
                                            >
                                                <Trash2 className="w-4 h-4" /> Remove
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="mt-6 flex items-center justify-between gap-3">
                        <button
                            onClick={handleAddQuickReply}
                            className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#111b21] border border-[#d7dfe2] px-4 py-3 rounded-2xl hover:bg-[#f6f8f9] transition-all"
                        >
                            <Plus className="w-4 h-4" /> Add Quick Reply
                        </button>
                        <button
                            onClick={handleSaveQuickReplies}
                            disabled={quickRepliesSaving || quickRepliesLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {quickRepliesSaving ? 'Saving…' : 'Save Quick Replies'}
                        </button>
                    </div>
                </div>

                {isAdmin && (
                    <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h3 className="text-xl text-[#111b21] font-bold">Connected Clients</h3>
                                <p className="text-sm text-[#54656f] font-medium mt-1">
                                    Clients connected via Embedded Signup for your company.
                                </p>
                            </div>
                            <button
                                onClick={() => fetchClientConnections()}
                                disabled={clientLoading}
                                className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                            >
                                Refresh
                            </button>
                        </div>

                        {clientError && (
                            <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                                {clientError}
                            </div>
                        )}

                        <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                            <table className="w-full text-left">
                                <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                    <tr>
                                        <th className="px-6 py-4">Profile</th>
                                        <th className="px-6 py-4">Phone Number ID</th>
                                        <th className="px-6 py-4">WABA ID</th>
                                        <th className="px-6 py-4">Status</th>
                                        <th className="px-6 py-4">Token Source</th>
                                        <th className="px-6 py-4">Token Expiry</th>
                                        <th className="px-6 py-4">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#f0f2f5]">
                                    {clientLoading ? (
                                        <tr>
                                            <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={7}>
                                                Loading connected clients...
                                            </td>
                                        </tr>
                                    ) : clientConnections.length === 0 ? (
                                        <tr>
                                            <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={7}>
                                                No connected clients found.
                                            </td>
                                        </tr>
                                    ) : (
                                        clientConnections.map((client: any) => {
                                            const status = client.enabled ? 'ACTIVE' : 'DISABLED';
                                            return (
                                                <tr key={client.profile_id} className="hover:bg-white transition-all">
                                                    <td className="px-6 py-4">
                                                        <div className="text-sm font-bold text-[#111b21]">{client.profile_id}</div>
                                                    </td>
                                                    <td className="px-6 py-4 text-xs font-mono text-[#54656f]">
                                                        {client.phone_number_id || '—'}
                                                    </td>
                                                    <td className="px-6 py-4 text-xs font-mono text-[#54656f]">
                                                        {client.waba_id || client.business_account_id || '—'}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(status)}`}>
                                                            {status}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-[#54656f] uppercase font-bold tracking-widest">
                                                        {client.token_source || 'user'}
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-[#54656f]">
                                                        {formatTokenExpiry(client.access_token_expires_at)}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => handleDisconnectClient(client.profile_id, false)}
                                                                disabled={!client.enabled || clientLoading}
                                                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                                                            >
                                                                Disable
                                                            </button>
                                                            <button
                                                                onClick={() => handleDisconnectClient(client.profile_id, true)}
                                                                disabled={!client.enabled || clientLoading}
                                                                className="px-3 py-2 rounded-xl border border-rose-200 text-[11px] font-bold uppercase tracking-widest text-rose-600 hover:border-rose-300 disabled:opacity-50"
                                                            >
                                                                Revoke
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {isAdmin && (
                    <div className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Connected Businesses</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Fetch client businesses connected to your Meta app for this profile.
                            </p>
                        </div>
                        <button
                            onClick={() => fetchConnectedBusinesses()}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Application ID (optional)</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Uses waba_configs.app_id if left empty"
                                value={connectedAppId}
                                onChange={e => setConnectedAppId(e.target.value)}
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">
                                Leave blank to use the stored <code className="font-mono">app_id</code> from Supabase or <code className="font-mono">WABA_APP_ID</code>.
                            </p>
                        </div>
                        <button
                            onClick={() => fetchConnectedBusinesses()}
                            disabled={connectedLoading}
                            className="h-[58px] mt-[24px] bg-[#111b21] text-white px-5 rounded-2xl flex items-center justify-center gap-2 font-bold hover:bg-[#202c33] transition-all shadow-lg text-xs disabled:opacity-50"
                        >
                            {connectedLoading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Fetch'}
                        </button>
                    </div>

                    {connectedError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {connectedError}
                        </div>
                    )}

                    <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                        <table className="w-full text-left">
                            <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                <tr>
                                    <th className="px-6 py-4">Business</th>
                                    <th className="px-6 py-4">Business ID</th>
                                    <th className="px-6 py-4">Verification</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Updated</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#f0f2f5]">
                                {connectedLoading ? (
                                    <tr>
                                        <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={5}>
                                            Loading connected businesses...
                                        </td>
                                    </tr>
                                ) : connectedBusinesses.length === 0 ? (
                                    <tr>
                                        <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={5}>
                                            No connected businesses found.
                                        </td>
                                    </tr>
                                ) : (
                                    connectedBusinesses.map((biz: any) => (
                                        <tr key={biz.id} className="hover:bg-white transition-all">
                                            <td className="px-6 py-4">
                                                <div className="text-sm font-bold text-[#111b21]">{biz.name || 'Unnamed Business'}</div>
                                            </td>
                                            <td className="px-6 py-4 text-xs font-mono text-[#54656f]">{biz.id}</td>
                                            <td className="px-6 py-4">
                                                <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(biz.verification_status)}`}>
                                                    {biz.verification_status || 'UNKNOWN'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(biz.business_status)}`}>
                                                    {biz.business_status || 'UNKNOWN'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-xs text-[#54656f]">
                                                {formatConnectedDate(biz.updated_time || biz.created_time)}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-4 flex items-center justify-between">
                        <div className="text-[11px] text-[#8696a0] font-bold uppercase tracking-widest">
                            {connectedBusinesses.length} results
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => fetchConnectedBusinesses({ before: connectedPaging?.cursors?.before })}
                                disabled={!connectedPaging?.cursors?.before || connectedLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                            >
                                Previous
                            </button>
                            <button
                                onClick={() => fetchConnectedBusinesses({ after: connectedPaging?.cursors?.after })}
                                disabled={!connectedPaging?.cursors?.after || connectedLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                    </div>
                )}
            </div>
        </div>
    );
}
