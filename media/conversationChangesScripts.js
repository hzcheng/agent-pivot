(function () {
    'use strict';

    var GROUPS = ['merge', 'staged', 'changes', 'untracked'];
    var GROUP_TITLES = {
        merge: 'Merge Changes',
        staged: 'Staged Changes',
        changes: 'Changes',
        untracked: 'Untracked Changes',
    };
    // Display sections (PRD 体验反馈): Untracked merges into Changes — the
    // per-row U badge already carries the distinction, so a split section
    // only repeats information. The first entry names the section.
    var SECTION_GROUPS = [['merge'], ['staged'], ['changes', 'untracked']];
    var MAX_TOOLTIP_MEMBER_LINES = 8;

    // Panel-level tooltip overlay (changes-panel PRD §17). A pure-CSS
    // pseudo-element tooltip cannot escape the panel's overflow
    // hidden/auto clipping containers, and content: attr(data-tooltip) is
    // not a reliable screen-reader description — so a single JS-driven
    // node hangs off <body> with position: fixed, driven by the
    // data-tooltip attribute, triggered by hover and keyboard focus, and
    // closed by Esc, blur, scroll, or sidebar close. aria-describedby ties
    // the trigger to the overlay while it is visible: the visible hint and
    // the spoken description share one source. The trigger's accessible
    // name still comes from aria-label/text content — the tooltip never
    // replaces it.
    function createTooltipOverlay(panelRoot) {
        var OVERLAY_ID = 'conversation-changes-tooltip-overlay';
        var VIEWPORT_GAP = 4;
        var overlay = null;
        var activeTrigger = null;

        function ensureOverlay() {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = OVERLAY_ID;
                overlay.className = 'conversation-tooltip-overlay';
                overlay.setAttribute('role', 'tooltip');
                overlay.hidden = true;
                document.body.appendChild(overlay);
            }
            return overlay;
        }

        function hide() {
            if (!activeTrigger) {
                return;
            }
            activeTrigger.removeAttribute('aria-describedby');
            activeTrigger = null;
            if (overlay) {
                overlay.hidden = true;
            }
        }

        function show(trigger) {
            if (activeTrigger === trigger) {
                return;
            }
            hide();
            var text = trigger.getAttribute('data-tooltip');
            if (!text) {
                return;
            }
            var node = ensureOverlay();
            node.textContent = text;
            node.hidden = false;
            activeTrigger = trigger;
            trigger.setAttribute('aria-describedby', OVERLAY_ID);
            // Pin below the trigger; clamp into the webview viewport when
            // the hint would overflow horizontally or vertically. No
            // automatic flipping — the PRD asks for clamping only.
            var rect = trigger.getBoundingClientRect();
            var maxLeft = Math.max(VIEWPORT_GAP,
                window.innerWidth - node.offsetWidth - VIEWPORT_GAP);
            var maxTop = Math.max(VIEWPORT_GAP,
                window.innerHeight - node.offsetHeight - VIEWPORT_GAP);
            node.style.left = Math.max(VIEWPORT_GAP,
                Math.min(rect.left, maxLeft)) + 'px';
            node.style.top = Math.max(VIEWPORT_GAP,
                Math.min(rect.bottom + VIEWPORT_GAP, maxTop)) + 'px';
        }

        function eventTrigger(event) {
            return event.target && event.target.closest
                ? event.target.closest('[data-tooltip]')
                : null;
        }

        // Delegation on the panel root only: the telemetry bar carries its
        // own CSS tooltip on the same data-tooltip attribute and must not
        // gain a second, JS-driven popup.
        panelRoot.addEventListener('mouseover', function (event) {
            var trigger = eventTrigger(event);
            if (trigger) {
                show(trigger);
            }
        });
        panelRoot.addEventListener('mouseout', function (event) {
            if (!activeTrigger || eventTrigger(event) !== activeTrigger) {
                return;
            }
            if (event.relatedTarget
                && activeTrigger.contains(event.relatedTarget)) {
                return;
            }
            // A focused trigger keeps its hint until blur — keyboard users
            // never move the mouse.
            if (document.activeElement === activeTrigger) {
                return;
            }
            hide();
        });
        panelRoot.addEventListener('focusin', function (event) {
            var trigger = eventTrigger(event);
            if (trigger) {
                show(trigger);
            }
        });
        panelRoot.addEventListener('focusout', function (event) {
            if (activeTrigger && event.target === activeTrigger) {
                hide();
            }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                hide();
            }
        });
        // Scroll events do not bubble; capture catches the panel's scroll
        // containers. A fixed overlay would otherwise strand mid-viewport
        // while its trigger scrolled away.
        document.addEventListener('scroll', hide, true);
        window.addEventListener('blur', hide);
        // Sidebar close flips the hidden attribute of the panel root (view
        // switch) or of an ancestor (whole sidebar) — the hint must not
        // outlive its panel.
        var visibilityObserver = new MutationObserver(function () {
            if (!panelRoot.isConnected || panelRoot.offsetParent === null) {
                hide();
            }
        });
        var observedNode = panelRoot;
        while (observedNode && observedNode !== document.body) {
            visibilityObserver.observe(observedNode, {
                attributes: true,
                attributeFilter: ['hidden'],
            });
            observedNode = observedNode.parentElement;
        }

        return { hide: hide };
    }

    function create(options) {
        var post = options.post;
        var button = options.telemetryChanges;
        var buttonValue = options.telemetryChangesValue;
        var memberSelect = options.memberSelect;
        var prevButton = options.prevButton;
        var nextButton = options.nextButton;
        var positionIndicator = options.positionIndicator;
        var repoTitle = options.repoTitle;
        var repoPicker = options.repoPicker;
        var repoLabel = options.repoLabel;
        var repoName = options.repoName;
        var outsideBadge = options.outsideBadge;
        var branchRoot = options.branchRoot;
        var branchPrefix = options.branchPrefix;
        var branchTail = options.branchTail;
        var liveRegion = options.liveRegion;
        var refreshButton = options.refreshButton;
        var crossMemberNote = options.crossMemberNote;
        var crossMemberSummary = options.crossMemberSummary;
        var crossMemberGo = options.crossMemberGo;
        var taskRoot = options.taskRoot;
        var taskSummary = options.taskSummary;
        var taskTracking = options.taskTracking;
        var reviewButton = options.reviewButton;
        var collapseAllButton = options.collapseAllButton;
        var expandAllButton = options.expandAllButton;
        var groupsRoot = options.groupsRoot;
        var emptyRoot = options.emptyRoot;
        var unavailableRoot = options.unavailableRoot;
        var openScmButton = options.openScmButton;
        var updateToggle = options.updateToggle || function () {};
        var subscriptionGeneration = options.subscriptionGeneration;
        var tooltip = options.panelRoot
            ? createTooltipOverlay(options.panelRoot)
            : { hide: function () {} };
        var latestState = null;
        var lastSelectSignature = '';
        var lastLiveText = '';

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

        // Tracking-branch three-state union (PRD §14.1/§14.4): 'none' is
        // a stated fact, 'unknown' a failed query — never rendered as 0.
        function validUpstream(upstream) {
            if (!upstream || typeof upstream !== 'object'
                || Array.isArray(upstream)) {
                return false;
            }
            if (upstream.status === 'none' || upstream.status === 'unknown') {
                return exactKeys(upstream, ['status'], []);
            }
            if (upstream.status === 'tracked') {
                return exactKeys(upstream,
                        ['status', 'fullRef', 'sha', 'ahead', 'behind'], [])
                    && typeof upstream.fullRef === 'string'
                    && upstream.fullRef.length > 0
                    && upstream.fullRef.length <= 1024
                    && typeof upstream.sha === 'string'
                    && /^[0-9a-f]{40}$/.test(upstream.sha)
                    && Number.isSafeInteger(upstream.ahead)
                    && upstream.ahead >= 0
                    && Number.isSafeInteger(upstream.behind)
                    && upstream.behind >= 0;
            }
            return false;
        }

        function validMember(member) {
            return exactKeys(member, [
                'memberId', 'repoLabel', 'branchName', 'worktreePath',
                'availability', 'workingItemCount', 'truncated',
            ], ['aheadCount', 'taskFileCount', 'detached', 'headSha',
                'upstream'])
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
                && (member.taskFileCount === undefined
                    || (Number.isSafeInteger(member.taskFileCount)
                        && member.taskFileCount >= 0))
                && (member.headSha === undefined
                    || (typeof member.headSha === 'string'
                        && /^[0-9a-f]{40}$/.test(member.headSha)))
                && (member.upstream === undefined
                    || validUpstream(member.upstream))
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
                return null;
            }
            if (aggregate.aheadPartial) {
                return null;
            }
            return String(aggregate.aheadCount || 0);
        }

        function memberTooltipLines(member) {
            var label = member.branchName
                ? member.repoLabel + ' (' + member.branchName + ')'
                : member.repoLabel;
            var lines = [label];
            if (member.availability === 'unreadable') {
                lines.push('  Unreadable');
            } else if (member.availability === 'historyRewritten') {
                lines.push('  History rewritten — baseline is no longer an ancestor');
            } else if (member.availability === 'baselineUnavailable') {
                lines.push('  Uncommitted: ' + member.workingItemCount);
                lines.push('  Baseline unavailable (no recorded task start)');
            } else {
                if (member.taskFileCount !== undefined
                    || member.aheadCount !== undefined) {
                    lines.push('  Task result: '
                        + (member.taskFileCount === undefined
                            ? '? files'
                            : member.taskFileCount + ' files')
                        + ' · '
                        + (member.aheadCount === undefined
                            ? '? commits'
                            : member.aheadCount + ' commits')
                        + ' since start');
                }
                lines.push('  Uncommitted: ' + member.workingItemCount
                    + (member.truncated ? ' (list truncated)' : ''));
            }
            lines.push('  ' + member.worktreePath);
            return lines;
        }

        function buttonSummary(aggregate) {
            var ahead = aheadText(aggregate);
            return ahead === null
                ? workingText(aggregate) + ' uncommitted'
                    + ' · commits unknown (no recorded task start)'
                : workingText(aggregate) + ' uncommitted · '
                    + ahead + ' commits since baseline';
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
            // Retired stays clickable: the panel carries the explanation
            // (PRD §7.3) — a disabled button would hide it entirely.
            button.classList.toggle(
                'conversation-telemetry-changes-unavailable', !!retired);
            var ahead = aheadText(aggregate);
            var text = retired
                ? ''
                : ahead === null
                    ? workingText(aggregate)
                    : workingText(aggregate) + ' · ' + ahead;
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
                        memberTooltipLines(member).forEach(function (line) {
                            lines.push(line);
                        });
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
            // No title attribute: the custom data-tooltip is the single
            // popup — a native title would stack a second one on top.
            button.removeAttribute('title');
            button.setAttribute('aria-label', retired ? tooltip : aria);
            button.setAttribute('data-tooltip', tooltip);
            updateToggle();
        }

        function memberOptionText(member) {
            // The dropdown's only job is identifying the worktree — repo
            // and branch suffice; counts live in the tooltip and panel.
            var label = member.branchName
                ? member.repoLabel + ' · ⎇ ' + member.branchName
                : member.repoLabel;
            if (member.availability === 'unreadable') {
                label += ' · unreadable';
            }
            return label + (member.detached ? ' (outside workspace)' : '');
        }

        function renderMemberSelect(state) {
            if (!memberSelect) return;
            // Never touch an open native dropdown: rebuilding its <option>s
            // closes the popup, and the periodic state push made that
            // flicker forever.
            if (document.activeElement === memberSelect) {
                return;
            }
            var selected = state.selectedMemberId
                || (state.members[0] && state.members[0].memberId) || '';
            var signature = state.members.map(function (member) {
                return member.memberId + '|' + memberOptionText(member);
            }).join('\u0001') + '|' + selected;
            // Skip the rebuild entirely when nothing visible changed.
            if (signature === lastSelectSignature) {
                return;
            }
            memberSelect.textContent = '';
            state.members.forEach(function (member) {
                var option = document.createElement('option');
                option.value = member.memberId;
                option.textContent = memberOptionText(member);
                memberSelect.appendChild(option);
            });
            memberSelect.value = state.members.some(function (member) {
                return member.memberId === selected;
            }) ? selected : '';
            lastSelectSignature = signature;
            var selectedMember = state.members.filter(function (member) {
                return member.memberId === selected;
            })[0];
            // No native title: the worktree path rides the panel-level
            // tooltip overlay (PRD §17) — the select's accessible name
            // stays on its aria-label.
            if (selectedMember) {
                memberSelect.setAttribute('data-tooltip',
                    selectedMember.worktreePath);
            } else {
                memberSelect.removeAttribute('data-tooltip');
            }
        }

        function selectedMemberOf(state) {
            var selected = state.selectedMemberId
                || (state.members[0] && state.members[0].memberId) || '';
            return state.members.filter(function (member) {
                return member.memberId === selected;
            })[0] || state.members[0] || null;
        }

        // Row 1 + row 2 of the member header (PRD §15.1): ‹ › cycling
        // buttons, a visible repo label under a transparent native select
        // overlay, the (i/n) position indicator, and the branch row. The
        // cycling order is the members array order — the manifest order —
        // recomputed from the latest state on every activation (PRD §14.2).
        function renderHeader(state) {
            var member = selectedMemberOf(state);
            var count = state.members.length;
            var multi = count > 1;
            if (prevButton) {
                prevButton.hidden = !multi;
            }
            if (nextButton) {
                nextButton.hidden = !multi;
            }
            if (positionIndicator) {
                positionIndicator.hidden = !multi;
                if (multi && member) {
                    positionIndicator.textContent = '('
                        + (state.members.indexOf(member) + 1) + '/' + count
                        + ')';
                }
            }
            // Single member: no select at all — the repo name degrades to
            // a plain text title, not a disabled dropdown (PRD §15.1).
            if (repoPicker && repoTitle && memberSelect) {
                repoPicker.hidden = !multi;
                repoTitle.hidden = multi;
                if (multi) {
                    if (!memberSelect.isConnected) {
                        repoPicker.appendChild(memberSelect);
                    }
                } else if (memberSelect.isConnected) {
                    repoPicker.removeChild(memberSelect);
                }
            }
            if (member) {
                if (!multi && repoTitle) {
                    repoTitle.textContent = member.repoLabel;
                    repoTitle.setAttribute('data-tooltip',
                        member.worktreePath);
                }
                if (multi && repoName) {
                    repoName.textContent = member.repoLabel;
                }
                if (multi && repoLabel) {
                    repoLabel.setAttribute('data-tooltip',
                        member.worktreePath);
                }
                if (outsideBadge) {
                    outsideBadge.hidden = !member.detached;
                }
            }
            renderMemberSelect(state);
            if (liveRegion) {
                var announcement = multi && member
                    ? member.repoLabel + ', '
                        + (state.members.indexOf(member) + 1) + ' of ' + count
                    : '';
                if (announcement !== lastLiveText) {
                    lastLiveText = announcement;
                    liveRegion.textContent = announcement;
                }
            }
            // Row 2: the branch owns the row; the last path segment stays
            // visible while the prefix elides (two-span middle ellipsis).
            if (branchRoot && member) {
                var branchName = member.branchName || '';
                branchRoot.setAttribute('data-tooltip', branchName
                    ? branchName + '\n' + member.worktreePath
                    : member.worktreePath);
                var slash = branchName.lastIndexOf('/');
                if (branchPrefix) {
                    branchPrefix.textContent = slash >= 0
                        ? branchName.slice(0, slash + 1)
                        : '';
                }
                if (branchTail) {
                    branchTail.textContent = branchName
                        ? (slash >= 0
                            ? branchName.slice(slash + 1)
                            : branchName)
                        : '(no branch)';
                }
            }
        }

        function cycleMember(delta) {
            if (!latestState || latestState.kind !== 'ready') {
                return;
            }
            var members = latestState.members;
            if (members.length <= 1) {
                return;
            }
            var current = selectedMemberOf(latestState);
            var index = current ? members.indexOf(current) : 0;
            if (index < 0) {
                index = 0;
            }
            var target = members[
                (index + delta + members.length) % members.length];
            if (target) {
                post({
                    type: 'conversation-viewer-changes-select',
                    version: 1,
                    memberId: target.memberId,
                });
            }
        }

        // Cross-member hint (PRD §15.1): count and jump target share one
        // candidate set — readable members (availability !== 'unreadable')
        // other than the selected one. Unreadable members are unknown, and
        // unknown is never counted as zero nor offered as a target.
        function crossMemberCandidates(state) {
            var selected = state.selectedMemberId;
            return state.members.filter(function (member) {
                return member.memberId !== selected
                    && member.availability !== 'unreadable'
                    && member.workingItemCount > 0;
            });
        }

        function crossMemberTarget(state) {
            var members = state.members;
            var current = selectedMemberOf(state);
            var index = current ? members.indexOf(current) : 0;
            if (index < 0) {
                index = 0;
            }
            for (var step = 1; step < members.length; step += 1) {
                var candidate = members[(index + step) % members.length];
                if (candidate.memberId !== state.selectedMemberId
                    && candidate.availability !== 'unreadable'
                    && candidate.workingItemCount > 0) {
                    return candidate;
                }
            }
            return null;
        }

        function renderCrossMemberNote(state) {
            if (!crossMemberNote) {
                return;
            }
            var others = crossMemberCandidates(state);
            var target = crossMemberTarget(state);
            // All changes from the current member → no hint at all.
            if (!others.length || !target) {
                crossMemberNote.hidden = true;
                return;
            }
            var total = others.reduce(function (sum, member) {
                return sum + member.workingItemCount;
            }, 0);
            var names = others.map(function (member) {
                return member.repoLabel;
            });
            var listed = names.length > 2
                ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2)
                    + ' more'
                : names.join(', ');
            crossMemberNote.hidden = false;
            if (crossMemberSummary) {
                crossMemberSummary.textContent = total === 1
                    ? '1 more change in ' + listed
                    : total + ' more changes in ' + listed;
            }
            if (crossMemberGo) {
                crossMemberGo.textContent = ' · Go to ' + target.repoLabel;
            }
            crossMemberNote.setAttribute('data-tooltip',
                others.map(function (member) {
                    return member.repoLabel + ': ' + member.workingItemCount;
                }).join('\n'));
        }

        // Summary area line 2 (PRD §14.1): the upstream reference frame as
        // a three-state union — 'none' is a stated fact in neutral color,
        // 'unknown' a failed query; neither is ever rendered as zero.
        function shortUpstreamRef(fullRef) {
            var prefix = 'refs/remotes/';
            return fullRef.indexOf(prefix) === 0
                ? fullRef.slice(prefix.length)
                : fullRef;
        }

        function renderTracking(state) {
            if (!taskTracking) {
                return;
            }
            var member = selectedMemberOf(state);
            var upstream = member && member.upstream;
            if (!upstream) {
                taskTracking.hidden = true;
                taskTracking.textContent = '';
                taskTracking.removeAttribute('data-tooltip');
                return;
            }
            taskTracking.hidden = false;
            if (upstream.status === 'tracked') {
                taskTracking.textContent = 'Tracking '
                    + shortUpstreamRef(upstream.fullRef) + ' · '
                    + upstream.ahead + ' ahead · ' + upstream.behind
                    + ' behind';
                taskTracking.setAttribute('data-tooltip',
                    upstream.fullRef + '\nBased on local remote-tracking '
                        + 'refs; no fetch was performed');
            } else {
                taskTracking.textContent = upstream.status === 'none'
                    ? 'No tracking branch'
                    : 'Tracking unknown';
                taskTracking.removeAttribute('data-tooltip');
            }
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
            row.setAttribute('data-tooltip', item.originalPath
                ? item.originalPath + ' → ' + item.path
                : item.path);
            row.appendChild(statusBadge(item));
            var name = document.createElement('span');
            name.className = 'conversation-changes-file-path';
            // Tree view (PRD 体验反馈): show the basename; the full path
            // stays available on hover.
            var base = item.path.split('/').pop();
            name.textContent = item.originalPath
                ? item.originalPath + ' → ' + item.path
                : base;
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

        // Per-member UI context (PRD §15.2): fold state (folders + group
        // headers) and the content scroll position are remembered per
        // member for the panel's lifetime — switching away and back
        // restores both. Nothing persists; resetSession drops everything.
        var memberContexts = {};
        var currentMemberId = null;

        function contextFor(memberId) {
            if (!memberContexts[memberId]) {
                memberContexts[memberId] = {
                    collapsedFolders: {},
                    collapsedGroups: {},
                    scrollTop: 0,
                };
            }
            return memberContexts[memberId];
        }

        function folderKey(group, folderPath) {
            return group + ':' + folderPath;
        }

        function buildTree(items) {
            var root = { dirs: {}, dirOrder: [], files: [] };
            items.forEach(function (item) {
                var segments = item.path.split('/');
                var node = root;
                var prefix = '';
                for (var index = 0; index < segments.length - 1; index += 1) {
                    prefix = prefix ? prefix + '/' + segments[index] : segments[index];
                    if (!node.dirs[segments[index]]) {
                        node.dirs[segments[index]] = {
                            name: segments[index],
                            fullPath: prefix,
                            dirs: {},
                            dirOrder: [],
                            files: [],
                        };
                        node.dirOrder.push(segments[index]);
                    }
                    node = node.dirs[segments[index]];
                }
                node.files.push(item);
            });
            return root;
        }

        function sortTree(node) {
            node.dirOrder.sort();
            node.files.sort(function (left, right) {
                return left.path < right.path ? -1
                    : left.path > right.path ? 1 : 0;
            });
            node.dirOrder.forEach(function (name) {
                sortTree(node.dirs[name]);
            });
        }

        // SCM-style compression (PRD 体验反馈): a directory chain whose
        // levels each hold a single child directory and no files renders as
        // one row (a/b/c) instead of one indented row per level. The chain's
        // final directory keeps the collapse key and tooltip.
        function compressDir(dir) {
            var names = [dir.name];
            var node = dir;
            while (node.files.length === 0 && node.dirOrder.length === 1) {
                node = node.dirs[node.dirOrder[0]];
                names.push(node.name);
            }
            return { name: names.join('/'), node: node };
        }

        function renderTreeNode(group, node, container, memberId, depth, context) {
            node.dirOrder.forEach(function (name) {
                var compressed = compressDir(node.dirs[name]);
                var dir = compressed.node;
                var key = folderKey(group, dir.fullPath);
                var collapsed = !!context.collapsedFolders[key];
                var folderRow = document.createElement('button');
                folderRow.type = 'button';
                folderRow.className = 'conversation-changes-folder';
                folderRow.style.paddingLeft = (0.2 + depth * 0.7) + 'rem';
                folderRow.setAttribute('aria-expanded',
                    collapsed ? 'false' : 'true');
                folderRow.setAttribute('data-tooltip', dir.fullPath);
                var chevron = document.createElement('span');
                chevron.className = 'conversation-changes-folder-chevron';
                chevron.textContent = collapsed ? '▸' : '▾';
                folderRow.appendChild(chevron);
                var label = document.createElement('span');
                label.className = 'conversation-changes-folder-name';
                label.textContent = compressed.name;
                folderRow.appendChild(label);
                var children = document.createElement('div');
                children.hidden = collapsed;
                folderRow.addEventListener('click', function () {
                    context.collapsedFolders[key] = !collapsed;
                    children.hidden = !children.hidden;
                    chevron.textContent = children.hidden ? '▸' : '▾';
                    folderRow.setAttribute('aria-expanded',
                        children.hidden ? 'false' : 'true');
                });
                container.appendChild(folderRow);
                container.appendChild(children);
                renderTreeNode(group, dir, children, memberId, depth + 1,
                    context);
            });
            node.files.forEach(function (item) {
                var row = renderFileRow(memberId, item);
                row.style.paddingLeft = (0.2 + depth * 0.7) + 'rem';
                container.appendChild(row);
            });
        }

        function renderGroups(detail) {
            if (!groupsRoot) return;
            // A member switch captures the outgoing member's scroll
            // position synchronously — the rebuild clamps scrollTop to 0
            // and the async scroll event would otherwise land on the new
            // member's context.
            if (currentMemberId && currentMemberId !== detail.memberId) {
                contextFor(currentMemberId).scrollTop = groupsRoot.scrollTop;
            }
            currentMemberId = detail.memberId;
            var context = contextFor(detail.memberId);
            // Rebuilt rows orphan any trigger the overlay points at —
            // close it instead of leaving a stale hint mid-viewport.
            tooltip.hide();
            clearChildren(groupsRoot);
            SECTION_GROUPS.forEach(function (sectionGroups) {
                var group = sectionGroups[0];
                var items = detail.items.filter(function (item) {
                    return sectionGroups.indexOf(item.group) !== -1;
                });
                if (!items.length) return;
                var collapsed = !!context.collapsedGroups[group];
                var section = document.createElement('div');
                section.className = 'conversation-changes-group';
                // Group headers are fold buttons (PRD §15.3): chevron +
                // title + the item-row count (a file staged and unstaged
                // counts twice — the workingItemCount reference frame).
                var header = document.createElement('button');
                header.type = 'button';
                header.className = 'conversation-changes-group-header';
                header.setAttribute('aria-expanded',
                    collapsed ? 'false' : 'true');
                var chevron = document.createElement('span');
                chevron.className = 'conversation-changes-group-chevron';
                chevron.setAttribute('aria-hidden', 'true');
                chevron.textContent = collapsed ? '▸' : '▾';
                header.appendChild(chevron);
                header.appendChild(document.createTextNode(' '));
                var title = document.createElement('span');
                title.className = 'conversation-changes-group-title';
                title.textContent = GROUP_TITLES[group];
                header.appendChild(title);
                var count = document.createElement('span');
                count.className = 'conversation-changes-group-count';
                count.textContent = ' · ' + items.length;
                header.appendChild(count);
                section.appendChild(header);
                var list = document.createElement('div');
                list.className = 'conversation-changes-group-list';
                list.hidden = collapsed;
                header.addEventListener('click', function () {
                    var nowCollapsed = !context.collapsedGroups[group];
                    context.collapsedGroups[group] = nowCollapsed;
                    list.hidden = nowCollapsed;
                    chevron.textContent = nowCollapsed ? '▸' : '▾';
                    header.setAttribute('aria-expanded',
                        nowCollapsed ? 'false' : 'true');
                });
                var tree = buildTree(items);
                sortTree(tree);
                renderTreeNode(group, tree, list, detail.memberId, 0, context);
                section.appendChild(list);
                groupsRoot.appendChild(section);
            });
            // Restore the member's remembered scroll position after the
            // rebuild (PRD §15.2); the browser clamps stale values.
            groupsRoot.scrollTop = context.scrollTop;
        }

        // Collapse/Expand All (PRD §15.3): every group header and every
        // directory of the current member at once — Collapse All leaves a
        // plain list of group header rows.
        function collectFolderKeys(group, node, keys) {
            node.dirOrder.forEach(function (name) {
                var compressed = compressDir(node.dirs[name]);
                var dir = compressed.node;
                keys.push(folderKey(group, dir.fullPath));
                collectFolderKeys(group, dir, keys);
            });
        }

        function setAllCollapsed(collapsed) {
            if (!latestState || !latestState.detail) {
                return;
            }
            var detail = latestState.detail;
            var context = contextFor(detail.memberId);
            SECTION_GROUPS.forEach(function (sectionGroups) {
                var group = sectionGroups[0];
                var items = detail.items.filter(function (item) {
                    return sectionGroups.indexOf(item.group) !== -1;
                });
                if (!items.length) return;
                context.collapsedGroups[group] = collapsed;
                var keys = [];
                collectFolderKeys(group, buildTree(items), keys);
                keys.forEach(function (key) {
                    context.collapsedFolders[key] = collapsed;
                });
            });
            renderGroups(detail);
        }

        // The fold actions die when there is nothing to fold (PRD §15.3:
        // the no-changes empty state disables both buttons).
        function updateFoldActions() {
            var empty = !latestState || !latestState.detail
                || latestState.detail.items.length === 0;
            if (collapseAllButton) {
                collapseAllButton.disabled = empty;
            }
            if (expandAllButton) {
                expandAllButton.disabled = empty;
            }
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
            // The header rows stay visible in every state; only the
            // task-result row and lists degrade.
            if (taskRoot) {
                taskRoot.hidden = !content;
            }
            if (!content) return;
            renderHeader(state);

            var detail = state.detail;
            var aggregate = state.aggregate;
            renderCrossMemberNote(state);

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
                    // Line 1, baseline reference frame (PRD §14.1).
                    taskSummary.textContent = 'Since start · '
                        + detail.taskFileCount + ' files · '
                        + (detail.aheadCount || 0) + ' commits';
                } else if (detail.availability === 'baselineUnavailable') {
                    taskSummary.textContent = 'No recorded task start'
                        + ' — only uncommitted changes are shown';
                } else if (detail.availability === 'historyRewritten') {
                    taskSummary.textContent = 'History rewritten'
                        + ' — the recorded task start is no longer an ancestor';
                } else {
                    taskSummary.textContent = '';
                }
            }
            renderTracking(state);
            if (reviewButton) {
                // No baseline (or nothing to review) hides the action
                // entirely — a dead Review link reads as a bug.
                reviewButton.hidden = !showTask
                    || !(detail.taskFileCount > 0 || (detail.aheadCount || 0) > 0);
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
            updateFoldActions();
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
            // ‹ › reuse the plain select intent — the protocol needs no
            // next/previous command (PRD §14.2).
            if (prevButton) {
                prevButton.addEventListener('click', function () {
                    cycleMember(-1);
                });
            }
            if (nextButton) {
                nextButton.addEventListener('click', function () {
                    cycleMember(1);
                });
            }
            if (crossMemberNote) {
                crossMemberNote.addEventListener('click', function () {
                    if (!latestState) {
                        return;
                    }
                    var target = crossMemberTarget(latestState);
                    if (target) {
                        post({
                            type: 'conversation-viewer-changes-select',
                            version: 1,
                            memberId: target.memberId,
                        });
                    }
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
            if (collapseAllButton) {
                collapseAllButton.addEventListener('click', function () {
                    setAllCollapsed(true);
                });
            }
            if (expandAllButton) {
                expandAllButton.addEventListener('click', function () {
                    setAllCollapsed(false);
                });
            }
            if (groupsRoot) {
                // Track the live scroll position into the bound member's
                // context so same-member re-renders and later switches
                // back restore it (PRD §15.2).
                groupsRoot.addEventListener('scroll', function () {
                    if (currentMemberId) {
                        contextFor(currentMemberId).scrollTop =
                            groupsRoot.scrollTop;
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
            // Session switches advance the viewer's generation without a
            // document rebuild — adopt it and drop the old session's
            // state, or every later changes message is rejected as stale.
            resetSession: function (generation) {
                subscriptionGeneration = generation;
                latestState = null;
                lastSelectSignature = '';
                lastLiveText = '';
                memberContexts = {};
                currentMemberId = null;
                updateFoldActions();
                tooltip.hide();
                if (button) {
                    button.hidden = true;
                    button.classList.remove(
                        'conversation-telemetry-changes-unavailable');
                    updateToggle();
                }
                if (groupsRoot) {
                    clearChildren(groupsRoot);
                }
                // Self-heal any ordering race: the host publishes the new
                // session's state right after the switch page, but this
                // controller only adopts the new generation when that page
                // arrives — an early push would be dropped. Pull instead.
                post({
                    type: 'conversation-viewer-changes-refresh',
                    version: 1,
                });
            },
            getSelectedMemberId: function () {
                return latestState && latestState.selectedMemberId;
            },
        };
    }

    window.__agentPivotConversation.changes = { create: create };
}());
