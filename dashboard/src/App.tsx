
import React, { Suspense, lazy, useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
import { getSocketUrl, resolveCompanyIdFromLocation } from './runtimeConfig';
import { useElementSize } from './hooks/useElementSize';
import { buildActionsFromBuilder, buildBuilderFromActions } from './features/workflows/builderConverters';
import BroadcastView from './features/workspace/BroadcastView';
import AutomationsView from './features/workspace/AutomationsView';
import ContactsView from './features/workspace/ContactsView';
import ChatbotsView from './features/workspace/ChatbotsView';
import SettingsView from './features/workspace/SettingsView';
import ChatflowView from './features/workspace/ChatflowView';
import AddProfileModal from './features/workspace/modals/AddProfileModal';
import EditProfileModal from './features/workspace/modals/EditProfileModal';
import NewChatModal from './features/workspace/modals/NewChatModal';
import OnboardingTutorialModal from './features/workspace/modals/OnboardingTutorialModal';
import {
    formatBps,
    formatBytes,
    formatDateLabel,
    formatLogTime,
    formatPhoneNumber,
    formatRemaining,
    getCleanId,
    getInitials,
    getLastInboundTs,
    getMessagePreviewText,
    pickContactName,
    redactSecret,
    textColor,
    withHexAlpha
} from './features/chat/utils';


const SOCKET_URL = getSocketUrl();
const SINGLE_PROFILE_MODE = true;
const OAUTH_PENDING_COMPANY_KEY = 'pendingOAuthCompanyId';

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

type WorkflowTemplateOption = {
    id: string;
    name: string;
    language: string;
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

type AppToast = {
    id: number;
    message: string;
    tone: 'success' | 'error';
};

type OnboardingStepId = 'welcome' | 'waba_id' | 'phone_number_id' | 'access_token' | 'verify_token' | 'connect';

type OnboardingFieldKey = 'wabaId' | 'phoneNumberId' | 'accessToken' | 'verifyToken';

type OnboardingStepConfig = {
    id: OnboardingStepId;
    title: string;
    description: string;
    details: string[];
    fieldKey?: OnboardingFieldKey;
    fieldLabel?: string;
    fieldPlaceholder?: string;
    fieldType?: 'text' | 'password';
    whereToGet?: string[];
    guideLinks?: Array<{
        label: string;
        href: string;
    }>;
};

type ContactMeta = {
    name?: string;
    lastInboundAt?: string | null;
    tags?: string[];
    humanTakeover?: boolean;
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
const ONBOARDING_TOUR_STORAGE_PREFIX = 'onboardingTourSeen:';
const ONBOARDING_TOUR_VERSION = 'v1';
const ONBOARDING_SETUP_DEFAULTS: Record<OnboardingFieldKey, string> = {
    wabaId: '',
    phoneNumberId: '',
    accessToken: '',
    verifyToken: ''
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


export default function App() {
    // Auth State
    const [session, setSession] = useState<Session | null>(null);
    const [authChecking, setAuthChecking] = useState(true);
    const [hostAuthError, setHostAuthError] = useState<string | null>(null);

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
    const [composerMediaType, setComposerMediaType] = useState<'none' | 'image' | 'video' | 'document'>('none');
    const [composerMediaUrl, setComposerMediaUrl] = useState('');
    const [composerMediaFilename, setComposerMediaFilename] = useState('');
    const [showMediaComposer, setShowMediaComposer] = useState(false);
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
    const [appToast, setAppToast] = useState<AppToast | null>(null);
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
    const [workflowTemplateOptions, setWorkflowTemplateOptions] = useState<WorkflowTemplateOption[]>([]);
    const [assignMenuContactId, setAssignMenuContactId] = useState<string | null>(null);
    const [assigningContactId, setAssigningContactId] = useState<string | null>(null);
    const [humanTakeoverSaving, setHumanTakeoverSaving] = useState(false);
    const [mediaCache, setMediaCache] = useState<Record<string, MediaData>>({});
    const [showContactInfo, setShowContactInfo] = useState(false);
    const [showNewChatModal, setShowNewChatModal] = useState(false);
    const [newPhoneNumber, setNewPhoneNumber] = useState('');
    const [showOnboardingTutorial, setShowOnboardingTutorial] = useState(false);
    const [onboardingStep, setOnboardingStep] = useState(0);
    const [onboardingSetup, setOnboardingSetup] = useState<Record<OnboardingFieldKey, string>>({ ...ONBOARDING_SETUP_DEFAULTS });
    const [onboardingValidationError, setOnboardingValidationError] = useState<string | null>(null);
    const [onboardingConnectLoading, setOnboardingConnectLoading] = useState(false);
    const [onboardingConnectError, setOnboardingConnectError] = useState<string | null>(null);
    const [onboardingConnectSuccess, setOnboardingConnectSuccess] = useState<string | null>(null);
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

    const isWabaProviderAdmin = useMemo(() => {
        const userMeta: any = (session?.user?.user_metadata as any) || {};
        const appMeta: any = (session?.user?.app_metadata as any) || {};
        const candidates = [
            userMeta.waba_admin,
            userMeta.is_waba_admin,
            appMeta.waba_admin,
            appMeta.is_waba_admin,
            userMeta.role,
            appMeta.role
        ];
        return candidates.some((value) => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                return normalized === 'true' || normalized === 'waba_admin' || normalized === 'super_admin';
            }
            return false;
        });
    }, [session?.user?.app_metadata, session?.user?.user_metadata]);

    const onboardingSteps = useMemo<OnboardingStepConfig[]>(() => ([
        {
            id: 'welcome',
            title: 'Required first-time setup',
            description: 'Complete these steps to activate your WhatsApp workspace.',
            details: [
                'This setup is required for company admins and cannot be skipped.',
                'You will enter real Meta credentials and verify connection before continuing.'
            ]
        },
        {
            id: 'waba_id',
            title: 'Step 1: WhatsApp Business Account ID',
            description: 'Enter the WABA ID for the account you want to connect.',
            details: [
                'Use numbers only (example: 102290129340398).',
                'Make sure this WABA belongs to the same Meta Business that owns the phone number.'
            ],
            fieldKey: 'wabaId',
            fieldLabel: 'WABA ID',
            fieldPlaceholder: 'e.g. 102290129340398',
            fieldType: 'text',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > WhatsApp Business Account ID.',
                'Or Meta Business Manager > WhatsApp Accounts > select account > copy ID.'
            ],
            guideLinks: [
                { label: 'Cloud API Get Started', href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started' }
            ]
        },
        {
            id: 'phone_number_id',
            title: 'Step 2: Business Phone Number ID',
            description: 'Enter the phone number ID linked to your WABA.',
            details: [
                'Use numbers only (example: 106540352242922).',
                'This is NOT your display phone number; it is the Meta phone number ID.'
            ],
            fieldKey: 'phoneNumberId',
            fieldLabel: 'Phone Number ID',
            fieldPlaceholder: 'e.g. 106540352242922',
            fieldType: 'text',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > Phone number ID.',
                'Use the ID from the number you want this workspace to send from.'
            ],
            guideLinks: [
                { label: 'WhatsApp API Setup', href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers' }
            ]
        },
        {
            id: 'access_token',
            title: 'Step 3: Access Token',
            description: 'Enter a valid token with WhatsApp permissions.',
            details: [
                'Use a system user long-lived token in production.',
                'Token must allow WhatsApp Business messaging and management.'
            ],
            fieldKey: 'accessToken',
            fieldLabel: 'Access Token',
            fieldPlaceholder: 'Paste access token',
            fieldType: 'password',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > temporary token (testing).',
                'For production, use Business Settings > System Users > generate long-lived token.'
            ],
            guideLinks: [
                { label: 'System User Access Tokens', href: 'https://developers.facebook.com/docs/whatsapp/business-management-api/get-started' }
            ]
        },
        {
            id: 'verify_token',
            title: 'Step 4: Webhook Verify Token',
            description: 'Create a verify token you can remember and use in Meta webhook settings.',
            details: [
                'This is your own secret string, not issued by Meta.',
                'Use at least 8 characters with letters and numbers.'
            ],
            fieldKey: 'verifyToken',
            fieldLabel: 'Verify Token',
            fieldPlaceholder: 'e.g. mycompany_verify_2026',
            fieldType: 'password',
            whereToGet: [
                'Create your own token value, then reuse the exact same value in Meta webhook verify token field.'
            ],
            guideLinks: [
                { label: 'Webhook Verification', href: 'https://developers.facebook.com/docs/graph-api/webhooks/getting-started' }
            ]
        },
        {
            id: 'connect',
            title: 'Step 5: Save and verify setup',
            description: 'We will save config and verify it by subscribing your app to this WABA.',
            details: [
                'Click "Save and verify connection".',
                'If verification fails, fix the value(s) and retry before continuing.'
            ]
        }
    ]), []);

    const scrollToSettingsSection = useCallback((id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, []);

    const onboardingStorageKey = session?.user?.id
        ? `${ONBOARDING_TOUR_STORAGE_PREFIX}${ONBOARDING_TOUR_VERSION}:${session.user.id}`
        : null;

    const resetOnboardingWizard = useCallback(() => {
        setOnboardingStep(0);
        setOnboardingSetup({ ...ONBOARDING_SETUP_DEFAULTS });
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
        setOnboardingConnectLoading(false);
    }, []);

    const completeOnboardingTutorial = useCallback(() => {
        if (!onboardingStorageKey) return;
        try {
            window.localStorage.setItem(onboardingStorageKey, '1');
        } catch {
            // ignore storage errors
        }
    }, [onboardingStorageKey]);

    const closeOnboardingTutorial = useCallback((markAsComplete: boolean) => {
        if (markAsComplete) {
            completeOnboardingTutorial();
        }
        setShowOnboardingTutorial(false);
        resetOnboardingWizard();
    }, [completeOnboardingTutorial, resetOnboardingWizard]);

    const updateOnboardingField = useCallback((field: OnboardingFieldKey, value: string) => {
        setOnboardingSetup(prev => ({ ...prev, [field]: value }));
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
    }, []);

    const isNumericMetaId = useCallback((value: string) => /^\d{6,25}$/.test(value.trim()), []);
    const isAccessTokenValid = useCallback((value: string) => value.trim().length >= 30, []);
    const isVerifyTokenValid = useCallback((value: string) => value.trim().length >= 8, []);

    const currentOnboardingStep = onboardingSteps[Math.min(onboardingStep, onboardingSteps.length - 1)] || onboardingSteps[0];
    const isFinalOnboardingStep = onboardingStep >= onboardingSteps.length - 1;

    const isCurrentOnboardingStepValid = useMemo(() => {
        switch (currentOnboardingStep.id) {
            case 'waba_id':
                return isNumericMetaId(onboardingSetup.wabaId);
            case 'phone_number_id':
                return isNumericMetaId(onboardingSetup.phoneNumberId);
            case 'access_token':
                return isAccessTokenValid(onboardingSetup.accessToken);
            case 'verify_token':
                return isVerifyTokenValid(onboardingSetup.verifyToken);
            case 'connect':
                return Boolean(onboardingConnectSuccess);
            default:
                return true;
        }
    }, [
        currentOnboardingStep.id,
        isAccessTokenValid,
        isNumericMetaId,
        isVerifyTokenValid,
        onboardingConnectSuccess,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId
    ]);

    const validateCurrentOnboardingStep = useCallback((): string | null => {
        switch (currentOnboardingStep.id) {
            case 'waba_id':
                return isNumericMetaId(onboardingSetup.wabaId) ? null : 'WABA ID must be numeric.';
            case 'phone_number_id':
                return isNumericMetaId(onboardingSetup.phoneNumberId) ? null : 'Phone Number ID must be numeric.';
            case 'access_token':
                return isAccessTokenValid(onboardingSetup.accessToken) ? null : 'Access token looks incomplete. Paste full token.';
            case 'verify_token':
                return isVerifyTokenValid(onboardingSetup.verifyToken) ? null : 'Verify token must be at least 8 characters.';
            case 'connect':
                return onboardingConnectSuccess ? null : 'Save and verify connection before continuing.';
            default:
                return null;
        }
    }, [
        currentOnboardingStep.id,
        isAccessTokenValid,
        isNumericMetaId,
        isVerifyTokenValid,
        onboardingConnectSuccess,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId
    ]);

    const handleOnboardingConnect = useCallback(async () => {
        if (!session?.access_token) {
            setOnboardingConnectError('You must be logged in to save setup.');
            return;
        }
        if (!activeProfileId) {
            setOnboardingConnectError('No active profile selected yet. Wait for profile to load and retry.');
            return;
        }
        setOnboardingConnectLoading(true);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/manual-config`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId: activeProfileId,
                    wabaId: onboardingSetup.wabaId.trim(),
                    phoneNumberId: onboardingSetup.phoneNumberId.trim(),
                    accessToken: onboardingSetup.accessToken.trim(),
                    verifyToken: onboardingSetup.verifyToken.trim(),
                    businessId: null,
                    appId: null,
                    appSecret: null,
                    apiVersion: null
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to save setup');
            }
            if (data?.subscribeError) {
                throw new Error(`Saved, but Meta verification failed: ${data.subscribeError}`);
            }
            setOnboardingConnectSuccess('Connection verified successfully. You can continue.');
        } catch (err: any) {
            setOnboardingConnectError(err?.message || 'Failed to verify connection');
        } finally {
            setOnboardingConnectLoading(false);
        }
    }, [
        activeProfileId,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId,
        session?.access_token
    ]);

    const handleOnboardingNext = useCallback(() => {
        const validationError = validateCurrentOnboardingStep();
        if (validationError) {
            setOnboardingValidationError(validationError);
            return;
        }
        setOnboardingValidationError(null);
        if (onboardingStep >= onboardingSteps.length - 1) {
            closeOnboardingTutorial(true);
            return;
        }
        setOnboardingStep((prev) => prev + 1);
    }, [closeOnboardingTutorial, onboardingStep, onboardingSteps.length, validateCurrentOnboardingStep]);

    const handleOnboardingBack = useCallback(() => {
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingStep((prev) => Math.max(prev - 1, 0));
    }, []);

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

    const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
        if (!message) return;
        setAppToast({
            id: Date.now(),
            message,
            tone
        });
    }, []);

    useEffect(() => {
        if (!appToast) return;
        const timer = window.setTimeout(() => {
            setAppToast((current) => (current?.id === appToast.id ? null : current));
        }, 2400);
        return () => window.clearTimeout(timer);
    }, [appToast]);

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

    const fetchWorkflowTemplateOptions = useCallback(async () => {
        if (!activeProfileId || !session?.access_token) {
            setWorkflowTemplateOptions([]);
            return;
        }

        try {
            const params = new URLSearchParams();
            params.set('profileId', activeProfileId);
            params.set('limit', '100');
            params.set('status', 'APPROVED');
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load templates');
            }
            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const mapped: WorkflowTemplateOption[] = rows
                .map((row: any) => ({
                    id: typeof row?.id === 'string' ? row.id : '',
                    name: typeof row?.name === 'string' ? row.name : '',
                    language: typeof row?.language === 'string' ? row.language : 'en_US'
                }))
                .filter((tpl: WorkflowTemplateOption) => Boolean(tpl.name))
                .sort((a: WorkflowTemplateOption, b: WorkflowTemplateOption) => {
                    const nameCmp = a.name.localeCompare(b.name);
                    if (nameCmp !== 0) return nameCmp;
                    return a.language.localeCompare(b.language);
                });
            setWorkflowTemplateOptions(mapped);
        } catch (err) {
            console.error('Failed to load workflow template options:', err);
            setWorkflowTemplateOptions([]);
        }
    }, [activeProfileId, session?.access_token]);

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
        if (!activeProfileId || !session?.access_token) {
            setQuickReplies([]);
            return;
        }
        setQuickRepliesLoading(true);
        setQuickRepliesError(null);
        fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`, {
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        })
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
    }, [activeProfileId, session?.access_token]);

    const saveQuickReplies = useCallback(async (items: QuickReply[]) => {
        if (!activeProfileId || !session?.access_token) return;
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
            const res = await fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
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
    }, [activeProfileId, normalizeQuickReplyShortcut, session?.access_token]);

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
            setComposerMediaType('none');
            setComposerMediaUrl('');
            setComposerMediaFilename('');
            setShowMediaComposer(false);
            return;
        }
        try {
            const key = getDraftStorageKey(activeProfileId, selectedChatId);
            if (!key) {
                setMessageText('');
                setComposerMediaType('none');
                setComposerMediaUrl('');
                setComposerMediaFilename('');
                setShowMediaComposer(false);
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
        if (activeView !== 'chatflow') return;
        if (!teamUsers.length && !teamUsersLoading) {
            fetchTeamUsers();
        }
        fetchWorkflowTemplateOptions();
    }, [activeView, teamUsers.length, teamUsersLoading, fetchTeamUsers, fetchWorkflowTemplateOptions]);

    useEffect(() => {
        setAssignMenuContactId(null);
    }, [activeProfileId, workspaceSection]);


    const handleSignOut = async () => {
        clearAllDrafts();
        setMessageText('');
        setHostAuthError(null);
        setShowOnboardingTutorial(false);
        resetOnboardingWizard();
        try {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
        } catch {
            // ignore
        }
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
            return;
        }

        let pendingCompanyId = '';
        try {
            pendingCompanyId = window.localStorage.getItem(OAUTH_PENDING_COMPANY_KEY) || '';
        } catch {
            pendingCompanyId = '';
        }

        const hostCompanyId = resolveCompanyIdFromLocation();
        const requiredCompanyId = String(hostCompanyId || pendingCompanyId || '').trim().toLowerCase();
        if (!requiredCompanyId) {
            setHostAuthError(null);
            return;
        }

        const userCompanyRaw =
            (session.user.user_metadata as any)?.company_id ||
            (session.user.app_metadata as any)?.company_id ||
            '';
        const userCompany = String(userCompanyRaw || '').trim().toLowerCase();
        if (userCompany === requiredCompanyId) {
            try {
                window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
            } catch {
                // ignore
            }
            setHostAuthError(null);
            return;
        }

        const message = userCompany
            ? `This account belongs to "${userCompany}". Please use ${userCompany}.2fast.xyz.`
            : 'This account is not assigned to any company. Ask your admin to set up your account first.';

        setHostAuthError(message);
        try {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
        } catch {
            // ignore
        }
        supabase.auth.signOut().finally(() => {
            setSession(null);
        });
    }, [session]);

    useEffect(() => {
        if (authChecking || hostAuthError) return;
        if (!session?.user?.id || !onboardingStorageKey || !isAdmin || isWabaProviderAdmin) {
            setShowOnboardingTutorial(false);
            resetOnboardingWizard();
            return;
        }

        let hasSeen = false;
        try {
            hasSeen = window.localStorage.getItem(onboardingStorageKey) === '1';
        } catch {
            hasSeen = false;
        }

        if (hasSeen) {
            setShowOnboardingTutorial(false);
            return;
        }

        resetOnboardingWizard();
        setShowOnboardingTutorial(true);
    }, [authChecking, hostAuthError, isAdmin, isWabaProviderAdmin, onboardingStorageKey, resetOnboardingWizard, session?.user?.id]);

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
        const normalized = (Array.isArray(list) ? list : []).map((wf: any) => {
            if (wf?.builder && Array.isArray(wf.builder.nodes)) return wf;
            return {
                ...wf,
                builder: buildBuilderFromActions(Array.isArray(wf?.actions) ? wf.actions : [], wf.id)
            };
        });

        setWorkflows(normalized);
        const nextSelected = normalized[0]?.id || null;
        if (!selectedWorkflowId || !normalized.find((f: any) => f.id === selectedWorkflowId)) {
            setSelectedWorkflowId(nextSelected);
        }
        const drafts: Record<string, string> = {};
        normalized.forEach((wf: any) => {
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

            showToast('Workflows saved', 'success');
        } catch (err: any) {
            showToast(err?.message || 'Failed to save workflows', 'error');
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

    const workflowTagOptions = useMemo(() => {
        const seen = new Set<string>();
        Object.values(contacts).forEach((contact) => {
            const tags = Array.isArray(contact?.tags) ? contact.tags : [];
            tags.forEach((tag) => {
                const value = typeof tag === 'string' ? tag.trim() : '';
                if (value) seen.add(value);
            });
        });
        contactTagsDraft.forEach((tag) => {
            const value = typeof tag === 'string' ? tag.trim() : '';
            if (value) seen.add(value);
        });
        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }, [contacts, contactTagsDraft]);

    const workflowTriggerOptions = useMemo(() => {
        return workflows
            .map((wf: any) => {
                const id = typeof wf?.id === 'string' ? wf.id : '';
                if (!id) return null;
                const keyword = typeof wf?.trigger_keyword === 'string' ? wf.trigger_keyword.trim() : '';
                return {
                    id,
                    name: keyword ? `${id} (${keyword})` : id
                };
            })
            .filter(Boolean) as Array<{ id: string; name?: string }>;
    }, [workflows]);

    const workflowVariableOptions = useMemo(() => {
        const seen = new Set<string>();

        workflows.forEach((wf: any) => {
            const actions = Array.isArray(wf?.actions) ? wf.actions : [];
            actions.forEach((action: any) => {
                if (action?.type !== 'ask_question') return;
                const key = typeof action?.save_as === 'string'
                    ? action.save_as.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
                    : '';
                if (key) seen.add(key);
            });
        });

        allMessages.forEach((msg) => {
            const vars = msg?.workflowState?.vars;
            if (!vars || typeof vars !== 'object') return;
            Object.keys(vars).forEach((rawKey) => {
                const key = typeof rawKey === 'string'
                    ? rawKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
                    : '';
                if (key) seen.add(key);
            });
        });

        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }, [workflows, allMessages]);

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

    const selectedWorkflowMemory = useMemo(() => {
        let vars: Record<string, string> = {};
        let qaHistory: Array<{ key: string; question: string; answer: string; at: string }> = [];

        for (let idx = currentChatMessages.length - 1; idx >= 0; idx -= 1) {
            const state = currentChatMessages[idx]?.workflowState;
            if (!state || typeof state !== 'object') continue;

            if (Object.keys(vars).length === 0 && state.vars && typeof state.vars === 'object') {
                const nextVars: Record<string, string> = {};
                Object.entries(state.vars as Record<string, unknown>).forEach(([key, value]) => {
                    if (typeof key !== 'string') return;
                    const normalized = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
                    if (!normalized) return;
                    if (value === null || value === undefined) return;
                    nextVars[normalized] = String(value);
                });
                if (Object.keys(nextVars).length > 0) vars = nextVars;
            }

            if (qaHistory.length === 0 && Array.isArray(state.qa_history)) {
                const nextQa = state.qa_history
                    .map((entry: any) => ({
                        key: typeof entry?.key === 'string' ? entry.key : '',
                        question: typeof entry?.question === 'string' ? entry.question : '',
                        answer: typeof entry?.answer === 'string' ? entry.answer : '',
                        at: typeof entry?.at === 'string' ? entry.at : ''
                    }))
                    .filter((entry: any) => entry.key && entry.answer);
                if (nextQa.length > 0) qaHistory = nextQa;
            }

            if (Object.keys(vars).length > 0 && qaHistory.length > 0) break;
        }

        return {
            vars,
            qaHistory: qaHistory.slice(-20).reverse()
        };
    }, [currentChatMessages]);

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

    const messageContentHeight = useMemo(() => {
        if (messageRows.length === 0) return 0;
        let total = 0;
        for (let index = 0; index < messageRows.length; index += 1) {
            const size = messageRowHeight.getRowHeight(index);
            if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
                total += size;
            } else {
                total += 120;
            }
        }
        return total;
    }, [messageRows, messageRowHeight]);

    const messageTopPadding = useMemo(() => {
        const viewportHeight = messageViewport.height || 0;
        if (!viewportHeight) return 0;
        return Math.max(0, viewportHeight - messageContentHeight);
    }, [messageViewport.height, messageContentHeight]);

    useEffect(() => {
        if (!selectedChatId) return;
        if (messageRows.length === 0) return;
        requestAnimationFrame(() => {
            messageListRef.current?.scrollToRow({
                index: messageRows.length - 1,
                align: 'end'
            });
        });
    }, [selectedChatId, messageRows.length, messageViewport.height]);

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
    const selectedHumanTakeover = Boolean(selectedContact?.humanTakeover);
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
    const hasComposerMedia = composerMediaType !== 'none' && composerMediaUrl.trim().length > 0;
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
        if (!socket || !activeProfileId || !selectedChatId) return;
        const outgoingText = messageText.trim();
        const mediaUrl = composerMediaUrl.trim();
        const mediaType = composerMediaType;
        const mediaFilename = composerMediaFilename.trim();
        const sendMedia =
            (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && mediaUrl
                ? {
                    type: mediaType,
                    url: mediaUrl,
                    ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                }
                : null;

        if (!outgoingText && !sendMedia) return;

        socket.emit('sendMessage', {
            profileId: activeProfileId,
            jid: selectedChatId,
            text: outgoingText,
            ...(sendMedia ? { media: sendMedia } : {})
        });
        const tempMsg: Message = {
            key: { id: Math.random().toString(), remoteJid: selectedChatId, fromMe: true },
            message: (() => {
                if (!sendMedia) return { conversation: outgoingText };
                if (sendMedia.type === 'image') {
                    return {
                        ...(outgoingText ? { conversation: outgoingText } : {}),
                        imageMessage: {
                            caption: outgoingText,
                            url: sendMedia.url
                        }
                    };
                }
                if (sendMedia.type === 'video') {
                    return {
                        ...(outgoingText ? { conversation: outgoingText } : {}),
                        videoMessage: {
                            caption: outgoingText,
                            url: sendMedia.url
                        }
                    };
                }
                return {
                    ...(outgoingText ? { conversation: outgoingText } : {}),
                    documentMessage: {
                        caption: outgoingText,
                        fileName: sendMedia.filename || 'document',
                        url: sendMedia.url
                    }
                };
            })(),
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
        setComposerMediaType('none');
        setComposerMediaUrl('');
        setComposerMediaFilename('');
        setShowMediaComposer(false);
    };

    const openSettingsFromMore = useCallback(() => {
        setWorkspaceSection('team-inbox');
        requestAnimationFrame(() => {
            setActiveView('settings');
        });
    }, []);

    const openAnalyticsFromMore = useCallback(() => {
        setWorkspaceSection('team-inbox');
        requestAnimationFrame(() => {
            setShowAnalytics(true);
        });
    }, []);

    const handleToggleHumanTakeover = useCallback(async () => {
        if (!socket || !activeProfileId || !selectedChatId) return;
        if (selectedChatId.endsWith('@g.us')) return;

        const nextEnabled = !selectedHumanTakeover;
        setHumanTakeoverSaving(true);
        try {
            const response: any = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve({ success: false, error: 'Request timed out. Please try again.' });
                }, 8000);
                socket.emit(
                    'contact.human_takeover',
                    { profileId: activeProfileId, jid: selectedChatId, enabled: nextEnabled },
                    (ack: any) => {
                        clearTimeout(timeout);
                        resolve(ack);
                    }
                );
            });
            if (!response?.success) {
                throw new Error(response?.error || 'Failed to update human takeover');
            }
        } catch (err: any) {
            alert(err?.message || 'Failed to update human takeover');
        } finally {
            setHumanTakeoverSaving(false);
        }
    }, [activeProfileId, selectedChatId, selectedHumanTakeover, socket]);

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
                forcedMessage={hostAuthError}
                onLogin={(nextSession) => {
                    setHostAuthError(null);
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
        { id: 'template-library', label: 'Create Template' },
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
                        <button
                            onClick={() => setWorkspaceSection('more')}
                            className="w-10 h-10 rounded-full bg-[#f3f4f6] text-[#6b7280] flex items-center justify-center"
                        >
                            <MoreVertical className="w-5 h-5" />
                        </button>
                        <button
                            onClick={openSettingsFromMore}
                            className="w-10 h-10 rounded-full bg-[#f3f4f6] text-[#6b7280] flex items-center justify-center"
                        >
                            <User className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </header>

            {workspaceSection === 'team-inbox' ? (
                <div className="flex h-screen pt-[72px] bg-[#f8f9fa] overflow-hidden text-[#111b21] font-sans">
            <div className="w-[400px] border-r border-[#eceff1] flex flex-col bg-white">
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
                                            <span className="ml-2 inline-block">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleToggleHumanTakeover();
                                                    }}
                                                    disabled={humanTakeoverSaving}
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all disabled:opacity-60 ${selectedHumanTakeover
                                                            ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                                                            : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                                                        }`}
                                                >
                                                    <Shield className="w-3 h-3" />
                                                    <span>{selectedHumanTakeover ? 'Human' : 'Bot'}</span>
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
                                        width: messageViewport.width || '100%',
                                        paddingTop: messageTopPadding
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
                                                                        const directUrl = msg.message?.imageMessage?.url;
                                                                        const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                        return cacheEntry ? (
                                                                            <img
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                                alt="WhatsApp Attachment"
                                                                                className="max-w-full h-auto block"
                                                                            />
                                                                        ) : directUrl ? (
                                                                            <img
                                                                                src={directUrl}
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
                                                                const docUrl = doc.url || '';
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
                                                                            ) : docUrl ? (
                                                                                <img
                                                                                    src={docUrl}
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
                                                                            } else if (docUrl) {
                                                                                window.open(docUrl, '_blank');
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

                                                            {msg.message?.videoMessage && (() => {
                                                                const mediaId = msg.message?.videoMessage?.mediaId;
                                                                const directUrl = msg.message?.videoMessage?.url;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                return (
                                                                    <div className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]">
                                                                        {cacheEntry ? (
                                                                            <video
                                                                                controls
                                                                                className="max-w-full h-auto block"
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                            />
                                                                        ) : directUrl ? (
                                                                            <video
                                                                                controls
                                                                                className="max-w-full h-auto block"
                                                                                src={directUrl}
                                                                            />
                                                                        ) : (
                                                                            <div className="p-4 text-center" onClick={() => handleDownloadMedia(msg)}>
                                                                                <p className="text-xs text-[#54656f] font-bold">Loading video…</p>
                                                                            </div>
                                                                        )}
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
                            <button
                                type="button"
                                onClick={() => {
                                    setComposerMediaType('image');
                                    setShowMediaComposer(true);
                                }}
                                className={`p-2 rounded-xl transition-all cursor-pointer ${composerMediaType === 'image' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach image"
                            >
                                <ImageIcon className="w-5 h-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setComposerMediaType('document');
                                    setShowMediaComposer(true);
                                }}
                                className={`p-2 rounded-xl transition-all cursor-pointer ${composerMediaType === 'document' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach document"
                            >
                                <FileIcon className="w-5 h-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setComposerMediaType('video');
                                    setShowMediaComposer(true);
                                }}
                                className={`p-2 rounded-xl transition-all cursor-pointer ${composerMediaType === 'video' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach video"
                            >
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
                            {canSendText && showMediaComposer && (
                                <div className="absolute bottom-[58px] left-0 right-0 bg-white border border-[#eceff1] rounded-2xl shadow-xl z-20 p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="text-[11px] font-bold uppercase tracking-widest text-[#54656f]">Attach Media</div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setShowMediaComposer(false);
                                                setComposerMediaType('none');
                                                setComposerMediaUrl('');
                                                setComposerMediaFilename('');
                                            }}
                                            className="text-[#8696a0] hover:text-rose-500"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                        <select
                                            value={composerMediaType}
                                            onChange={(e) => setComposerMediaType(e.target.value as any)}
                                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                        >
                                            <option value="image">Image</option>
                                            <option value="video">Video</option>
                                            <option value="document">Document</option>
                                        </select>
                                        <input
                                            type="text"
                                            placeholder="Public media URL (https://...)"
                                            value={composerMediaUrl}
                                            onChange={(e) => setComposerMediaUrl(e.target.value)}
                                            className="md:col-span-2 bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-mono text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                        />
                                    </div>
                                    {composerMediaType === 'document' && (
                                        <input
                                            type="text"
                                            placeholder="Document filename (optional)"
                                            value={composerMediaFilename}
                                            onChange={(e) => setComposerMediaFilename(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-medium text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                        />
                                    )}
                                    <p className="text-[11px] text-[#6b7280]">
                                        Text + media will be sent in one message.
                                    </p>
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
                            {hasComposerMedia && (
                                <div className="mt-1 text-[11px] font-bold text-[#00a884]">
                                    Attachment ready: {composerMediaType}
                                </div>
                            )}
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
                                (messageText.trim() || hasComposerMedia) ? (
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
                                        <span className="text-[10px] text-[#2563eb] font-bold uppercase tracking-wider">Saved Answers</span>
                                        {Object.keys(selectedWorkflowMemory.vars).length === 0 ? (
                                            <span className="text-[11px] text-[#8696a0]">No saved workflow variables yet</span>
                                        ) : (
                                            <div className="flex flex-col gap-1.5">
                                                {Object.entries(selectedWorkflowMemory.vars).map(([key, value]) => (
                                                    <div key={`var-${key}`} className="bg-white border border-[#eceff1] rounded-xl px-3 py-2">
                                                        <div className="text-[10px] font-black uppercase tracking-wider text-[#2563eb]">{key}</div>
                                                        <div className="text-[12px] font-semibold text-[#111b21] break-words">{value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {selectedWorkflowMemory.qaHistory.length > 0 && (
                                            <div className="flex flex-col gap-1.5">
                                                {selectedWorkflowMemory.qaHistory.map((entry, idx) => (
                                                    <div key={`qa-${entry.key}-${idx}`} className="bg-white border border-[#eceff1] rounded-xl px-3 py-2">
                                                        <div className="text-[10px] font-black uppercase tracking-wider text-[#54656f]">{entry.key}</div>
                                                        {entry.question ? (
                                                            <div className="text-[10px] text-[#64748b] mt-1 break-words">Q: {entry.question}</div>
                                                        ) : null}
                                                        <div className="text-[11px] font-semibold text-[#111b21] break-words mt-1">A: {entry.answer}</div>
                                                        {entry.at ? (
                                                            <div className="text-[10px] text-[#94a3b8] mt-1">{new Date(entry.at).toLocaleString()}</div>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
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
            <AddProfileModal
                open={!SINGLE_PROFILE_MODE && showAddProfileModal}
                profileName={newProfileName}
                isCreatingProfile={isCreatingProfile}
                onProfileNameChange={setNewProfileName}
                onClose={() => setShowAddProfileModal(false)}
                onSubmit={submitAddProfile}
            />

            {/* Edit Profile Modal */}
            <EditProfileModal
                open={!SINGLE_PROFILE_MODE && showEditProfileModal}
                profileName={editingProfileName}
                onProfileNameChange={setEditingProfileName}
                onClose={() => setShowEditProfileModal(false)}
                onSubmit={submitUpdateProfileName}
            />

            {/* New Chat Modal */}
            <NewChatModal
                open={showNewChatModal}
                phoneNumber={newPhoneNumber}
                onPhoneNumberChange={setNewPhoneNumber}
                onClose={() => setShowNewChatModal(false)}
                onSubmit={handleNewChat}
            />

            {/* First Login Onboarding */}
            <OnboardingTutorialModal
                open={showOnboardingTutorial}
                currentStep={currentOnboardingStep}
                steps={onboardingSteps}
                stepIndex={onboardingStep}
                onboardingSetup={onboardingSetup}
                isCurrentStepValid={isCurrentOnboardingStepValid}
                isFinalStep={isFinalOnboardingStep}
                onboardingConnectLoading={onboardingConnectLoading}
                activeProfileId={activeProfileId}
                onboardingConnectError={onboardingConnectError}
                onboardingConnectSuccess={onboardingConnectSuccess}
                onboardingValidationError={onboardingValidationError}
                onUpdateField={(field, value) => updateOnboardingField(field as OnboardingFieldKey, value)}
                onConnect={handleOnboardingConnect}
                onBack={handleOnboardingBack}
                onNext={handleOnboardingNext}
            />

            {/* Chat Flow Setup View */}
            {
                activeView === 'chatflow' && (
                    <ChatflowView
                        open={activeView === 'chatflow'}
                        selectedWorkflowId={selectedWorkflowId}
                        workflows={workflows}
                        workflowDrafts={workflowDrafts}
                        workflowEditorMode={workflowEditorMode}
                        setWorkflowEditorMode={setWorkflowEditorMode}
                        setWorkflows={setWorkflows}
                        setWorkflowDrafts={setWorkflowDrafts}
                        setSelectedWorkflowId={setSelectedWorkflowId}
                        onSaveWorkflows={handleSaveWorkflows}
                        onClose={() => setActiveView('dashboard')}
                        onBackToAutomations={() => {
                            setActiveView('dashboard');
                            setWorkspaceSection('automations');
                        }}
                        buildBuilderFromActions={buildBuilderFromActions}
                        buildActionsFromBuilder={buildActionsFromBuilder}
                        FlowCanvasComponent={LazyFlowCanvas}
                        workflowTagOptions={workflowTagOptions}
                        workflowVariableOptions={workflowVariableOptions}
                        teamUsers={teamUsers}
                        workflowTriggerOptions={workflowTriggerOptions}
                        workflowTemplateOptions={workflowTemplateOptions}
                    />
                )
            }

            {/* Settings View */}
            {
                activeView === 'settings' && (
                    <SettingsView
                        settingsNav={settingsNav}
                        onScrollToSettingsSection={scrollToSettingsSection}
                        onSignOut={handleSignOut}
                        onClose={() => setActiveView('dashboard')}
                        profileId={activeProfileId || ''}
                        sessionToken={session?.access_token || null}
                        isAdmin={isAdmin}
                        quickReplies={quickReplies}
                        quickRepliesLoading={quickRepliesLoading}
                        quickRepliesSaving={quickRepliesSaving}
                        quickRepliesError={quickRepliesError}
                        onRefreshQuickReplies={fetchQuickReplies}
                        onSaveQuickReplies={saveQuickReplies}
                        WebhookViewComponent={LazyWebhookView}
                    />
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
                <BroadcastView
                    broadcastNav={broadcastNav}
                    broadcastSection={broadcastSection}
                    setBroadcastSection={setBroadcastSection}
                    activeProfileId={activeProfileId}
                    sessionToken={session?.access_token || null}
                    BroadcastTemplateBuilder={LazyBroadcastTemplateBuilder}
                    BroadcastTemplatesList={LazyBroadcastTemplatesList}
                />
            ) : workspaceSection === 'automations' ? (
                <AutomationsView
                    startableWorkflows={startableWorkflows}
                    onOpenBuilder={(workflowId) => {
                        setSelectedWorkflowId(workflowId);
                        setActiveView('chatflow');
                    }}
                    onCreateWorkflow={() => setActiveView('chatflow')}
                    onRunWorkflow={(workflowId) => {
                        setWorkspaceSection('team-inbox');
                        setShowWorkflowStarter(true);
                        setStartWorkflowId(workflowId);
                    }}
                />
            ) : workspaceSection === 'chatbots' ? (
                <ChatbotsView
                    profileId={activeProfileId}
                    sessionToken={session?.access_token || null}
                    apiBaseUrl={SOCKET_URL}
                />
            ) : workspaceSection === 'more' ? (
                <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
                    <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                        <div className="max-w-3xl mx-auto space-y-4">
                            <div className="bg-white border border-[#eceff1] rounded-3xl p-6 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                                <h2 className="text-2xl font-black text-[#111b21]">More</h2>
                                <p className="text-sm text-[#54656f] mt-1">
                                    Open additional tools and account settings.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <button
                                    type="button"
                                    onClick={openSettingsFromMore}
                                    className="text-left bg-white border border-[#eceff1] rounded-2xl p-5 hover:bg-[#f8f9fa] transition-all cursor-pointer pointer-events-auto"
                                >
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="w-9 h-9 rounded-xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884] flex items-center justify-center">
                                            <Settings className="w-5 h-5" />
                                        </div>
                                        <div className="text-lg font-black text-[#111b21]">Settings</div>
                                    </div>
                                    <p className="text-sm text-[#54656f]">
                                        Webhooks, onboarding, team users, and workspace configuration.
                                    </p>
                                </button>

                                <button
                                    type="button"
                                    onClick={openAnalyticsFromMore}
                                    className="text-left bg-white border border-[#eceff1] rounded-2xl p-5 hover:bg-[#f8f9fa] transition-all cursor-pointer pointer-events-auto"
                                >
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="w-9 h-9 rounded-xl bg-[#111b21]/5 border border-[#111b21]/10 text-[#111b21] flex items-center justify-center">
                                            <CircleDashed className="w-5 h-5" />
                                        </div>
                                        <div className="text-lg font-black text-[#111b21]">Analytics</div>
                                    </div>
                                    <p className="text-sm text-[#54656f]">
                                        View message totals, workflow metrics, and date-based performance.
                                    </p>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : workspaceSection === 'contacts' ? (
                <ContactsView
                    contactsList={contactsList}
                    teamUsersLoading={teamUsersLoading}
                    teamUsers={teamUsers}
                    contactsSearchQuery={contactsSearchQuery}
                    onContactsSearchChange={setContactsSearchQuery}
                    assigningContactId={assigningContactId}
                    onToggleAssignMenu={(contactId) => {
                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                        setAssignMenuContactId(prev => (prev === contactId ? null : contactId));
                    }}
                    onOpenChat={(contactId) => {
                        setSelectedChatId(contactId);
                        setWorkspaceSection('team-inbox');
                    }}
                />
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
            {appToast && (
                <div className="fixed top-4 right-4 z-[280] max-w-[360px]">
                    <div
                        className={`rounded-xl border px-4 py-2.5 text-sm font-semibold shadow-lg ${appToast.tone === 'success'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-rose-50 border-rose-200 text-rose-700'
                            }`}
                    >
                        {appToast.message}
                    </div>
                </div>
            )}
        </>
    );
}
