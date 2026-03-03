import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, KeyRound, Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';

type AiSettingsPayload = {
    enabled: boolean;
    model: string;
    systemPrompt: string;
    temperature: number;
    maxTokens: number;
    memoryEnabled: boolean;
    memoryMessages: number;
    hasApiKey: boolean;
    apiKeyHint: string;
    updatedAt?: string;
};

type ChatbotsViewProps = {
    profileId: string | null;
    sessionToken: string | null;
    apiBaseUrl: string;
};

const MODEL_OPTIONS = [
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini (fast)' },
    { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini (balanced)' },
    { value: 'gpt-4.1', label: 'gpt-4.1 (best quality)' }
];

const DEFAULT_SETTINGS: AiSettingsPayload = {
    enabled: false,
    model: MODEL_OPTIONS[0].value,
    systemPrompt: 'You are a concise, helpful WhatsApp business assistant.',
    temperature: 0.4,
    maxTokens: 512,
    memoryEnabled: true,
    memoryMessages: 16,
    hasApiKey: false,
    apiKeyHint: '',
    updatedAt: ''
};

function formatSavedTime(value?: string): string {
    if (!value) return '';
    const ts = new Date(value).getTime();
    if (Number.isNaN(ts)) return '';
    return new Date(ts).toLocaleString();
}

export default function ChatbotsView({
    profileId,
    sessionToken,
    apiBaseUrl
}: ChatbotsViewProps) {
    const [settings, setSettings] = useState<AiSettingsPayload>(DEFAULT_SETTINGS);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [settingsError, setSettingsError] = useState<string | null>(null);
    const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

    const canUseApi = useMemo(() => {
        return Boolean(profileId && sessionToken);
    }, [profileId, sessionToken]);

    const loadSettings = useCallback(async () => {
        if (!profileId || !sessionToken) return;
        setLoading(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const params = new URLSearchParams({ profileId });
            const res = await fetch(`${apiBaseUrl}/api/company/ai/settings?${params.toString()}`, {
                headers: {
                    authorization: `Bearer ${sessionToken}`
                }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to load AI settings');
            }
            const incoming: AiSettingsPayload = {
                ...DEFAULT_SETTINGS,
                ...payload.data
            };
            setSettings(incoming);
            setApiKeyInput('');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to load AI settings');
        } finally {
            setLoading(false);
        }
    }, [apiBaseUrl, profileId, sessionToken]);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    const saveSettings = useCallback(async (clearApiKey: boolean) => {
        if (!profileId || !sessionToken) return;
        setSaving(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const body: Record<string, unknown> = {
                profileId,
                enabled: settings.enabled,
                model: settings.model,
                systemPrompt: settings.systemPrompt,
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                memoryEnabled: settings.memoryEnabled,
                memoryMessages: settings.memoryMessages
            };
            if (clearApiKey) {
                body.clearApiKey = true;
            } else if (apiKeyInput.trim()) {
                body.apiKey = apiKeyInput.trim();
            }

            const res = await fetch(`${apiBaseUrl}/api/company/ai/settings`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to save AI settings');
            }

            setSettings({
                ...DEFAULT_SETTINGS,
                ...payload.data
            });
            setApiKeyInput('');
            setSettingsNotice(clearApiKey ? 'API key removed.' : 'AI settings saved.');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to save AI settings');
        } finally {
            setSaving(false);
        }
    }, [apiBaseUrl, apiKeyInput, profileId, sessionToken, settings]);

    return (
        <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                <div className="max-w-[860px] mx-auto">
                    <section className="bg-white border border-[#eceff1] rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] p-5">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <h2 className="text-2xl font-black text-[#111b21] flex items-center gap-2">
                                    <Bot className="w-6 h-6 text-[#00a884]" />
                                    Chatbot AI
                                </h2>
                                <p className="text-sm text-[#54656f] mt-1">
                                    Configure API key, model, response behavior, and memory.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={loadSettings}
                                disabled={loading || !canUseApi}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-xs font-bold hover:bg-[#f8f9fa] transition-all disabled:opacity-50"
                            >
                                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {!canUseApi && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold">
                                Select a profile and log in to configure AI.
                            </div>
                        )}
                        {settingsError && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 text-xs font-semibold">
                                {settingsError}
                            </div>
                        )}
                        {settingsNotice && (
                            <div className="mt-4 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">
                                {settingsNotice}
                            </div>
                        )}

                        <div className="mt-5 space-y-4">
                            <label className="flex items-center justify-between gap-3 rounded-2xl border border-[#eceff1] bg-[#f8f9fa] px-4 py-3">
                                <div>
                                    <div className="text-sm font-bold text-[#111b21]">Enable AI assistant</div>
                                    <div className="text-[11px] text-[#6b7280]">Auto-reply when no workflow is triggered, and use generator manually.</div>
                                </div>
                                <input
                                    type="checkbox"
                                    checked={settings.enabled}
                                    onChange={(e) => setSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                                    disabled={!canUseApi}
                                    className="w-4 h-4 accent-[#00a884]"
                                />
                            </label>

                            <div className="space-y-2">
                                <label className="text-xs font-black uppercase tracking-widest text-[#54656f]">API Key</label>
                                <div className="relative">
                                    <KeyRound className="w-4 h-4 text-[#8696a0] absolute left-3 top-1/2 -translate-y-1/2" />
                                    <input
                                        type="password"
                                        value={apiKeyInput}
                                        onChange={(e) => setApiKeyInput(e.target.value)}
                                        disabled={!canUseApi}
                                        placeholder={settings.hasApiKey ? 'Leave blank to keep existing key' : 'Paste OpenAI API key'}
                                        className="w-full pl-9 pr-3 py-3 rounded-xl border border-[#eceff1] bg-white text-sm text-[#111b21] focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] text-[#6b7280]">
                                        {settings.hasApiKey ? `Saved: ${settings.apiKeyHint}` : 'No API key saved yet'}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => saveSettings(true)}
                                        disabled={!canUseApi || saving || !settings.hasApiKey}
                                        className="px-2.5 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-[11px] font-bold hover:bg-rose-50 transition-all disabled:opacity-50"
                                    >
                                        <Trash2 className="w-3.5 h-3.5 inline mr-1" />
                                        Remove
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-xs font-black uppercase tracking-widest text-[#54656f]">AI Model</label>
                                <select
                                    value={settings.model}
                                    onChange={(e) => setSettings(prev => ({ ...prev, model: e.target.value }))}
                                    disabled={!canUseApi}
                                    className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-3 text-sm text-[#111b21] focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                >
                                    {MODEL_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <label className="space-y-1">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Temperature</span>
                                    <input
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={settings.temperature}
                                        onChange={(e) => setSettings(prev => ({ ...prev, temperature: Number(e.target.value) }))}
                                        disabled={!canUseApi}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                                <label className="space-y-1">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Max Tokens</span>
                                    <input
                                        type="number"
                                        min={64}
                                        max={4096}
                                        step={1}
                                        value={settings.maxTokens}
                                        onChange={(e) => setSettings(prev => ({ ...prev, maxTokens: Number(e.target.value) }))}
                                        disabled={!canUseApi}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                            </div>

                            <label className="space-y-1 block">
                                <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">System Prompt</span>
                                <textarea
                                    rows={6}
                                    value={settings.systemPrompt}
                                    onChange={(e) => setSettings(prev => ({ ...prev, systemPrompt: e.target.value }))}
                                    disabled={!canUseApi}
                                    className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2.5 text-sm text-[#111b21] focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 resize-y"
                                />
                            </label>

                            <div className="rounded-2xl border border-[#eceff1] p-3 bg-[#f8f9fa]">
                                <label className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-bold text-[#111b21]">Conversation memory</div>
                                        <div className="text-[11px] text-[#6b7280]">Include previous messages for context.</div>
                                    </div>
                                    <input
                                        type="checkbox"
                                        checked={settings.memoryEnabled}
                                        onChange={(e) => setSettings(prev => ({ ...prev, memoryEnabled: e.target.checked }))}
                                        disabled={!canUseApi}
                                        className="w-4 h-4 accent-[#00a884]"
                                    />
                                </label>
                                <label className="block mt-3 space-y-1">
                                    <span className="text-[11px] font-black uppercase tracking-widest text-[#54656f]">Memory Messages</span>
                                    <input
                                        type="number"
                                        min={0}
                                        max={80}
                                        step={1}
                                        value={settings.memoryMessages}
                                        onChange={(e) => setSettings(prev => ({ ...prev, memoryMessages: Number(e.target.value) }))}
                                        disabled={!canUseApi || !settings.memoryEnabled}
                                        className="w-full rounded-xl border border-[#eceff1] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20"
                                    />
                                </label>
                            </div>

                            <div className="flex items-center justify-between gap-3 pt-2">
                                <div className="text-[11px] text-[#6b7280]">
                                    {settings.updatedAt ? `Last saved: ${formatSavedTime(settings.updatedAt)}` : ''}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => saveSettings(false)}
                                    disabled={!canUseApi || saving}
                                    className="px-4 py-2.5 rounded-xl bg-[#00a884] text-white text-xs font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all disabled:opacity-60 flex items-center gap-2"
                                >
                                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                    Save Settings
                                </button>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
