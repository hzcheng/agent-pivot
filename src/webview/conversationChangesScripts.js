(function () {
    'use strict';

    var GROUPS = ['merge', 'staged', 'changes', 'untracked'];
    var GROUP_TITLES = {
        merge: 'Merge Changes',
        staged: 'Staged Changes',
        changes: 'Changes',
        untracked: 'Untracked Changes',
    };
    var MAX_TOOLTIP_MEMBER_LINES = 8;

    function create(options) {
        var post = options.post;
        var button = options.telemetryChanges;
        var buttonValue = options.telemetryChangesValue;
        var memberSelect = options.memberSelect;
        var refreshButton = options.refreshButton;
        var crossMemberNote = options.crossMemberNote;
        var taskRoot = options.taskRoot;
        var taskSummary = options.taskSummary;
        var reviewButton = options.reviewButton;
        var workingHeader = options.workingHeader;
        var groupsRoot = options.groupsRoot;
        var emptyRoot = options.emptyRoot;
        var unavailableRoot = options.unavailableRoot;
        var openScmButton = options.openScmButton;
        var updateToggle = options.updateToggle || function () {};
        var subscriptionGeneration = options.subscriptionGeneration;
        var latestState = null;

        function exactKeys(value, required, optional) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            var keys = Object.keys(value);
            var allowed = {};
            required.concat(optional || []).forEach(function (key) {
                allowed[key] = true;
            });
            return required.every(function (key) {
                return Object.prototype.hasOwnProperty.call(value, key);
            }) && keys.every(function (key) { return !!allowed[key]; });
        }

        function validAvailability(value) {
            return ['available', 'baselineUnavailable',
                'historyRewritten', 'unreadable'].includes(value);
        }

        function validMember(member) {
            return exactKeys(member, [
                'memberId', 'repoLabel', 'branchName', 'worktreePath',
                'availability', 'workingItemCount', 'truncated',
            ], ['aheadCount', 'detached'])
                && typeof member.memberId === 'string'
                && member.memberId.length > 0
                && member.memberId.length <= 128
                && typeof member.repoLabel === 'string'
                && typeof member.branchName === 'string'
                && typeof member.worktreePath === 'string'
                && validAvailability(member.availability)
                && Number.isSafeInteger(member.workingItemCount)
                && member.workingItemCount >= 0
                && (member.aheadCount === undefined
                    || (Number.isSafeInteger(member.aheadCount)
                        && member.aheadCount >= 0))
                && typeof member.truncated === 'boolean';
        }

        function validItem(item) {
            return exactKeys(item, ['group', 'xy', 'path'], ['originalPath'])
                && GROUPS.includes(item.group)
                && typeof item.xy === 'string' && item.xy.length === 2
                && typeof item.path === 'string' && item.path.length > 0
                && (item.originalPath === undefined
                    || typeof item.originalPath === 'string');
        }

        function validDetail(detail) {
            return exactKeys(detail, [
                'memberId', 'availability', 'items', 'truncated',
            ], ['baselineSha', 'aheadCount', 'taskFileCount'])
                && typeof detail.memberId === 'string'
                && validAvailability(detail.availability)
                && Array.isArray(detail.items)
                && detail.items.length <= 20000
                && detail.items.every(validItem)
                && typeof detail.truncated === 'boolean';
        }

        function validAggregate(aggregate) {
            return exactKeys(aggregate, [
                'completeness', 'workingItemCount', 'workingPartial',
                'aheadPartial', 'allUnreadable',
            ], ['aheadCount'])
                && ['complete', 'partial', 'unavailable']
                    .includes(aggregate.completeness)
                && Number.isSafeInteger(aggregate.workingItemCount)
                && aggregate.workingItemCount >= 0
                && typeof aggregate.workingPartial === 'boolean'
                && typeof aggregate.aheadPartial === 'boolean'
                && typeof aggregate.allUnreadable === 'boolean'
                && (aggregate.aheadCount === undefined
                    || (Number.isSafeInteger(aggregate.aheadCount)
                        && aggregate.aheadCount >= 0));
        }

        function validState(state) {
            return exactKeys(state, [
                'kind', 'aggregate', 'members', 'collectedAt',
            ], ['selectedMemberId', 'detail'])
                && ['ready', 'retired', 'unavailable'].includes(state.kind)
                && validAggregate(state.aggregate)
                && Array.isArray(state.members)
                && state.members.length <= 64
                && state.members.every(validMember)
                && (state.selectedMemberId === undefined
                    || typeof state.selectedMemberId === 'string')
                && (state.detail === undefined || validDetail(state.detail))
                && Number.isSafeInteger(state.collectedAt);
        }

        function workingText(aggregate) {
            return aggregate.workingPartial
                ? aggregate.workingItemCount + '+'
                : String(aggregate.workingItemCount);
        }

        function aheadText(aggregate) {
            if (aggregate.allUnreadable) {
                return '↑—';
            }
            if (aggregate.aheadPartial) {
                return aggregate.aheadCount === undefined ? '↑—' : '↑?';
            }
            return '↑' + (aggregate.aheadCount || 0);
        }

        function memberTooltipLine(member) {
            var label = member.branchName
                ? member.repoLabel + ' (' + member.branchName + ')'
                : member.repoLabel;
            if (member.availability === 'unreadable') {
                return label + ' · unreadable';
            }
            if (member.availability === 'historyRewritten') {
                return label + ' · history rewritten';
            }
            var ahead = member.aheadCount === undefined ? '↑—' : '↑' + member.aheadCount;
            return label + ' · ' + member.workingItemCount + ' uncommitted · ' + ahead;
        }

        function buttonSummary(aggregate) {
            return workingText(aggregate) + ' uncommitted · '
                + aheadText(aggregate).slice(1) + ' commits since baseline';
        }

        function renderButton(state) {
            if (!button) return;
            var aggregate = state.aggregate;
            var hide = state.kind === 'unavailable'
                || (state.kind === 'ready' && !state.members.length);
            button.hidden = !!hide;
            if (hide) {
                updateToggle();
                return;
            }
            var retired = state.kind === 'retired' || aggregate.allUnreadable;
            button.disabled = !!retired;
            button.classList.toggle(
                'conversation-telemetry-changes-unavailable', !!retired);
            var text = retired
                ? '—'
                : workingText(aggregate) + ' · ' + aheadText(aggregate);
            if (buttonValue) {
                buttonValue.textContent = text;
            } else {
                button.textContent = text;
            }
            var lines;
            if (retired) {
                lines = state.kind === 'retired'
                    ? ['This worktree has been deleted.']
                    : ['Changes unavailable — every worktree is unreadable.'];
            } else {
                lines = ['Changes · ' + buttonSummary(aggregate)];
                state.members.slice(0, MAX_TOOLTIP_MEMBER_LINES)
                    .forEach(function (member) {
                        lines.push(memberTooltipLine(member));
                    });
                if (aggregate.workingPartial || aggregate.aheadPartial) {
                    lines.push('Partial: some worktrees are unknown '
                        + '— unknown is never counted as zero.');
                }
            }
            var tooltip = lines.join('\n');
            var aria = state.members.length === 1
                ? tooltip.split('\n')[0] + ' — click to view'
                : 'Changes · ' + buttonSummary(aggregate) + ' — click to view';
            button.setAttribute('aria-label', retired ? tooltip : aria);
            button.title = tooltip;
            button.setAttribute('data-tooltip', tooltip);
            updateToggle();
        }

        function memberOptionText(member) {
            var counts = member.availability === 'unreadable'
                ? 'unreadable'
                : member.workingItemCount + ' · '
                    + (member.aheadCount === undefined
                        ? '↑—' : '↑' + member.aheadCount);
            var label = member.branchName
                ? member.repoLabel + ' · ⎇ ' + member.branchName
                : member.repoLabel;
            return label + (member.detached ? ' (outside workspace)' : '')
                + ' · ' + counts;
        }

        function renderMemberSelect(state) {
            if (!memberSelect) return;
            var selected = state.selectedMemberId
                || (state.members[0] && state.members[0].memberId) || '';
            var previous = memberSelect.value;
            memberSelect.textContent = '';
            state.members.forEach(function (member) {
                var option = document.createElement('option');
                option.value = member.memberId;
                option.textContent = memberOptionText(member);
                memberSelect.appendChild(option);
            });
            memberSelect.value = state.members.some(function (member) {
                return member.memberId === previous;
            }) && previous === selected ? previous : selected;
            memberSelect.disabled = state.members.length <= 1;
        }

        function clearChildren(root) {
            while (root.firstChild) {
                root.removeChild(root.firstChild);
            }
        }

        function statusBadge(item) {
            var badge = document.createElement('span');
            badge.className = 'conversation-changes-file-status '
                + 'conversation-changes-file-status-' + item.group;
            badge.textContent = item.group === 'untracked'
                ? 'U'
                : item.group === 'merge'
                    ? '!'
                    : item.group === 'staged'
                        ? (item.xy[0] === ' ' ? 'M' : item.xy[0])
                        : (item.xy[1] === ' ' ? 'M' : item.xy[1]);
            return badge;
        }

        function renderFileRow(memberId, item) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'conversation-changes-file';
            row.title = item.originalPath
                ? item.originalPath + ' → ' + item.path
                : item.path;
            row.appendChild(statusBadge(item));
            var name = document.createElement('span');
            name.className = 'conversation-changes-file-path';
            name.textContent = item.originalPath
                ? item.originalPath + ' → ' + item.path
                : item.path;
            row.appendChild(name);
            row.addEventListener('click', function () {
                post({
                    type: 'conversation-viewer-changes-open-file',
                    version: 1,
                    memberId: memberId,
                    group: item.group,
                    xy: item.xy,
                    path: item.path,
                    originalPath: item.originalPath,
                });
            });
            return row;
        }

        function renderGroups(detail) {
            if (!groupsRoot) return;
            clearChildren(groupsRoot);
            GROUPS.forEach(function (group) {
                var items = detail.items.filter(function (item) {
                    return item.group === group;
                }).sort(function (left, right) {
                    return left.path < right.path ? -1
                        : left.path > right.path ? 1 : 0;
                });
                if (!items.length) return;
                var section = document.createElement('div');
                section.className = 'conversation-changes-group';
                var header = document.createElement('div');
                header.className = 'conversation-changes-group-header';
                header.textContent = GROUP_TITLES[group];
                section.appendChild(header);
                var list = document.createElement('div');
                list.className = 'conversation-changes-group-list';
                items.forEach(function (item) {
                    list.appendChild(renderFileRow(detail.memberId, item));
                });
                section.appendChild(list);
                groupsRoot.appendChild(section);
            });
        }

        function renderPanel(state) {
            var unavailable = state.kind === 'retired'
                || state.aggregate.allUnreadable
                || (state.kind === 'ready' && !state.members.length);
            if (unavailableRoot) {
                unavailableRoot.hidden = !unavailable;
                if (unavailable) {
                    unavailableRoot.textContent = state.kind === 'retired'
                        ? 'This worktree has been deleted; its changes are no longer available.'
                        : 'No worktree changes are available for this session.';
                }
            }
            var content = !unavailable && state.kind === 'ready';
            [taskRoot, workingHeader && workingHeader.parentNode,
                openScmButton && openScmButton.parentNode,
                memberSelect && memberSelect.parentNode]
                .forEach(function (root) {
                    if (root) root.hidden = !content;
                });
            if (!content) return;
            renderMemberSelect(state);

            var detail = state.detail;
            var aggregate = state.aggregate;
            if (crossMemberNote) {
                var others = state.members.filter(function (member) {
                    return member.memberId !== state.selectedMemberId
                        && member.workingItemCount > 0;
                });
                var otherCount = others.reduce(function (sum, member) {
                    return sum + member.workingItemCount;
                }, 0);
                crossMemberNote.hidden = !(others.length && otherCount);
                if (others.length && otherCount) {
                    crossMemberNote.textContent = otherCount
                        + ' changes in ' + others.length
                        + ' other ' + (others.length === 1 ? 'repository' : 'repositories');
                }
            }

            var showTask = !!detail && detail.baselineSha !== undefined
                && detail.availability === 'available'
                && detail.taskFileCount !== undefined;
            if (taskRoot) {
                taskRoot.hidden = !showTask
                    && !(detail
                        && detail.availability !== 'available'
                        && detail.availability !== 'unreadable');
            }
            if (taskSummary && detail) {
                if (showTask) {
                    taskSummary.textContent = detail.taskFileCount + ' files · '
                        + (detail.aheadCount || 0) + ' commits';
                } else if (detail.availability === 'baselineUnavailable') {
                    taskSummary.textContent = 'Baseline unavailable';
                } else if (detail.availability === 'historyRewritten') {
                    taskSummary.textContent = 'History rewritten';
                } else {
                    taskSummary.textContent = '';
                }
            }
            if (reviewButton) {
                reviewButton.disabled = !showTask
                    || !(detail.taskFileCount > 0 || (detail.aheadCount || 0) > 0);
            }

            if (workingHeader) {
                workingHeader.textContent = 'Uncommitted now · '
                    + (detail ? detail.items.length : 0) + ' changes';
            }
            if (detail) {
                renderGroups(detail);
                if (emptyRoot) {
                    emptyRoot.hidden = detail.items.length > 0;
                }
            }
            void aggregate;
        }

        function apply(message) {
            if (!message || typeof message !== 'object'
                || message.type !== 'conversation-viewer-changes'
                || message.version !== 1
                || message.subscriptionGeneration !== subscriptionGeneration
                || !validState(message.changes)) {
                return false;
            }
            latestState = message.changes;
            renderButton(latestState);
            renderPanel(latestState);
            return true;
        }

        function attach() {
            if (memberSelect) {
                memberSelect.addEventListener('change', function () {
                    post({
                        type: 'conversation-viewer-changes-select',
                        version: 1,
                        memberId: memberSelect.value,
                    });
                });
            }
            if (refreshButton) {
                refreshButton.addEventListener('click', function () {
                    post({
                        type: 'conversation-viewer-changes-refresh',
                        version: 1,
                    });
                });
            }
            if (reviewButton) {
                reviewButton.addEventListener('click', function () {
                    if (latestState && latestState.selectedMemberId) {
                        post({
                            type: 'conversation-viewer-changes-review',
                            version: 1,
                            memberId: latestState.selectedMemberId,
                        });
                    }
                });
            }
            if (openScmButton) {
                openScmButton.addEventListener('click', function () {
                    if (latestState && latestState.selectedMemberId) {
                        post({
                            type: 'conversation-viewer-changes-open-scm',
                            version: 1,
                            memberId: latestState.selectedMemberId,
                        });
                    }
                });
            }
        }

        attach();

        return {
            apply: apply,
            getSelectedMemberId: function () {
                return latestState && latestState.selectedMemberId;
            },
        };
    }

    window.__agentPivotConversationChanges = { create: create };
}());
