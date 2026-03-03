import React, { Suspense } from 'react';

type BroadcastSection = 'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts';

type BroadcastViewProps = {
    broadcastNav: Array<{ id: BroadcastSection; label: string }>;
    broadcastSection: BroadcastSection;
    setBroadcastSection: (section: BroadcastSection) => void;
    activeProfileId: string | null;
    sessionToken: string | null;
    BroadcastTemplateBuilder: React.ComponentType<any>;
    BroadcastTemplatesList: React.ComponentType<any>;
};

export default function BroadcastView({
    broadcastNav,
    broadcastSection,
    setBroadcastSection,
    activeProfileId,
    sessionToken,
    BroadcastTemplateBuilder,
    BroadcastTemplatesList
}: BroadcastViewProps) {
    return (
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
                            <BroadcastTemplateBuilder
                                profileId={activeProfileId || ''}
                                sessionToken={sessionToken}
                                onClose={() => setBroadcastSection('my-templates')}
                                embedded
                            />
                        </Suspense>
                    )}
                    {broadcastSection === 'my-templates' && (
                        <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading templates…</div>}>
                            <BroadcastTemplatesList
                                profileId={activeProfileId || ''}
                                sessionToken={sessionToken}
                                title="Template Gallery"
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
    );
}
