(function () {
    'use strict';

    var PROMPT_VERSION = 1;
    var PROMPT_TARGET = 'global-prompt-library';
    var MAX_REQUEST_ID_LENGTH = 128;
    var MAX_SETTLED_KEYS = 100;
    var OPERATIONS = new Set([
        'create',
        'update',
        'delete',
        'reorder',
        'select-default',
    ]);
    var ERROR_CODES = new Set([
        'invalid',
        'not-found',
        'conflict',
        'storage',
        'unsupported-version',
        'cancelled',
    ]);
    var state = {
        snapshot: null,
        pending: new Map(),
        settled: new Set(),
        draft: null,
        blockedDraft: false,
        activeSubtab: 'prompts',
    };
    var root = null;
    var currentRevision = 0;
    var currentAuthoritySequence = 0;
    var pendingRefresh = null;
    var lockedControls = [];
    var requestSequence = 0;
    var draggedPromptId = null;
    var dragOriginList = null;
    var dragOriginNodes = [];

    function clone(value) {
        if (value === null || value === undefined) {
            return value;
        }
        return JSON.parse(JSON.stringify(value));
    }

    function correlationKey(message) {
        return [
            message.version,
            message.requestId,
            message.target,
            message.operation,
        ].join(':');
    }

    function hasExactKeys(value, requiredKeys, optionalKeys) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var allowedKeys = requiredKeys.concat(optionalKeys || []);
        var keys = Object.keys(value);
        return requiredKeys.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        }) && keys.every(function (key) {
            return allowedKeys.indexOf(key) >= 0;
        });
    }

    function isRequestId(value) {
        return typeof value === 'string'
            && value.length > 0
            && value.length <= MAX_REQUEST_ID_LENGTH;
    }

    function isAuthoritySequence(value) {
        return Number.isSafeInteger(value) && value > 0;
    }

    function isSnapshot(snapshot) {
        if (!hasExactKeys(
            snapshot,
            ['version', 'revision', 'selectedPromptId', 'prompts'],
            ['readOnlyReason']
        )
            || snapshot.version !== PROMPT_VERSION
            || !Number.isSafeInteger(snapshot.revision)
            || snapshot.revision < 0
            || (snapshot.selectedPromptId !== null
                && (typeof snapshot.selectedPromptId !== 'string'
                    || snapshot.selectedPromptId.length === 0))
            || !Array.isArray(snapshot.prompts)
            || (snapshot.readOnlyReason !== undefined
                && snapshot.readOnlyReason !== 'invalid-data'
                && snapshot.readOnlyReason !== 'unsupported-version')) {
            return false;
        }

        var ids = new Set();
        var names = new Set();
        for (var prompt of snapshot.prompts) {
            if (!hasExactKeys(prompt, ['id', 'name', 'text'])
                || typeof prompt.id !== 'string'
                || prompt.id.length === 0
                || typeof prompt.name !== 'string'
                || prompt.name.trim().length === 0
                || typeof prompt.text !== 'string'
                || prompt.text.trim().length === 0
                || ids.has(prompt.id)
                || names.has(prompt.name.toLowerCase())) {
                return false;
            }
            ids.add(prompt.id);
            names.add(prompt.name.toLowerCase());
        }
        return snapshot.selectedPromptId === null || ids.has(snapshot.selectedPromptId);
    }

    function isCommandResult(message) {
        return hasExactKeys(message, [
            'type',
            'version',
            'authoritySequence',
            'requestId',
            'target',
            'operation',
            'success',
            'snapshot',
            'html',
        ], ['errorCode'])
            && message.type === 'prompt-command-result'
            && message.version === PROMPT_VERSION
            && isAuthoritySequence(message.authoritySequence)
            && isRequestId(message.requestId)
            && message.target === PROMPT_TARGET
            && OPERATIONS.has(message.operation)
            && typeof message.success === 'boolean'
            && isSnapshot(message.snapshot)
            && typeof message.html === 'string'
            && (message.success
                ? message.errorCode === undefined
                : ERROR_CODES.has(message.errorCode));
    }

    function isRefresh(message) {
        return hasExactKeys(message, [
            'type',
            'version',
            'authoritySequence',
            'target',
            'snapshot',
            'html',
        ])
            && message.type === 'prompt-panel-updated'
            && message.version === PROMPT_VERSION
            && isAuthoritySequence(message.authoritySequence)
            && message.target === PROMPT_TARGET
            && isSnapshot(message.snapshot)
            && typeof message.html === 'string';
    }

    function getSurface() {
        return root && typeof root.querySelector === 'function'
            ? root.querySelector('[data-prompt-surface]')
            : null;
    }

    function readSurfaceRevision(surface) {
        if (!surface || typeof surface.getAttribute !== 'function') {
            return null;
        }
        var value = surface.getAttribute('data-prompt-revision');
        if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
            return null;
        }
        var revision = Number(value);
        return Number.isSafeInteger(revision) ? revision : null;
    }

    function getStatusRegion() {
        var surface = getSurface();
        return surface && typeof surface.querySelector === 'function'
            ? surface.querySelector('[data-prompt-status]')
            : null;
    }

    function getPromptForms() {
        var surface = getSurface();
        if (!surface) {
            return [];
        }
        var createForm = typeof surface.querySelector === 'function'
            ? surface.querySelector('[data-prompt-form="create"]')
            : null;
        var editForms = typeof surface.querySelectorAll === 'function'
            ? Array.from(surface.querySelectorAll('[data-prompt-form="edit"]'))
            : [];
        return [createForm].concat(editForms).filter(Boolean);
    }

    function configurePromptForms() {
        getPromptForms().forEach(function (form) {
            form.noValidate = true;
        });
    }

    function announce(message) {
        var bounded = String(message || '').slice(0, 240);
        var region = getStatusRegion();
        if (region) {
            region.textContent = bounded;
        }
    }

    function pendingAnnouncement() {
        announce('A Prompt change is already in progress. Wait for it to finish.');
    }

    function mutationAnnouncement(operation) {
        if (operation === 'create') return 'Saving new Prompt…';
        if (operation === 'update') return 'Saving Prompt changes…';
        if (operation === 'delete') return 'Waiting for Prompt deletion confirmation…';
        if (operation === 'reorder') return 'Saving Prompt order…';
        return 'Saving default Prompt…';
    }

    function successAnnouncement(operation) {
        if (operation === 'create') return 'Prompt created.';
        if (operation === 'update') return 'Prompt updated.';
        if (operation === 'delete') return 'Prompt deleted.';
        if (operation === 'reorder') return 'Prompt order saved.';
        return 'Default Prompt updated.';
    }

    function errorAnnouncement(code) {
        if (code === 'cancelled') return 'Prompt deletion was cancelled.';
        if (code === 'conflict') {
            return 'Prompts changed elsewhere. Reopen the form to review your draft.';
        }
        if (code === 'not-found') return 'That Prompt no longer exists.';
        if (code === 'invalid') return 'Check the Prompt fields and try again.';
        if (code === 'unsupported-version') {
            return 'This Prompt library needs a newer version of Project Steward.';
        }
        return 'Could not save the Prompt change. The latest saved library is shown.';
    }

    function setMutationLock(enabled) {
        var surface = getSurface();
        if (!surface) {
            lockedControls = [];
            return;
        }
        if (!enabled) {
            lockedControls.forEach(function (entry) {
                if (entry.element) {
                    entry.element.disabled = entry.disabled;
                }
            });
            lockedControls = [];
            if (typeof surface.removeAttribute === 'function') {
                surface.removeAttribute('aria-busy');
            }
            return;
        }
        lockedControls = [];
        if (typeof surface.setAttribute === 'function') {
            surface.setAttribute('aria-busy', 'true');
        }
        if (typeof surface.querySelectorAll !== 'function') {
            return;
        }
        Array.from(surface.querySelectorAll(
            'button, input, textarea, select, [data-drag-prompt-id]'
        )).forEach(function (control) {
            lockedControls.push({ element: control, disabled: control.disabled === true });
            control.disabled = true;
        });
    }

    function freshRequestId() {
        requestSequence += 1;
        var randomId = '';
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                randomId = crypto.randomUUID();
            }
        } catch (_error) {
            randomId = '';
        }
        if (!randomId) {
            randomId = Date.now().toString(36)
                + '-' + Math.random().toString(36).slice(2);
        }
        return (randomId + '-' + requestSequence.toString(36)).slice(0, MAX_REQUEST_ID_LENGTH);
    }

    function closest(target, selector) {
        return target && typeof target.closest === 'function'
            ? target.closest(selector)
            : null;
    }

    function captureSemanticFocus() {
        var active = document.activeElement;
        if (!active || !root || typeof root.contains !== 'function' || !root.contains(active)) {
            return null;
        }
        var promptElement = closest(active, '[data-prompt-id]');
        if (!promptElement) {
            return null;
        }
        var promptId = promptElement.getAttribute('data-prompt-id');
        var actionElement = closest(active, '[data-action]');
        var action = actionElement ? actionElement.getAttribute('data-action') : null;
        if (!action && closest(active, '[data-drag-prompt-id]')) {
            action = 'prompt-drag';
        }
        return promptId && action ? { promptId: promptId, action: action } : null;
    }

    function findPromptItem(promptId) {
        var surface = getSurface();
        if (!surface || typeof surface.querySelectorAll !== 'function') {
            return null;
        }
        return Array.from(surface.querySelectorAll('.prompt-item[data-prompt-id]'))
            .find(function (candidate) {
                return candidate.getAttribute('data-prompt-id') === promptId;
            }) || null;
    }

    function restoreSemanticFocus(target) {
        if (!target) {
            return;
        }
        var item = findPromptItem(target.promptId);
        if (!item) {
            return;
        }
        var action = target.action === 'prompt-drag'
            ? Array.from(item.querySelectorAll('[data-drag-prompt-id]'))
                .find(function (candidate) {
                    return candidate.getAttribute('data-drag-prompt-id') === target.promptId;
                })
            : Array.from(item.querySelectorAll('[data-action]'))
                .find(function (candidate) {
                    return candidate.getAttribute('data-action') === target.action;
                });
        if (action && typeof action.focus === 'function') {
            action.focus();
        }
    }

    function getPromptList() {
        var surface = getSurface();
        return surface && typeof surface.querySelector === 'function'
            ? surface.querySelector('[data-prompt-list]')
            : null;
    }

    function captureLocalState() {
        var list = getPromptList();
        return {
            focus: captureSemanticFocus(),
            scrollTop: list && typeof list.scrollTop === 'number' ? list.scrollTop : 0,
            draft: clone(state.draft),
            activeSubtab: state.activeSubtab,
        };
    }

    function restoreLocalState(local) {
        if (!local) {
            return;
        }
        activateSubtab(local.activeSubtab, false);
        var list = getPromptList();
        if (list) {
            list.scrollTop = local.scrollTop;
        }
        restoreSemanticFocus(local.focus);
    }

    function surfaceHtmlHasRevision(html, revision) {
        var trimmed = String(html || '').trim();
        if (!trimmed) {
            return false;
        }
        if (typeof document.createElement === 'function') {
            try {
                var template = document.createElement('template');
                template.innerHTML = trimmed;
                if (!template.content
                    || template.content.childElementCount !== 1
                    || !template.content.firstElementChild
                    || !template.content.firstElementChild.hasAttribute('data-prompt-surface')) {
                    return false;
                }
                return readSurfaceRevision(template.content.firstElementChild) === revision;
            } catch (_error) {
                return false;
            }
        }
        var opening = trimmed.match(/^<[a-zA-Z][\w:-]*\b([^>]*)>/);
        if (!opening || !/\bdata-prompt-surface(?:\s|=|>)/.test(opening[0])) {
            return false;
        }
        var revisionMatch = opening[0].match(
            /\bdata-prompt-revision\s*=\s*["'](0|[1-9]\d*)["']/
        );
        return Boolean(revisionMatch) && Number(revisionMatch[1]) === revision;
    }

    function installAuthoritative(message, local) {
        if (!surfaceHtmlHasRevision(message.html, message.snapshot.revision)) {
            return false;
        }
        var surface = getSurface();
        if (!surface || !Object.prototype.hasOwnProperty.call(surface, 'outerHTML')
            && !('outerHTML' in surface)) {
            return false;
        }
        try {
            surface.outerHTML = message.html;
        } catch (_error) {
            return false;
        }
        var installed = getSurface();
        if (readSurfaceRevision(installed) !== message.snapshot.revision) {
            return false;
        }
        currentRevision = message.snapshot.revision;
        currentAuthoritySequence = message.authoritySequence;
        state.snapshot = clone(message.snapshot);
        lockedControls = [];
        configurePromptForms();
        restoreLocalState(local);
        return true;
    }

    function recordSettled(key) {
        state.settled.add(key);
        while (state.settled.size > MAX_SETTLED_KEYS) {
            state.settled.delete(state.settled.values().next().value);
        }
    }

    function findEditForm(promptId) {
        var surface = getSurface();
        if (!surface || typeof surface.querySelectorAll !== 'function') {
            return null;
        }
        return Array.from(surface.querySelectorAll('[data-prompt-form="edit"]'))
            .find(function (form) {
                return form.getAttribute('data-prompt-id') === promptId;
            }) || null;
    }

    function readField(form, name) {
        var field = form && typeof form.querySelector === 'function'
            ? form.querySelector('[name="' + name + '"]')
            : null;
        return field ? String(field.value || '') : '';
    }

    function applyDraft(draft) {
        if (!draft) {
            return false;
        }
        var form = draft.kind === 'create'
            ? getSurface().querySelector('[data-prompt-form="create"]')
            : findEditForm(draft.promptId);
        if (!form) {
            return false;
        }
        getPromptForms().forEach(function (candidate) {
            if (candidate !== form) {
                resetPromptForm(candidate);
            }
        });
        form.hidden = false;
        var name = form.querySelector('[name="name"]');
        var text = form.querySelector('[name="text"]');
        if (name) name.value = draft.name;
        if (text) text.value = draft.text;
        return true;
    }

    function resetPromptForm(form) {
        if (!form) {
            return;
        }
        if (typeof form.reset === 'function') {
            form.reset();
        }
        clearFieldError(form, 'name');
        clearFieldError(form, 'text');
        form.hidden = true;
    }

    function resetOpenDraft() {
        getPromptForms().forEach(resetPromptForm);
        state.draft = null;
        state.blockedDraft = false;
    }

    function formMatchesDraft(form, draft) {
        if (!form || !draft) {
            return false;
        }
        var kind = form.getAttribute('data-prompt-form');
        if (kind !== draft.kind) {
            return false;
        }
        return kind === 'create'
            || form.getAttribute('data-prompt-id') === draft.promptId;
    }

    function applyQueuedRefresh() {
        var refresh = pendingRefresh;
        pendingRefresh = null;
        if (!refresh || refresh.authoritySequence <= currentAuthoritySequence) {
            return false;
        }
        return installAuthoritative(refresh, captureLocalState());
    }

    function dispatch(operation, payload) {
        if (!OPERATIONS.has(operation)
            || !payload
            || typeof payload !== 'object'
            || Array.isArray(payload)
            || !Number.isSafeInteger(currentRevision)
            || currentRevision < 0) {
            return false;
        }
        if (state.pending.size > 0) {
            pendingAnnouncement();
            return false;
        }
        if (state.blockedDraft) {
            announce('Reopen the Prompt form before trying to save this draft.');
            return false;
        }
        if (!window.vscode || typeof window.vscode.postMessage !== 'function') {
            announce('Could not send the Prompt change. Reload the Dashboard and try again.');
            return false;
        }

        var message = {
            type: 'prompt-command',
            version: PROMPT_VERSION,
            requestId: freshRequestId(),
            target: PROMPT_TARGET,
            expectedRevision: currentRevision,
            operation: operation,
            payload: clone(payload),
        };
        var key = correlationKey(message);
        var local = captureLocalState();
        state.pending.set(key, {
            version: message.version,
            requestId: message.requestId,
            target: message.target,
            expectedRevision: message.expectedRevision,
            operation: message.operation,
            payload: clone(message.payload),
            draft: local.draft,
            focus: local.focus,
            scrollTop: local.scrollTop,
            activeSubtab: local.activeSubtab,
        });
        setMutationLock(true);
        announce(mutationAnnouncement(operation));
        try {
            window.vscode.postMessage(message);
        } catch (_error) {
            state.pending.delete(key);
            setMutationLock(false);
            announce('Could not send the Prompt change. Reload the Dashboard and try again.');
            return false;
        }
        return message.requestId;
    }

    function applyCommandResult(message) {
        if (!isCommandResult(message)) {
            return false;
        }
        var key = correlationKey(message);
        if (state.settled.has(key)) {
            return false;
        }
        var pending = state.pending.get(key);
        if (!pending
            || message.authoritySequence <= currentAuthoritySequence) {
            return false;
        }

        var local = captureLocalState();
        if (!local.focus
            && pending.focus
            && (!document.activeElement || document.activeElement === document.body)
            && local.activeSubtab === pending.activeSubtab) {
            local.focus = clone(pending.focus);
        }
        if (!installAuthoritative(message, local)) {
            setMutationLock(true);
            return false;
        }

        state.pending.delete(key);
        recordSettled(key);
        if (message.success) {
            state.blockedDraft = false;
            state.draft = message.operation === 'create' || message.operation === 'update'
                ? null
                : local.draft;
        } else {
            state.draft = clone(pending.draft || local.draft);
            state.blockedDraft = message.errorCode === 'conflict' && Boolean(state.draft);
        }
        setMutationLock(false);
        if (state.draft) {
            applyDraft(state.draft);
        }
        applyQueuedRefresh();
        if (state.draft) {
            applyDraft(state.draft);
        }
        announce(message.success
            ? successAnnouncement(message.operation)
            : errorAnnouncement(message.errorCode));
        return true;
    }

    function applyRefresh(message) {
        if (!isRefresh(message)
            || message.authoritySequence <= currentAuthoritySequence
            || !surfaceHtmlHasRevision(message.html, message.snapshot.revision)) {
            return false;
        }
        if (state.pending.size > 0) {
            if (pendingRefresh
                && message.authoritySequence <= pendingRefresh.authoritySequence) {
                return false;
            }
            pendingRefresh = {
                type: message.type,
                version: message.version,
                authoritySequence: message.authoritySequence,
                target: message.target,
                snapshot: clone(message.snapshot),
                html: message.html,
            };
            return true;
        }
        var applied = installAuthoritative(message, captureLocalState());
        if (applied && state.draft) {
            applyDraft(state.draft);
        }
        return applied;
    }

    function clearFieldError(form, name) {
        var error = form.querySelector('[data-prompt-field-error="' + name + '"]');
        var field = form.querySelector('[name="' + name + '"]');
        if (error) error.textContent = '';
        if (field && typeof field.removeAttribute === 'function') {
            field.removeAttribute('aria-invalid');
        }
    }

    function setFieldError(form, name, message) {
        var error = form.querySelector('[data-prompt-field-error="' + name + '"]');
        var field = form.querySelector('[name="' + name + '"]');
        if (error) error.textContent = message;
        if (field && typeof field.setAttribute === 'function') {
            field.setAttribute('aria-invalid', 'true');
        }
    }

    function submitForm(form) {
        var kind = form.getAttribute('data-prompt-form');
        if (kind !== 'create' && kind !== 'edit') {
            return false;
        }
        if (state.blockedDraft) {
            announce('Reopen the Prompt form before trying to save this draft.');
            return false;
        }
        var name = readField(form, 'name');
        var text = readField(form, 'text');
        clearFieldError(form, 'name');
        clearFieldError(form, 'text');
        var valid = true;
        if (!name.trim()) {
            setFieldError(form, 'name', 'Enter a Prompt name.');
            valid = false;
        }
        if (!text.trim()) {
            setFieldError(form, 'text', 'Enter Prompt text.');
            valid = false;
        }
        if (!valid) {
            announce('Enter a Prompt name and Prompt text.');
            return false;
        }
        state.draft = {
            kind: kind,
            promptId: kind === 'edit' ? form.getAttribute('data-prompt-id') : null,
            name: name,
            text: text,
        };
        return kind === 'create'
            ? dispatch('create', { name: name, text: text })
            : dispatch('update', {
                promptId: state.draft.promptId,
                name: name,
                text: text,
            });
    }

    function showCreateForm() {
        var surface = getSurface();
        var form = surface && surface.querySelector('[data-prompt-form="create"]');
        if (!form) {
            return false;
        }
        var retained = state.blockedDraft && state.draft && state.draft.kind === 'create'
            ? clone(state.draft)
            : { kind: 'create', promptId: null, name: '', text: '' };
        resetOpenDraft();
        state.draft = retained;
        applyDraft(retained);
        var name = form.querySelector('[name="name"]');
        if (name && typeof name.focus === 'function') name.focus();
        return true;
    }

    function showEditForm(promptId) {
        var form = findEditForm(promptId);
        if (!form) {
            return false;
        }
        var retained = state.blockedDraft
            && state.draft
            && state.draft.kind === 'edit'
            && state.draft.promptId === promptId
            ? clone(state.draft)
            : null;
        resetOpenDraft();
        retained = retained || {
            kind: 'edit',
            promptId: promptId,
            name: readField(form, 'name'),
            text: readField(form, 'text'),
        };
        state.draft = retained;
        applyDraft(retained);
        var name = form.querySelector('[name="name"]');
        if (name && typeof name.focus === 'function') name.focus();
        return true;
    }

    function closeDraft(form) {
        if (!formMatchesDraft(form, state.draft)) {
            return false;
        }
        resetPromptForm(form);
        state.draft = null;
        state.blockedDraft = false;
        return true;
    }

    function onClick(event) {
        var tab = closest(event.target, '[role="tab"]');
        if (tab) {
            activateSubtab(tabName(tab), true);
            return;
        }
        var actionTarget = closest(event.target, '[data-action]');
        if (!actionTarget) {
            return;
        }
        var action = actionTarget.getAttribute('data-action');
        var promptId = actionTarget.getAttribute('data-prompt-id');
        if (action === 'prompt-new') {
            showCreateForm();
        } else if (action === 'prompt-cancel-create') {
            closeDraft(closest(actionTarget, '[data-prompt-form]'));
        } else if (action === 'prompt-edit') {
            showEditForm(promptId);
        } else if (action === 'prompt-cancel-edit') {
            closeDraft(closest(actionTarget, '[data-prompt-form]'));
        } else if (action === 'prompt-delete') {
            dispatch('delete', { promptId: promptId });
        } else if (action === 'prompt-select-default') {
            dispatch('select-default', {
                promptId: actionTarget.getAttribute('aria-pressed') === 'true'
                    ? null
                    : promptId,
            });
        }
    }

    function onSubmit(event) {
        var form = closest(event.target, '[data-prompt-form]');
        if (!form) {
            return;
        }
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        submitForm(form);
    }

    function onInput(event) {
        var field = event.target;
        var form = closest(field, '[data-prompt-form]');
        if (!form || !state.draft) {
            return;
        }
        var name = field.getAttribute && field.getAttribute('name');
        if (name !== 'name' && name !== 'text') {
            return;
        }
        var kind = form.getAttribute('data-prompt-form');
        var promptId = form.getAttribute('data-prompt-id');
        if (state.draft.kind !== kind
            || (kind === 'edit' && state.draft.promptId !== promptId)) {
            return;
        }
        state.draft[name] = String(field.value || '');
        clearFieldError(form, name);
    }

    function tabName(tab) {
        var id = tab && (tab.id || tab.getAttribute('id'));
        var match = typeof id === 'string' ? id.match(/^ai-tab-(prompts|skills|mcp|hooks)$/) : null;
        return match ? match[1] : null;
    }

    function activateSubtab(name, focus) {
        if (!root || ['prompts', 'skills', 'mcp', 'hooks'].indexOf(name) < 0) {
            return false;
        }
        var tabs = typeof root.querySelectorAll === 'function'
            ? Array.from(root.querySelectorAll('[role="tab"]'))
            : [];
        var panels = typeof root.querySelectorAll === 'function'
            ? Array.from(root.querySelectorAll('[role="tabpanel"]'))
            : [];
        var selected = null;
        tabs.forEach(function (tab) {
            var active = tabName(tab) === name;
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.setAttribute('tabindex', active ? '0' : '-1');
            if (active) selected = tab;
        });
        panels.forEach(function (panel) {
            panel.hidden = panel.id !== 'ai-panel-' + name;
        });
        state.activeSubtab = name;
        if (focus && selected && typeof selected.focus === 'function') {
            selected.focus();
        }
        return Boolean(selected);
    }

    function onKeyDown(event) {
        var tab = closest(event.target, '[role="tab"]');
        if (!tab) {
            return;
        }
        var tabs = Array.from(root.querySelectorAll('[role="tab"]'));
        var index = tabs.indexOf(tab);
        var next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        activateSubtab(tabName(tabs[next]), true);
    }

    function onDragStart(event) {
        var handle = closest(event.target, '[data-drag-prompt-id]');
        if (!handle || handle.disabled === true || state.pending.size > 0) {
            draggedPromptId = null;
            return;
        }
        draggedPromptId = handle.getAttribute('data-drag-prompt-id');
        dragOriginList = getPromptList();
        dragOriginNodes = dragOriginList && typeof dragOriginList.querySelectorAll === 'function'
            ? Array.from(dragOriginList.querySelectorAll(':scope > [data-prompt-id]'))
            : [];
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            try {
                event.dataTransfer.setData('text/plain', '');
            } catch (_error) {
                // Some Webview engines restrict synthetic drag data.
            }
        }
    }

    function onDragOver(event) {
        if (!draggedPromptId) {
            return;
        }
        event.preventDefault();
        var targetElement = closest(event.target, '[data-prompt-id]');
        var targetPromptId = targetElement && targetElement.getAttribute('data-prompt-id');
        var draggedItem = findPromptItem(draggedPromptId);
        var targetItem = targetPromptId ? findPromptItem(targetPromptId) : null;
        var list = getPromptList();
        if (!list
            || !draggedItem
            || !targetItem
            || draggedItem === targetItem
            || typeof list.insertBefore !== 'function') {
            return;
        }
        var insertAfter = false;
        if (typeof targetItem.getBoundingClientRect === 'function'
            && typeof event.clientY === 'number') {
            var bounds = targetItem.getBoundingClientRect();
            insertAfter = event.clientY > bounds.top + bounds.height / 2;
        }
        list.insertBefore(draggedItem, insertAfter ? targetItem.nextSibling : targetItem);
    }

    function onDrop(event) {
        if (!draggedPromptId) {
            return;
        }
        event.preventDefault();
        var list = getPromptList();
        var items = list && typeof list.querySelectorAll === 'function'
            ? Array.from(list.querySelectorAll(':scope > [data-prompt-id]'))
            : [];
        var promptIds = items.map(function (item) {
            return item.getAttribute('data-prompt-id');
        });
        restoreDragOrigin();
        if (promptIds.length === 0
            || promptIds.some(function (promptId) { return !promptId; })
            || new Set(promptIds).size !== promptIds.length) {
            announce('Could not save Prompt order. Reload the Dashboard and try again.');
            return;
        }
        dispatch('reorder', { promptIds: promptIds });
    }

    function restoreDragOrigin() {
        if (dragOriginList
            && dragOriginList === getPromptList()
            && typeof dragOriginList.appendChild === 'function') {
            dragOriginNodes.forEach(function (item) {
                if (item.parentElement === dragOriginList) {
                    dragOriginList.appendChild(item);
                }
            });
        }
        draggedPromptId = null;
        dragOriginList = null;
        dragOriginNodes = [];
    }

    function onDragEnd() {
        restoreDragOrigin();
    }

    function onWindowMessage(event) {
        if (event && event.data && event.data.type === 'prompt-command-result') {
            applyCommandResult(event.data);
        }
    }

    function mount(nextRoot, initialAuthority) {
        if (!nextRoot
            || typeof nextRoot.querySelector !== 'function'
            || !initialAuthority
            || !isAuthoritySequence(initialAuthority.authoritySequence)
            || initialAuthority.authoritySequence <= currentAuthoritySequence
            || !isSnapshot(initialAuthority.snapshot)) {
            return false;
        }
        var surface = nextRoot.querySelector('[data-prompt-surface]');
        var revision = readSurfaceRevision(surface);
        if (revision === null || revision !== initialAuthority.snapshot.revision) {
            return false;
        }
        root = nextRoot;
        currentAuthoritySequence = initialAuthority.authoritySequence;
        currentRevision = revision;
        state.snapshot = clone(initialAuthority.snapshot);
        configurePromptForms();
        var selectedTab = typeof root.querySelectorAll === 'function'
            ? Array.from(root.querySelectorAll('[role="tab"]')).find(function (tab) {
                return tab.getAttribute('aria-selected') === 'true';
            })
            : null;
        state.activeSubtab = tabName(selectedTab) || state.activeSubtab;
        if (!root.__projectStewardPromptsMounted) {
            root.__projectStewardPromptsMounted = true;
            root.addEventListener('click', onClick);
            root.addEventListener('submit', onSubmit);
            root.addEventListener('input', onInput);
            root.addEventListener('keydown', onKeyDown);
            root.addEventListener('dragstart', onDragStart);
            root.addEventListener('dragover', onDragOver);
            root.addEventListener('drop', onDrop);
            root.addEventListener('dragend', onDragEnd);
        }
        return true;
    }

    window.addEventListener('message', onWindowMessage);
    window.__projectStewardPrompts = {
        mount: mount,
        dispatch: dispatch,
        applyCommandResult: applyCommandResult,
        applyRefresh: applyRefresh,
        getState: function () { return state; },
    };
})();
