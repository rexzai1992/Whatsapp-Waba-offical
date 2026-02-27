import fs from 'fs';
import type { Flow, FlowConfig, Session, FlowNode, MessageSender } from './types';

export class FlowAssistant {
    private sessions: { [jid: string]: Session } = {};
    private config: FlowConfig = { flows: [], idleEnabled: false };
    private sender: MessageSender;
    private profileId: string;
    private sessionFile: string;
    private flowFile: string;

    constructor(sender: MessageSender, profileId: string = 'default') {
        this.sender = sender;
        this.profileId = profileId;
        this.sessionFile = `./sessions_${profileId}.json`;
        this.flowFile = `./flows_${profileId}.json`;
        this.loadSessions();
        this.loadFlows();

        // Check for timeouts every hour
        setInterval(() => this.checkTimeouts(), 3600000);
    }

    private loadSessions() {
        if (fs.existsSync(this.sessionFile)) {
            try {
                this.sessions = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
            } catch (e) {
                this.sessions = {};
            }
        }
    }

    private saveSessions() {
        fs.writeFileSync(this.sessionFile, JSON.stringify(this.sessions, null, 2));
    }

    private loadFlows() {
        if (fs.existsSync(this.flowFile)) {
            try {
                this.config = JSON.parse(fs.readFileSync(this.flowFile, 'utf-8'));
            } catch (e) {
                console.error(`[${this.profileId}] Failed to load flows:`, e);
            }
        } else {
            // Default empty config
            this.config = { flows: [], idleEnabled: false };
            fs.writeFileSync(this.flowFile, JSON.stringify(this.config, null, 2));
        }
    }

    public async handleMessage(jid: string, text: string) {
        this.loadFlows();
        let session = this.sessions[jid];
        // Clean text: remove emojis/symbols, extra spaces, and lowercase
        const normalizedText = text.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();

        // 1. Validate existing session
        if (session) {
            // Check expiry
            if (Date.now() - session.lastActivity > 86400000) {
                await this.endSession(jid, 'Session expired due to inactivity.');
                return;
            }

            // Check if flow exists
            const flow = this.config.flows.find(f => f.id === session.activeFlowId);
            if (!flow) {
                console.log(`[FlowAssistant] Flow ${session.activeFlowId} not found. Clearing session.`);
                delete this.sessions[jid];
                session = undefined; // Mark as undefined so we check triggers
            } else {
                // Check if node exists
                const currentNode = flow.nodes.find(n => n.id === session.currentNodeId);
                if (!currentNode) {
                    console.log(`[FlowAssistant] Node ${session.currentNodeId} not found. Clearing session.`);
                    delete this.sessions[jid];
                    session = undefined;
                } else {
                    // VALID SESSION: Process input
                    session.lastActivity = Date.now();

                    if (currentNode.type === 'QUESTION') {
                        session.answers[currentNode.id] = text;
                        this.saveSessions();

                        let nextNodeId = null;

                        // Check connections
                        if (currentNode.connections) {
                            // Exact match
                            for (const key in currentNode.connections) {
                                if (normalizedText === key.toLowerCase()) {
                                    nextNodeId = currentNode.connections[key];
                                    break;
                                }
                            }

                            // Numbered match
                            if (!nextNodeId && currentNode.options) {
                                const selection = parseInt(normalizedText);
                                if (!isNaN(selection) && selection > 0 && selection <= currentNode.options.length) {
                                    const selectedOpt = currentNode.options[selection - 1];
                                    if (selectedOpt && currentNode.connections[selectedOpt]) {
                                        nextNodeId = currentNode.connections[selectedOpt];
                                    }
                                }
                            }

                            // Partial match
                            if (!nextNodeId) {
                                for (const key in currentNode.connections) {
                                    if (normalizedText.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedText)) {
                                        nextNodeId = currentNode.connections[key];
                                        break;
                                    }
                                }
                            }
                        }

                        // Fallback nextId
                        if (!nextNodeId) {
                            nextNodeId = currentNode.nextId || (currentNode.connections ? currentNode.connections['default'] : null);
                        }

                        if (nextNodeId) {
                            await this.processNode(jid, flow, nextNodeId);
                        } else if (currentNode.nextId || currentNode.connections) {
                            if (currentNode.options && currentNode.options.length > 0) {
                                await this.sender.sendText(jid, "Please select one of the options by typing the number or the text.");
                            } else {
                                await this.endSession(jid);
                            }
                        } else {
                            await this.endSession(jid);
                        }
                    }
                    return; // Message handled by session
                }
            }
        }

        // 2. No valid session (or just cleared), check triggers
        if (!this.sessions[jid]) {
            for (const flow of this.config.flows) {
                const match = flow.triggers.some(trigger => {
                    const cleanedTrigger = trigger.replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const words = normalizedText.split(' ');
                    return words.includes(cleanedTrigger) || normalizedText === cleanedTrigger || normalizedText.includes(cleanedTrigger);
                });

                if (match) {
                    await this.startFlow(jid, flow);
                    return;
                }
            }

            // If no match and idle enabled
            if (this.config.idleEnabled && this.config.idleMessage) {
                await this.sender.sendText(jid, this.config.idleMessage);
            }
        }
    }

    private async startFlow(jid: string, flow: Flow) {
        const startNode = flow.nodes.find(n => n.type === 'START');
        if (!startNode) return;

        this.sessions[jid] = {
            id: jid,
            activeFlowId: flow.id,
            currentNodeId: startNode.id,
            answers: {},
            lastActivity: Date.now()
        };
        this.saveSessions();

        const nextNodeId = startNode.nextId;
        if (nextNodeId) {
            await this.processNode(jid, flow, nextNodeId);
        }
    }

    private async processNode(jid: string, flow: Flow, nodeId: string) {
        const node = flow.nodes.find(n => n.id === nodeId);
        if (!node) return;

        const session = this.sessions[jid];
        if (session) {
            session.currentNodeId = nodeId;
            this.saveSessions();
        }

        switch (node.type) {
            case 'MESSAGE':
                await this.sender.sendText(jid, node.content || '');
                if (node.nextId) await this.processNode(jid, flow, node.nextId);
                break;

            case 'IMAGE':
                if (node.imageUrl) {
                    await this.sender.sendImage(jid, node.imageUrl, node.caption);
                }
                if (node.nextId) await this.processNode(jid, flow, node.nextId);
                break;

            case 'QUESTION':
                let questionText = node.content || '';
                if (node.options && node.options.length > 0) {
                    questionText += '\n\n' + node.options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
                }
                await this.sender.sendText(jid, questionText);
                // We stop here and wait for user reply
                break;

            case 'CONDITION':
                // For simplicity, let's assume it checks the last answer
                const lastAnswer = session ? Object.values(session.answers).pop() : null;
                let nextPath = 'default';
                if (node.connections && lastAnswer) {
                    // Logic to decide path based on lastAnswer
                    // This is a placeholder for actual condition evaluation
                    for (const key in node.connections) {
                        if (lastAnswer.toLowerCase().includes(key.toLowerCase())) {
                            nextPath = key;
                            break;
                        }
                    }
                }
                const nextNode = node.connections ? node.connections[nextPath] : node.nextId;
                if (nextNode) await this.processNode(jid, flow, nextNode);
                break;

            case 'ACTION':
                // Execute system action (e.g., call a webhook, save to DB)
                console.log(`Executing action: ${node.action}`);
                if (node.nextId) await this.processNode(jid, flow, node.nextId);
                break;

            case 'END':
                if (node.content) {
                    await this.sender.sendText(jid, node.content);
                }
                await this.endSession(jid);
                break;
        }
    }

    private async endSession(jid: string, timeoutMessage?: string) {
        if (timeoutMessage) {
            await this.sender.sendText(jid, timeoutMessage);
        }
        delete this.sessions[jid];
        this.saveSessions();
    }

    private async checkTimeouts() {
        const now = Date.now();
        for (const jid in this.sessions) {
            const session = this.sessions[jid];
            if (session && now - session.lastActivity > 86400000) {
                await this.endSession(jid, 'Session expired due to 24-hour inactivity.');
            }
        }
    }
}
