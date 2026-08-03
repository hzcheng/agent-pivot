var PROMPT_VERSION = 1;

var PROMPT_TARGET = 'global-prompt-library';

var MAX_REQUEST_ID_LENGTH = 128;

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
    'settings-write-conflict',
    'unsupported-version',
    'cancelled',
]);

var INSERT_ERROR_CODES = new Set([
    'no-active-terminal',
    'prompt-unavailable',
    'prompt-not-found',
    'terminal-unavailable',
]);

function clonePromptValue(value) {
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

function insertCorrelationKey(message) {
    return [
        message.version,
        message.requestId,
        message.target,
        'insert-terminal',
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

function isPromptSnapshot(snapshot) {
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
        && isPromptSnapshot(message.snapshot)
        && typeof message.html === 'string'
        && (message.success
            ? message.errorCode === undefined
            : ERROR_CODES.has(message.errorCode));
}

function isInsertResult(message) {
    return hasExactKeys(message, [
        'type',
        'version',
        'requestId',
        'target',
        'success',
        'errorCode',
    ])
        && message.type === 'prompt-insert-terminal-result'
        && message.version === PROMPT_VERSION
        && isRequestId(message.requestId)
        && message.target === PROMPT_TARGET
        && typeof message.success === 'boolean'
        && (message.success
            ? message.errorCode === null
            : INSERT_ERROR_CODES.has(message.errorCode));
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
        && isPromptSnapshot(message.snapshot)
        && typeof message.html === 'string';
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
        return 'This Prompt library needs a newer version of Agent Pivot.';
    }
    if (code === 'settings-write-conflict') {
        return 'Save or revert User Settings, then try again. Your Prompt draft is still here.';
    }
    return 'Could not save the Prompt change. The latest saved library is shown.';
}

function insertErrorAnnouncement(code) {
    if (code === 'no-active-terminal') {
        return 'No active terminal is available to receive the Prompt.';
    }
    if (code === 'prompt-unavailable') {
        return 'AI Prompts are currently unavailable.';
    }
    if (code === 'prompt-not-found') {
        return 'That Prompt is no longer available.';
    }
    return 'The selected terminal is no longer available.';
}

function closest(target, selector) {
    return target && typeof target.closest === 'function'
        ? target.closest(selector)
        : null;
}

function setInsertPending(control, pending) {
    if (!control || typeof control.setAttribute !== 'function') {
        return;
    }
    if (pending) {
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('data-prompt-insert-pending', 'true');
    } else {
        control.removeAttribute('aria-disabled');
        control.removeAttribute('data-prompt-insert-pending');
    }
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

function readField(form, name) {
    var field = form && typeof form.querySelector === 'function'
        ? form.querySelector('[name="' + name + '"]')
        : null;
    return field ? String(field.value || '') : '';
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

function tabName(tab) {
    var id = tab && (tab.id || tab.getAttribute('id'));
    var match = typeof id === 'string' ? id.match(/^ai-tab-(prompts|skills|mcp|hooks)$/) : null;
    return match ? match[1] : null;
}
