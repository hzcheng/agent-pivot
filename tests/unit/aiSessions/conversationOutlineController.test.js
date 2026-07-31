'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationOutlineController,
} = require('../../../out/aiSessions/conversation/outlineController');

function outline(overrides = {}) {
    return {
        provider: 'codex',
        sessionId: 'session-outline-controller',
        sourceRevision: 'r1',
        interactions: ['input-1', 'input-2', 'input-3'].map(id => ({
            id,
            userPreview: `Preview ${id}`,
            userGraphemeCount: id.length,
            responseState: id === 'input-3' ? 'inProgress' : 'complete',
        })),
        totalInteractions: 5,
        partial: true,
        ...overrides,
    };
}

test('CONVERSATION-OUTLINE-CONTROLLER-001 owns selection, adjacency, and bounded publication projection', () => {
    const controller = new ConversationOutlineController();
    controller.reset('input-2');
    assert.equal(controller.snapshot, undefined);
    assert.equal(controller.selection, 'input-2');
    assert.equal(controller.replace(outline(), 'input-2'), true);
    assert.equal(controller.adjacentInteractionId('before'), 'input-1');
    assert.equal(controller.adjacentInteractionId('after'), 'input-3');
    assert.equal(controller.latestInteractionId(), 'input-3');
    assert.deepEqual(controller.createPublication(), {
        outline: [{
            interactionId: 'input-1',
            userPreview: 'Preview input-1',
            responseState: 'complete',
        }, {
            interactionId: 'input-2',
            userPreview: 'Preview input-2',
            responseState: 'complete',
        }, {
            interactionId: 'input-3',
            userPreview: 'Preview input-3',
            responseState: 'inProgress',
        }],
        selectedInteractionId: 'input-2',
        selectedInput: 4,
        totalInputs: 5,
        partial: true,
        atLatest: false,
    });
    assert.equal(controller.select('input-3'), true);
    assert.equal(controller.createPublication().atLatest, true);
});

test('CONVERSATION-OUTLINE-CONTROLLER-001 rejects unowned selections without corrupting the current outline', () => {
    const controller = new ConversationOutlineController();
    assert.equal(controller.replace(outline(), 'missing'), false);
    assert.equal(controller.snapshot, undefined);
    assert.throws(() => controller.createPublication(), /unavailable/);

    assert.equal(controller.replace(outline(), 'input-1'), true);
    assert.equal(controller.select('missing'), false);
    assert.equal(controller.selection, 'input-1');
    controller.reset();
    assert.equal(controller.snapshot, undefined);
    assert.equal(controller.selection, undefined);
});
