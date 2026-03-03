import React from 'react';

type GuideLink = {
    label: string;
    href: string;
};

type OnboardingStep = {
    id: string;
    title: string;
    description: string;
    details: string[];
    whereToGet?: string[];
    guideLinks?: GuideLink[];
    fieldKey?: string;
    fieldLabel?: string;
    fieldPlaceholder?: string;
    fieldType?: string;
};

type OnboardingSetup = Record<string, string> & {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
};

type OnboardingTutorialModalProps = {
    open: boolean;
    currentStep: OnboardingStep;
    steps: OnboardingStep[];
    stepIndex: number;
    onboardingSetup: OnboardingSetup;
    isCurrentStepValid: boolean;
    isFinalStep: boolean;
    onboardingConnectLoading: boolean;
    activeProfileId: string | null;
    onboardingConnectError: string | null;
    onboardingConnectSuccess: string | null;
    onboardingValidationError: string | null;
    onUpdateField: (field: string, value: string) => void;
    onConnect: () => void;
    onBack: () => void;
    onNext: () => void;
};

export default function OnboardingTutorialModal({
    open,
    currentStep,
    steps,
    stepIndex,
    onboardingSetup,
    isCurrentStepValid,
    isFinalStep,
    onboardingConnectLoading,
    activeProfileId,
    onboardingConnectError,
    onboardingConnectSuccess,
    onboardingValidationError,
    onUpdateField,
    onConnect,
    onBack,
    onNext
}: OnboardingTutorialModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[320] bg-[#111b21]/50 backdrop-blur-[2px] flex items-center justify-center p-4">
            <div className="w-full max-w-2xl bg-white border border-[#eceff1] rounded-3xl shadow-[0_24px_80px_rgba(17,27,33,0.35)] overflow-hidden">
                <div className="px-6 pt-6 pb-5 border-b border-[#eceff1]">
                    <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[#00a884]">First-time setup</div>
                    <h2 className="mt-2 text-2xl font-bold text-[#111b21]">{currentStep.title}</h2>
                    <p className="mt-2 text-sm text-[#54656f] leading-relaxed">{currentStep.description}</p>
                    <div className="mt-4 flex items-center gap-2">
                        {steps.map((step, idx) => (
                            <div
                                key={`tour-step-${step.id}`}
                                className={`h-1.5 flex-1 rounded-full ${idx <= stepIndex ? 'bg-[#00a884]' : 'bg-[#e5e7eb]'}`}
                            />
                        ))}
                    </div>
                    <div className="mt-2 text-[11px] text-[#8696a0] font-semibold">
                        Step {Math.min(stepIndex + 1, steps.length)} of {steps.length}
                    </div>
                    <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-rose-500">
                        Required setup for company admin account
                    </div>
                </div>

                <div className="px-6 py-5">
                    <div className="rounded-2xl border border-[#eceff1] bg-[#f8f9fa] p-4">
                        <div className="text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-2">What to do here</div>
                        <ul className="space-y-2">
                            {currentStep.details.map((detail, idx) => (
                                <li key={`tour-detail-${stepIndex}-${idx}`} className="text-sm text-[#1f2937] flex items-start gap-2">
                                    <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[#00a884] shrink-0" />
                                    <span>{detail}</span>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {currentStep.whereToGet && currentStep.whereToGet.length > 0 && (
                        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 mt-4">
                            <div className="text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-2">Where to get it</div>
                            <ul className="space-y-2">
                                {currentStep.whereToGet.map((line, idx) => (
                                    <li key={`onboarding-source-${currentStep.id}-${idx}`} className="text-sm text-[#1f2937] flex items-start gap-2">
                                        <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[#00a884] shrink-0" />
                                        <span>{line}</span>
                                    </li>
                                ))}
                            </ul>
                            {currentStep.guideLinks && currentStep.guideLinks.length > 0 && (
                                <div className="flex flex-wrap gap-2 mt-3">
                                    {currentStep.guideLinks.map((link) => (
                                        <a
                                            key={`guide-link-${currentStep.id}-${link.href}`}
                                            href={link.href}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="px-3 py-1.5 rounded-xl border border-[#d1d5db] bg-[#f9fafb] text-[#111b21] text-[11px] font-bold hover:bg-[#f3f4f6] transition-all"
                                        >
                                            {link.label}
                                        </a>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {currentStep.fieldKey && (
                        <div className="mt-4">
                            <label className="block text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-2">
                                {currentStep.fieldLabel}
                            </label>
                            <input
                                type={currentStep.fieldType || 'text'}
                                value={onboardingSetup[currentStep.fieldKey] || ''}
                                onChange={(e) => onUpdateField(currentStep.fieldKey!, e.target.value)}
                                placeholder={currentStep.fieldPlaceholder || ''}
                                autoFocus
                                className="w-full bg-white border border-[#dce3e8] rounded-xl px-4 py-3 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                            />
                            {!isCurrentStepValid && (
                                <div className="mt-2 text-xs text-[#b45309] font-semibold">
                                    Enter a valid value to continue.
                                </div>
                            )}
                        </div>
                    )}

                    {currentStep.id === 'connect' && (
                        <div className="mt-4 flex flex-col gap-3">
                            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4">
                                <div className="text-[11px] font-black uppercase tracking-widest text-[#54656f] mb-2">Review</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                                    <div className="text-[#54656f]">WABA ID</div>
                                    <div className="font-bold text-[#111b21] break-all">{onboardingSetup.wabaId || '—'}</div>
                                    <div className="text-[#54656f]">Phone Number ID</div>
                                    <div className="font-bold text-[#111b21] break-all">{onboardingSetup.phoneNumberId || '—'}</div>
                                    <div className="text-[#54656f]">Access Token</div>
                                    <div className="font-bold text-[#111b21]">{onboardingSetup.accessToken ? 'Entered' : 'Missing'}</div>
                                    <div className="text-[#54656f]">Verify Token</div>
                                    <div className="font-bold text-[#111b21]">{onboardingSetup.verifyToken ? 'Entered' : 'Missing'}</div>
                                </div>
                            </div>
                            <button
                                onClick={onConnect}
                                disabled={onboardingConnectLoading || !activeProfileId}
                                className="px-5 py-2.5 rounded-xl bg-[#00a884] text-white hover:bg-[#008f6f] disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-widest transition-colors shadow-sm"
                            >
                                {onboardingConnectLoading ? 'Verifying...' : 'Save and verify connection'}
                            </button>
                            {!activeProfileId && (
                                <div className="text-xs text-[#b45309] font-semibold">
                                    Waiting for profile to load before verification.
                                </div>
                            )}
                            {onboardingConnectError && (
                                <div className="text-xs text-rose-600 font-semibold">{onboardingConnectError}</div>
                            )}
                            {onboardingConnectSuccess && (
                                <div className="text-xs text-emerald-600 font-semibold">{onboardingConnectSuccess}</div>
                            )}
                        </div>
                    )}

                    {onboardingValidationError && (
                        <div className="mt-4 text-xs text-rose-600 font-semibold">{onboardingValidationError}</div>
                    )}
                </div>

                <div className="px-6 pb-6 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px] text-[#8696a0] font-semibold">Complete each step to unlock dashboard access.</div>
                    <div className="flex items-center gap-2 ml-auto">
                        <button
                            onClick={onBack}
                            disabled={stepIndex === 0 || onboardingConnectLoading}
                            className="px-4 py-2 rounded-xl border border-[#eceff1] text-[#111b21] hover:bg-[#f8f9fa] disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-widest transition-all"
                        >
                            Back
                        </button>
                        <button
                            onClick={onNext}
                            disabled={onboardingConnectLoading || !isCurrentStepValid}
                            className="px-5 py-2 rounded-xl bg-[#00a884] text-white hover:bg-[#008f6f] disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-widest transition-colors shadow-sm"
                        >
                            {isFinalStep ? 'Enter dashboard' : 'Next'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
