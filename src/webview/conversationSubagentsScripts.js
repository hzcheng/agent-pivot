(function () {
    'use strict';

    var STATUS_LABELS = {
        running: 'Running',
        idle: 'Finished',
        quiet: 'Quiet',
        failed: 'Failed',
        killed: 'Stopped',
    };

    function text(value) {
        return typeof value === 'string' ? value : '';
    }

    function formatTime(timestamp) {
        if (!Number.isFinite(timestamp)) return '';
        try {
            var date = new Date(timestamp);
            var now = Date.now();
            var elapsedMs = now - timestamp;
            if (elapsedMs >= 0 && elapsedMs < 60 * 1000) {
                return 'just now';
            }
            if (elapsedMs >= 0 && elapsedMs < 60 * 60 * 1000) {
                return Math.floor(elapsedMs / 60000) + 'm ago';
            }
            if (elapsedMs >= 0 && elapsedMs < 24 * 60 * 60 * 1000) {
                return Math.floor(elapsedMs / 3600000) + 'h ago';
            }
            var today = new Date();
            var sameDay = date.toDateString() === today.toDateString();
            return sameDay
                ? date.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                })
                : date.toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                });
        } catch (_error) {
            return '';
        }
    }

    function create(options) {
        var listRoot = options.listRoot;
        var emptyRoot = options.emptyRoot;
        var summaryRoot = options.summaryRoot;
        var banner = options.banner;
        var bannerLabel = options.bannerLabel;
        var runningOnly = options.runningOnly;
        var telemetrySubagents = options.telemetrySubagents;
        var telemetrySection = options.telemetrySection;
        var onOpen = options.onOpen;
        var lastSubagents = [];
        var lastActiveSubagent = null;

        function visibleEntries() {
            var entries = runningOnly.checked
                ? lastSubagents.filter(function (entry) {
                    return entry.status === 'running'
                        || entry.status === 'quiet';
                })
                : lastSubagents.slice();
            // Live-ish entries pin to the top: running first, then quiet;
            // the rest keep dispatch order.
            var rank = function (entry) {
                return entry.status === 'running'
                    ? 0
                    : entry.status === 'quiet' ? 1 : 2;
            };
            return entries.slice().sort(function (left, right) {
                return rank(left) - rank(right);
            });
        }

        function render() {
            listRoot.textContent = '';
            var entries = visibleEntries();
            emptyRoot.hidden = entries.length > 0;
            if (lastSubagents.length) {
                summaryRoot.textContent = entries.length + ' / '
                    + lastSubagents.length
                    + (lastSubagents.length === 1 ? ' subagent' : ' subagents');
            } else {
                summaryRoot.textContent = 'No subagents yet';
            }
            entries.forEach(function (entry) {
                var item = document.createElement('li');
                item.className = 'conversation-subagent';
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'conversation-subagent-button';
                button.setAttribute('data-subagent-id', entry.id);
                if (lastActiveSubagent
                    && lastActiveSubagent.id === entry.id) {
                    button.setAttribute('aria-current', 'true');
                }
                var label = document.createElement('span');
                label.className = 'conversation-subagent-label';
                label.textContent = text(entry.label);
                label.title = text(entry.label);
                button.appendChild(label);
                var meta = document.createElement('span');
                meta.className = 'conversation-subagent-meta';
                var status = document.createElement('span');
                status.className = 'conversation-subagent-status';
                status.setAttribute('data-status', text(entry.status));
                status.textContent = STATUS_LABELS[entry.status]
                    || text(entry.status);
                meta.appendChild(status);
                var time = formatTime(entry.updatedAt);
                if (time) {
                    var timeElement = document.createElement('span');
                    timeElement.className = 'conversation-subagent-time';
                    timeElement.textContent = time;
                    meta.appendChild(timeElement);
                }
                button.appendChild(meta);
                button.addEventListener('click', function () {
                    onOpen(entry.id);
                });
                item.appendChild(button);
                listRoot.appendChild(item);
            });
            banner.hidden = !lastActiveSubagent;
            bannerLabel.textContent = lastActiveSubagent
                ? text(lastActiveSubagent.label)
                : '';
            document.body.setAttribute(
                'data-viewing-subagent',
                lastActiveSubagent ? 'true' : 'false'
            );
            var runningCount = lastSubagents.filter(function (entry) {
                return entry.status === 'running';
            }).length;
            // The pill doubles as the Subagents quick entry; keep it
            // visible even at zero.
            telemetrySubagents.hidden = false;
            telemetrySection.hidden = false;
            var telemetrySubagentsValue = telemetrySubagents.querySelector(
                '[data-telemetry-subagents-value]'
            );
            var visibleSubagents = runningCount + '/' + lastSubagents.length;
            if (telemetrySubagentsValue) {
                telemetrySubagentsValue.textContent = visibleSubagents;
            } else {
                telemetrySubagents.textContent = visibleSubagents;
            }
            var telemetrySubagentsLabel = runningCount + ' running of '
                + lastSubagents.length
                + (lastSubagents.length === 1 ? ' subagent' : ' subagents')
                + ' — click to view';
            telemetrySubagents.removeAttribute('title');
            telemetrySubagents.setAttribute(
                'aria-label', telemetrySubagentsLabel
            );
            telemetrySubagents.setAttribute(
                'data-tooltip', telemetrySubagentsLabel
            );
        }

        function apply(subagents, activeSubagent) {
            lastSubagents = Array.isArray(subagents) ? subagents : [];
            lastActiveSubagent = activeSubagent || null;
            render();
        }

        runningOnly.addEventListener('change', function () {
            render();
            if (typeof options.onRunningOnlyChange === 'function') {
                options.onRunningOnlyChange(runningOnly.checked);
            }
        });

        return Object.freeze({ apply: apply, refresh: render });
    }

    window.__agentPivotConversation.subagents = Object.freeze({
        create: create,
    });
}());
