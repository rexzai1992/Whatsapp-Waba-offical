import React from 'react';
import { Workflow } from 'lucide-react';

type AutomationsViewProps = {
    startableWorkflows: any[];
    onOpenBuilder: (workflowId: string | null) => void;
    onCreateWorkflow: () => void;
    onRunWorkflow: (workflowId: string) => void;
};

export default function AutomationsView({
    startableWorkflows,
    onOpenBuilder,
    onCreateWorkflow,
    onRunWorkflow
}: AutomationsViewProps) {
    return (
        <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className="h-full flex flex-col p-6 gap-4 overflow-hidden">
                <div className="bg-white border border-[#eceff1] rounded-3xl p-5 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div>
                            <h2 className="text-2xl font-black text-[#111b21]">Automations</h2>
                            <p className="text-sm text-[#54656f] mt-1">
                                Your saved workflows for this company profile.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => onOpenBuilder(startableWorkflows[0]?.id || null)}
                                className="px-4 py-2 rounded-xl bg-[#111b21] text-white text-xs font-bold uppercase tracking-wider hover:bg-[#202c33] transition-all flex items-center gap-2"
                            >
                                <Workflow className="w-4 h-4" />
                                Open Workflow Builder
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 bg-white border border-[#eceff1] rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] overflow-hidden">
                    {startableWorkflows.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center px-6">
                            <Workflow className="w-12 h-12 text-[#aebac1] mb-3" />
                            <p className="text-[#111b21] font-bold">No workflows yet</p>
                            <p className="text-sm text-[#8696a0] mt-1 mb-4">
                                Create your first automation workflow in Chatflow builder.
                            </p>
                            <button
                                onClick={onCreateWorkflow}
                                className="px-4 py-2 rounded-xl bg-[#00a884] text-white text-xs font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                            >
                                Create Workflow
                            </button>
                        </div>
                    ) : (
                        <div className="h-full overflow-y-auto custom-scrollbar p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {startableWorkflows.map((wf: any) => {
                                const actionCount = Array.isArray(wf?.actions) ? wf.actions.length : 0;
                                const triggerKeyword = (wf?.trigger_keyword || '').toString().trim();
                                return (
                                    <div key={`automation-workflow-${wf.id}`} className="rounded-2xl border border-[#eceff1] bg-white p-4 shadow-sm hover:shadow-md transition-all">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-sm font-black text-[#111b21] truncate">{wf.id}</p>
                                                <p className="text-[11px] text-[#54656f] mt-1">
                                                    Trigger: <span className="font-bold text-[#00a884]">{triggerKeyword || 'manual only'}</span>
                                                </p>
                                            </div>
                                            <span className="px-2 py-1 rounded-full bg-[#f0f2f5] border border-[#eceff1] text-[10px] font-black uppercase tracking-widest text-[#54656f]">
                                                {actionCount} step{actionCount === 1 ? '' : 's'}
                                            </span>
                                        </div>
                                        <div className="mt-4 flex items-center gap-2">
                                            <button
                                                onClick={() => onOpenBuilder(wf.id)}
                                                className="flex-1 px-3 py-2 rounded-xl bg-[#00a884] text-white text-[11px] font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => onRunWorkflow(wf.id)}
                                                className="flex-1 px-3 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-[11px] font-bold uppercase tracking-wider hover:bg-[#f8f9fa] transition-all"
                                            >
                                                Run
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
