'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewPromptScripts.js'),
    'utf8'
);

function snapshotAt(revision, overrides = {}) {
    return {
        version: 1,
        revision,
        selectedPromptId: null,
        prompts: [
            { id: 'prompt-a', name: 'Alpha', text: 'First body' },
            { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
        ],
        ...overrides,
    };
}

function surfaceHtml(revision, promptIds = ['prompt-a', 'prompt-b'], marker = '') {
    const items = promptIds.map(promptId => `<li data-prompt-id="${promptId}">
        <button data-drag-prompt-id="${promptId}">Drag</button>
        <button data-action="prompt-select-default" data-prompt-id="${promptId}" aria-pressed="false">Default</button>
        <button data-action="prompt-edit" data-prompt-id="${promptId}">Edit</button>
        <button data-action="prompt-delete" data-prompt-id="${promptId}">Delete</button>
        <form data-prompt-form="edit" data-prompt-id="${promptId}" hidden>
            <input name="name" value="${promptId}">
            <textarea name="text">${promptId} body</textarea>
            <span data-prompt-field-error="name"></span>
            <span data-prompt-field-error="text"></span>
            <button type="submit" data-prompt-form-action="submit">Save</button>
            <button type="button" data-action="prompt-cancel-edit" data-prompt-form-action="cancel">Cancel</button>
        </form>
    </li>`).join('');
    return `<div data-prompt-surface data-prompt-revision="${revision}">
        <button data-action="prompt-new">New Prompt</button>
        <form data-prompt-form="create" hidden>
            <input name="name"><textarea name="text"></textarea>
            <span data-prompt-field-error="name"></span>
            <span data-prompt-field-error="text"></span>
            <button type="submit" data-prompt-form-action="submit">Save</button>
            <button type="button" data-action="prompt-cancel-create" data-prompt-form-action="cancel">Cancel</button>
        </form>
        <ol data-prompt-list>${items}</ol>
        <div data-prompt-status role="status" aria-live="polite"></div>${marker}
    </div>`;
}

function matches(element, selector) {
    if (!element) return false;
    if (selector === '[data-action]') return element.getAttribute('data-action') !== null;
    if (selector === '[data-prompt-id]') return element.getAttribute('data-prompt-id') !== null;
    if (selector === '[data-drag-prompt-id]') {
        return element.getAttribute('data-drag-prompt-id') !== null;
    }
    if (selector === '[data-prompt-form]') {
        return element.getAttribute('data-prompt-form') !== null;
    }
    if (selector === '[data-prompt-form-action]') {
        return element.getAttribute('data-prompt-form-action') !== null;
    }
    if (selector === '[role="tab"]') return element.getAttribute('role') === 'tab';
    return false;
}

function createElement(document, attributes = {}) {
    const values = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    const element = {
        ownerRoot: null,
        parentElement: null,
        hidden: false,
        value: '',
        textContent: '',
        scrollTop: 0,
        getAttribute(name) {
            return values.has(name) ? values.get(name) : null;
        },
        setAttribute(name, value) {
            values.set(name, String(value));
        },
        removeAttribute(name) {
            values.delete(name);
        },
        hasAttribute(name) {
            return values.has(name);
        },
        closest(selector) {
            let candidate = this;
            while (candidate) {
                if (matches(candidate, selector)) return candidate;
                candidate = candidate.parentElement;
            }
            return null;
        },
        focus() {
            document.activeElement = this;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };
    let disabled = false;
    Object.defineProperty(element, 'disabled', {
        get: () => disabled,
        set: value => {
            disabled = value === true;
            if (disabled && document.activeElement === element) {
                document.activeElement = document.body;
            }
        },
    });
    return element;
}

function createForm(document, kind, promptId) {
    const attributes = { 'data-prompt-form': kind };
    if (promptId) attributes['data-prompt-id'] = promptId;
    const form = createElement(document, attributes);
    form.hidden = true;
    form.noValidate = false;
    const fields = {
        name: createElement(document, { name: 'name' }),
        text: createElement(document, { name: 'text' }),
    };
    const errors = {
        name: createElement(document, { 'data-prompt-field-error': 'name' }),
        text: createElement(document, { 'data-prompt-field-error': 'text' }),
    };
    Object.values(fields).concat(Object.values(errors)).forEach(child => {
        child.parentElement = form;
    });
    Object.values(fields).forEach(field => {
        field.defaultValue = '';
    });
    const cancelAction = createElement(document, {
        'data-action': kind === 'create' ? 'prompt-cancel-create' : 'prompt-cancel-edit',
        'data-prompt-form-action': 'cancel',
        ...(promptId ? { 'data-prompt-id': promptId } : {}),
    });
    const submitAction = createElement(document, {
        type: 'submit',
        'data-prompt-form-action': 'submit',
    });
    cancelAction.parentElement = form;
    submitAction.parentElement = form;
    form.querySelector = selector => {
        const name = selector.match(/^\[name="([^"]+)"\]$/);
        if (name) return fields[name[1]] || null;
        const error = selector.match(/^\[data-prompt-field-error="([^"]+)"\]$/);
        if (error) return errors[error[1]] || null;
        const action = selector.match(/^\[data-prompt-form-action="([^"]+)"\]$/);
        if (action) {
            return action[1] === 'submit' ? submitAction
                : action[1] === 'cancel' ? cancelAction : null;
        }
        return null;
    };
    form.querySelectorAll = selector => selector === 'button, input, textarea, select'
        ? [submitAction, cancelAction].concat(Object.values(fields))
        : [];
    form.reset = () => {
        Object.values(fields).forEach(field => {
            field.value = field.defaultValue;
        });
    };
    form.fields = fields;
    form.errors = errors;
    form.cancelAction = cancelAction;
    form.submitAction = submitAction;
    return form;
}

function createPromptRoot(document, initialHtml) {
    const listeners = {};
    const root = {
        _html: '',
        surface: null,
        list: null,
        status: null,
        controls: [],
        items: [],
        forms: new Map(),
        addEventListener(type, listener) {
            (listeners[type] || (listeners[type] = [])).push(listener);
        },
        dispatch(type, event) {
            (listeners[type] || []).forEach(listener => listener(event));
        },
        contains(element) {
            return Boolean(element && element.ownerRoot === root);
        },
        querySelector(selector) {
            if (selector === '[data-prompt-surface]') return root.surface;
            if (selector === '[data-prompt-status]') return root.status;
            if (selector === '[data-prompt-list]') return root.list;
            if (selector === '[data-prompt-form="create"]') return root.forms.get('create') || null;
            if (selector === '[data-action="prompt-new"]') return root.newButton || null;
            const edit = selector.match(/^\[data-prompt-form="edit"\]\[data-prompt-id="([^"]+)"\]$/);
            if (edit) return root.forms.get(`edit:${edit[1]}`) || null;
            return root.tabs.find(tab => `#${tab.id}` === selector) || null;
        },
        querySelectorAll(selector) {
            if (selector === '[role="tab"]') return root.tabs;
            if (selector === '[role="tabpanel"]') return root.panels;
            if (selector === '.prompt-item[data-prompt-id]') return root.items;
            return [];
        },
        getForm(kind, promptId) {
            return root.forms.get(promptId ? `${kind}:${promptId}` : kind);
        },
        getItem(promptId) {
            return root.items.find(item => item.getAttribute('data-prompt-id') === promptId);
        },
    };
    root.tabs = ['prompts', 'skills', 'mcp', 'hooks'].map((name, index) => {
        const tab = createElement(document, {
            role: 'tab',
            id: `ai-tab-${name}`,
            'aria-controls': `ai-panel-${name}`,
            'aria-selected': index === 0 ? 'true' : 'false',
            tabindex: index === 0 ? '0' : '-1',
        });
        tab.id = `ai-tab-${name}`;
        tab.ownerRoot = root;
        return tab;
    });
    root.panels = root.tabs.map((tab, index) => {
        const panel = createElement(document, {
            role: 'tabpanel',
            id: tab.getAttribute('aria-controls'),
        });
        panel.id = tab.getAttribute('aria-controls');
        panel.hidden = index !== 0;
        panel.ownerRoot = root;
        return panel;
    });

    function rebuild(html) {
        if (root.controls.indexOf(document.activeElement) >= 0) {
            document.activeElement = document.body;
        }
        root._html = html;
        root.controls = [];
        root.items = [];
        root.forms = new Map();
        const revision = html.match(/data-prompt-revision="(\d+)"/);
        if (!revision) {
            root.surface = null;
            root.list = null;
            root.status = null;
            return;
        }
        const surface = createElement(document, {
            'data-prompt-surface': '',
            'data-prompt-revision': revision[1],
        });
        surface.ownerRoot = root;
        Object.defineProperty(surface, 'outerHTML', {
            get: () => root._html,
            set: value => rebuild(String(value)),
        });
        root.surface = surface;
        root.status = createElement(document, {
            'data-prompt-status': '',
            role: 'status',
            'aria-live': 'polite',
        });
        root.status.ownerRoot = root;
        root.list = createElement(document, { 'data-prompt-list': '' });
        root.list.ownerRoot = root;

        const newButton = createElement(document, { 'data-action': 'prompt-new' });
        newButton.ownerRoot = root;
        root.newButton = newButton;
        root.controls.push(newButton);
        const create = createForm(document, 'create');
        create.ownerRoot = root;
        create.cancelAction.ownerRoot = root;
        create.submitAction.ownerRoot = root;
        root.controls.push(create.submitAction, create.cancelAction);
        Object.values(create.fields).forEach(field => {
            field.ownerRoot = root;
            root.controls.push(field);
        });
        root.forms.set('create', create);

        for (const match of html.matchAll(/<li[^>]*data-prompt-id="([^"]+)"/g)) {
            const promptId = match[1];
            const item = createElement(document, { 'data-prompt-id': promptId });
            item.ownerRoot = root;
            item.parentElement = root.list;
            item.actions = [
                createElement(document, { 'data-drag-prompt-id': promptId }),
                createElement(document, {
                    'data-action': 'prompt-select-default',
                    'data-prompt-id': promptId,
                    'aria-pressed': 'false',
                }),
                createElement(document, {
                    'data-action': 'prompt-edit',
                    'data-prompt-id': promptId,
                }),
                createElement(document, {
                    'data-action': 'prompt-delete',
                    'data-prompt-id': promptId,
                }),
            ];
            item.actions.forEach(action => {
                action.parentElement = item;
                action.ownerRoot = root;
                root.controls.push(action);
            });
            item.querySelectorAll = selector => selector === '[data-action]'
                ? item.actions.filter(action => action.getAttribute('data-action') !== null)
                : [];
            const edit = createForm(document, 'edit', promptId);
            edit.ownerRoot = root;
            edit.parentElement = item;
            edit.fields.name.value = promptId;
            edit.fields.text.value = `${promptId} body`;
            edit.fields.name.defaultValue = promptId;
            edit.fields.text.defaultValue = `${promptId} body`;
            edit.cancelAction.ownerRoot = root;
            edit.submitAction.ownerRoot = root;
            root.controls.push(edit.submitAction, edit.cancelAction);
            Object.values(edit.fields).forEach(field => {
                field.ownerRoot = root;
                root.controls.push(field);
            });
            root.forms.set(`edit:${promptId}`, edit);
            root.items.push(item);
        }
        root.list.querySelectorAll = selector =>
            selector === ':scope > [data-prompt-id]' ? root.items : [];
        root.list.insertBefore = (item, target) => {
            const from = root.items.indexOf(item);
            const to = root.items.indexOf(target);
            if (from < 0 || to < 0 || from === to) return;
            root.items.splice(from, 1);
            root.items.splice(root.items.indexOf(target), 0, item);
        };
        root.list.appendChild = item => {
            const from = root.items.indexOf(item);
            if (from >= 0) root.items.splice(from, 1);
            root.items.push(item);
        };
        surface.querySelector = selector => {
            if (selector === '[data-prompt-status]') return root.status;
            if (selector === '[data-prompt-list]') return root.list;
            return root.querySelector(selector);
        };
        surface.querySelectorAll = selector => {
            if (selector === 'button, input, textarea, select, [data-drag-prompt-id]') {
                return root.controls;
            }
            if (selector === '.prompt-item[data-prompt-id]') return root.items;
            if (selector === '[data-prompt-form="edit"]') {
                return Array.from(root.forms.entries())
                    .filter(([key]) => key.startsWith('edit:'))
                    .map(([, form]) => form);
            }
            return [];
        };
    }
    Object.defineProperty(root, 'innerHTML', {
        get: () => root._html,
        set: value => rebuild(String(value)),
    });
    root.innerHTML = initialHtml;
    return root;
}

function createPromptHarness(options = {}) {
    const initialHtml = options.initialHtml || surfaceHtml(options.revision || 0);
    const messages = [];
    const windowListeners = {};
    const document = { activeElement: null, body: {} };
    const root = createPromptRoot(document, initialHtml);
    let uuid = 0;
    const context = {
        console,
        document,
        window: {
            vscode: {
                postMessage(message) {
                    messages.push(JSON.parse(JSON.stringify(message)));
                },
            },
            addEventListener(type, listener) {
                (windowListeners[type] || (windowListeners[type] = [])).push(listener);
            },
            scrollY: options.scrollY || 0,
            scrollTo(_x, y) {
                this.scrollY = y;
            },
        },
        crypto: {
            randomUUID() {
                uuid += 1;
                return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
            },
        },
    };
    vm.runInNewContext(source, context, { filename: 'webviewPromptScripts.js' });
    const controller = context.window.__projectStewardPrompts;
    const initialRevision = Number(initialHtml.match(/data-prompt-revision="(\d+)"/)?.[1] || 0);
    controller.mount(root, {
        authoritySequence: options.authoritySequence || 1,
        snapshot: options.snapshot || snapshotAt(initialRevision),
    });
    return {
        context,
        controller,
        document,
        initialHtml,
        messages,
        root,
        send(message) {
            (windowListeners.message || []).forEach(listener => listener({ data: message }));
        },
    };
}

function resultFor(request, revision, overrides = {}) {
    const promptIds = overrides.promptIds || ['prompt-a', 'prompt-b'];
    const messageOverrides = { ...overrides };
    delete messageOverrides.promptIds;
    delete messageOverrides.marker;
    return {
        type: 'prompt-command-result',
        version: 1,
        authoritySequence: overrides.authoritySequence || Math.max(2, revision + 1),
        requestId: request.requestId,
        target: request.target,
        operation: request.operation,
        success: true,
        snapshot: snapshotAt(revision, {
            prompts: promptIds.map((id, index) => ({
                id,
                name: `Prompt ${index + 1}`,
                text: `Body ${index + 1}`,
            })),
        }),
        html: surfaceHtml(revision, promptIds, overrides.marker || ''),
        ...messageOverrides,
    };
}

function eventFor(target, overrides = {}) {
    return {
        target,
        preventDefault() {},
        stopPropagation() {},
        ...overrides,
    };
}

test('WEBVIEW-AI-PROMPT-MUTATION-001 keeps pending until matching authoritative HTML is applied', () => {
    const harness = createPromptHarness();
    harness.controller.dispatch('create', { name: 'Review', text: 'Review this.' });
    const pending = harness.controller.getState().pending;
    assert.equal(pending.size, 1);
    assert.equal(harness.root.innerHTML, harness.initialHtml);

    const request = harness.messages[0];
    assert.equal(harness.controller.applyCommandResult(resultFor(request, 1, {
        marker: '<span>saved</span>',
    })), true);

    assert.match(harness.root.innerHTML, />saved</);
    assert.equal(harness.controller.getState().pending.size, 0);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 validates forms and posts exact create and edit strings once', () => {
    const harness = createPromptHarness();
    const create = harness.root.getForm('create');
    assert.equal(create.noValidate, true);
    harness.root.dispatch('submit', eventFor(create));
    assert.equal(harness.messages.length, 0);
    assert.match(create.errors.name.textContent, /name/i);
    assert.match(create.errors.text.textContent, /text/i);

    create.fields.name.value = '  Review  ';
    create.fields.text.value = '  Keep exact spacing.  ';
    harness.root.dispatch('input', eventFor(create.fields.name));
    harness.root.dispatch('input', eventFor(create.fields.text));
    harness.root.dispatch('submit', eventFor(create));
    assert.deepEqual(harness.messages[0].payload, {
        name: '  Review  ',
        text: '  Keep exact spacing.  ',
    });
    assert.equal(harness.messages.length, 1);

    harness.controller.applyCommandResult(resultFor(harness.messages[0], 1));
    const editButton = harness.root.getItem('prompt-a').actions[2];
    harness.root.dispatch('click', eventFor(editButton));
    const edit = harness.root.getForm('edit', 'prompt-a');
    edit.fields.name.value = 'Alpha revised';
    edit.fields.text.value = 'Revised body';
    harness.root.dispatch('input', eventFor(edit.fields.name));
    harness.root.dispatch('input', eventFor(edit.fields.text));
    harness.root.dispatch('submit', eventFor(edit));
    assert.deepEqual(harness.messages[1].payload, {
        promptId: 'prompt-a',
        name: 'Alpha revised',
        text: 'Revised body',
    });
    assert.equal(harness.messages.length, 2);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 keeps one tracked edit form across switching cancellation and refresh', () => {
    const harness = createPromptHarness();
    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-a').actions[2]));
    const editA = harness.root.getForm('edit', 'prompt-a');
    editA.fields.name.value = 'Untracked if left open';
    editA.fields.text.value = 'First local edit';
    harness.root.dispatch('input', eventFor(editA.fields.name));
    harness.root.dispatch('input', eventFor(editA.fields.text));

    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-b').actions[2]));
    let editB = harness.root.getForm('edit', 'prompt-b');
    assert.equal(editA.hidden, true);
    assert.equal(editA.fields.name.value, 'prompt-a');
    assert.equal(editA.fields.text.value, 'prompt-a body');
    assert.equal(editB.hidden, false);
    assert.equal(harness.controller.getState().draft.promptId, 'prompt-b');

    editB.fields.name.value = 'Tracked Bravo draft';
    editB.fields.text.value = 'Second local edit';
    harness.root.dispatch('input', eventFor(editB.fields.name));
    harness.root.dispatch('input', eventFor(editB.fields.text));
    harness.root.dispatch('click', eventFor(editA.cancelAction));
    assert.equal(editB.hidden, false);
    assert.equal(harness.controller.getState().draft.promptId, 'prompt-b');
    assert.equal(harness.controller.getState().draft.name, 'Tracked Bravo draft');

    assert.equal(harness.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: snapshotAt(1),
        html: surfaceHtml(1),
    }), true);
    assert.equal(harness.root.getForm('edit', 'prompt-a').hidden, true);
    editB = harness.root.getForm('edit', 'prompt-b');
    assert.equal(editB.hidden, false);
    assert.equal(editB.fields.name.value, 'Tracked Bravo draft');
    assert.equal(editB.fields.text.value, 'Second local edit');

    harness.root.dispatch('click', eventFor(editB.cancelAction));
    assert.equal(editB.hidden, true);
    assert.equal(harness.controller.getState().draft, null);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 resets singleton draft state when switching create and edit forms', () => {
    const harness = createPromptHarness();
    harness.root.dispatch('click', eventFor(harness.root.newButton));
    const create = harness.root.getForm('create');
    create.fields.name.value = 'Discarded create draft';
    create.fields.text.value = 'Discarded create body';
    harness.root.dispatch('input', eventFor(create.fields.name));
    harness.root.dispatch('input', eventFor(create.fields.text));

    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-a').actions[2]));
    const editA = harness.root.getForm('edit', 'prompt-a');
    assert.equal(create.hidden, true);
    assert.equal(create.fields.name.value, '');
    assert.equal(create.fields.text.value, '');
    assert.equal(editA.hidden, false);
    assert.equal(harness.controller.getState().draft.kind, 'edit');
    assert.equal(harness.controller.getState().draft.promptId, 'prompt-a');

    editA.fields.name.value = 'Discarded edit draft';
    harness.root.dispatch('input', eventFor(editA.fields.name));
    harness.root.dispatch('click', eventFor(harness.root.newButton));
    assert.equal(editA.hidden, true);
    assert.equal(editA.fields.name.value, 'prompt-a');
    assert.equal(create.hidden, false);
    assert.equal(create.fields.name.value, '');
    assert.equal(harness.controller.getState().draft.kind, 'create');
    assert.equal(harness.controller.getState().draft.name, '');

    harness.root.dispatch('click', eventFor(editA.cancelAction));
    assert.equal(create.hidden, false);
    assert.equal(harness.controller.getState().draft.kind, 'create');
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 sends set, replace, clear, delete, and exact reorder intent', () => {
    const actions = [
        ['prompt-a', false, { promptId: 'prompt-a' }],
        ['prompt-b', false, { promptId: 'prompt-b' }],
        ['prompt-a', true, { promptId: null }],
    ];
    for (const [promptId, selected, payload] of actions) {
        const harness = createPromptHarness();
        const target = harness.root.getItem(promptId).actions[1];
        target.setAttribute('aria-pressed', selected ? 'true' : 'false');
        harness.root.dispatch('click', eventFor(target));
        assert.equal(harness.messages[0].operation, 'select-default');
        assert.deepEqual(harness.messages[0].payload, payload);
    }

    const deleted = createPromptHarness();
    deleted.root.dispatch('click', eventFor(deleted.root.getItem('prompt-b').actions[3]));
    assert.equal(deleted.messages[0].operation, 'delete');
    assert.deepEqual(deleted.messages[0].payload, { promptId: 'prompt-b' });

    const reordered = createPromptHarness();
    const handle = reordered.root.getItem('prompt-b').actions[0];
    reordered.root.dispatch('dragstart', eventFor(handle, {
        dataTransfer: { effectAllowed: '', setData() {} },
    }));
    reordered.root.dispatch('dragover', eventFor(reordered.root.getItem('prompt-a')));
    reordered.root.dispatch('drop', eventFor(reordered.root.list));
    assert.equal(reordered.messages[0].operation, 'reorder');
    assert.deepEqual(reordered.messages[0].payload, {
        promptIds: ['prompt-b', 'prompt-a'],
    });
    assert.deepEqual(
        reordered.root.items.map(item => item.getAttribute('data-prompt-id')),
        ['prompt-a', 'prompt-b'],
        'drag preview must return to authoritative order while the Host mutation is pending'
    );

    const rejected = createPromptHarness();
    rejected.root.dispatch('dragstart', eventFor(rejected.root.getItem('prompt-a')));
    rejected.root.dispatch('drop', eventFor(rejected.root.list));
    assert.equal(rejected.messages.length, 0);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 locks one mutation and ignores rapid later intent', () => {
    const harness = createPromptHarness();
    const firstControl = harness.root.controls[0];
    harness.controller.dispatch('create', { name: 'First', text: 'First body' });
    assert.equal(firstControl.disabled, true);
    assert.equal(harness.controller.dispatch('delete', { promptId: 'prompt-a' }), false);
    assert.equal(harness.messages.length, 1);
    assert.match(harness.root.status.textContent, /in progress/i);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 retains failed drafts and locks conflicts until reopen', () => {
    const harness = createPromptHarness();
    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-a').actions[2]));
    let edit = harness.root.getForm('edit', 'prompt-a');
    edit.fields.name.value = 'Draft name';
    edit.fields.text.value = 'Private draft body';
    harness.root.dispatch('input', eventFor(edit.fields.name));
    harness.root.dispatch('input', eventFor(edit.fields.text));
    harness.root.dispatch('submit', eventFor(edit));
    const request = harness.messages[0];
    harness.controller.applyCommandResult(resultFor(request, 0, {
        success: false,
        errorCode: 'conflict',
    }));

    assert.deepEqual(JSON.parse(JSON.stringify(harness.controller.getState().draft)), {
        kind: 'edit',
        promptId: 'prompt-a',
        name: 'Draft name',
        text: 'Private draft body',
    });
    assert.equal(harness.controller.getState().blockedDraft, true);
    edit = harness.root.getForm('edit', 'prompt-a');
    harness.root.dispatch('submit', eventFor(edit));
    assert.equal(harness.messages.length, 1);

    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-a').actions[2]));
    assert.equal(harness.controller.getState().blockedDraft, false);
    edit = harness.root.getForm('edit', 'prompt-a');
    assert.equal(edit.fields.name.value, 'Draft name');
    assert.equal(edit.fields.text.value, 'Private draft body');
    harness.root.dispatch('submit', eventFor(edit));
    assert.equal(harness.messages.length, 2);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 rejects stale, duplicate, unrelated, and out-of-order settlements', () => {
    const harness = createPromptHarness({ revision: 2, initialHtml: surfaceHtml(2) });
    harness.controller.dispatch('create', { name: 'Review', text: 'Body' });
    const first = harness.messages[0];
    const wrong = resultFor(first, 3, { requestId: 'wrong-request' });
    assert.equal(harness.controller.applyCommandResult(wrong), false);
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 3, {
        target: 'another-library',
    })), false);
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 3, {
        operation: 'delete',
    })), false);
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 1, {
        authoritySequence: 1,
    })), false);
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 3, {
        html: surfaceHtml(4),
    })), false);
    assert.equal(harness.controller.getState().pending.size, 1);

    assert.equal(harness.controller.applyCommandResult(resultFor(first, 3)), true);
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 3)), false);
    harness.controller.dispatch('delete', { promptId: 'prompt-b' });
    const second = harness.messages[1];
    assert.equal(harness.controller.applyCommandResult(resultFor(first, 4)), false);
    assert.equal(harness.controller.getState().pending.size, 1);
    assert.equal(harness.controller.applyCommandResult(resultFor(second, 4)), true);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 accepts newer Host authority after persisted revision rollback and rejects older authority', () => {
    const withoutPending = createPromptHarness({
        revision: 5,
        initialHtml: surfaceHtml(5),
        authoritySequence: 10,
    });
    assert.equal(withoutPending.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 10,
        target: 'global-prompt-library',
        snapshot: snapshotAt(6),
        html: surfaceHtml(6),
    }), false);
    assert.equal(withoutPending.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 11,
        target: 'global-prompt-library',
        snapshot: snapshotAt(3),
        html: surfaceHtml(3, ['prompt-a', 'prompt-b'], '<span>rolled back</span>'),
    }), true);
    assert.equal(withoutPending.controller.getState().snapshot.revision, 3);
    assert.match(withoutPending.root.innerHTML, /rolled back/);
    assert.equal(withoutPending.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 10,
        target: 'global-prompt-library',
        snapshot: snapshotAt(6),
        html: surfaceHtml(6, ['prompt-a', 'prompt-b'], '<span>stale authority</span>'),
    }), false);
    assert.equal(withoutPending.controller.getState().snapshot.revision, 3);
    assert.doesNotMatch(withoutPending.root.innerHTML, /stale authority/);

    const withPending = createPromptHarness({
        revision: 5,
        initialHtml: surfaceHtml(5),
        authoritySequence: 20,
    });
    withPending.controller.dispatch('select-default', { promptId: 'prompt-a' });
    const request = withPending.messages[0];
    assert.equal(withPending.controller.applyCommandResult(resultFor(request, 3, {
        authoritySequence: 21,
        success: false,
        errorCode: 'conflict',
        marker: '<span>matching rollback</span>',
    })), true);
    assert.equal(withPending.controller.getState().pending.size, 0);
    assert.equal(withPending.controller.getState().snapshot.revision, 3);
    assert.match(withPending.root.innerHTML, /matching rollback/);
    assert.equal(withPending.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 20,
        target: 'global-prompt-library',
        snapshot: snapshotAt(7),
        html: surfaceHtml(7),
    }), false);
    assert.equal(withPending.controller.getState().snapshot.revision, 3);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 settles matching nonzero recovery without weakening stale rejection', () => {
    const harness = createPromptHarness({
        revision: 7,
        initialHtml: surfaceHtml(7),
    });
    harness.controller.dispatch('create', { name: 'Review', text: 'Private body' });
    const request = harness.messages[0];
    const recovery = {
        type: 'prompt-command-result',
        version: 1,
        authoritySequence: 2,
        requestId: request.requestId,
        target: request.target,
        operation: request.operation,
        success: false,
        errorCode: 'storage',
        snapshot: {
            version: 1,
            revision: 7,
            selectedPromptId: null,
            prompts: [],
            readOnlyReason: 'invalid-data',
        },
        html: `<div data-prompt-surface data-prompt-revision="7" data-prompt-recovery>
            <div data-prompt-status role="status" aria-live="polite"></div>
        </div>`,
    };

    assert.equal(harness.controller.applyCommandResult({
        ...recovery,
        authoritySequence: 1,
        snapshot: { ...recovery.snapshot, revision: 6 },
        html: recovery.html.replace('revision="7"', 'revision="6"'),
    }), false);
    assert.equal(harness.controller.getState().pending.size, 1);
    assert.equal(harness.controller.applyCommandResult(recovery), true);
    assert.equal(harness.controller.getState().pending.size, 0);
    assert.match(harness.root.innerHTML, /data-prompt-recovery/);
    assert.equal(harness.controller.getState().snapshot.revision, 7);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 retains only the newest external refresh until settlement', () => {
    const harness = createPromptHarness();
    harness.controller.dispatch('create', { name: 'Review', text: 'Body' });
    const request = harness.messages[0];
    assert.equal(harness.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 3,
        target: 'global-prompt-library',
        snapshot: snapshotAt(2),
        html: surfaceHtml(2, ['prompt-a', 'prompt-b'], '<span>older refresh</span>'),
    }), true);
    assert.equal(harness.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 4,
        target: 'global-prompt-library',
        snapshot: snapshotAt(3),
        html: surfaceHtml(3, ['prompt-a', 'prompt-b'], '<span>newest refresh</span>'),
    }), true);
    assert.equal(harness.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 5,
        target: 'global-prompt-library',
        snapshot: snapshotAt(4),
        html: surfaceHtml(5, ['prompt-a', 'prompt-b'], '<span>malformed refresh</span>'),
    }), false);
    assert.equal(harness.root.innerHTML, harness.initialHtml);

    harness.controller.applyCommandResult(resultFor(request, 1, {
        authoritySequence: 2,
    }));
    assert.match(harness.root.innerHTML, /newest refresh/);
    assert.equal(harness.controller.getState().snapshot.revision, 3);
    assert.equal(harness.controller.getState().pending.size, 0);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 keeps an unsaved draft local across an external refresh', () => {
    const harness = createPromptHarness();
    harness.root.dispatch('click', eventFor(harness.root.getItem('prompt-a').actions[2]));
    let edit = harness.root.getForm('edit', 'prompt-a');
    edit.fields.name.value = 'Local draft';
    edit.fields.text.value = 'Unsaved local body';
    harness.root.dispatch('input', eventFor(edit.fields.name));
    harness.root.dispatch('input', eventFor(edit.fields.text));

    assert.equal(harness.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: snapshotAt(1),
        html: surfaceHtml(1),
    }), true);

    edit = harness.root.getForm('edit', 'prompt-a');
    assert.equal(edit.hidden, false);
    assert.equal(edit.fields.name.value, 'Local draft');
    assert.equal(edit.fields.text.value, 'Unsaved local body');
    assert.equal(harness.messages.length, 0);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 restores list scroll and semantic Prompt action focus', () => {
    const harness = createPromptHarness();
    const focused = harness.root.getItem('prompt-b').actions[2];
    harness.document.activeElement = focused;
    harness.root.list.scrollTop = 73;
    harness.controller.dispatch('select-default', { promptId: 'prompt-a' });
    const request = harness.messages[0];
    harness.controller.applyCommandResult(resultFor(request, 1));

    assert.equal(harness.root.list.scrollTop, 73);
    const restored = harness.document.activeElement;
    assert.equal(restored.getAttribute('data-prompt-id'), 'prompt-b');
    assert.equal(restored.getAttribute('data-action'), 'prompt-edit');
    assert.notEqual(restored, focused);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 restores the real viewport and semantic create edit and New focus', () => {
    const createField = createPromptHarness();
    createField.root.dispatch('click', eventFor(createField.root.newButton));
    let form = createField.root.getForm('create');
    form.fields.name.value = 'Local create';
    form.fields.text.value = 'Local create body';
    createField.root.dispatch('input', eventFor(form.fields.name));
    createField.root.dispatch('input', eventFor(form.fields.text));
    createField.document.activeElement = form.fields.text;
    createField.context.window.scrollY = 91;
    createField.controller.dispatch('create', {
        name: form.fields.name.value,
        text: form.fields.text.value,
    });
    assert.equal(createField.controller.applyCommandResult(resultFor(
        createField.messages[0],
        0,
        { success: false, errorCode: 'storage' }
    )), true);
    form = createField.root.getForm('create');
    assert.equal(createField.document.activeElement, form.fields.text);
    assert.equal(createField.context.window.scrollY, 91);

    const createAction = createPromptHarness();
    createAction.root.dispatch('click', eventFor(createAction.root.newButton));
    form = createAction.root.getForm('create');
    createAction.document.activeElement = form.submitAction;
    createAction.context.window.scrollY = 83;
    createAction.controller.dispatch('create', { name: 'Create', text: 'Body' });
    createAction.controller.applyCommandResult(resultFor(
        createAction.messages[0],
        0,
        { success: false, errorCode: 'storage' }
    ));
    form = createAction.root.getForm('create');
    assert.equal(createAction.document.activeElement, form.submitAction);
    assert.equal(createAction.context.window.scrollY, 83);

    const editField = createPromptHarness();
    editField.root.dispatch('click', eventFor(editField.root.getItem('prompt-a').actions[2]));
    form = editField.root.getForm('edit', 'prompt-a');
    editField.document.activeElement = form.fields.name;
    editField.context.window.scrollY = 77;
    editField.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: snapshotAt(1),
        html: surfaceHtml(1),
    });
    form = editField.root.getForm('edit', 'prompt-a');
    assert.equal(editField.document.activeElement, form.fields.name);
    assert.equal(editField.context.window.scrollY, 77);

    const editAction = createPromptHarness();
    editAction.root.dispatch('click', eventFor(editAction.root.getItem('prompt-a').actions[2]));
    form = editAction.root.getForm('edit', 'prompt-a');
    editAction.document.activeElement = form.cancelAction;
    editAction.context.window.scrollY = 69;
    editAction.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: snapshotAt(1),
        html: surfaceHtml(1),
    });
    form = editAction.root.getForm('edit', 'prompt-a');
    assert.equal(editAction.document.activeElement, form.cancelAction);
    assert.equal(editAction.context.window.scrollY, 69);

    const newAction = createPromptHarness();
    newAction.document.activeElement = newAction.root.newButton;
    newAction.context.window.scrollY = 61;
    newAction.controller.applyRefresh({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: snapshotAt(1),
        html: surfaceHtml(1),
    });
    assert.equal(newAction.document.activeElement, newAction.root.newButton);
    assert.equal(newAction.context.window.scrollY, 61);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 preserves an explicit focus change while pending', () => {
    const harness = createPromptHarness();
    harness.document.activeElement = harness.root.getItem('prompt-b').actions[2];
    harness.controller.dispatch('select-default', { promptId: 'prompt-a' });
    harness.document.activeElement = harness.root.tabs[0];

    harness.controller.applyCommandResult(resultFor(harness.messages[0], 1));

    assert.equal(harness.document.activeElement, harness.root.tabs[0]);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 provides automatic roving AI subtab keyboard navigation', () => {
    const harness = createPromptHarness();
    let prevented = 0;
    harness.root.dispatch('keydown', eventFor(harness.root.tabs[0], {
        key: 'ArrowRight',
        preventDefault() { prevented += 1; },
    }));
    assert.equal(harness.controller.getState().activeSubtab, 'skills');
    assert.equal(harness.root.tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(harness.root.panels[1].hidden, false);
    assert.equal(harness.document.activeElement, harness.root.tabs[1]);

    harness.root.dispatch('keydown', eventFor(harness.root.tabs[1], {
        key: 'End',
        preventDefault() { prevented += 1; },
    }));
    assert.equal(harness.controller.getState().activeSubtab, 'hooks');
    harness.root.dispatch('keydown', eventFor(harness.root.tabs[3], {
        key: 'Home',
        preventDefault() { prevented += 1; },
    }));
    assert.equal(harness.controller.getState().activeSubtab, 'prompts');
    assert.equal(prevented, 3);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 bounds settled identities and announces mapped outcomes without bodies', () => {
    const harness = createPromptHarness();
    for (let revision = 1; revision <= 105; revision += 1) {
        harness.controller.dispatch('select-default', { promptId: 'prompt-a' });
        const request = harness.messages.at(-1);
        harness.controller.applyCommandResult(resultFor(request, revision));
    }
    assert.equal(harness.controller.getState().settled.size, 100);
    assert.match(harness.root.status.textContent, /default/i);
    assert.doesNotMatch(harness.root.status.textContent, /Body 1|First body/);

    harness.controller.dispatch('delete', { promptId: 'prompt-a' });
    const request = harness.messages.at(-1);
    harness.send(resultFor(request, 105, {
        authoritySequence: 107,
        success: false,
        errorCode: 'cancelled',
    }));
    assert.match(harness.root.status.textContent, /cancelled/i);
});
