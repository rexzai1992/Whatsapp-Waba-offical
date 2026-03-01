
import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Globe, Shield } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
const ADMIN_PASS = 'admin123';

type QuickReply = {
    id?: string;
    shortcut: string;
    text: string;
};

type TeamRole = 'owner' | 'admin' | 'agent';

type TeamUser = {
    id: string;
    email?: string | null;
    name: string;
    role: TeamRole;
    color?: string | null;
    createdAt?: string | null;
    lastSignInAt?: string | null;
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
    const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
    const [teamLoading, setTeamLoading] = useState(false);
    const [teamError, setTeamError] = useState<string | null>(null);
    const [teamCurrentRole, setTeamCurrentRole] = useState<TeamRole>('agent');
    const [teamCurrentUserId, setTeamCurrentUserId] = useState<string | null>(null);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState<TeamRole>('agent');
    const [inviteLoading, setInviteLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
    const [roleSavingUserId, setRoleSavingUserId] = useState<string | null>(null);
    const [manualConfig, setManualConfig] = useState({
        wabaId: '',
        phoneNumberId: '',
        accessToken: '',
        businessId: '',
        verifyToken: '',
        appId: '',
        appSecret: '',
        apiVersion: ''
    });
    const [manualLoading, setManualLoading] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [manualSuccess, setManualSuccess] = useState<string | null>(null);
    const [registrationConfig, setRegistrationConfig] = useState<any | null>(null);
    const [registrationLoading, setRegistrationLoading] = useState(false);
    const [registrationError, setRegistrationError] = useState<string | null>(null);
    const [registrationNumbers, setRegistrationNumbers] = useState<any[]>([]);
    const [registrationNumbersLoading, setRegistrationNumbersLoading] = useState(false);
    const [registrationNumbersError, setRegistrationNumbersError] = useState<string | null>(null);
    const [showRegistrationWizard, setShowRegistrationWizard] = useState(false);
    const [registrationStep, setRegistrationStep] = useState<1 | 2 | 3 | 4>(1);
    const [registrationRequestSent, setRegistrationRequestSent] = useState(false);
    const [registrationVerified, setRegistrationVerified] = useState(false);
    const [registrationRegistered, setRegistrationRegistered] = useState(false);
    const [registrationProfileUpdated, setRegistrationProfileUpdated] = useState(false);
    const [registrationWabaId, setRegistrationWabaId] = useState('');
    const [registrationPhoneNumberId, setRegistrationPhoneNumberId] = useState('');
    const [registrationCodeMethod, setRegistrationCodeMethod] = useState<'SMS' | 'VOICE'>('SMS');
    const [registrationLocale, setRegistrationLocale] = useState('en_US');
    const [registrationCode, setRegistrationCode] = useState('');
    const [registrationPin, setRegistrationPin] = useState('');
    const [registrationProfileJson, setRegistrationProfileJson] = useState(`{
  "about": "Tell customers about your business",
  "address": "123 Main Street",
  "description": "Fast support via WhatsApp",
  "email": "support@example.com",
  "websites": ["https://example.com"],
  "vertical": "OTHER"
}`);
    const [registrationBusy, setRegistrationBusy] = useState<null | 'request' | 'verify' | 'register' | 'profile'>(null);

    useEffect(() => {
        if (!profileId) return;
        fetchWebhooks();
        fetchAutomation();
        fetchWindowReminder();
        fetchFallbackSettings();
        if (isAdmin) {
            fetchConnectedBusinesses();
            fetchClientConnections();
        }
        if (sessionToken) {
            fetchRegistrationConfig();
            fetchTeamUsers();
        }
        onRefreshQuickReplies();
    }, [profileId, onRefreshQuickReplies, isAdmin, sessionToken]);

    useEffect(() => {
        if (!sessionToken) return;
        const params = new URLSearchParams(window.location.search);
        if (params.get('waba') === 'connected') {
            openRegistrationWizard();
            params.delete('waba');
            const next = params.toString();
            const nextUrl = `${window.location.pathname}${next ? `?${next}` : ''}`;
            window.history.replaceState({}, '', nextUrl);
        }
    }, [sessionToken]);

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

    const handleManualConfigSave = async () => {
        if (!sessionToken) {
            setManualError('You must be logged in to save a manual configuration.');
            return;
        }
        setManualLoading(true);
        setManualError(null);
        setManualSuccess(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/manual-config`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId,
                    wabaId: manualConfig.wabaId.trim(),
                    phoneNumberId: manualConfig.phoneNumberId.trim(),
                    accessToken: manualConfig.accessToken.trim(),
                    businessId: manualConfig.businessId.trim() || null,
                    verifyToken: manualConfig.verifyToken.trim() || null,
                    appId: manualConfig.appId.trim() || null,
                    appSecret: manualConfig.appSecret.trim() || null,
                    apiVersion: manualConfig.apiVersion.trim() || null
                })
            });
            const data = await res.json();
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Manual config failed');
            }
            setManualSuccess(data?.subscribeError ? `Saved. Webhook subscription failed: ${data.subscribeError}` : 'Saved and subscribed.');
        } catch (err: any) {
            setManualError(err?.message || 'Manual config failed');
        } finally {
            setManualLoading(false);
        }
    };

    const openRegistrationWizard = () => {
        setRegistrationStep(1);
        setRegistrationRequestSent(false);
        setRegistrationVerified(false);
        setRegistrationRegistered(false);
        setRegistrationProfileUpdated(false);
        setRegistrationError(null);
        setRegistrationNumbersError(null);
        setRegistrationCode('');
        setRegistrationPin('');
        setShowRegistrationWizard(true);
        if (sessionToken) {
            fetchRegistrationConfig();
            fetchRegistrationNumbers();
        }
    };

    const closeRegistrationWizard = () => {
        setShowRegistrationWizard(false);
    };

    const fetchRegistrationConfig = () => {
        if (!sessionToken || !profileId) return;
        setRegistrationLoading(true);
        setRegistrationError(null);
        fetch(`${SOCKET_URL}/api/waba/registration/config?profileId=${encodeURIComponent(profileId)}`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const cfg = data.data || {};
                    setRegistrationConfig(cfg);
                    setRegistrationWabaId(cfg.wabaId || '');
                    setRegistrationPhoneNumberId(cfg.phoneNumberId || '');
                    setRegistrationError(null);
                } else {
                    setRegistrationConfig(null);
                    setRegistrationError(data?.error || 'Failed to load registration config');
                }
            })
            .finally(() => setRegistrationLoading(false));
    };

    const fetchRegistrationNumbers = () => {
        if (!sessionToken || !profileId) return;
        setRegistrationNumbersLoading(true);
        setRegistrationNumbersError(null);
        const params = new URLSearchParams();
        params.set('profileId', profileId);
        if (registrationWabaId.trim()) params.set('wabaId', registrationWabaId.trim());
        fetch(`${SOCKET_URL}/api/waba/registration/phone-numbers?${params.toString()}`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const payload = data.data?.data || data.data || {};
                    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
                    setRegistrationNumbers(list);
                    if (!registrationPhoneNumberId && list[0]?.id) {
                        setRegistrationPhoneNumberId(list[0].id);
                    }
                    setRegistrationNumbersError(null);
                } else {
                    setRegistrationNumbers([]);
                    setRegistrationNumbersError(data?.error || 'Failed to load phone numbers');
                }
            })
            .finally(() => setRegistrationNumbersLoading(false));
    };

    const handleRequestVerificationCode = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('request');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/request-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    codeMethod: registrationCodeMethod,
                    locale: registrationLocale.trim() || 'en_US'
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to request verification code');
            }
            setRegistrationRequestSent(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to request verification code');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleVerifyCode = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('verify');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/verify-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    code: registrationCode.trim()
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to verify code');
            }
            setRegistrationVerified(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to verify code');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleRegisterNumber = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('register');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    pin: registrationPin.trim()
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to register number');
            }
            setRegistrationRegistered(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to register number');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleUpdateProfile = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('profile');
        setRegistrationError(null);
        try {
            const parsed = JSON.parse(registrationProfileJson);
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/profile`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    profile: parsed
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to update business profile');
            }
            setRegistrationProfileUpdated(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to update business profile');
        } finally {
            setRegistrationBusy(null);
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

    const fetchTeamUsers = async () => {
        if (!sessionToken) return;
        setTeamLoading(true);
        setTeamError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load team users');
            }
            setTeamUsers(Array.isArray(data?.data?.users) ? data.data.users : []);
            setTeamCurrentRole((data?.data?.currentUserRole || 'agent') as TeamRole);
            setTeamCurrentUserId(data?.data?.currentUserId || null);
        } catch (err: any) {
            setTeamError(err?.message || 'Failed to load team users');
            setTeamUsers([]);
        } finally {
            setTeamLoading(false);
        }
    };

    const canManageTeam = teamCurrentRole === 'owner' || teamCurrentRole === 'admin';

    const handleInviteTeamUser = async () => {
        if (!sessionToken) return;
        setInviteLoading(true);
        setInviteError(null);
        setInviteSuccess(null);
        try {
            const email = inviteEmail.trim().toLowerCase();
            if (!email) throw new Error('Email is required');

            const res = await fetch(`${SOCKET_URL}/api/company/team-users/invite`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email,
                    role: inviteRole
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to invite user');
            }
            setInviteSuccess(`Invite sent to ${email}`);
            setInviteEmail('');
            await fetchTeamUsers();
        } catch (err: any) {
            setInviteError(err?.message || 'Failed to invite user');
        } finally {
            setInviteLoading(false);
        }
    };

    const handleUpdateTeamRole = async (userId: string, role: TeamRole) => {
        if (!sessionToken) return;
        setRoleSavingUserId(userId);
        setTeamError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users/${encodeURIComponent(userId)}/role`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ role })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to update role');
            }
            await fetchTeamUsers();
        } catch (err: any) {
            setTeamError(err?.message || 'Failed to update role');
        } finally {
            setRoleSavingUserId(null);
        }
    };

    return (
        <div className="flex-1 bg-[#fcfdfd] p-10 overflow-y-auto text-[#111b21] h-full font-sans">
            <h2 className="text-3xl font-black mb-10 flex items-center gap-4 tracking-tight">
                <Globe className="text-[#00a884] w-8 h-8" /> API & Connectivity
                <span className="text-xs bg-[#f0f2f5] px-4 py-1.5 rounded-full text-[#54656f] font-bold border border-[#eceff1] uppercase tracking-widest">Active profile: {profileId}</span>
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                {/* Embedded Signup Section */}
                <div id="settings-connect" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
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

                {/* Manual Setup Section */}
                <div id="settings-manual" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Manual WABA Setup</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Self‑service fallback when Embedded Signup permissions are not available. Paste WABA IDs and token from Meta UI.
                    </p>
                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">WABA ID</label>
                            <input
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="WhatsApp Business Account ID"
                                value={manualConfig.wabaId}
                                onChange={e => setManualConfig(prev => ({ ...prev, wabaId: e.target.value }))}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID</label>
                            <input
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Business phone number ID"
                                value={manualConfig.phoneNumberId}
                                onChange={e => setManualConfig(prev => ({ ...prev, phoneNumberId: e.target.value }))}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Access Token</label>
                            <textarea
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-mono placeholder-[#aebac1] min-h-[120px]"
                                placeholder="System user access token"
                                value={manualConfig.accessToken}
                                onChange={e => setManualConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                            />
                        </div>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Business ID (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta business ID"
                                    value={manualConfig.businessId}
                                    onChange={e => setManualConfig(prev => ({ ...prev, businessId: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Verify Token (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Webhook verify token"
                                    value={manualConfig.verifyToken}
                                    onChange={e => setManualConfig(prev => ({ ...prev, verifyToken: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">App ID (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta App ID"
                                    value={manualConfig.appId}
                                    onChange={e => setManualConfig(prev => ({ ...prev, appId: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">App Secret (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta App Secret"
                                    value={manualConfig.appSecret}
                                    onChange={e => setManualConfig(prev => ({ ...prev, appSecret: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">API Version (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="v19.0"
                                    value={manualConfig.apiVersion}
                                    onChange={e => setManualConfig(prev => ({ ...prev, apiVersion: e.target.value }))}
                                />
                            </div>
                        </div>
                        <button
                            onClick={handleManualConfigSave}
                            disabled={manualLoading || !sessionToken}
                            className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                        >
                            {manualLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Save Manual Config'}
                        </button>
                        {manualError && <p className="text-sm text-rose-600 font-semibold">{manualError}</p>}
                        {manualSuccess && <p className="text-sm text-emerald-600 font-semibold">{manualSuccess}</p>}
                    </div>
                </div>

                {/* Number Registration Section */}
                <div id="settings-register" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Register WhatsApp Number</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Complete verification and registration in one guided flow. Display name changes must be handled in Meta Business Manager.
                    </p>
                    <button
                        onClick={openRegistrationWizard}
                        disabled={!sessionToken}
                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                    >
                        Launch Guided Setup
                    </button>
                    {(registrationError || registrationNumbersError) && (
                        <p className="text-sm text-rose-600 mt-4 font-semibold">
                            {registrationError || registrationNumbersError}
                        </p>
                    )}
                </div>

                {/* Webhooks Section */}
                <div id="settings-webhooks" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
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

                {/* API Keys Section Removed */}

                {/* Conversational Components */}
                <div id="settings-conversational" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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
                <div id="settings-reminder" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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
                <div id="settings-fallback" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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
                <div id="settings-quick-replies" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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

                <div id="settings-team-users" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Team Users</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Invite teammates with their own login to the same team inbox.
                            </p>
                        </div>
                        <button
                            onClick={fetchTeamUsers}
                            disabled={teamLoading || !sessionToken}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                        >
                            Refresh
                        </button>
                    </div>

                    {teamError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {teamError}
                        </div>
                    )}

                    {canManageTeam && (
                        <div className="mb-6 grid grid-cols-1 lg:grid-cols-5 gap-3 bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-4">
                            <input
                                className="lg:col-span-3 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="agent@company.com"
                                value={inviteEmail}
                                onChange={e => setInviteEmail(e.target.value)}
                            />
                            <select
                                className="lg:col-span-1 bg-white border border-[#eceff1] rounded-xl px-3 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={inviteRole}
                                onChange={e => setInviteRole((e.target.value as TeamRole) || 'agent')}
                            >
                                <option value="agent">Agent</option>
                                <option value="admin">Admin</option>
                            </select>
                            <button
                                onClick={handleInviteTeamUser}
                                disabled={inviteLoading || !inviteEmail.trim()}
                                className="lg:col-span-1 bg-[#00a884] hover:bg-[#008f6f] text-white rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest disabled:opacity-50"
                            >
                                {inviteLoading ? 'Sending…' : 'Invite'}
                            </button>
                            {inviteError && (
                                <div className="lg:col-span-5 text-sm text-rose-600 font-medium">
                                    {inviteError}
                                </div>
                            )}
                            {inviteSuccess && (
                                <div className="lg:col-span-5 text-sm text-emerald-600 font-medium">
                                    {inviteSuccess}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                        <table className="w-full text-left">
                            <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                <tr>
                                    <th className="px-4 py-3">User</th>
                                    <th className="px-4 py-3">Role</th>
                                    <th className="px-4 py-3">Last Sign-In</th>
                                    <th className="px-4 py-3">Joined</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#f0f2f5]">
                                {teamLoading ? (
                                    <tr>
                                        <td className="px-4 py-4 text-sm text-[#8696a0]" colSpan={4}>
                                            Loading team users...
                                        </td>
                                    </tr>
                                ) : teamUsers.length === 0 ? (
                                    <tr>
                                        <td className="px-4 py-4 text-sm text-[#8696a0]" colSpan={4}>
                                            No team users found.
                                        </td>
                                    </tr>
                                ) : (
                                    teamUsers.map(item => {
                                        const canChangeRole =
                                            canManageTeam &&
                                            item.id !== teamCurrentUserId &&
                                            !(item.role === 'owner' && teamCurrentRole !== 'owner');
                                        return (
                                            <tr key={item.id} className="hover:bg-white transition-all">
                                                <td className="px-4 py-3">
                                                    <div className="text-sm font-bold text-[#111b21]">{item.name || item.email || item.id}</div>
                                                    <div className="text-xs text-[#54656f] font-medium">{item.email || item.id}</div>
                                                </td>
                                                <td className="px-4 py-3">
                                                    {canChangeRole ? (
                                                        <select
                                                            value={item.role}
                                                            disabled={roleSavingUserId === item.id}
                                                            onChange={(e) => handleUpdateTeamRole(item.id, (e.target.value as TeamRole) || 'agent')}
                                                            className="bg-white border border-[#eceff1] rounded-lg px-2 py-1 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-50"
                                                        >
                                                            <option value="agent">Agent</option>
                                                            <option value="admin">Admin</option>
                                                            {teamCurrentRole === 'owner' && <option value="owner">Owner</option>}
                                                        </select>
                                                    ) : (
                                                        <span className="text-xs font-bold uppercase tracking-widest text-[#54656f]">{item.role}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-xs text-[#54656f]">
                                                    {item.lastSignInAt ? new Date(item.lastSignInAt).toLocaleString() : 'Never'}
                                                </td>
                                                <td className="px-4 py-3 text-xs text-[#54656f]">
                                                    {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—'}
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {isAdmin && (
                    <div id="settings-connected-clients" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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
                    <div id="settings-connected-businesses" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
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

            {showRegistrationWizard && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
                    <div className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl border border-[#eceff1] overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-5 border-b border-[#eceff1]">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-widest text-[#54656f]">Step {registrationStep} of 4</p>
                                <h3 className="text-xl font-bold text-[#111b21]">WhatsApp Number Setup</h3>
                            </div>
                            <button onClick={closeRegistrationWizard} className="text-[#54656f] hover:text-[#111b21] font-bold text-sm">Close</button>
                        </div>

                        <div className="p-6 space-y-5">
                            {registrationStep === 1 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Confirm the WABA and phone number you want to register.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">WABA ID</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationWabaId}
                                            onChange={e => setRegistrationWabaId(e.target.value)}
                                            placeholder="WhatsApp Business Account ID"
                                            readOnly={Boolean(registrationWabaId)}
                                        />
                                        {registrationWabaId && (
                                            <p className="text-[11px] text-[#8696a0] -mt-2">Auto-selected from Meta Embedded Signup.</p>
                                        )}
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationPhoneNumberId}
                                            onChange={e => setRegistrationPhoneNumberId(e.target.value)}
                                            placeholder="Phone Number ID"
                                        />
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <button
                                            onClick={fetchRegistrationNumbers}
                                            disabled={registrationNumbersLoading || !sessionToken}
                                            className="bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-2.5 px-4 rounded-xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationNumbersLoading ? 'Loading...' : 'Fetch Phone Numbers'}
                                        </button>
                                        {registrationNumbers.length > 0 && (
                                            <span className="text-xs text-[#54656f] font-semibold">
                                                Found {registrationNumbers.length} number(s)
                                            </span>
                                        )}
                                    </div>
                                    {registrationNumbers.length > 0 && (
                                        <div className="space-y-2 max-h-40 overflow-y-auto">
                                            {registrationNumbers.map((num: any) => (
                                                <button
                                                    key={num.id}
                                                    onClick={() => setRegistrationPhoneNumberId(num.id)}
                                                    className={`w-full text-left p-3 rounded-2xl border text-xs font-mono ${registrationPhoneNumberId === num.id ? 'border-[#00a884] bg-[#00a884]/5 text-[#00a884]' : 'border-[#eceff1] bg-[#fcfdfd] text-[#54656f]'}`}
                                                >
                                                    {num.display_phone_number || '—'} · {num.verified_name || '—'} · {num.quality_rating || '—'} · {num.id}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            {registrationStep === 2 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Send a verification code to the phone number via SMS or Voice.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Code Method</label>
                                        <select
                                            value={registrationCodeMethod}
                                            onChange={e => setRegistrationCodeMethod(e.target.value as 'SMS' | 'VOICE')}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                        >
                                            <option value="SMS">SMS</option>
                                            <option value="VOICE">VOICE</option>
                                        </select>
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Locale</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationLocale}
                                            onChange={e => setRegistrationLocale(e.target.value)}
                                            placeholder="en_US"
                                        />
                                    </div>
                                    <button
                                        onClick={handleRequestVerificationCode}
                                        disabled={registrationBusy !== null || !sessionToken}
                                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                    >
                                        {registrationBusy === 'request' ? 'Requesting...' : 'Request Code'}
                                    </button>
                                    {registrationRequestSent && (
                                        <p className="text-xs text-[#00a884] font-bold uppercase tracking-widest">Code sent</p>
                                    )}
                                </>
                            )}

                            {registrationStep === 3 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Enter the verification code received by the client.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Verification Code</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationCode}
                                            onChange={e => setRegistrationCode(e.target.value)}
                                            placeholder="123456"
                                        />
                                    </div>
                                    <button
                                        onClick={handleVerifyCode}
                                        disabled={registrationBusy !== null || !sessionToken}
                                        className="w-full bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                    >
                                        {registrationBusy === 'verify' ? 'Verifying...' : 'Verify Code'}
                                    </button>
                                    {registrationVerified && (
                                        <p className="text-xs text-[#00a884] font-bold uppercase tracking-widest">Verified</p>
                                    )}
                                </>
                            )}

                            {registrationStep === 4 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Register the number with a 6-digit PIN and optionally set the business profile.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Two-Step PIN</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationPin}
                                            onChange={e => setRegistrationPin(e.target.value)}
                                            placeholder="6 digits"
                                        />
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Business Profile JSON</label>
                                        <textarea
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-xs font-mono text-[#111b21] min-h-[140px]"
                                            value={registrationProfileJson}
                                            onChange={e => setRegistrationProfileJson(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        <button
                                            onClick={handleRegisterNumber}
                                            disabled={registrationBusy !== null || !sessionToken}
                                            className="bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationBusy === 'register' ? 'Registering...' : 'Register Number'}
                                        </button>
                                        <button
                                            onClick={handleUpdateProfile}
                                            disabled={registrationBusy !== null || !sessionToken}
                                            className="bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationBusy === 'profile' ? 'Saving...' : 'Update Profile'}
                                        </button>
                                    </div>
                                    <div className="flex flex-wrap gap-3 text-xs font-bold uppercase tracking-widest text-[#54656f]">
                                        {registrationRegistered && <span className="text-[#00a884]">Registered</span>}
                                        {registrationProfileUpdated && <span className="text-[#00a884]">Profile Updated</span>}
                                    </div>
                                </>
                            )}

                            {(registrationError || registrationNumbersError) && (
                                <p className="text-sm text-rose-600 font-semibold">
                                    {registrationError || registrationNumbersError}
                                </p>
                            )}
                        </div>

                        <div className="flex items-center justify-between px-6 py-5 border-t border-[#eceff1]">
                            <button
                                onClick={() => setRegistrationStep(prev => (prev > 1 ? (prev - 1) as 1 | 2 | 3 | 4 : prev))}
                                disabled={registrationStep === 1}
                                className="text-xs font-bold uppercase tracking-widest text-[#54656f] disabled:opacity-40"
                            >
                                Back
                            </button>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setRegistrationStep(prev => (prev < 4 ? (prev + 1) as 1 | 2 | 3 | 4 : prev))}
                                    disabled={
                                        (registrationStep === 1 && !registrationPhoneNumberId) ||
                                        (registrationStep === 2 && !registrationRequestSent) ||
                                        (registrationStep === 3 && !registrationVerified) ||
                                        registrationStep === 4
                                    }
                                    className="bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 px-6 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                >
                                    {registrationStep === 4 ? 'Done' : 'Next'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
