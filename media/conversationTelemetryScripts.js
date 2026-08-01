(function () {
    'use strict';

    function create(options) {
        var commentTarget = options.target;
        var subscriptionGeneration = options.subscriptionGeneration;
        var latestRequestId = options.latestRequestId;
        var telemetryRoot = options.telemetryRoot;
        var telemetryModel = options.telemetryModel;
        var telemetryModelValue = options.telemetryModelValue;
        var telemetryContext = options.telemetryContext;
        var telemetryContextProgress = options.telemetryContextProgress;
        var telemetryContextValue = options.telemetryContextValue;
        var telemetryLimits = options.telemetryLimits;
        var telemetryWorktree = options.telemetryWorktree;
        var telemetryWorktreeBranch = options.telemetryWorktreeBranch;
        var scroll = options.scroll;
        var captureAnchor = options.captureAnchor;
        var restoreViewport = options.restoreViewport;
        var state = {
            latestTelemetryRequestId: 0,
        };

        function exactKeys(value, required, optional) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            var keys = Object.keys(value);
            var allowed = new Set(required.concat(optional || []));
            return required.every(function (key) {
                return Object.prototype.hasOwnProperty.call(value, key);
            }) && keys.every(function (key) {
                return allowed.has(key);
            });
        }

        function validTelemetry(value) {
            if (!exactKeys(
                value,
                ['provider', 'sessionId', 'rateLimits'],
                ['model', 'context', 'worktree']
            )) return false;
            if (!['codex', 'kimi', 'claude'].includes(value.provider)
                || typeof value.sessionId !== 'string'
                || !value.sessionId
                || value.sessionId.length > 256
                || (value.model !== undefined
                    && (typeof value.model !== 'string'
                        || !value.model
                        || value.model.length > 128))
                || !Array.isArray(value.rateLimits)
                || value.rateLimits.length > 4) {
                return false;
            }
            if (value.context !== undefined
                && (!exactKeys(value.context, ['usedTokens', 'maxTokens'])
                    || !Number.isSafeInteger(value.context.usedTokens)
                    || value.context.usedTokens < 0
                    || !Number.isSafeInteger(value.context.maxTokens)
                    || value.context.maxTokens <= 0)) {
                return false;
            }
            if (value.worktree !== undefined
                && (!exactKeys(
                    value.worktree,
                    ['branch', 'worktreeRoot', 'repoRoot'],
                    ['missing']
                )
                    || typeof value.worktree.branch !== 'string'
                    || !value.worktree.branch
                    || value.worktree.branch.length > 128
                    || typeof value.worktree.worktreeRoot !== 'string'
                    || !value.worktree.worktreeRoot
                    || value.worktree.worktreeRoot.length > 1024
                    || typeof value.worktree.repoRoot !== 'string'
                    || !value.worktree.repoRoot
                    || value.worktree.repoRoot.length > 1024
                    || (value.worktree.missing !== undefined
                        && typeof value.worktree.missing !== 'boolean'))) {
                return false;
            }
            return value.rateLimits.every(function (limit) {
                return exactKeys(
                    limit,
                    ['id', 'label', 'usedPercent'],
                    ['windowDurationMins', 'resetsAt']
                )
                    && typeof limit.id === 'string'
                    && limit.id.length > 0
                    && limit.id.length <= 256
                    && typeof limit.label === 'string'
                    && limit.label.length > 0
                    && limit.label.length <= 64
                    && Number.isFinite(limit.usedPercent)
                    && limit.usedPercent >= 0
                    && limit.usedPercent <= 100
                    && (limit.windowDurationMins === undefined
                        || (Number.isSafeInteger(limit.windowDurationMins)
                            && limit.windowDurationMins > 0))
                    && (limit.resetsAt === undefined
                        || (Number.isSafeInteger(limit.resetsAt)
                            && limit.resetsAt > 0));
            });
        }

        function compactTokens(value) {
            if (value >= 1000000) {
                return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + 'm';
            }
            if (value >= 1000) {
                return (value / 1000).toFixed(value >= 100000 ? 0 : 1) + 'k';
            }
            return String(value);
        }

        function compactResetTime(resetsAt) {
            var remainingMinutes = Math.max(
                1,
                Math.ceil((resetsAt * 1000 - Date.now()) / 60000)
            );
            if (remainingMinutes < 60) return remainingMinutes + 'm';
            var remainingHours = Math.ceil(remainingMinutes / 60);
            if (remainingHours < 48) return remainingHours + 'h';
            return Math.ceil(remainingHours / 24) + 'd';
        }

        function applyTelemetry(message) {
            if (!exactKeys(
                message,
                ['type', 'version', 'requestId', 'subscriptionGeneration', 'telemetry']
            )
                || message.type !== 'conversation-viewer-telemetry'
                || message.version !== 1
                || !Number.isSafeInteger(message.requestId)
                || message.requestId < latestRequestId()
                || message.requestId < state.latestTelemetryRequestId
                || message.subscriptionGeneration !== subscriptionGeneration
                || (message.telemetry !== null
                    && !validTelemetry(message.telemetry))
                || (message.telemetry !== null
                    && (!commentTarget
                        || message.telemetry.provider !== commentTarget.provider
                        || message.telemetry.sessionId !== commentTarget.sessionId))
                || !telemetryRoot || !telemetryModel || !telemetryModelValue
                || !telemetryContext || !telemetryContextProgress
                || !telemetryContextValue || !telemetryLimits
                || !telemetryWorktree || !telemetryWorktreeBranch) {
                return false;
            }
            state.latestTelemetryRequestId = message.requestId;
            var readingAnchor = captureAnchor();
            var previousScrollTop = scroll.scrollTop;
            var telemetry = message.telemetry;
            if (!telemetry) {
                telemetryRoot.hidden = true;
                restoreViewport(
                    readingAnchor,
                    previousScrollTop
                );
                return true;
            }
            telemetryModel.hidden = !telemetry.model;
            telemetryModelValue.textContent = telemetry.model || '';
            var worktree = telemetry.worktree;
            telemetryWorktree.hidden = !worktree;
            if (worktree) {
                telemetryWorktreeBranch.textContent = worktree.branch;
                telemetryWorktree.setAttribute(
                    'data-worktree-root',
                    worktree.worktreeRoot
                );
                telemetryWorktree.classList.toggle(
                    'conversation-telemetry-worktree-missing',
                    !!worktree.missing
                );
                telemetryWorktree.title = worktree.missing
                    ? 'Worktree path no longer exists: '
                        + worktree.worktreeRoot
                    : 'Working in worktree: ' + worktree.worktreeRoot
                        + ' · Click to show changes in Source Control';
            }
            telemetryContext.hidden = !telemetry.context;
            if (telemetry.context) {
                var percent = Math.max(0, Math.min(
                    100,
                    telemetry.context.usedTokens
                        / telemetry.context.maxTokens * 100
                ));
                telemetryContextProgress.max = telemetry.context.maxTokens;
                telemetryContextProgress.value = telemetry.context.usedTokens;
                telemetryContextValue.textContent = Math.round(percent) + '% · '
                    + compactTokens(telemetry.context.usedTokens) + ' / '
                    + compactTokens(telemetry.context.maxTokens);
            }
            telemetryLimits.replaceChildren();
            telemetry.rateLimits.forEach(function (limit) {
                var meter = document.createElement('div');
                meter.className = 'conversation-telemetry-meter';
                var label = document.createElement('span');
                label.textContent = limit.label;
                var progress = document.createElement('progress');
                progress.max = 100;
                progress.value = limit.usedPercent;
                progress.setAttribute('aria-label', limit.label + ' usage');
                var value = document.createElement('span');
                var text = Math.round(100 - limit.usedPercent) + '% left';
                if (limit.resetsAt) {
                    text += ' · resets in ' + compactResetTime(limit.resetsAt);
                    value.title = new Date(
                        limit.resetsAt * 1000
                    ).toLocaleString();
                }
                value.textContent = text;
                meter.append(label, progress, value);
                telemetryLimits.appendChild(meter);
            });
            telemetryRoot.hidden = !telemetry.model
                && !telemetry.context
                && !worktree
                && telemetry.rateLimits.length === 0;
            restoreViewport(readingAnchor, previousScrollTop);
            return true;
        }

        return Object.freeze({
            apply: applyTelemetry,
        });
    }

    window.__agentPivotConversationTelemetry = Object.freeze({ create: create });
}());
