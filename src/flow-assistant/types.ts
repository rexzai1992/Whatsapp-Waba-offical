export type NodeType = 'START' | 'MESSAGE' | 'IMAGE' | 'QUESTION' | 'WEBHOOK' | 'CONDITION' | 'ACTION' | 'END';

export interface FlowNode {
    id: string;
    type: NodeType;
    content?: string;
    caption?: string;
    imageUrl?: string;
    options?: string[];
    nextId?: string;
    connections?: { [key: string]: string }; // For CONDITION node: { 'yes': 'node2', 'no': 'node3' }
    action?: string;
}

export interface Flow {
    id: string;
    name: string;
    triggers: string[];
    nodes: FlowNode[];
}

export interface Session {
    id: string; // User ID (JID)
    activeFlowId: string;
    currentNodeId: string;
    answers: { [nodeId: string]: string };
    lastActivity: number;
}

export interface FlowConfig {
    flows: Flow[];
    idleMessage?: string;
    idleEnabled: boolean;
}

export interface MessageSender {
    sendText(to: string, text: string): Promise<any>;
    sendImage(to: string, url: string, caption?: string): Promise<any>;
}
