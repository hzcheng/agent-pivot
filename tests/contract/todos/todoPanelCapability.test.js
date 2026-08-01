'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTodoPanelCapability } = require('../../../out/todos/todoPanelCapability');
const { UnsupportedTodoDataVersionError } = require('../../../out/todos/types');

const NOW = '2026-07-24T00:00:00.000Z';

function makeTodoData() {
    return {
        version: 1,
        groups: [{ id: 'group-a', title: 'Work', collapsed: false, order: 0 }],
        todos: [
            {
                id: 'todo-a',
                groupId: 'group-a',
                title: 'Write the slice',
                notes: '',
                priority: 'high',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 0,
            },
            {
                id: 'todo-b',
                groupId: 'group-a',
                title: 'Audit the slice',
                notes: 'notes',
                priority: 'medium',
                completed: true,
                createdAt: NOW,
                updatedAt: NOW,
                order: 1,
            },
        ],
    };
}

function createFixture(overrides = {}) {
    const posted = [];
    const errors = [];
    const warnings = [];
    const prompts = [];
    const service = {
        data: makeTodoData(),
        viewState: { showCompleted: false },
        unsupportedVersionError: undefined,
        calls: [],
        getViewState() { return { ...this.viewState }; },
        async setShowCompleted(value) {
            this.calls.push(['setShowCompleted', value]);
            this.viewState = { ...this.viewState, showCompleted: value };
            return { ...this.viewState };
        },
        getData() { return this.data; },
        getSearchItems: () => [],
        getUnsupportedVersionError() { return this.unsupportedVersionError; },
        async addTodo(input) { this.calls.push(['addTodo', input]); return this.data; },
        async addGroup(title) { this.calls.push(['addGroup', title]); return this.data; },
        async completeTodo(todoId, completed) { this.calls.push(['completeTodo', todoId, completed]); return this.data; },
        async deleteTodo(todoId) { this.calls.push(['deleteTodo', todoId]); return this.data; },
        async deleteGroup(groupId) { this.calls.push(['deleteGroup', groupId]); return this.data; },
        async renameGroup(groupId, title) { this.calls.push(['renameGroup', groupId, title]); return this.data; },
        async reorderGroups(groupIds) { this.calls.push(['reorderGroups', groupIds]); return this.data; },
        async reorderTodos(groupId, todoIds) { this.calls.push(['reorderTodos', groupId, todoIds]); return this.data; },
        async setGroupCollapsed(groupId, collapsed) {
            this.calls.push(['setGroupCollapsed', groupId, collapsed]);
            return this.data;
        },
        async setGroupsCollapsed(collapsed) { this.calls.push(['setGroupsCollapsed', collapsed]); return this.data; },
        async sortGroupByPriority(groupId) { this.calls.push(['sortGroupByPriority', groupId]); return this.data; },
        async revealTodo(todoId, groupId) {
            this.calls.push(['revealTodo', todoId, groupId]);
            return { revealed: true };
        },
        async updateTodo(todoId, patch) { this.calls.push(['updateTodo', todoId, patch]); return this.data; },
    };
    const capability = createTodoPanelCapability({
        provider: { postMessage: async message => { posted.push(message); return true; } },
        todoService: service,
        getSearchCatalog: () => ({ version: 2, todos: [] }),
        getConfiguration: () => overrides.configuration || { get: (_key, fallback) => fallback },
        showInputBox: async options => {
            prompts.push(options);
            return overrides.inputBoxResponses ? overrides.inputBoxResponses.shift() : undefined;
        },
        showWarningMessage: async message => {
            warnings.push(message);
            return overrides.warningResponse;
        },
        showErrorMessage: async message => { errors.push(message); return undefined; },
        logError: (message, error) => { errors.push(`${message} ${String(error)}`); },
    });
    return { capability, posted, service, errors, warnings, prompts };
}

test('TODO-TODO-COMMAND-CONTROLLER-001 exposes every production todo handler key', () => {
    const { capability } = createFixture();

    assert.deepEqual(Object.keys(capability.handlers), [
        'request-todo-panel',
        'todo-command',
        'todo-add',
        'todo-add-group',
        'todo-toggle',
        'todo-delete',
        'todo-delete-group',
        'todo-rename-group',
        'todo-reorder-groups',
        'todo-reorder-items',
        'todo-collapse-group',
        'todo-collapse-groups',
        'todo-sort-priority',
        'todo-toggle-show-completed',
        'todo-reveal',
        'todo-update',
    ]);
});

test('TODO-TODO-COMMAND-CONTROLLER-001 routes versioned commands and attaches the search catalog', async () => {
    const { capability, posted, service } = createFixture();

    await capability.handlers['todo-command']({
        type: 'todo-command',
        version: 2,
        requestId: 7,
        action: 'show-completed',
        payload: { showCompleted: true },
    });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'todo-command-result');
    assert.equal(posted[0].requestId, 7);
    assert.equal(posted[0].success, true);
    assert.deepEqual(posted[0].searchCatalog, { version: 2, todos: [] });
    assert.equal(posted[0].snapshot.showCompleted, true);
    assert.deepEqual(service.calls, [['setShowCompleted', true]]);

    await capability.handlers['todo-command']({ type: 'todo-command', version: 1 });
    assert.equal(posted.length, 1, 'invalid command envelopes must not produce results');
});

test('TODO-DASHBOARD-TODO-MIGRATION-SEQUENCING-001 gates rendering and commands on the storage migration', async () => {
    const { capability, posted } = createFixture();

    let releaseMigration;
    capability.setStorageMigrationReady(new Promise(resolve => { releaseMigration = resolve; }));

    const pendingPanel = capability.handlers['request-todo-panel']({
        type: 'request-todo-panel', version: 1, requestId: 1,
    });
    const pendingCommand = capability.handlers['todo-command']({
        type: 'todo-command', version: 2, requestId: 1,
        action: 'collapse-groups', payload: { collapsed: true },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted.length, 0, 'the render gate must hold panel posts while migration runs');

    releaseMigration();
    await Promise.all([pendingPanel, pendingCommand]);
    assert.equal(posted.length, 2);
    assert.equal(posted[0].type, 'todo-panel-content');
    assert.equal(posted[0].requestId, 1);
    assert.equal(posted[1].type, 'todo-command-result');

    await capability.handlers['request-todo-panel']({ type: 'request-todo-panel', version: 2, requestId: 2 });
    await capability.handlers['request-todo-panel']({ type: 'request-todo-panel', version: 1, requestId: 0 });
    assert.equal(posted.length, 2, 'invalid panel requests must stay ignored');
});

test('TODO-FUTURE-VERSION-DASHBOARD-001 live-probes and recovers inside the capability panel post', async () => {
    const { capability, posted, service } = createFixture();

    service.unsupportedVersionError = new UnsupportedTodoDataVersionError(9);
    await capability.handlers['request-todo-panel']({ type: 'request-todo-panel', version: 1, requestId: 1 });
    assert.equal(posted.length, 1);
    assert.match(posted[0].html, /data-todo-error="unsupported-version"/);
    assert.match(posted[0].html, /unsupported version 9/);
    assert.equal(posted[0].snapshot, undefined, 'unsupported panels must not carry a stale snapshot');

    service.unsupportedVersionError = undefined;
    await capability.handlers['request-todo-panel']({ type: 'request-todo-panel', version: 1, requestId: 2 });
    assert.equal(posted.length, 2);
    assert.doesNotMatch(posted[1].html, /data-todo-error="unsupported-version"/);
    assert.match(posted[1].html, /class="todo-panel\b/);
    assert.ok(posted[1].snapshot, 'a recovered panel projects a fresh snapshot');
});

test('TODO-MAX-VISIBLE-PER-GROUP-001 applies the configured per-group viewport and safe fallback', async () => {
    const configured = createFixture({
        configuration: { get: (key, fallback) => key === 'maxVisibleTodosPerGroup' ? 2.9 : fallback },
    });
    await configured.capability.handlers['request-todo-panel']({
        type: 'request-todo-panel', version: 1, requestId: 1,
    });
    assert.match(configured.posted[0].html, /--todo-visible-items: 2;/);

    const fallback = createFixture({
        configuration: { get: (key, value) => key === 'maxVisibleTodosPerGroup' ? 0 : value },
    });
    await fallback.capability.handlers['request-todo-panel']({
        type: 'request-todo-panel', version: 1, requestId: 1,
    });
    assert.match(fallback.posted[0].html, /--todo-visible-items: 5;/);
});

test('TODO-TODO-HOST-MUTATION-001 legacy handlers validate, mutate, and refresh through the error boundary', async () => {
    const { capability, posted, service } = createFixture();

    await capability.handlers['todo-toggle']({ todoId: 'todo-a', completed: true });
    assert.deepEqual(service.calls, [['completeTodo', 'todo-a', true]]);
    assert.equal(posted[0].type, 'todo-panel-updated');
    assert.deepEqual(posted[0].searchCatalog, { version: 2, todos: [] });

    await capability.handlers['todo-toggle']({ todoId: 42 });
    assert.equal(service.calls.length, 1, 'non-string todo ids must be rejected');

    await capability.handlers['todo-update']({ todoId: 'todo-a', title: 'Renamed', notes: 7, priority: 'low' });
    assert.deepEqual(service.calls[1], ['updateTodo', 'todo-a', {
        title: 'Renamed', notes: '', priority: 'low',
    }]);

    await capability.handlers['todo-reorder-groups']({ groupIds: ['group-a'] });
    await capability.handlers['todo-reorder-items']({ groupId: 'group-a', todoIds: ['todo-b', 'todo-a'] });
    await capability.handlers['todo-collapse-group']({ groupId: 'group-a', collapsed: true });
    await capability.handlers['todo-collapse-groups']({ collapsed: false });
    await capability.handlers['todo-sort-priority']({ groupId: 'group-a' });
    assert.deepEqual(service.calls.slice(2), [
        ['reorderGroups', ['group-a']],
        ['reorderTodos', 'group-a', ['todo-b', 'todo-a']],
        ['setGroupCollapsed', 'group-a', true],
        ['setGroupsCollapsed', false],
        ['sortGroupByPriority', 'group-a'],
    ]);

    await capability.handlers['todo-reorder-groups']({ groupIds: 'group-a' });
    await capability.handlers['todo-reorder-items']({ groupId: 'group-a', todoIds: 'todo-a' });
    await capability.handlers['todo-collapse-group']({ groupId: 7 });
    await capability.handlers['todo-sort-priority']({});
    await capability.handlers['todo-update']({ todoId: 'todo-a' });
    assert.equal(service.calls.length, 7, 'malformed mutation envelopes must not reach the service');
});

test('TODO-TODO-HOST-MUTATION-001 compose add posts the request-correlated result and refresh', async () => {
    const { capability, posted, service } = createFixture();

    await capability.handlers['todo-add']({
        type: 'todo-add', requestId: 3, title: '  ', notes: 'n', priority: 'urgent',
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'todo-mutation-result');
    assert.equal(posted[0].success, false, 'blank titles must fail validation');
    assert.equal(service.calls.length, 0);

    await capability.handlers['todo-add']({
        type: 'todo-add', requestId: 4, title: 'Ship it', notes: 'n', priority: 'high', groupId: 'group-a',
    });
    assert.deepEqual(service.calls, [['addTodo', {
        title: 'Ship it', notes: 'n', priority: 'high', groupId: 'group-a',
    }]]);
    assert.equal(posted[1].type, 'todo-panel-updated', 'the panel refresh precedes the result post');
    assert.equal(posted[2].type, 'todo-mutation-result');
    assert.equal(posted[2].success, true);
});

test('TODO-TODO-HOST-MUTATION-001 prompt and confirmation flows mutate only after acceptance', async () => {
    const { capability, posted, service, warnings } = createFixture({
        inputBoxResponses: ['New group', 'Renamed group'],
        warningResponse: 'Delete',
    });

    await capability.handlers['todo-add-group']({});
    assert.deepEqual(service.calls, [['addGroup', 'New group']]);

    await capability.handlers['todo-rename-group']({ groupId: 'group-a' });
    assert.deepEqual(service.calls[1], ['renameGroup', 'group-a', 'Renamed group']);

    await capability.handlers['todo-delete']({ todoId: 'todo-a' });
    assert.deepEqual(service.calls[2], ['deleteTodo', 'todo-a']);
    assert.match(warnings[0], /Delete TODO "Write the slice"\?/);

    await capability.handlers['todo-delete-group']({ groupId: 'group-a' });
    assert.deepEqual(service.calls[3], ['deleteGroup', 'group-a']);
    assert.match(warnings[1], /Delete TODO group "Work" and all of its todos\?/);

    assert.equal(
        posted.filter(message => message.type === 'todo-panel-updated').length,
        4,
        'every accepted prompt/confirmation mutation refreshes the panel',
    );
});

test('TODO-TODO-HOST-MUTATION-001 declined confirmations and cancelled prompts leave state untouched', async () => {
    const { capability, service } = createFixture({
        inputBoxResponses: [undefined, undefined],
        warningResponse: undefined,
    });

    await capability.handlers['todo-add-group']({});
    await capability.handlers['todo-rename-group']({ groupId: 'group-a' });
    await capability.handlers['todo-delete']({ todoId: 'todo-a' });
    await capability.handlers['todo-delete-group']({ groupId: 'group-a' });
    await capability.handlers['todo-delete-group']({ groupId: 'missing' });
    assert.equal(service.calls.length, 0);
});

test('TODO-TODO-HOST-MUTATION-001 reveal and completed toggles manage the temporary reveal target', async () => {
    const { capability, posted, service } = createFixture();

    await capability.handlers['todo-reveal']({ todoId: 'todo-b', groupId: 'group-a' });
    assert.deepEqual(service.calls, [['revealTodo', 'todo-b', 'group-a']]);
    assert.equal(posted[0].type, 'todo-panel-updated');
    assert.equal(posted[0].snapshot.revealedTodoId, 'todo-b');

    await capability.handlers['todo-toggle-show-completed']({ showCompleted: false });
    assert.deepEqual(service.calls[1], ['setShowCompleted', false]);
    assert.equal(posted[1].snapshot.revealedTodoId, undefined,
        'an explicit completed toggle clears the temporary target after persistence');

    await capability.handlers['todo-reveal']({ todoId: 'todo-a', groupId: 'group-a' });
    assert.equal(posted[2].snapshot.revealedTodoId, 'todo-a');
    await capability.handlers['todo-reveal']({ todoId: 'todo-a' });
    assert.equal(posted.length, 3, 'missing group ids must reject before mutating');
    assert.equal(service.calls.length, 3);
});

test('TODO-TODO-COMMAND-CONTROLLER-001 versioned commands see the cleared reveal target', async () => {
    const { capability, posted } = createFixture();

    await capability.handlers['todo-reveal']({ todoId: 'todo-b', groupId: 'group-a' });
    await capability.handlers['todo-command']({
        type: 'todo-command', version: 2, requestId: 9,
        action: 'show-completed', payload: { showCompleted: false },
    });
    const result = posted.find(message => message.type === 'todo-command-result');
    assert.equal(result.snapshot.revealedTodoId, undefined,
        'the versioned show-completed path clears the temporary target');

    capability.dispose();
});
