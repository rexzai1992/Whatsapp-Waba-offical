import React, { Suspense } from 'react';
import { GitBranch, Save, Workflow, X } from 'lucide-react';

type WorkflowEditorMode = 'visual' | 'json';

type ChatflowViewProps = {
    open: boolean;
    selectedWorkflowId: string | null;
    workflows: any[];
    workflowDrafts: Record<string, string>;
    workflowEditorMode: WorkflowEditorMode;
    setWorkflowEditorMode: (mode: WorkflowEditorMode) => void;
    setWorkflows: React.Dispatch<React.SetStateAction<any[]>>;
    setWorkflowDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setSelectedWorkflowId: (id: string | null) => void;
    onSaveWorkflows: (updatedWorkflows: any[], draftOverrides?: Record<string, string>) => void;
    onClose: () => void;
    onBackToAutomations: () => void;
    buildBuilderFromActions: (actions: any[], workflowId: string) => any;
    buildActionsFromBuilder: (flow: any) => { actions: any[] };
    FlowCanvasComponent: React.ComponentType<any>;
    workflowTagOptions: string[];
    workflowVariableOptions: string[];
    teamUsers: any[];
    workflowTriggerOptions: Array<{ id: string; name?: string }>;
    workflowTemplateOptions: any[];
};

export default function ChatflowView({
    open,
    selectedWorkflowId,
    workflows,
    workflowDrafts,
    workflowEditorMode,
    setWorkflowEditorMode,
    setWorkflows,
    setWorkflowDrafts,
    setSelectedWorkflowId,
    onSaveWorkflows,
    onClose,
    onBackToAutomations,
    buildBuilderFromActions,
    buildActionsFromBuilder,
    FlowCanvasComponent,
    workflowTagOptions,
    workflowVariableOptions,
    teamUsers,
    workflowTriggerOptions,
    workflowTemplateOptions
}: ChatflowViewProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-[#f8f9fa] z-[150] flex flex-col">
            <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                <div className="flex items-center gap-4">
                    <Workflow className="text-[#00a884] w-8 h-8" />
                    <h1 className="text-xl font-bold text-[#111b21]">WABA Workflow Builder</h1>
                </div>
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => onSaveWorkflows(workflows)}
                        className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors shadow-sm"
                    >
                        <Save className="w-4 h-4" /> Save Workflows
                    </button>
                    <button onClick={onClose} className="p-2 hover:bg-white rounded-xl transition-all"><X className="w-6 h-6 text-[#54656f]" /></button>
                </div>
            </header>

            <div className="flex-1 overflow-hidden bg-white">
                {selectedWorkflowId ? (
                    <div className="h-full flex flex-col p-8 gap-6 overflow-y-auto">
                        {(() => {
                            const wf = workflows.find(w => w.id === selectedWorkflowId);
                            if (!wf) {
                                return (
                                    <div className="flex-1 flex flex-col items-center justify-center text-[#8696a0] gap-4">
                                        <GitBranch className="w-12 h-12" />
                                        <p className="text-sm font-bold">Workflow not found</p>
                                        <button
                                            onClick={onBackToAutomations}
                                            className="px-4 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-xs font-bold hover:bg-[#f8f9fa] transition-all"
                                        >
                                            Back to Automations
                                        </button>
                                    </div>
                                );
                            }
                            return (
                                <>
                                    <div className="flex items-center justify-between flex-wrap gap-3">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-[#8696a0]">Editing Workflow</span>
                                            <span className="text-sm font-bold text-[#111b21]">{wf.id}</span>
                                        </div>
                                        <button
                                            onClick={onBackToAutomations}
                                            className="px-4 py-2 rounded-xl border border-[#eceff1] bg-white text-[#111b21] text-xs font-bold hover:bg-[#f8f9fa] transition-all"
                                        >
                                            Back to Automations
                                        </button>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-wider">Trigger Keyword</label>
                                        <input
                                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-3 text-[#111b21] text-sm font-bold focus:outline-none focus:border-[#00a884]"
                                            value={wf.trigger_keyword || ''}
                                            onChange={(e) => {
                                                const val = e.target.value;
                                                setWorkflows(prev => prev.map(item => item.id === wf.id ? { ...item, trigger_keyword: val } : item));
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
                                            Visual builder supports send message, ask question (save variable), question choices, list, condition, CTA URL, template send, add tags, assign staff, and trigger workflow.
                                        </span>
                                    </div>
                                    {workflowEditorMode === 'visual' ? (
                                        <div className="border border-[#eceff1] rounded-2xl overflow-hidden bg-white min-h-[560px] h-[70vh]">
                                            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-[#54656f]">Loading flow editor…</div>}>
                                                <FlowCanvasComponent
                                                    flow={wf.builder || buildBuilderFromActions(wf.actions || [], wf.id)}
                                                    tagOptions={workflowTagOptions}
                                                    variableOptions={workflowVariableOptions}
                                                    staffOptions={teamUsers}
                                                    workflowOptions={workflowTriggerOptions.filter((option) => option.id !== wf.id)}
                                                    templateOptions={workflowTemplateOptions}
                                                    onSave={(nextFlow: any) => {
                                                        const { actions } = buildActionsFromBuilder(nextFlow);
                                                        const nextWorkflows = workflows.map(item =>
                                                            item.id === wf.id ? { ...item, actions, builder: nextFlow } : item
                                                        );
                                                        const nextDrafts = { ...workflowDrafts, [wf.id]: JSON.stringify(actions, null, 2) };
                                                        setWorkflows(nextWorkflows);
                                                        setWorkflowDrafts(nextDrafts);
                                                        onSaveWorkflows(nextWorkflows, nextDrafts);
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
                                                    const next = e.target.value;
                                                    setWorkflowDrafts(prev => ({ ...prev, [wf.id]: next }));
                                                }}
                                            />
                                            <p className="text-[11px] text-[#8696a0]">
                                                Examples:
                                                {' '}
                                                <code className="font-mono">[{`{ "type": "send_text", "text": "Hello!" }`}]</code>
                                                {' '}
                                                <code className="font-mono">[{`{ "type": "ask_question", "question": "Your name?", "save_as": "customer_name" }`}]</code>
                                            </p>
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-[#8696a0] gap-4">
                        <GitBranch className="w-14 h-14" />
                        <p className="text-sm font-bold">No workflow selected</p>
                        <button
                            onClick={() => {
                                const id = `wf-${Date.now()}`;
                                const actions = [{ type: 'send_text', text: 'Hello! How can we help you?' }];
                                const newWf = {
                                    id,
                                    trigger_keyword: '',
                                    actions,
                                    builder: buildBuilderFromActions(actions, id)
                                };
                                setWorkflows(prev => [...prev, newWf]);
                                setWorkflowDrafts(prev => ({
                                    ...prev,
                                    [id]: JSON.stringify(actions, null, 2)
                                }));
                                setSelectedWorkflowId(id);
                            }}
                            className="px-4 py-2 rounded-xl bg-[#00a884] text-white text-xs font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                        >
                            Create Workflow
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
