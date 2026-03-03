const BUILDER_ACTION_NODE_TYPES = new Set([
    'MESSAGE',
    'ASK',
    'QUESTION',
    'LIST',
    'CONDITION',
    'IMAGE',
    'TEMPLATE',
    'TAG',
    'ASSIGN',
    'WORKFLOW_TRIGGER',
    'END',
    'CTA_URL'
]);
const SUPPORTED_ACTION_TYPES = new Set([
    'send_text',
    'send_buttons',
    'send_list',
    'send_cta_url',
    'send_template',
    'ask_question',
    'condition',
    'send_image',
    'send_document',
    'send_video',
    'add_tags',
    'set_tag',
    'assign_staff',
    'trigger_workflow',
    'update_state',
    'end_flow'
]);

const slugifyButtonId = (label: string, index: number) => {
    const base = (label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || `option_${index + 1}`;
};

const getNodeNextIds = (node: any) => {
    if (!node) return [];
    if (node.type === 'QUESTION' || node.type === 'LIST' || node.type === 'CONDITION') {
        return Object.values(node.connections || {}).filter(Boolean) as string[];
    }
    if (node.nextId) return [node.nextId];
    return [];
};

const pickFallbackNextId = (node: any) => {
    if (!node) return '';
    if (node.nextId) return node.nextId;
    const connections = node.connections || {};
    return connections.default || connections.true || connections.false || Object.values(connections)[0] || '';
};

const buildActionsFromBuilder = (builder: any) => {
    const nodes = Array.isArray(builder?.nodes) ? builder.nodes : [];
    if (!nodes.length) return { actions: [], warnings: [] as string[] };

    const nodesById: Record<string, any> = {};
    nodes.forEach((node: any) => {
        if (node?.id) nodesById[node.id] = node;
    });

    const startNode = nodes.find((node: any) => node.type === 'START');
    const startId = startNode?.nextId || startNode?.id || nodes[0]?.id;

    const ordered: string[] = [];
    const visited = new Set<string>();

    const visit = (nodeId?: string) => {
        if (!nodeId || visited.has(nodeId)) return;
        visited.add(nodeId);
        ordered.push(nodeId);
        const node = nodesById[nodeId];
        if (!node) return;
        const nextIds = getNodeNextIds(node);
        nextIds.forEach(visit);
    };

    if (startId) visit(startId);

    const actions: any[] = [];
    const indexByNode: Record<string, number> = {};
    const pendingQuestions: Array<{ node: any; nodeId: string; actionIndex: number; buttons: Array<{ id: string; title: string }> }> = [];
    const pendingLists: Array<{ node: any; nodeId: string; actionIndex: number; rows: Array<{ id: string; title: string; handleId: string }> }> = [];
    const pendingConditions: Array<{ node: any; nodeId: string; actionIndex: number }> = [];
    const warnings: string[] = [];

    ordered.forEach((nodeId) => {
        const node = nodesById[nodeId];
        if (!node || !BUILDER_ACTION_NODE_TYPES.has(node.type)) return;

        if (node.type === 'MESSAGE') {
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_text',
                text: node.content || ''
            };
            const mediaType = typeof node.mediaType === 'string' ? node.mediaType : 'none';
            const mediaUrl = typeof node.mediaUrl === 'string' ? node.mediaUrl.trim() : '';
            const mediaFilename = typeof node.mediaFilename === 'string' ? node.mediaFilename.trim() : '';
            if ((mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && mediaUrl) {
                action.media = {
                    type: mediaType,
                    link: mediaUrl,
                    ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                };
            } else if ((mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && !mediaUrl) {
                warnings.push(`Message node ${nodeId} has media type selected but no media URL. Sending text only.`);
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'ASK') {
            const actionIndex = actions.length;
            const question = typeof node.question === 'string' ? node.question : (node.content || '');
            const saveAsRaw = typeof node.saveAs === 'string' ? node.saveAs : '';
            const saveAs = saveAsRaw
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, '_')
                .replace(/^_+|_+$/g, '');
            const retryLimitRaw = Number(node.retryLimit);
            const retryLimit = Number.isFinite(retryLimitRaw) ? Math.max(1, Math.min(10, Math.floor(retryLimitRaw))) : 3;
            const action: any = {
                type: 'ask_question',
                question: question || '',
                save_as: saveAs,
                retry_limit: retryLimit
            };
            if (node.fallbackText) {
                action.fallback_text = node.fallbackText;
            }
            if (!action.question.trim()) {
                warnings.push(`Ask Question node ${nodeId} has no question text.`);
            }
            if (!action.save_as) {
                warnings.push(`Ask Question node ${nodeId} must define a variable key.`);
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'QUESTION') {
            const options = Array.isArray(node.options) ? node.options : [];
            const limitedOptions = options.slice(0, 3);
            if (options.length > 3) {
                warnings.push(`Buttons node ${nodeId} supports max 3 choices. Extra choices were trimmed.`);
            }
            const buttons = limitedOptions.map((opt: string, idx: number) => ({
                id: slugifyButtonId(opt, idx),
                title: opt || `Option ${idx + 1}`
            }));
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_buttons',
                text: node.content || '',
                buttons
            };
            if (node.fallbackText) {
                action.fallback_text = node.fallbackText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            pendingQuestions.push({ node, nodeId, actionIndex, buttons });
            return;
        }

        if (node.type === 'LIST') {
            const sections = Array.isArray(node.sections) ? node.sections : [];
            const normalizedSections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> = [];
            const rowsMeta: Array<{ id: string; title: string; handleId: string }> = [];
            let globalRowIndex = 0;
            let trimmedRows = 0;

            sections.forEach((section: any, sectionIdx: number) => {
                const title = section?.title || '';
                const rows = Array.isArray(section?.rows) ? section.rows : [];
                const normalizedRows = rows
                    .map((row: any, rowIdx: number) => ({ row, rowIdx }))
                    .filter(() => {
                        if (globalRowIndex >= 10) {
                            trimmedRows += 1;
                            return false;
                        }
                        return true;
                    })
                    .map(({ row, rowIdx }: any) => {
                        const rowTitle = row?.title || `Option ${globalRowIndex + 1}`;
                        let rowId = row?.id || slugifyButtonId(rowTitle, globalRowIndex);
                        if (!rowId) rowId = `option_${globalRowIndex + 1}`;
                        const handleId = `row-${sectionIdx}-${rowIdx}`;
                        rowsMeta.push({ id: rowId, title: rowTitle, handleId });
                        globalRowIndex += 1;
                        return {
                            id: rowId,
                            title: rowTitle,
                            ...(row?.description ? { description: row.description } : {})
                        };
                    });
                normalizedSections.push({
                    ...(title ? { title } : {}),
                    rows: normalizedRows
                });
            });
            if (trimmedRows > 0) {
                warnings.push(`List node ${nodeId} supports max 10 choices. ${trimmedRows} row(s) were trimmed.`);
            }

            const actionIndex = actions.length;
            const action: any = {
                type: 'send_list',
                text: node.body || node.content || '',
                button_text: node.buttonText || node.button_text || node.button || 'View options',
                sections: normalizedSections
            };
            if (node.headerText) {
                action.header = { type: 'text', text: node.headerText };
            }
            if (node.footerText) {
                action.footer = node.footerText;
            }
            if (node.fallbackText) {
                action.fallback_text = node.fallbackText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            pendingLists.push({ node, nodeId, actionIndex, rows: rowsMeta });
            return;
        }

        if (node.type === 'CTA_URL') {
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_cta_url',
                body: node.body || '',
                button_text: node.buttonText || 'Open',
                url: node.url || ''
            };
            if (node.headerText) {
                action.header = { type: 'text', text: node.headerText };
            }
            if (node.footerText) {
                action.footer = node.footerText;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'CONDITION') {
            const actionIndex = actions.length;
            const source = typeof node.source === 'string' ? node.source.trim() : '';
            const operator = typeof node.operator === 'string' ? node.operator.trim() : 'contains';
            const value = node.value === undefined || node.value === null ? '' : String(node.value);
            const action: any = {
                type: 'condition',
                source,
                operator
            };
            if (operator !== 'exists') {
                action.value = value;
            }
            if (!source) {
                warnings.push(`Condition node ${nodeId} has no source variable.`);
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            pendingConditions.push({ node, nodeId, actionIndex });
            return;
        }

        if (node.type === 'TEMPLATE') {
            const actionIndex = actions.length;
            const action: any = {
                type: 'send_template',
                name: (node.templateName || '').trim(),
                language: (node.templateLanguage || 'en_US').trim() || 'en_US'
            };
            const rawComponents = typeof node.templateComponents === 'string' ? node.templateComponents.trim() : '';
            if (rawComponents) {
                try {
                    const parsed = JSON.parse(rawComponents);
                    if (Array.isArray(parsed)) {
                        action.components = parsed;
                    } else {
                        warnings.push(`Template node ${nodeId} components must be a JSON array. Ignored.`);
                    }
                } catch {
                    warnings.push(`Template node ${nodeId} has invalid components JSON. Ignored.`);
                }
            }
            if (!action.name) {
                warnings.push(`Template node ${nodeId} has no template name.`);
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'TAG') {
            const actionIndex = actions.length;
            const nodeTags = Array.isArray(node.tags) ? node.tags : [];
            const tags = Array.from(new Set(
                nodeTags
                    .map((tag: any) => (typeof tag === 'string' ? tag.trim() : ''))
                    .filter(Boolean)
            ));
            actions.push({
                type: 'add_tags',
                tags
            });
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'ASSIGN') {
            const actionIndex = actions.length;
            const assigneeUserId = typeof node.assigneeUserId === 'string' ? node.assigneeUserId.trim() : '';
            actions.push({
                type: 'assign_staff',
                assignee_user_id: assigneeUserId || null,
                assignee_name: assigneeUserId ? ((node.assigneeName || '').trim() || assigneeUserId) : null,
                assignee_color: assigneeUserId ? ((node.assigneeColor || '').trim() || '#6b7280') : null
            });
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'WORKFLOW_TRIGGER') {
            const actionIndex = actions.length;
            const workflowId = typeof node.targetWorkflowId === 'string' ? node.targetWorkflowId.trim() : '';
            if (!workflowId) {
                warnings.push(`Trigger node ${nodeId} has no target workflow.`);
            }
            actions.push({
                type: 'trigger_workflow',
                workflow_id: workflowId
            });
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'IMAGE') {
            const actionIndex = actions.length;
            const caption = node.caption || '';
            const mediaTypeRaw = typeof node.mediaType === 'string' ? node.mediaType.toLowerCase() : 'image';
            const mediaType = mediaTypeRaw === 'video' || mediaTypeRaw === 'document' ? mediaTypeRaw : 'image';
            const url = (node.mediaUrl || node.imageUrl || '').trim();
            const mediaFilename = typeof node.mediaFilename === 'string' ? node.mediaFilename.trim() : '';
            const action: any = {
                type: 'send_text',
                text: caption
            };
            if (url) {
                action.media = {
                    type: mediaType,
                    link: url,
                    ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                };
            } else if (!caption) {
                warnings.push(`Media node ${nodeId} is empty and will be skipped.`);
                return;
            }
            actions.push(action);
            indexByNode[nodeId] = actionIndex;
            return;
        }

        if (node.type === 'END') {
            const actionIndex = actions.length;
            if (node.content) {
                actions.push({ type: 'send_text', text: node.content });
                actions.push({ type: 'end_flow' });
                indexByNode[nodeId] = actionIndex;
            } else {
                actions.push({ type: 'end_flow' });
                indexByNode[nodeId] = actionIndex;
            }
            return;
        }
    });

    const resolveActionIndex = (targetId?: string) => {
        let current = targetId;
        const guard = new Set<string>();
        while (current) {
            if (indexByNode[current] !== undefined) return indexByNode[current];
            if (guard.has(current)) return undefined;
            guard.add(current);
            const node = nodesById[current];
            if (!node) return undefined;
            current = pickFallbackNextId(node);
        }
        return undefined;
    };

    pendingQuestions.forEach(({ node, actionIndex, buttons }) => {
        const routes: Record<string, number> = {};
        buttons.forEach((button, idx) => {
            const optionLabel = Array.isArray(node.options) ? node.options[idx] : button.title;
            const connectionKeys = [
                optionLabel,
                button.id,
                `opt-${idx}`
            ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
            let targetId: string | undefined;
            for (const key of connectionKeys) {
                const nextTarget = node.connections?.[key];
                if (typeof nextTarget === 'string' && nextTarget) {
                    targetId = nextTarget;
                    break;
                }
            }
            const resolvedIndex = resolveActionIndex(targetId);
            if (resolvedIndex !== undefined) {
                routes[button.id] = resolvedIndex;
            } else if (actionIndex + 1 < actions.length) {
                routes[button.id] = actionIndex + 1;
            }
        });
        if (Object.keys(routes).length > 0) {
            (actions[actionIndex] as any).routes = routes;
        }
    });

    pendingLists.forEach(({ node, actionIndex, rows }) => {
        const routes: Record<string, number> = {};
        rows.forEach((row) => {
            const targetId = node.connections?.[row.handleId];
            const resolvedIndex = resolveActionIndex(targetId);
            if (resolvedIndex !== undefined) {
                routes[row.id] = resolvedIndex;
            } else if (actionIndex + 1 < actions.length) {
                routes[row.id] = actionIndex + 1;
            }
        });
        if (Object.keys(routes).length > 0) {
            (actions[actionIndex] as any).routes = routes;
        }
    });

    pendingConditions.forEach(({ node, nodeId, actionIndex }) => {
        const trueTargetId = node.connections?.true;
        const falseTargetId = node.connections?.false;
        const trueIndex = resolveActionIndex(trueTargetId);
        const falseIndex = resolveActionIndex(falseTargetId);
        if (trueIndex !== undefined) {
            (actions[actionIndex] as any).true_step = trueIndex;
        } else if (trueTargetId) {
            warnings.push(`Condition node ${nodeId} true branch is not connected.`);
        }
        if (falseIndex !== undefined) {
            (actions[actionIndex] as any).false_step = falseIndex;
        } else if (falseTargetId) {
            warnings.push(`Condition node ${nodeId} false branch is not connected.`);
        }
    });

    ordered.forEach((nodeId) => {
        const node = nodesById[nodeId];
        if (!node) return;
        const supportsNextStep =
            node.type === 'MESSAGE' ||
            node.type === 'ASK' ||
            node.type === 'IMAGE' ||
            node.type === 'TEMPLATE' ||
            node.type === 'TAG' ||
            node.type === 'ASSIGN';
        if (!supportsNextStep) return;
        const actionIndex = indexByNode[nodeId];
        if (actionIndex === undefined) return;
        const resolvedIndex = resolveActionIndex(node.nextId);
        if (resolvedIndex !== undefined && resolvedIndex !== actionIndex) {
            (actions[actionIndex] as any).next_step = resolvedIndex;
        }
    });

    return { actions, warnings };
};

const buildBuilderFromActions = (actions: any[], workflowId: string) => {
    const nodes: any[] = [];
    const startId = `node-start-${workflowId}`;
    nodes.push({
        id: startId,
        type: 'START',
        position: { x: 120, y: 80 },
        nextId: ''
    });

    const indexToNodeId: Record<number, string> = {};
    const nodeByActionIndex: Record<number, any> = {};
    let lastId = startId;
    let y = 220;

    actions.forEach((action: any, idx: number) => {
        if (!SUPPORTED_ACTION_TYPES.has(action?.type)) return;
        const nodeId = `node-${workflowId}-${idx}`;
        const base: any = {
            id: nodeId,
            position: { x: 120, y },
            nextId: ''
        };

        if (action.type === 'send_text') {
            base.type = 'MESSAGE';
            base.content = action.text || '';
            const mediaType = action?.media?.type;
            const mediaLink = action?.media?.link;
            base.mediaType = mediaType === 'image' || mediaType === 'video' || mediaType === 'document' ? mediaType : 'none';
            base.mediaUrl = typeof mediaLink === 'string' ? mediaLink : '';
            base.mediaFilename = typeof action?.media?.filename === 'string' ? action.media.filename : '';
        } else if (action.type === 'ask_question') {
            base.type = 'ASK';
            base.question = action.question || '';
            base.saveAs = action.save_as || '';
            base.fallbackText = action.fallback_text || '';
            base.retryLimit = typeof action.retry_limit === 'number' ? action.retry_limit : 3;
        } else if (action.type === 'condition') {
            base.type = 'CONDITION';
            base.source = action.source || '';
            base.operator = action.operator || 'contains';
            base.value = action.value ?? '';
        } else if (action.type === 'send_template') {
            base.type = 'TEMPLATE';
            base.templateName = action.name || '';
            base.templateLanguage = action.language || 'en_US';
            base.templateComponents = Array.isArray(action.components) ? JSON.stringify(action.components, null, 2) : '';
        } else if (action.type === 'add_tags' || action.type === 'set_tag') {
            base.type = 'TAG';
            if (action.type === 'set_tag') {
                base.tags = action.tag ? [action.tag] : [];
            } else {
                base.tags = Array.isArray(action.tags) ? action.tags : [];
            }
            base.tagDraft = '';
        } else if (action.type === 'assign_staff') {
            base.type = 'ASSIGN';
            base.assigneeUserId = action.assignee_user_id || '';
            base.assigneeName = action.assignee_name || '';
            base.assigneeColor = action.assignee_color || '#6b7280';
        } else if (action.type === 'trigger_workflow') {
            base.type = 'WORKFLOW_TRIGGER';
            base.targetWorkflowId = action.workflow_id || '';
        } else if (action.type === 'send_image' || action.type === 'send_document' || action.type === 'send_video') {
            base.type = 'MESSAGE';
            const mediaType = action.type === 'send_document' ? 'document' : action.type === 'send_video' ? 'video' : 'image';
            base.content = action.caption || action.text || '';
            base.mediaType = mediaType;
            base.mediaUrl = action.link || '';
            base.mediaFilename = mediaType === 'document' ? (action.filename || '') : '';
        } else if (action.type === 'send_buttons') {
            base.type = 'QUESTION';
            base.content = action.text || '';
            base.options = Array.isArray(action.buttons)
                ? action.buttons.slice(0, 3).map((b: any) => b.title || b.id)
                : [];
            base.fallbackText = action.fallback_text || action.fallback || '';
        } else if (action.type === 'send_list') {
            base.type = 'LIST';
            base.body = action.text || action.body || '';
            base.buttonText = action.button_text || action.buttonText || action.button || 'View options';
            base.headerText = action.header?.text || '';
            base.footerText = action.footer || '';
            if (Array.isArray(action.sections)) {
                let rowCount = 0;
                base.sections = action.sections.map((section: any) => {
                    const rows = Array.isArray(section?.rows) ? section.rows : [];
                    const trimmedRows = rows.filter(() => {
                        if (rowCount >= 10) return false;
                        rowCount += 1;
                        return true;
                    });
                    return { ...section, rows: trimmedRows };
                });
            } else {
                base.sections = [];
            }
            base.fallbackText = action.fallback_text || action.fallback || '';
        } else if (action.type === 'send_cta_url') {
            base.type = 'CTA_URL';
            base.body = action.body || '';
            base.buttonText = action.button_text || '';
            base.url = action.url || '';
            base.headerText = action.header?.text || '';
            base.footerText = action.footer || '';
        } else if (action.type === 'end_flow') {
            base.type = 'END';
            base.content = '';
        } else {
            return;
        }

        const prevNode = nodes.find(n => n.id === lastId);
        if (prevNode) prevNode.nextId = nodeId;

        nodes.push(base);
        indexToNodeId[idx] = nodeId;
        nodeByActionIndex[idx] = base;
        lastId = nodeId;
        y += 180;
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (!action) return;
        if (node.type === 'QUESTION' || node.type === 'LIST' || node.type === 'CONDITION') return;
        if (typeof action.next_step !== 'number') return;
        const targetNodeId = indexToNodeId[action.next_step];
        if (!targetNodeId || targetNodeId === node.id) return;
        node.nextId = targetNodeId;
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (node.type !== 'QUESTION' || !action) return;
        const connections: Record<string, string> = {};
        const buttons = Array.isArray(action.buttons) ? action.buttons : [];
        buttons.forEach((button: any, btnIdx: number) => {
            const route = action.routes?.[button.id];
            let targetIndex: number | undefined;
            if (typeof route === 'number') {
                targetIndex = route;
            } else if (route && route.next_step !== undefined) {
                targetIndex = route.next_step;
            } else {
                targetIndex = idx + 1;
            }
            if (targetIndex === undefined) return;
            const targetNodeId = indexToNodeId[targetIndex];
            if (targetNodeId) {
                connections[`opt-${btnIdx}`] = targetNodeId;
            }
        });
        if (Object.keys(connections).length > 0) {
            node.connections = connections;
        }
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (node.type !== 'LIST' || !action) return;
        const connections: Record<string, string> = {};
        const sections = Array.isArray(node.sections) ? node.sections : [];
        sections.forEach((section: any, sectionIdx: number) => {
            const rows = Array.isArray(section?.rows) ? section.rows : [];
            rows.forEach((row: any, rowIdx: number) => {
                const rowId = row?.id;
                if (!rowId) return;
                const route = action.routes?.[rowId];
                let targetIndex: number | undefined;
                if (typeof route === 'number') {
                    targetIndex = route;
                } else if (route && route.next_step !== undefined) {
                    targetIndex = route.next_step;
                } else {
                    targetIndex = idx + 1;
                }
                if (targetIndex === undefined) return;
                const targetNodeId = indexToNodeId[targetIndex];
                if (targetNodeId) {
                    const handleId = `row-${sectionIdx}-${rowIdx}`;
                    connections[handleId] = targetNodeId;
                }
            });
        });
        if (Object.keys(connections).length > 0) {
            node.connections = connections;
        }
    });

    Object.entries(nodeByActionIndex).forEach(([idxStr, node]) => {
        const idx = Number(idxStr);
        const action = actions[idx];
        if (node.type !== 'CONDITION' || !action) return;
        const connections: Record<string, string> = {};
        if (typeof action.true_step === 'number') {
            const trueTargetNodeId = indexToNodeId[action.true_step];
            if (trueTargetNodeId) connections.true = trueTargetNodeId;
        }
        if (typeof action.false_step === 'number') {
            const falseTargetNodeId = indexToNodeId[action.false_step];
            if (falseTargetNodeId) connections.false = falseTargetNodeId;
        }
        if (Object.keys(connections).length > 0) {
            node.connections = connections;
        }
    });

    return { id: workflowId, nodes };
};

export { buildActionsFromBuilder, buildBuilderFromActions };
