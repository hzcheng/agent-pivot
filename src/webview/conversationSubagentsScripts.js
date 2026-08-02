(function () {
    'use strict';

    var STATUS_LABELS = {
        running: 'Running',
        idle: 'Finished',
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
                    return entry.status === 'running';
                })
                : lastSubagents.slice();
            // Running entries pin to the top; the rest keep dispatch order.
            return entries.slice().sort(function (left, right) {
                return (left.status === 'running' ? 0 : 1)
                    - (right.status === 'running' ? 0 : 1);
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
            telemetrySubagents.hidden = lastSubagents.length === 0;
            if (lastSubagents.length > 0) {
                telemetrySection.hidden = false;
            }
            telemetrySubagents.textContent = 'Agents ' + runningCount + '/'
                + lastSubagents.length;
            telemetrySubagents.title = runningCount + ' running of '
                + lastSubagents.length
                + (lastSubagents.length === 1 ? ' subagent' : ' subagents')
                + ' — click to view';
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

    window.__agentPivotConversationSubagents = Object.freeze({
        create: create,
    });
}());
