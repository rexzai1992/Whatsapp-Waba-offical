export type MessageLike = {
    key?: {
        remoteJid?: string;
        fromMe?: boolean;
    };
    messageTimestamp?: number;
    message?: {
        conversation?: string;
        extendedTextMessage?: { text?: string };
        buttonsMessage?: { contentText?: string };
        listMessage?: { description?: string };
        imageMessage?: { caption?: string };
        videoMessage?: { caption?: string };
        documentMessage?: { caption?: string; fileName?: string };
    };
};

export type ContactMetaLike = {
    lastInboundAt?: string | null;
};

export const getCleanId = (jid: string | undefined): string => {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
};

export const formatPhoneNumber = (id: string): string => {
    if (!id) return id;
    if (id.length > 13) return id;

    if (/^\d+$/.test(id)) {
        if (id.startsWith('60') && id.length >= 11) {
            return `+${id.slice(0, 2)} ${id.slice(2, 4)}-${id.slice(4, 8)} ${id.slice(8)}`;
        }
        if (id.startsWith('62') && id.length >= 11) {
            return `+${id.slice(0, 2)} ${id.slice(2, 5)}-${id.slice(5, 9)}-${id.slice(9)}`;
        }
        return `+${id}`;
    }
    return id;
};

const isPhoneLikeName = (name: string, jid?: string): boolean => {
    if (!name) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    const cleanJid = getCleanId(jid);
    const digitsOnly = trimmed.replace(/\D/g, '');
    const jidDigits = cleanJid.replace(/\D/g, '');
    if (jidDigits && digitsOnly === jidDigits) return true;
    if (/^\+?\d[\d\s-]{5,}$/.test(trimmed)) return true;
    return false;
};

export const pickContactName = (incoming: string, prev?: string, jid?: string): string => {
    const incomingTrimmed = (incoming || '').trim();
    const prevTrimmed = (prev || '').trim();
    if (!incomingTrimmed) return prevTrimmed;
    if (prevTrimmed && !isPhoneLikeName(prevTrimmed, jid) && isPhoneLikeName(incomingTrimmed, jid)) {
        return prevTrimmed;
    }
    return incomingTrimmed;
};

export const getInitials = (name?: string | null): string => {
    const value = (name || '').trim();
    if (!value) return '?';
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
};

export const withHexAlpha = (color?: string | null, alpha = '22', fallback = '#e5e7eb'): string => {
    const value = (color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return `${value}${alpha}`;
    return fallback;
};

export const textColor = (color?: string | null, fallback = '#374151'): string => {
    const value = (color || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    return fallback;
};

export const formatBytes = (value?: number): string => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Math.max(0, value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

export const formatBps = (value?: number): string => {
    if (value === undefined || value === null || !Number.isFinite(value)) return '--';
    return `${formatBytes(value)}/s`;
};

export const redactSecret = (value?: string | null, visibleStart = 6, visibleEnd = 4): string | null => {
    if (!value) return null;
    const str = String(value);
    if (str.length <= visibleStart + visibleEnd + 3) return `${str} (len ${str.length})`;
    return `${str.slice(0, visibleStart)}…${str.slice(-visibleEnd)} (len ${str.length})`;
};

export const getLastInboundTs = (
    messages: MessageLike[],
    chatId: string | null,
    contacts: Record<string, ContactMetaLike>
): number | null => {
    if (!chatId) return null;
    let latestSeconds = 0;
    messages.forEach((msg) => {
        if (msg.key?.remoteJid === chatId && !msg.key?.fromMe && msg.messageTimestamp) {
            if (msg.messageTimestamp > latestSeconds) latestSeconds = msg.messageTimestamp;
        }
    });

    const contactInbound = contacts?.[chatId]?.lastInboundAt;
    if (contactInbound) {
        const inboundMs = new Date(contactInbound).getTime();
        if (!Number.isNaN(inboundMs)) {
            const inboundSeconds = Math.floor(inboundMs / 1000);
            if (inboundSeconds > latestSeconds) latestSeconds = inboundSeconds;
        }
    }

    return latestSeconds ? latestSeconds * 1000 : null;
};

export const formatRemaining = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
};

export const formatDateLabel = (ms: number) => {
    if (!ms) return '';
    const date = new Date(ms);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const dateKey = date.toDateString();
    if (dateKey === today.toDateString()) return 'Today';
    if (dateKey === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export const getMessagePreviewText = (msg: MessageLike): string => {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsMessage?.contentText ||
        msg.message?.listMessage?.description ||
        msg.message?.imageMessage?.caption ||
        (msg.message?.imageMessage ? '[Image]' : '') ||
        msg.message?.videoMessage?.caption ||
        (msg.message?.videoMessage ? '[Video]' : '') ||
        msg.message?.documentMessage?.caption ||
        msg.message?.documentMessage?.fileName ||
        (msg.message?.documentMessage ? '[Document]' : '') ||
        ''
    );
};

export const formatLogTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
