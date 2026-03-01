import React, { useCallback, useState } from 'react';
import { Bug, Check, Copy, RefreshCw, X } from 'lucide-react';

type DebugButtonProps = {
    payload: Record<string, unknown>;
    title?: string;
};

type DebugSnapshot = {
    capturedAt: number;
    json: string;
    error: string | null;
};

async function copyToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
}

export default function DebugButton({ payload, title = 'Debug' }: DebugButtonProps) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);

    const capture = useCallback(() => {
        const capturedAt = Date.now();
        try {
            setSnapshot({
                capturedAt,
                json: JSON.stringify(payload, null, 2),
                error: null
            });
        } catch (err: any) {
            setSnapshot({
                capturedAt,
                json: '',
                error: err?.message || 'Failed to serialize debug payload'
            });
        }
        setCopied(false);
    }, [payload]);

    const handleCopy = async () => {
        try {
            await copyToClipboard(snapshot?.json || snapshot?.error || '');
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore copy failures
        }
    };

    const handleToggle = () => {
        setOpen(prev => {
            const next = !prev;
            if (next) capture();
            return next;
        });
    };

    return (
        <>
            {open && (
                <div className="w-[380px] max-h-[60vh] bg-white border border-[#eceff1] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#eceff1] flex items-center gap-2">
                        <Bug className="w-4 h-4 text-[#00a884]" />
                        <span className="text-sm font-bold text-[#111b21]">{title}</span>
                        <button
                            onClick={capture}
                            className="ml-auto text-[11px] font-bold text-[#111b21] hover:text-[#202c33] flex items-center gap-2"
                            title="Capture a fresh snapshot"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Capture
                        </button>
                        <button
                            onClick={handleCopy}
                            className="text-[11px] font-bold text-[#00a884] hover:text-[#008f6f] flex items-center gap-2"
                            title="Copy as JSON"
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                        <button
                            onClick={() => setOpen(false)}
                            className="text-[#54656f] hover:text-[#111b21] p-1 rounded-md"
                            title="Close"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="max-h-[52vh] overflow-y-auto">
                        {snapshot?.capturedAt && (
                            <div className="px-4 pt-3 text-[10px] text-[#54656f] font-bold uppercase tracking-widest">
                                Captured {new Date(snapshot.capturedAt).toISOString()}
                            </div>
                        )}
                        {snapshot?.error ? (
                            <div className="px-4 py-4 text-xs text-rose-600">{snapshot.error}</div>
                        ) : (
                            <pre className="px-4 py-4 text-[11px] leading-relaxed text-[#111b21] bg-[#fcfdfd] whitespace-pre-wrap break-words">
                                {snapshot?.json || ''}
                            </pre>
                        )}
                    </div>
                </div>
            )}

            <button
                onClick={handleToggle}
                className="flex items-center gap-2 bg-white text-[#111b21] px-4 py-2 rounded-full shadow-lg hover:bg-[#f8f9fa] transition-all border border-[#eceff1]"
                title="Debug"
            >
                <Bug className="w-4 h-4 text-[#54656f]" />
                <span className="text-xs font-bold uppercase tracking-widest">Debug</span>
            </button>
        </>
    );
}
