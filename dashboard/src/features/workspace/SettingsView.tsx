import React, { Suspense } from 'react';
import { LogOut, Settings, X } from 'lucide-react';

type SettingsNavItem = {
    id: string;
    label: string;
};

type SettingsNavSection = {
    group: string;
    items: SettingsNavItem[];
};

type SettingsViewProps = {
    settingsNav: SettingsNavSection[];
    onScrollToSettingsSection: (id: string) => void;
    onSignOut: () => void;
    onClose: () => void;
    profileId: string;
    sessionToken: string | null;
    isAdmin: boolean;
    quickReplies: any[];
    quickRepliesLoading: boolean;
    quickRepliesSaving: boolean;
    quickRepliesError: string | null;
    onRefreshQuickReplies: () => void;
    onSaveQuickReplies: (items: any[]) => void;
    WebhookViewComponent: React.ComponentType<any>;
};

export default function SettingsView({
    settingsNav,
    onScrollToSettingsSection,
    onSignOut,
    onClose,
    profileId,
    sessionToken,
    isAdmin,
    quickReplies,
    quickRepliesLoading,
    quickRepliesSaving,
    quickRepliesError,
    onRefreshQuickReplies,
    onSaveQuickReplies,
    WebhookViewComponent
}: SettingsViewProps) {
    return (
        <div className="fixed inset-0 bg-[#f8f9fa] z-[150] flex flex-col">
            <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                <div className="flex items-center gap-4">
                    <Settings className="text-[#00a884] w-8 h-8" />
                    <h1 className="text-xl font-bold text-[#111b21]">Settings</h1>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={onSignOut}
                        className="px-4 py-2 rounded-xl bg-white text-rose-500 font-bold border border-[#eceff1] hover:bg-rose-50 transition-all flex items-center gap-2"
                    >
                        <LogOut className="w-4 h-4" />
                        Log Out
                    </button>
                    <button onClick={onClose} className="p-2 hover:bg-white rounded-xl transition-all">
                        <X className="w-6 h-6 text-[#54656f]" />
                    </button>
                </div>
            </header>
            <div className="flex-1 flex overflow-hidden">
                <aside className="w-64 bg-white border-r border-[#eceff1] px-5 py-6 overflow-y-auto">
                    <p className="text-[10px] font-black uppercase tracking-widest text-[#54656f] mb-4">Settings</p>
                    <div className="space-y-6">
                        {settingsNav.map((section) => (
                            <div key={section.group}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-[#8696a0] mb-2">{section.group}</p>
                                <div className="flex flex-col gap-2">
                                    {section.items.map((item) => (
                                        <button
                                            key={item.id}
                                            onClick={() => onScrollToSettingsSection(item.id)}
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
                        <WebhookViewComponent
                            profileId={profileId}
                            sessionToken={sessionToken}
                            isAdmin={isAdmin}
                            quickReplies={quickReplies}
                            quickRepliesLoading={quickRepliesLoading}
                            quickRepliesSaving={quickRepliesSaving}
                            quickRepliesError={quickRepliesError}
                            onRefreshQuickReplies={onRefreshQuickReplies}
                            onSaveQuickReplies={onSaveQuickReplies}
                        />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
