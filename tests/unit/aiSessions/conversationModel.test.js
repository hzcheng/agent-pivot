'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');
const model = require('../../../out/aiSessions/conversation/model');

function makeInteractions(count) {
    return Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        return {
            id: `i-${number}`,
            providerTurnId: `turn-${number}`,
            timestamp: number,
            userMarkdown: `user ${number}`,
            userPreview: `user ${number}`,
            userGraphemeCount: 6,
            assistantMarkdown: [`assistant ${number}`],
            responseState: number === count ? 'inProgress' : 'complete',
        };
    });
}

test('SESSION-AI-SESSION-CONVERSATION-PAGE-001 clamps pages and rejects stale revisions', () => {
    const interactions = makeInteractions(30);
    const request = {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-25',
        direction: 'around',
        limit: 99,
        expectedRevision: 'r1',
    };
    const page = model.buildConversationPage(interactions, request, 'r1');
    assert.equal(new Set(page.messages.map(message => message.interactionId)).size, 20);
    assert.throws(
        () => model.buildConversationPage(interactions, { ...request, expectedRevision: 'r1' }, 'r2'),
        /staleRevision/
    );
});

test('SESSION-AI-SESSION-CONVERSATION-MODEL-002 projects immutable bounded summaries and stopped state', () => {
    const interactions = makeInteractions(CONVERSATION_LIMITS.maxOutlineInteractions + 1);
    const outline = model.buildConversationOutline('kimi', 'session', 'r1', interactions, false);
    assert.equal(outline.totalInteractions, CONVERSATION_LIMITS.maxOutlineInteractions + 1);
    assert.equal(outline.interactions.length, CONVERSATION_LIMITS.maxOutlineInteractions);
    assert.equal(outline.interactions[0].id, 'i-2');
    assert.equal(outline.partial, true);
    assert.equal('userMarkdown' in outline.interactions[0], false);
    assert.equal('assistantMarkdown' in outline.interactions[0], false);
    assert.equal(model.applyStoppedLifecycleToResponseState('inProgress', true), 'interrupted');
    assert.equal(model.applyStoppedLifecycleToResponseState('complete', true), 'complete');
    assert.equal(
        model.applyActiveLifecycleToResponseState('interrupted', true, true),
        'inProgress'
    );
    assert.equal(
        model.applyActiveLifecycleToResponseState('interrupted', true, false),
        'interrupted'
    );
    assert.equal(
        model.applyActiveLifecycleToResponseState('complete', true, true),
        'inProgress'
    );
});

test('SESSION-AI-SESSION-CONVERSATION-MODEL-003 removes complete interactions until an UTF-8 page fits', () => {
    const interactions = makeInteractions(3).map(interaction => ({
        ...interaction,
        userMarkdown: '😀'.repeat(60000),
        assistantMarkdown: ['😀'.repeat(60000)],
    }));
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-2',
        direction: 'around',
        limit: 3,
    }, 'r1', (id, direction) => `${direction}:${id}`);
    assert.equal(new Set(page.messages.map(message => message.interactionId)).size, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= CONVERSATION_LIMITS.maxPageBytes);
});

test('SESSION-AI-SESSION-CONVERSATION-MODEL-004 bounds serialization work while shrinking a large page', () => {
    const interactions = makeInteractions(20).map(interaction => ({
        ...interaction,
        userMarkdown: 'u'.repeat(60 * 1024),
        assistantMarkdown: ['a'.repeat(60 * 1024)],
    }));
    const sourceCharacters = interactions.length * 120 * 1024;
    const originalStringify = JSON.stringify;
    let serializedCharacters = 0;
    JSON.stringify = function measuredStringify(...args) {
        const result = originalStringify(...args);
        serializedCharacters += result?.length || 0;
        return result;
    };
    let page;
    try {
        page = model.buildConversationPage(interactions, {
            provider: 'codex',
            sessionId: 'session',
            anchorInteractionId: 'i-20',
            direction: 'around',
            limit: 20,
        }, 'r1');
    } finally {
        JSON.stringify = originalStringify;
    }
    assert.ok(
        serializedCharacters <= sourceCharacters * 3,
        `serialized ${serializedCharacters} characters for ${sourceCharacters} source characters`
    );
    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 CONVERSATION-PROGRESS-VISIBILITY-001 interleaves tool calls with progress and final assistant text by position', () => {
    const interactions = [{
        id: 'i-1',
        providerTurnId: 'turn-1',
        timestamp: 1,
        userMarkdown: 'Run the tests',
        userPreview: 'Run the tests',
        userGraphemeCount: 13,
        assistantMarkdown: ['first chunk', 'second chunk'],
        assistantPhases: ['progress', 'answer'],
        toolCalls: [
            { position: 0, name: 'Shell', summary: 'Shell npm test' },
            { position: 1, name: 'ReadFile', summary: 'ReadFile a.ts', detail: 'file body' },
            { position: 2, name: 'Write', summary: 'Write b.ts' },
        ],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(
        page.messages.map(message => [message.role, message.id]),
        [
            ['user', 'i-1:user'],
            ['tool', 'i-1:tool:0'],
            ['progress', 'i-1:progress:0'],
            ['tool', 'i-1:tool:1'],
            ['assistant', 'i-1:assistant:1'],
            ['tool', 'i-1:tool:2'],
        ]
    );
    assert.deepEqual(page.messages[3].tool, {
        name: 'ReadFile',
        summary: 'ReadFile a.ts',
        detail: 'file body',
    });
    assert.equal(page.messages[1].markdown, '');
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 interleaves plan and question blocks with assistant text by position', () => {
    const interactions = [{
        id: 'i-1',
        providerTurnId: 'turn-1',
        timestamp: 1,
        userMarkdown: 'Ship it',
        userPreview: 'Ship it',
        userGraphemeCount: 8,
        assistantMarkdown: ['first chunk', 'second chunk'],
        plans: [
            { position: 1, markdown: '# Plan\n\n1. step', filePath: '/tmp/plan.md' },
        ],
        questions: [{
            position: 2,
            source: 'ExitPlanMode',
            questions: [{
                question: 'Approve this plan',
                header: 'Plan',
                options: [
                    { label: 'Full refactor', description: 'All at once' },
                    { label: 'Reject' },
                ],
                multiSelect: false,
                otherLabel: 'Revise',
                answers: ['Full refactor'],
            }],
            outcome: 'approved',
        }],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(
        page.messages.map(message => [message.role, message.id]),
        [
            ['user', 'i-1:user'],
            ['assistant', 'i-1:assistant:0'],
            ['plan', 'i-1:plan:0'],
            ['assistant', 'i-1:assistant:1'],
            ['question', 'i-1:question:0'],
        ]
    );
    assert.deepEqual(page.messages[2].plan, {
        markdown: '# Plan\n\n1. step',
        filePath: '/tmp/plan.md',
    });
    assert.equal(page.messages[2].markdown, '');
    assert.deepEqual(page.messages[4].question, {
        source: 'ExitPlanMode',
        questions: [{
            question: 'Approve this plan',
            header: 'Plan',
            options: [
                { label: 'Full refactor', description: 'All at once' },
                { label: 'Reject' },
            ],
            multiSelect: false,
            otherLabel: 'Revise',
            answers: ['Full refactor'],
        }],
        outcome: 'approved',
    });
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 omits optional plan and question fields when absent', () => {
    const interactions = [{
        id: 'i-1',
        userMarkdown: 'Ship it',
        userPreview: 'Ship it',
        userGraphemeCount: 8,
        assistantMarkdown: [],
        plans: [{ position: 0, markdown: '# Plan' }],
        questions: [{
            position: 0,
            source: 'AskUserQuestion',
            questions: [{
                question: 'Pick one',
                options: [{ label: 'A' }],
                multiSelect: true,
            }],
        }],
        responseState: 'inProgress',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(page.messages[1].plan, { markdown: '# Plan' });
    assert.deepEqual(page.messages[2].question, {
        source: 'AskUserQuestion',
        questions: [{
            question: 'Pick one',
            options: [{ label: 'A' }],
            multiSelect: true,
        }],
    });
});

test('CONVERSATION-DIFF-VISIBILITY-001 carries tool call diffs onto page messages', () => {
    const interactions = [{
        id: 'i-1',
        userMarkdown: 'Apply the patch',
        userPreview: 'Apply the patch',
        userGraphemeCount: 16,
        assistantMarkdown: ['Done.'],
        toolCalls: [{
            position: 0,
            name: 'fileChange',
            summary: 'fileChange update src/a.ts',
            diffs: [{
                path: 'src/a.ts',
                kind: 'update',
                additions: 1,
                deletions: 1,
                hunks: [{
                    oldStart: 3,
                    newStart: 3,
                    lines: [
                        { type: 'del', text: 'const a = 1;' },
                        { type: 'add', text: 'const a = 2;' },
                    ],
                }],
            }],
        }],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'codex',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    const tool = page.messages.find(message => message.role === 'tool');
    assert.deepEqual(tool.tool.diffs, [{
        path: 'src/a.ts',
        kind: 'update',
        additions: 1,
        deletions: 1,
        hunks: [{
            oldStart: 3,
            newStart: 3,
            lines: [
                { type: 'del', text: 'const a = 1;' },
                { type: 'add', text: 'const a = 2;' },
            ],
        }],
    }]);
    // The page carries a deep copy, not the adapter's mutable entry.
    interactions[0].toolCalls[0].diffs[0].hunks[0].lines[0].text = 'mutated';
    assert.equal(
        page.messages[1].tool.diffs[0].hunks[0].lines[0].text,
        'const a = 1;'
    );
});

test('CONVERSATION-THINKING-VISIBILITY-001 interleaves thinking blocks with tool calls and assistant text by position', () => {
    const interactions = [{
        id: 'i-1',
        providerTurnId: 'turn-1',
        timestamp: 1,
        userMarkdown: 'Fix the bug',
        userPreview: 'Fix the bug',
        userGraphemeCount: 11,
        assistantMarkdown: ['first chunk', 'second chunk'],
        toolCalls: [
            { position: 1, name: 'Shell', summary: 'Shell npm test' },
        ],
        thinking: [
            { position: 0, text: 'Let me think.' },
            { position: 2, text: 'One more check.' },
        ],
        responseState: 'complete',
    }];
    const page = model.buildConversationPage(interactions, {
        provider: 'claude',
        sessionId: 'session',
        anchorInteractionId: 'i-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(
        page.messages.map(message => [message.role, message.id]),
        [
            ['user', 'i-1:user'],
            ['thinking', 'i-1:thinking:0'],
            ['progress', 'i-1:progress:0'],
            ['tool', 'i-1:tool:0'],
            ['assistant', 'i-1:assistant:1'],
            ['thinking', 'i-1:thinking:1'],
        ]
    );
    assert.deepEqual(page.messages[1].thinking, { text: 'Let me think.' });
    assert.equal(page.messages[1].markdown, '');
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 page interaction states carry turn timing', () => {
    const page = model.buildConversationPage([{
        id: 'turn-1',
        timestamp: 1_000,
        completedAt: 81_000,
        userMarkdown: 'Run the tests',
        userPreview: 'Run the tests',
        userGraphemeCount: 13,
        assistantMarkdown: ['All pass.'],
        toolCalls: [{ position: 0, name: 'Shell', summary: 'Shell npm test' }],
        responseState: 'complete',
    }], {
        provider: 'codex',
        sessionId: 'session',
        anchorInteractionId: 'turn-1',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(page.interactionStates, [{
        interactionId: 'turn-1',
        responseState: 'complete',
        timestamp: 1_000,
        completedAt: 81_000,
    }]);
    const withoutTiming = model.buildConversationPage([{
        id: 'turn-2',
        userMarkdown: 'Hi',
        userPreview: 'Hi',
        userGraphemeCount: 2,
        assistantMarkdown: ['Hello'],
        responseState: 'complete',
    }], {
        provider: 'codex',
        sessionId: 'session',
        anchorInteractionId: 'turn-2',
        direction: 'around',
    }, 'r1');
    assert.deepEqual(withoutTiming.interactionStates, [{
        interactionId: 'turn-2',
        responseState: 'complete',
    }]);
});

test('CONVERSATION-OVERSIZED-TURN-001 preserves a multibyte user input and final answer when one turn must shrink', () => {
    const [interaction] = makeInteractions(1);
    interaction.userMarkdown = '👨‍👩‍👧‍👦'.repeat(12_500);
    interaction.userGraphemeCount = 12_500;
    interaction.assistantMarkdown = ['👩‍👩‍👧‍👦'.repeat(12_500)];
    const page = model.buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: interaction.id,
        direction: 'around',
    }, 'r1');

    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    assert.deepEqual(page.messages.map(message => message.role), [
        'user', 'progress', 'assistant',
    ]);
    assert.equal(new Set(page.messages.map(message => message.id)).size, 3);
});

test('CONVERSATION-OVERSIZED-TURN-001 truncates one individually oversized message before fitting the semantic endpoint', () => {
    const [interaction] = makeInteractions(1);
    interaction.userMarkdown = '👨‍👩‍👧‍👦'.repeat(25_000);
    interaction.userGraphemeCount = 25_000;
    interaction.assistantMarkdown = ['Final answer survives.'];
    const page = model.buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: interaction.id,
        direction: 'around',
    }, 'r1');

    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    assert.equal(page.messages[0].role, 'user');
    assert.match(page.messages[0].markdown, /…$/);
    assert.equal(page.messages.at(-1).markdown, 'Final answer survives.');
});

test('CONVERSATION-OVERSIZED-TURN-001 keeps a bounded provider question when its nested text exceeds one page', () => {
    const [interaction] = makeInteractions(1);
    interaction.assistantMarkdown = ['Final answer after the question.'];
    interaction.questions = [{
        position: 0,
        source: 'AskUserQuestion',
        questions: Array.from({ length: 8 }, (_item, questionIndex) => ({
            question: `Question ${questionIndex} ${'😀'.repeat(2_000)}`,
            options: Array.from({ length: 8 }, (_option, optionIndex) => ({
                label: `Option ${optionIndex} ${'🧭'.repeat(500)}`,
                description: '🔎'.repeat(2_000),
            })),
            multiSelect: false,
            answers: ['✅'.repeat(2_000)],
        })),
        outcome: 'answered',
    }];
    const page = model.buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: interaction.id,
        direction: 'around',
    }, 'r1');

    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    const question = page.messages.find(message => message.role === 'question');
    assert.ok(question, 'the semantic question endpoint must remain visible');
    assert.equal(question.question.source, 'AskUserQuestion');
    assert.equal(question.question.questions.length, 8);
    assert.deepEqual(
        page.messages.filter(message =>
            message.role === 'question' || message.role === 'assistant'
        ).map(message => message.role),
        ['question', 'assistant']
    );
    assert.equal(
        page.messages.find(message => message.role === 'assistant').markdown,
        'Final answer after the question.'
    );
    assert.equal(
        new Set(page.messages.map(message => message.id)).size,
        page.messages.length
    );
});

test('CONVERSATION-OVERSIZED-TURN-001 bounding truncates plan content but keeps the plan file path', () => {
    const [interaction] = makeInteractions(1);
    interaction.userMarkdown = 'U'.repeat(200 * 1024);
    interaction.userGraphemeCount = 200 * 1024;
    interaction.assistantMarkdown = [];
    interaction.plans = [{
        position: 0,
        markdown: 'P'.repeat(450 * 1024),
        filePath: '/home/user/.kimi/plans/keep-me.md',
    }];
    const page = model.buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: interaction.id,
        direction: 'around',
    }, 'r1');

    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    const plan = page.messages.find(message => message.role === 'plan');
    assert.ok(plan, 'the plan endpoint must remain visible');
    assert.match(plan.plan.markdown, /…$/);
    assert.equal(plan.plan.filePath, '/home/user/.kimi/plans/keep-me.md');
    assert.equal(page.messages[0].role, 'user');
    assert.equal(
        page.messages.some(message =>
            message.markdown === 'Work was omitted to keep this turn within the conversation size limit.'),
        true
    );
});

test('CONVERSATION-OVERSIZED-TURN-001 a worklog-only oversized turn keeps its user input and latest work entry', () => {
    // Real sessions contain complete turns with no assistant, plan, or
    // question message at all (e.g. orchestrator turns whose content lives
    // in provider events the adapter skips). The fallback endpoint is the
    // turn's last message.
    const [interaction] = makeInteractions(1);
    interaction.userMarkdown = 'U'.repeat(200 * 1024);
    interaction.userGraphemeCount = 200 * 1024;
    interaction.assistantMarkdown = [];
    interaction.toolCalls = [{
        position: 0,
        name: 'Shell',
        summary: 'the final work entry',
        detail: 'D'.repeat(400 * 1024),
    }];
    const page = model.buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: interaction.id,
        direction: 'around',
    }, 'r1');

    assert.ok(
        Buffer.byteLength(JSON.stringify(page), 'utf8')
            <= CONVERSATION_LIMITS.maxPageBytes
    );
    assert.equal(page.messages[0].role, 'user');
    assert.equal(
        page.messages.some(message =>
            message.markdown === 'Work was omitted to keep this turn within the conversation size limit.'),
        true
    );
    const tool = page.messages.find(message => message.role === 'tool');
    assert.ok(tool, 'the fallback endpoint must remain visible');
    assert.equal(tool.tool.name, 'Shell');
    assert.equal(tool.tool.summary, 'the final work entry');
    assert.match(tool.tool.detail, /…$/);
});
