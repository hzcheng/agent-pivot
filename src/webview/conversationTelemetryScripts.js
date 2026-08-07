(function () {
    'use strict';

    function create(options) {
        var commentTarget = options.target;
        var subscriptionGeneration = options.subscriptionGeneration;
        var latestRequestId = options.latestRequestId;
        var telemetryRoot = options.telemetryRoot;
        var telemetryProvider = options.telemetryProvider;
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

        function providerLabel(provider) {
            if (provider === 'kimi') return 'Kimi';
            if (provider === 'claude') return 'Claude';
            return 'Codex';
        }

        function setTooltip(element, label) {
            element.title = label;
            element.setAttribute('aria-label', label);
            element.setAttribute('data-tooltip', label);
        }

        function setRingProgress(circle, percent) {
            var usedPercent = Math.max(0, Math.min(100, percent));
            circle.setAttribute('stroke-dasharray', '100');
            circle.setAttribute(
                'stroke-dashoffset',
                String(Math.round((100 - usedPercent) * 10) / 10)
            );
        }

        function createLimitRing(limit) {
            var usedPercent = Math.max(0, Math.min(100, limit.usedPercent));
            var visibleValue = Math.round(usedPercent) + '%';
            var details = limit.label + ' · ' + visibleValue + ' used';
            if (limit.resetsAt) {
                details += ' · resets in ' + compactResetTime(limit.resetsAt);
            }
            var meter = document.createElement('div');
            meter.className = 'conversation-telemetry-usage '
                + 'conversation-telemetry-limit conversation-telemetry-tooltip';
            meter.setAttribute('data-telemetry-limit', '');
            meter.setAttribute('data-telemetry-limit-id', limit.id);
            meter.setAttribute('role', 'meter');
            meter.tabIndex = 0;
            meter.setAttribute('aria-valuemin', '0');
            meter.setAttribute('aria-valuemax', '100');
            meter.setAttribute('aria-valuenow', String(usedPercent));
            setTooltip(meter, details);

            var ring = document.createElement('span');
            ring.className = 'conversation-telemetry-ring';
            ring.setAttribute('aria-hidden', 'true');
            ring.innerHTML = '<svg class="conversation-telemetry-ring-progress"'
                + ' viewBox="0 0 36 36"><circle'
                + ' class="conversation-telemetry-ring-track" cx="18" cy="18"'
                + ' r="15.5" pathLength="100"></circle><circle'
                + ' class="conversation-telemetry-ring-value"'
                + ' data-telemetry-limit-progress cx="18" cy="18" r="15.5"'
                + ' pathLength="100"></circle></svg><svg'
                + ' class="conversation-telemetry-ring-icon" viewBox="0 0 16 16"'
                + ' aria-hidden="true" fill="none" stroke="currentColor"'
                + ' stroke-width="1.35" stroke-linecap="round"'
                + ' stroke-linejoin="round"><rect x="2.5" y="3.5"'
                + ' width="11" height="10" rx="2"></rect><path'
                + ' d="M5 2v3M11 2v3M2.5 6.5h11"></path><path'
                + ' d="M6.3 9h3.4l-2 3"></path></svg>';
            setRingProgress(
                ring.querySelector('[data-telemetry-limit-progress]'),
                usedPercent
            );
            var value = document.createElement('strong');
            value.setAttribute('data-telemetry-limit-value', '');
            value.textContent = visibleValue;
            meter.append(ring, value);
            return meter;
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
                || !telemetryRoot || !telemetryProvider
                || !telemetryModel || !telemetryModelValue
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
                // The quick-entry pills keep the bar visible even without
                // usage data; only the usage widgets stay hidden.
                telemetryModel.hidden = true;
                telemetryWorktree.hidden = true;
                telemetryContext.hidden = true;
                telemetryLimits.replaceChildren();
                telemetryRoot.hidden = false;
                restoreViewport(
                    readingAnchor,
                    previousScrollTop
                );
                return true;
            }
            telemetryModel.hidden = !telemetry.model;
            telemetryModelValue.textContent = telemetry.model || '';
            setTooltip(
                telemetryModel,
                telemetry.model ? 'Model · ' + telemetry.model : 'Model'
            );
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
                var worktreeTitle = worktree.missing
                    ? 'Worktree path no longer exists: '
                        + worktree.worktreeRoot + ' (branch ' + worktree.branch + ')'
                    : 'Working in worktree: ' + worktree.worktreeRoot
                        + ' (branch ' + worktree.branch + ')'
                        + ' · Click to show changes in Source Control';
                setTooltip(telemetryWorktree, worktreeTitle);
            }
            telemetryContext.hidden = !telemetry.context;
            if (telemetry.context) {
                var percent = Math.max(0, Math.min(
                    100,
                    telemetry.context.usedTokens
                        / telemetry.context.maxTokens * 100
                ));
                var visibleContext = Math.round(percent) + '%';
                var contextDetails = 'Context window · ' + visibleContext
                    + ' used\n' + compactTokens(telemetry.context.usedTokens)
                    + ' / ' + compactTokens(telemetry.context.maxTokens)
                    + ' tokens';
                setRingProgress(telemetryContextProgress, percent);
                telemetryContext.setAttribute('aria-valuenow', String(percent));
                setTooltip(telemetryContext, contextDetails);
                telemetryContextValue.textContent = visibleContext;
            }
            telemetryLimits.replaceChildren();
            telemetry.rateLimits.forEach(function (limit) {
                telemetryLimits.appendChild(createLimitRing(limit));
            });
            telemetryRoot.hidden = false;
            restoreViewport(readingAnchor, previousScrollTop);
            return true;
        }

        function resetSession(target, generation) {
            commentTarget = target;
            subscriptionGeneration = generation;
            state.latestTelemetryRequestId = 0;
            telemetryProvider.setAttribute('data-provider', target.provider);
            setTooltip(
                telemetryProvider,
                'Provider · ' + providerLabel(target.provider)
            );
            telemetryModel.hidden = true;
            telemetryWorktree.hidden = true;
            telemetryContext.hidden = true;
            telemetryLimits.replaceChildren();
            return true;
        }

        return Object.freeze({
            apply: applyTelemetry,
            resetSession: resetSession,
        });
    }

    window.__agentPivotConversationTelemetry = Object.freeze({ create: create });
}());
