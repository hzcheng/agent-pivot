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
        var foldToggleButton = options.foldToggle;
        var groupsRoot = options.groupsRoot;
        var emptyRoot = options.emptyRoot;
        var unavailableRoot = options.unavailableRoot;
        var openScmButton = options.openScmButton;
        var subtabsRoot = options.subtabs;
        var filesView = options.filesView;
        var commitsView = options.commitsView;
        var commitsSummary = options.commitsSummary;
        var commitsTracking = options.commitsTracking;
        var commitsNotice = options.commitsNotice;
        var commitsList = options.commitsList;
        var commitsEmpty = options.commitsEmpty;
        var commitsLoading = options.commitsLoading;
        var commitsError = options.commitsError;
        var commitsRetry = options.commitsRetry;
        var commitsMore = options.commitsMore;
        var commitsFull = options.commitsFull;
        var getSubTab = options.getChangesSubTab
            || function () { return 'files'; };
        var setSubTab = options.setChangesSubTab || function () {};
        var updateToggle = options.updateToggle || function () {};
        var subscriptionGeneration = options.subscriptionGeneration;
        var target = options.target;
        var tooltip = options.panelRoot
            ? createTooltipOverlay(options.panelRoot)
            : { hide: function () {} };
        var latestState = null;
        var lastSelectSignature = '';
        var lastLiveText = '';
        var pendingMemberId = null;
        var highestChangesVersion = 0;

        // Every action intent carries the authoritative target identity and
        // the current generation: the host drops intents stranded by a
        // session switch instead of acting on the newly active session.
        function postAction(message) {
            if (!target) {
                return;
            }
            message.subscriptionGeneration = subscriptionGeneration;
            message.projectId = target.projectId;
            message.provider = target.provider;
            message.sessionId = target.sessionId;
            post(message);
        }

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

        function clearAuthoritativeContent() {
            if (prevButton) prevButton.hidden = true;
            if (nextButton) nextButton.hidden = true;
            if (positionIndicator) {
                positionIndicator.hidden = true;
                positionIndicator.textContent = '';
            }
            if (repoPicker) repoPicker.hidden = true;
            if (repoTitle) {
                repoTitle.hidden = true;
                repoTitle.textContent = '';
                repoTitle.removeAttribute('data-tooltip');
            }
            if (repoName) repoName.textContent = '';
            if (repoLabel) repoLabel.removeAttribute('data-tooltip');
            if (outsideBadge) outsideBadge.hidden = true;
            if (branchRoot) branchRoot.hidden = true;
            if (branchRoot) branchRoot.removeAttribute('data-tooltip');
            if (branchPrefix) branchPrefix.textContent = '';
            if (branchTail) branchTail.textContent = '';
            if (liveRegion) {
                lastLiveText = '';
                liveRegion.textContent = '';
            }
            if (crossMemberNote) crossMemberNote.hidden = true;
            if (taskRoot) taskRoot.hidden = true;
            if (taskSummary) {
                taskSummary.textContent = '';
                taskSummary.removeAttribute('data-tooltip');
            }
            if (taskTracking) {
                taskTracking.hidden = true;
                taskTracking.textContent = '';
                taskTracking.removeAttribute('data-tooltip');
            }
            if (reviewButton) reviewButton.hidden = true;
            if (refreshButton) refreshButton.disabled = true;
            if (openScmButton) openScmButton.disabled = true;
            if (groupsRoot) clearChildren(groupsRoot);
            if (emptyRoot) emptyRoot.hidden = true;
            if (commitsList) clearChildren(commitsList);
            if (commitsEmpty) commitsEmpty.hidden = true;
            if (commitsLoading) commitsLoading.hidden = true;
            if (commitsError) commitsError.hidden = true;
            if (commitsMore) commitsMore.hidden = true;
            if (commitsFull) commitsFull.hidden = true;
            if (commitsNotice) commitsNotice.hidden = true;
            if (commitsSummary) {
                commitsSummary.textContent = '';
                commitsSummary.removeAttribute('data-tooltip');
            }
            if (commitsTracking) {
                commitsTracking.hidden = true;
                commitsTracking.textContent = '';
                commitsTracking.removeAttribute('data-tooltip');
            }
            commitsFocusKey = null;
            currentMemberId = null;
            lastFocusedTreeKey = null;
            pendingFocusRestore = null;
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
                    + ' · commits unknown'
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
            if (branchRoot) branchRoot.hidden = !member;
            if (refreshButton) refreshButton.disabled = false;
            if (openScmButton) openScmButton.disabled = false;
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
            var pending = pendingMemberId
                ? members.find(function (member) {
                    return member.memberId === pendingMemberId;
                })
                : null;
            var current = pending || selectedMemberOf(latestState);
            var index = current ? members.indexOf(current) : 0;
            if (index < 0) {
                index = 0;
            }
            var target = members[
                (index + delta + members.length) % members.length];
            if (target) {
                pendingMemberId = target.memberId;
                postAction({
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
                }).slice(0, MAX_TOOLTIP_MEMBER_LINES)
                    .concat(others.length > MAX_TOOLTIP_MEMBER_LINES
                        ? ['+' + (others.length - MAX_TOOLTIP_MEMBER_LINES)
                            + ' more']
                        : [])
                    .join('\n'));
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
                var trackingText = 'Tracking '
                    + shortUpstreamRef(upstream.fullRef) + ' · '
                    + upstream.ahead + ' ahead · ' + upstream.behind
                    + ' behind';
                taskTracking.textContent = trackingText;
                taskTracking.setAttribute('data-tooltip',
                    trackingText + '\n' + upstream.fullRef
                        + '\nBased on local remote-tracking refs; '
                        + 'no fetch was performed');
            } else {
                var stateText = upstream.status === 'none'
                    ? 'No tracking branch'
                    : 'Tracking unknown';
                taskTracking.textContent = stateText;
                taskTracking.setAttribute('data-tooltip', stateText);
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
            row.tabIndex = -1;
            row.setAttribute('data-changes-node-type', 'file');
            row.setAttribute('data-changes-node-key',
                item.group + ':' + item.path);
            row.setAttribute('role', 'treeitem');
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
                postAction({
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
        var memberContexts = new Map();
        var currentMemberId = null;
        var lastFocusedTreeKey = null;
        var pendingFocusRestore = null;
        var treeNodeSequence = 0;

        var TREE_ROW_SELECTOR = '.conversation-changes-group-header, '
            + '.conversation-changes-folder, .conversation-changes-file';

        function isRowVisible(row) {
            for (var element = row; element && element !== groupsRoot;
                element = element.parentElement) {
                if (element.hidden) return false;
            }
            return true;
        }

        function treeRows() {
            if (!groupsRoot) return [];
            return Array.prototype.slice.call(
                groupsRoot.querySelectorAll(TREE_ROW_SELECTOR)
            ).filter(isRowVisible);
        }

        function rowByKey(key) {
            if (!groupsRoot || !key) return null;
            return Array.prototype.slice.call(
                groupsRoot.querySelectorAll('[data-changes-node-key]')
            ).find(function (row) {
                return row.getAttribute('data-changes-node-key') === key;
            });
        }

        function focusTreeRow(row) {
            if (!row) return;
            updateRovingTabIndices(row);
            row.focus();
            lastFocusedTreeKey = row.getAttribute('data-changes-node-key');
        }

        function updateRovingTabIndices(preferredRow) {
            var rows = treeRows();
            var current = preferredRow && isRowVisible(preferredRow)
                ? preferredRow
                : rows.find(function (row) {
                    return row.tabIndex === 0;
                });
            if (!current) {
                current = rows[0];
            }
            rows.forEach(function (row) {
                row.tabIndex = row === current ? 0 : -1;
            });
            if (current) {
                lastFocusedTreeKey = current.getAttribute(
                    'data-changes-node-key');
            } else {
                lastFocusedTreeKey = null;
            }
        }

        function parentRowOf(row) {
            return rowByKey(row.getAttribute('data-parent-key'));
        }

        function ancestryKeysOf(row) {
            var keys = [];
            var parent = parentRowOf(row);
            while (parent) {
                keys.push(parent.getAttribute('data-changes-node-key'));
                parent = parentRowOf(parent);
            }
            return keys;
        }

        function rememberFocusedTreeRow() {
            var active = document.activeElement;
            var row = active && active.closest
                ? active.closest(TREE_ROW_SELECTOR)
                : null;
            if (!row || !groupsRoot || !groupsRoot.contains(row)) {
                row = rowByKey(lastFocusedTreeKey);
            }
            if (!row) return null;
            var parentKey = row.getAttribute('data-parent-key');
            var siblings = treeRows().filter(function (candidate) {
                return candidate.getAttribute('data-parent-key') === parentKey;
            });
            var index = siblings.indexOf(row);
            return {
                key: row.getAttribute('data-changes-node-key'),
                ancestry: ancestryKeysOf(row),
                previousSibling: index > 0
                    ? siblings[index - 1].getAttribute('data-changes-node-key')
                    : null,
                nextSibling: index >= 0 && index + 1 < siblings.length
                    ? siblings[index + 1].getAttribute('data-changes-node-key')
                    : null,
            };
        }

        function restoreFocusedTreeRow() {
            var restore = pendingFocusRestore;
            pendingFocusRestore = null;
            if (!restore) {
                updateRovingTabIndices();
                return;
            }
            var exact = rowByKey(restore.key);
            if (exact && isRowVisible(exact)) {
                focusTreeRow(exact);
                return;
            }
            var candidates = [restore.nextSibling, restore.previousSibling]
                .concat(restore.ancestry);
            for (var index = 0; index < candidates.length; index += 1) {
                var candidate = rowByKey(candidates[index]);
                if (candidate && isRowVisible(candidate)) {
                    focusTreeRow(candidate);
                    return;
                }
            }
            updateRovingTabIndices();
        }

        function contextFor(memberId) {
            var context = memberContexts.get(memberId);
            if (!context) {
                context = {
                    collapsedFolders: {},
                    collapsedGroups: {},
                    scrollTop: 0,
                };
                memberContexts.set(memberId, context);
            }
            return context;
        }

        function folderKey(group, folderPath) {
            return group + ':' + folderPath;
        }

        function buildTree(items) {
            var root = { dirs: new Map(), dirOrder: [], files: [] };
            items.forEach(function (item) {
                var segments = item.path.split('/');
                var node = root;
                var prefix = '';
                for (var index = 0; index < segments.length - 1; index += 1) {
                    prefix = prefix ? prefix + '/' + segments[index] : segments[index];
                    if (!node.dirs.has(segments[index])) {
                        node.dirs.set(segments[index], {
                            name: segments[index],
                            fullPath: prefix,
                            dirs: new Map(),
                            dirOrder: [],
                            files: [],
                        });
                        node.dirOrder.push(segments[index]);
                    }
                    node = node.dirs.get(segments[index]);
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
                sortTree(node.dirs.get(name));
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
                node = node.dirs.get(node.dirOrder[0]);
                names.push(node.name);
            }
            return { name: names.join('/'), node: node };
        }

        function renderTreeNode(group, node, container, memberId, depth,
            context, parentKey) {
            node.dirOrder.forEach(function (name) {
                var compressed = compressDir(node.dirs.get(name));
                var dir = compressed.node;
                var key = folderKey(group, dir.fullPath);
                var collapsed = !!context.collapsedFolders[key];
                var folderRow = document.createElement('button');
                folderRow.type = 'button';
                folderRow.className = 'conversation-changes-folder';
                folderRow.tabIndex = -1;
                folderRow.setAttribute('data-changes-node-type', 'folder');
                folderRow.setAttribute('data-changes-node-key', key);
                folderRow.id = 'conversation-changes-node-'
                    + (treeNodeSequence += 1);
                folderRow.setAttribute('role', 'treeitem');
                if (parentKey) {
                    folderRow.setAttribute('data-parent-key', parentKey);
                }
                folderRow.setAttribute('aria-level', String(depth + 2));
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
                children.id = 'conversation-changes-node-'
                    + (treeNodeSequence += 1);
                children.hidden = collapsed;
                folderRow.setAttribute('aria-owns', children.id);
                children.setAttribute('role', 'group');
                folderRow.addEventListener('click', function () {
                    context.collapsedFolders[key] = !children.hidden;
                    children.hidden = !children.hidden;
                    chevron.textContent = children.hidden ? '▸' : '▾';
                    folderRow.setAttribute('aria-expanded',
                        children.hidden ? 'false' : 'true');
                });
                container.appendChild(folderRow);
                container.appendChild(children);
                renderTreeNode(group, dir, children, memberId, depth + 1,
                    context, key);
            });
            node.files.forEach(function (item) {
                var row = renderFileRow(memberId, item);
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-level', String(depth + 2));
                row.setAttribute('data-parent-key', parentKey);
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
                pendingFocusRestore = null;
            }
            var switchedMembers = !!currentMemberId
                && currentMemberId !== detail.memberId;
            currentMemberId = detail.memberId;
            var context = contextFor(detail.memberId);
            // Rebuilt rows orphan any trigger the overlay points at —
            // close it instead of leaving a stale hint mid-viewport.
            tooltip.hide();
            var activeElement = document.activeElement;
            var activeRow = activeElement && activeElement.closest
                ? activeElement.closest(TREE_ROW_SELECTOR)
                : null;
            if (activeRow && groupsRoot.contains(activeRow)
                && !switchedMembers) {
                pendingFocusRestore = rememberFocusedTreeRow();
            }
            clearChildren(groupsRoot);
            groupsRoot.setAttribute('role', 'tree');
            groupsRoot.setAttribute('aria-label', 'Worktree changes');
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
                header.id = 'conversation-changes-node-'
                    + (treeNodeSequence += 1);
                header.tabIndex = -1;
                header.setAttribute('role', 'treeitem');
                header.setAttribute('data-changes-node-type', 'group');
                header.setAttribute('data-changes-node-key',
                    'group:' + group);
                header.setAttribute('data-parent-key', '');
                header.setAttribute('aria-level', '1');
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
                list.id = 'conversation-changes-node-'
                    + (treeNodeSequence += 1);
                list.className = 'conversation-changes-group-list';
                list.hidden = collapsed;
                header.setAttribute('aria-owns', list.id);
                list.setAttribute('role', 'group');
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
                renderTreeNode(group, tree, list, detail.memberId, 0,
                    context, 'group:' + group);
                section.appendChild(list);
                groupsRoot.appendChild(section);
            });
            // Restore the member's remembered scroll position after the
            // rebuild (PRD §15.2); the browser clamps stale values.
            groupsRoot.scrollTop = context.scrollTop;
            restoreFocusedTreeRow();
        }

        // Collapse/Expand All (PRD §15.3): every group header and every
        // directory of the current member at once — Collapse All leaves a
        // plain list of group header rows.
        function collectFolderKeys(group, node, keys) {
            node.dirOrder.forEach(function (name) {
                var compressed = compressDir(node.dirs.get(name));
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
            var activeElement = document.activeElement;
            var activeRow = activeElement && activeElement.closest
                ? activeElement.closest(TREE_ROW_SELECTOR)
                : null;
            if (activeRow && groupsRoot.contains(activeRow)) {
                var remembered = rememberFocusedTreeRow();
                if (remembered) {
                    pendingFocusRestore = remembered;
                }
            } else {
                pendingFocusRestore = null;
            }
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
            updateFoldActions();
        }

        // The fold actions die when there is nothing to fold (PRD §15.3:
        // the no-changes empty state disables both buttons).
        // Live fold state comes from the DOM (aria-expanded), never from
        // render-time captures — refresh and member switches re-render.
        function foldRows() {
            if (!groupsRoot) return [];
            return Array.prototype.slice.call(groupsRoot.querySelectorAll(
                '.conversation-changes-group-header, '
                    + '.conversation-changes-folder'));
        }

        function allCollapsedNow() {
            var rows = foldRows();
            return rows.length > 0 && rows.every(function (row) {
                return row.getAttribute('aria-expanded') === 'false';
            });
        }

        // One toggle: anything expanded ⇒ Collapse all; fully collapsed ⇒
        // Expand all. Always visible; inert in the Commits tab.
        function updateFoldActions() {
            if (!foldToggleButton) {
                return;
            }
            var empty = !latestState || !latestState.detail
                || latestState.detail.items.length === 0;
            foldToggleButton.disabled = empty
                || activeSubTab === 'commits';
            var expand = !empty && allCollapsedNow();
            var label = expand ? 'Expand all' : 'Collapse all';
            foldToggleButton.setAttribute('aria-label', label);
            foldToggleButton.setAttribute('data-tooltip', label);
            Array.prototype.forEach.call(
                foldToggleButton.querySelectorAll('[data-fold-icon]'),
                function (icon) {
                    var show = icon.getAttribute('data-fold-icon')
                        === (expand ? 'expand' : 'collapse');
                    icon.style.display = show ? '' : 'none';
                });
        }

        function renderPanel(state) {
            var unavailable = state.kind === 'retired'
                || state.kind === 'unavailable'
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
            if (!content || !state.detail) {
                clearAuthoritativeContent();
                return;
            }
            renderHeader(state);

            var detail = state.detail;
            var aggregate = state.aggregate;
            renderCrossMemberNote(state);

            var knownTask = detail.baselineSha !== undefined
                && detail.availability === 'available'
                && detail.taskFileCount !== undefined;
            var showTask = knownTask;
            if (taskRoot) {
                taskRoot.hidden = detail.availability === 'unreadable';
            }
            if (taskSummary && detail) {
                var summaryText;
                if (knownTask) {
                    // Line 1, baseline reference frame (PRD §14.1).
                    summaryText = 'Since start · '
                        + detail.taskFileCount + ' files · '
                        + (detail.aheadCount === undefined
                            ? '?'
                            : detail.aheadCount)
                        + ' commits';
                } else if (detail.availability === 'baselineUnavailable') {
                    summaryText = 'No recorded task start'
                        + ' — only uncommitted changes are shown';
                } else if (detail.availability === 'historyRewritten') {
                    summaryText = 'History rewritten'
                        + ' — the recorded task start is no longer an ancestor';
                } else {
                    summaryText = detail.availability === 'available'
                        ? 'Since start · ? files'
                            + (detail.aheadCount === undefined
                                ? ' · ? commits'
                                : ' · ' + detail.aheadCount + ' commits')
                        : '';
                }
                taskSummary.textContent = summaryText;
                if (summaryText) {
                    taskSummary.setAttribute('data-tooltip', summaryText
                        + '\nNet result vs task start — includes committed '
                        + 'and uncommitted changes');
                } else {
                    taskSummary.removeAttribute('data-tooltip');
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
            // Commits tab (PRD §14.3.2/§15.5): a signature change drops
            // the member's cache; a visible tab silently refetches.
            applySubTabVisibility();
            if (activeSubTab === 'commits') {
                ensureCommits(state);
                renderCommits(state);
            }
            void aggregate;
        }

        function apply(message) {
            // Commits responses (PRD §14.3) route through the same entry;
            // validators drop malformed, stale-generation, or superseded
            // payloads before any cache is touched.
            if (applyCommitsMessage(message)) {
                return true;
            }
            if (!message || typeof message !== 'object'
                || message.type !== 'conversation-viewer-changes'
                || (message.version !== 1 && message.version !== 2)
                || message.subscriptionGeneration !== subscriptionGeneration
                || !validState(message.changes)) {
                return false;
            }
            if (message.version === 1 && highestChangesVersion === 2) {
                return false;
            }
            highestChangesVersion = Math.max(
                highestChangesVersion, message.version);
            latestState = message.changes;
            if (!pendingMemberId
                || latestState.selectedMemberId === pendingMemberId) {
                pendingMemberId = null;
            }
            renderButton(latestState);
            renderPanel(latestState);
            updateFoldActions();
            return true;
        }

        // ===== Commits sub-tab (PRD §14.3 request/response lazy loading,
        // §15.4 framework, §15.5 rendering, §15.2 per-member memory) =====

        var activeSubTab = getSubTab() === 'commits' ? 'commits' : 'files';
        var commitsRequestSeq = 0;
        // Per-member caches (PRD §15.2): scope, pages, expansion, and
        // scroll survive a member switch; the invalidation signature
        // (§14.3 失效纪律) drops them when the underlying refs move.
        var commitsCaches = new Map();
        // Bounds (panel-lifetime memory discipline): at most 16 member
        // caches, at most 32 expanded commit details per member.
        var COMMITS_CACHE_MEMBER_LIMIT = 16;
        var COMMITS_EXPANDED_LIMIT = 32;
        // Roving-focus identity across re-renders: '<sha>' for a commit
        // row, '<sha>\0<file path>' for a file row, '<sha>\0review' for
        // the review action row.
        var commitsFocusKey = null;

        function nextCommitsRequestId() {
            commitsRequestSeq += 1;
            return 'commits-' + commitsRequestSeq;
        }

        // Full list-state reset (refresh ⟳, Retry, history-moved):
        // member scope memory and the cache's identity survive, paged
        // data and expansion do not.
        function resetCommitsList(cache) {
            cache.status = 'idle';
            cache.degraded = null;
            cache.historyHead = null;
            cache.commits = [];
            cache.earlierCommits = [];
            cache.seenShas = Object.create(null);
            cache.hasMore = false;
            cache.sectionComplete = false;
            cache.baselineRow = null;
            cache.earlierActive = false;
            cache.earlierHasMore = false;
            cache.earlierOffset = 0;
            cache.expanded = Object.create(null);
            cache.expandedOrder = [];
            cache.pageLoading = false;
            cache.latestListRequestId = null;
            cache.latestDetailRequestIds = Object.create(null);
        }

        // The invalidation signature (PRD §14.3.2): HEAD sha, baseline
        // identity, and the full upstream tuple — a push/fetch changes
        // fork counts and row badges without changing the commit list.
        function commitsSignatureOf(member, detail) {
            var upstream = member && member.upstream;
            return JSON.stringify([
                member.availability,
                member.headSha || null,
                detail && detail.baselineSha || null,
                upstream ? upstream.status : null,
                upstream && upstream.fullRef || null,
                upstream && upstream.sha || null,
                upstream && upstream.status === 'tracked'
                    ? upstream.ahead : null,
                upstream && upstream.status === 'tracked'
                    ? upstream.behind : null,
            ]);
        }

        function newCommitsCache(member, detail) {
            return {
                signature: commitsSignatureOf(member, detail),
                scope: 'since-start',
                status: 'idle',
                degraded: null,
                historyHead: null,
                commits: [],
                seenShas: Object.create(null),
                hasMore: false,
                sectionComplete: false,
                baselineRow: null,
                earlierActive: false,
                earlierHasMore: false,
                earlierOffset: 0,
                earlierCommits: [],
                expanded: Object.create(null),
                expandedOrder: [],
                scrollTop: 0,
                latestListRequestId: null,
                latestDetailRequestIds: Object.create(null),
            };
        }

        // A signature change invalidates the cache (§14.3.2); the scope
        // and expansion state survive a same-member refetch.
        function commitsCacheFor(member, detail) {
            var cache = commitsCaches.get(member.memberId);
            var signature = commitsSignatureOf(member, detail);
            if (cache && cache.signature === signature) {
                return cache;
            }
            var fresh = newCommitsCache(member, detail);
            if (cache) {
                fresh.scope = cache.scope;
                fresh.earlierActive = cache.earlierActive;
            }
            commitsCaches.set(member.memberId, fresh);
            if (commitsCaches.size > COMMITS_CACHE_MEMBER_LIMIT) {
                var oldest = commitsCaches.keys().next().value;
                if (oldest && oldest !== member.memberId) {
                    commitsCaches.delete(oldest);
                }
            }
            return fresh;
        }

        function requestCommitsPage(member, cache, scope, offset) {
            if (!member || !cache) {
                return;
            }
            var requestId = nextCommitsRequestId();
            cache.latestListRequestId = requestId;
            cache.status = cache.commits.length ? cache.status : 'loading';
            postAction({
                type: 'conversation-viewer-commits-list',
                version: 1,
                requestId: requestId,
                memberId: member.memberId,
                scope: scope,
                offset: offset,
                ...(cache.historyHead ? { historyHead: cache.historyHead } : {}),
            });
        }

        function requestCommitDetail(memberId, sha) {
            var cache = commitsCaches.get(memberId);
            if (!cache) {
                return;
            }
            var requestId = nextCommitsRequestId();
            cache.latestDetailRequestIds[sha] = requestId;
            postAction({
                type: 'conversation-viewer-commit-detail',
                version: 1,
                requestId: requestId,
                memberId: memberId,
                sha: sha,
            });
        }

        // ---- response validation (PRD §14.3.5 bounds) ----

        var COMMITS_DEGRADED = ['unreadable', 'timeout', 'history-moved',
            'unknown-commit', 'error'];
        var COMMIT_FILE_STATUSES = ['A', 'M', 'D', 'R', 'C', 'T', 'U'];

        function validCommitSha(value) {
            return typeof value === 'string'
                && /^[0-9a-f]{40}$/.test(value);
        }

        function validCommitsRequestId(value) {
            return typeof value === 'string'
                && /^[A-Za-z0-9-]{1,64}$/.test(value);
        }

        function validCommitSummary(commit) {
            return exactKeys(commit,
                    ['sha', 'subject', 'authorName', 'authorTime'],
                    ['inTrackingBranch'])
                && validCommitSha(commit.sha)
                && typeof commit.subject === 'string'
                && commit.subject.length <= 1024
                && typeof commit.authorName === 'string'
                && commit.authorName.length <= 256
                && Number.isSafeInteger(commit.authorTime)
                && commit.authorTime >= 0
                && (commit.inTrackingBranch === undefined
                    || typeof commit.inTrackingBranch === 'boolean');
        }

        function validCommitFile(file) {
            return exactKeys(file, ['path', 'status'],
                    ['oldPath', 'additions', 'deletions'])
                && typeof file.path === 'string'
                && file.path.length > 0 && file.path.length <= 4096
                && (file.oldPath === undefined
                    || (typeof file.oldPath === 'string'
                        && file.oldPath.length > 0
                        && file.oldPath.length <= 4096))
                && COMMIT_FILE_STATUSES.includes(file.status)
                && (file.additions === undefined
                    || (Number.isSafeInteger(file.additions)
                        && file.additions >= 0 && file.additions <= 1e7))
                && (file.deletions === undefined
                    || (Number.isSafeInteger(file.deletions)
                        && file.deletions >= 0 && file.deletions <= 1e7));
        }

        function validCommitsEnvelope(message, type, required, optional) {
            return message && typeof message === 'object'
                && !Array.isArray(message)
                && message.type === type
                && message.version === 1
                && exactKeys(message, required, optional)
                && validCommitsRequestId(message.requestId)
                && message.subscriptionGeneration === subscriptionGeneration
                && typeof message.memberId === 'string'
                && (message.degraded === undefined
                    || COMMITS_DEGRADED.includes(message.degraded));
        }

        function validCommitsListMessage(message) {
            if (!validCommitsEnvelope(message, 'conversation-viewer-commits',
                    ['type', 'version', 'requestId', 'subscriptionGeneration',
                        'memberId', 'scope', 'offset', 'historyHead',
                        'commits', 'hasMore'],
                    ['sectionComplete', 'baselineRow', 'degraded'])) {
                return false;
            }
            return (message.scope === 'since-start'
                    || message.scope === 'full')
                && Number.isSafeInteger(message.offset)
                && message.offset >= 0 && message.offset <= 1e6
                && (message.historyHead === ''
                    || validCommitSha(message.historyHead))
                && Array.isArray(message.commits)
                && message.commits.length <= 200
                && message.commits.every(validCommitSummary)
                && typeof message.hasMore === 'boolean'
                && (message.sectionComplete === undefined
                    || typeof message.sectionComplete === 'boolean')
                && (message.baselineRow === undefined
                    || (exactKeys(message.baselineRow, ['sha'], ['subject'])
                        && validCommitSha(message.baselineRow.sha)
                        && (message.baselineRow.subject === undefined
                            || typeof message.baselineRow.subject
                                === 'string')
                        && (message.baselineRow.subject === undefined
                            || message.baselineRow.subject.length
                                <= 1024)));
        }

        function validCommitDetailMessage(message) {
            if (!validCommitsEnvelope(message,
                    'conversation-viewer-commit-detail',
                    ['type', 'version', 'requestId', 'subscriptionGeneration',
                        'memberId', 'sha', 'files', 'totalFiles',
                        'filesTruncated'],
                    ['degraded'])) {
                return false;
            }
            return validCommitSha(message.sha)
                && Array.isArray(message.files)
                && message.files.length <= 400
                && message.files.every(validCommitFile)
                && Number.isSafeInteger(message.totalFiles)
                && message.totalFiles >= 0 && message.totalFiles <= 1e6
                && typeof message.filesTruncated === 'boolean';
        }

        // ---- response application: requestId + generation double
        // discard (PRD §14.3.4) ----

        function applyCommitsListResponse(message) {
            var cache = commitsCaches.get(message.memberId);
            if (!cache
                || message.requestId !== cache.latestListRequestId) {
                return true;
            }
            cache.latestListRequestId = null;
            cache.pageLoading = false;
            if (message.degraded === 'history-moved') {
                // History moved mid-pagination: discard the paged data
                // and restart the scope from its first page (§14.3).
                resetCommitsList(cache);
                var member = latestState && latestState.members.find(
                    function (candidate) {
                        return candidate.memberId === message.memberId;
                    });
                // The since-start scope always restarts first: the
                // Earlier section is re-entered explicitly via Show full
                // branch history (its data was discarded above).
                requestCommitsPage(member, cache, 'since-start', 0);
                renderCommitsIfVisible();
                return true;
            }
            if (message.degraded) {
                cache.status = 'error';
                cache.degraded = message.degraded;
                renderCommitsIfVisible();
                return true;
            }
            cache.status = 'ready';
            cache.degraded = null;
            cache.historyHead = message.historyHead || cache.historyHead;
            var target = message.scope === 'full'
                ? cache.earlierCommits
                : cache.commits;
            if (message.scope === 'full') {
                cache.earlierActive = true;
                cache.earlierHasMore = message.hasMore;
                cache.earlierOffset = message.offset
                    + message.commits.length;
            } else {
                cache.hasMore = message.hasMore;
            }
            message.commits.forEach(function (commit) {
                // Cross-page dedupe by sha (§14.3): the baseline closing
                // row and the full scope's first row share one sha.
                if (cache.seenShas[commit.sha]) {
                    return;
                }
                if (message.scope === 'full' && cache.baselineRow
                    && commit.sha === cache.baselineRow.sha) {
                    // The Earlier section starts at the baseline itself;
                    // its closing row is already rendered above.
                    return;
                }
                cache.seenShas[commit.sha] = true;
                target.push(commit);
            });
            if (message.sectionComplete) {
                cache.sectionComplete = true;
                cache.baselineRow = message.baselineRow || null;
            }
            renderCommitsIfVisible();
            return true;
        }

        function applyCommitDetailResponse(message) {
            var cache = commitsCaches.get(message.memberId);
            if (!cache
                || cache.latestDetailRequestIds[message.sha]
                    !== message.requestId) {
                return true;
            }
            delete cache.latestDetailRequestIds[message.sha];
            var entry = cache.expanded[message.sha];
            if (!entry) {
                // The row was collapsed or evicted while the request was
                // in flight: its response must not re-expand it.
                return true;
            }
            if (message.degraded) {
                entry.status = 'failed';
            } else {
                entry.status = 'ready';
                entry.files = message.files;
                entry.totalFiles = message.totalFiles;
                entry.filesTruncated = message.filesTruncated;
            }
            renderCommitsIfVisible();
            return true;
        }

        function applyCommitsMessage(message) {
            if (!message || typeof message !== 'object'
                || (message.type !== 'conversation-viewer-commits'
                    && message.type
                        !== 'conversation-viewer-commit-detail')) {
                return false;
            }
            if (message.type === 'conversation-viewer-commits') {
                return validCommitsListMessage(message)
                    ? (applyCommitsListResponse(message), true)
                    : false;
            }
            return validCommitDetailMessage(message)
                ? (applyCommitDetailResponse(message), true)
                : false;
        }

        // ---- rendering ----

        function relativeCommitTime(authorTime) {
            var seconds = Math.max(0, Math.floor(Date.now() / 1000)
                - authorTime);
            if (seconds < 60) return 'just now';
            var minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + 'm ago';
            var hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + 'h ago';
            var days = Math.floor(hours / 24);
            if (days < 30) return days + 'd ago';
            return new Date(authorTime * 1000).toLocaleDateString();
        }

        function commitsRowRows() {
            if (!commitsList) return [];
            return Array.prototype.slice.call(
                commitsList.querySelectorAll(
                    '.conversation-changes-commit-row, '
                        + '.conversation-changes-commit-file-row, '
                        + '.conversation-changes-commit-review-row'));
        }

        function focusCommitsRow(row) {
            commitsRowRows().forEach(function (candidate) {
                candidate.tabIndex = candidate === row ? 0 : -1;
            });
            if (row) {
                commitsFocusKey = commitsRowKeyOf(row);
                row.focus();
            }
        }

        function commitsRowKeyOf(row) {
            var sha = row.getAttribute('data-commit-sha');
            if (!sha) return null;
            if (row.classList.contains('conversation-changes-commit-row')) {
                return sha;
            }
            if (row.classList.contains(
                'conversation-changes-commit-review-row')) {
                return sha + '\0review';
            }
            return sha + '\0' + (row.getAttribute('data-file-path') || '');
        }

        function rowByCommitsKey(key) {
            if (!commitsList || !key) return null;
            return Array.prototype.slice.call(
                commitsList.querySelectorAll(
                    '.conversation-changes-commit-row, '
                        + '.conversation-changes-commit-file-row, '
                        + '.conversation-changes-commit-review-row')
            ).find(function (row) {
                return commitsRowKeyOf(row) === key;
            }) || null;
        }

        function setCommitsRowRoving(preferred) {
            var rows = commitsRowRows();
            var current = preferred
                || rowByCommitsKey(commitsFocusKey)
                || rows.find(function (row) { return row.tabIndex === 0; })
                || rows[0];
            rows.forEach(function (row) {
                row.tabIndex = row === current ? 0 : -1;
            });
        }

        function buildCommitRow(member, cache, commit) {
            var row = document.createElement('div');
            row.className = 'conversation-changes-commit-row';
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('data-commit-sha', commit.sha);
            var expanded = !!cache.expanded[commit.sha];
            row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            // The badge's semantics fold into the row label (PRD §15.5.2):
            // the badge itself never takes focus.
            var badgeText = commit.inTrackingBranch === false
                ? 'not in tracking branch'
                : commit.inTrackingBranch === true
                    ? 'in tracking branch'
                    : null;
            row.setAttribute('aria-label',
                commit.sha.slice(0, 7) + ', ' + commit.subject
                    + (badgeText ? ', ' + badgeText : ''));

            var firstLine = document.createElement('div');
            firstLine.className = 'conversation-changes-commit-line';
            var chevron = document.createElement('span');
            chevron.className = 'conversation-changes-commit-chevron';
            chevron.setAttribute('aria-hidden', 'true');
            chevron.textContent = expanded ? '▾' : '▸';
            firstLine.appendChild(chevron);
            if (badgeText) {
                var badge = document.createElement('span');
                badge.className = 'conversation-changes-commit-badge '
                    + (commit.inTrackingBranch
                        ? 'conversation-changes-commit-badge-in'
                        : 'conversation-changes-commit-badge-out');
                badge.setAttribute('aria-hidden', 'true');
                badge.textContent = commit.inTrackingBranch ? '✓' : '●';
                firstLine.appendChild(badge);
            }
            var sha = document.createElement('span');
            sha.className = 'conversation-changes-commit-sha';
            sha.textContent = commit.sha.slice(0, 7);
            firstLine.appendChild(sha);
            var subject = document.createElement('span');
            subject.className = 'conversation-changes-commit-subject '
                + 'conversation-changes-tooltip-target';
            subject.setAttribute('tabindex', '-1');
            subject.textContent = commit.subject;
            subject.setAttribute('data-tooltip', commit.subject);
            firstLine.appendChild(subject);
            row.appendChild(firstLine);

            var meta = document.createElement('div');
            meta.className = 'conversation-changes-commit-meta';
            meta.textContent = commit.authorName + ' · '
                + relativeCommitTime(commit.authorTime);
            row.appendChild(meta);
            return row;
        }

        function buildCommitFileRow(member, commit, file) {
            var row = document.createElement('div');
            row.className = 'conversation-changes-commit-file-row';
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('data-commit-sha', commit.sha);
            row.setAttribute('data-file-path', file.path);
            if (file.oldPath) {
                row.setAttribute('data-file-old-path', file.oldPath);
            }
            var status = document.createElement('span');
            status.className = 'conversation-changes-file-status '
                + 'conversation-changes-file-status-'
                + (file.status === 'A' ? 'untracked'
                    : file.status === 'D' ? 'deleted' : 'modified');
            status.textContent = file.status;
            row.appendChild(status);
            var name = document.createElement('span');
            name.className = 'conversation-changes-commit-file-name '
                + 'conversation-changes-tooltip-target';
            name.setAttribute('tabindex', '-1');
            var label = file.oldPath
                ? file.oldPath + ' → ' + file.path
                : file.path;
            name.textContent = file.path.split('/').pop();
            name.setAttribute('data-tooltip', label);
            row.appendChild(name);
            if (file.additions !== undefined
                || file.deletions !== undefined) {
                var numstat = document.createElement('span');
                numstat.className = 'conversation-changes-commit-numstat';
                numstat.textContent = '+'
                    + (file.additions === undefined ? '-' : file.additions)
                    + ' −'
                    + (file.deletions === undefined ? '-' : file.deletions);
                row.appendChild(numstat);
            }
            row.addEventListener('click', function () {
                postAction({
                    type: 'conversation-viewer-commit-open-file',
                    version: 1,
                    requestId: nextCommitsRequestId(),
                    memberId: member.memberId,
                    sha: commit.sha,
                    path: file.path,
                    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
                });
            });
            return row;
        }

        function buildCommitExpansion(member, cache, commit) {
            var entry = cache.expanded[commit.sha];
            var fragment = document.createDocumentFragment();
            if (!entry || entry.status === 'loading') {
                var loading = document.createElement('p');
                loading.className = 'conversation-changes-commit-inline-note';
                loading.textContent = 'Loading files…';
                fragment.appendChild(loading);
                return fragment;
            }
            if (entry.status === 'failed') {
                var failed = document.createElement('p');
                failed.className = 'conversation-changes-commit-inline-note';
                failed.textContent = 'Failed · ';
                var retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'conversation-changes-action';
                retry.textContent = 'Retry';
                retry.addEventListener('click', function () {
                    entry.status = 'loading';
                    requestCommitDetail(member.memberId, commit.sha);
                    renderCommitsIfVisible();
                });
                failed.appendChild(retry);
                fragment.appendChild(failed);
                return fragment;
            }
            entry.files.forEach(function (file) {
                fragment.appendChild(buildCommitFileRow(member, commit, file));
            });
            if (entry.filesTruncated) {
                var truncated = document.createElement('p');
                truncated.className =
                    'conversation-changes-commit-inline-note';
                truncated.textContent = 'Showing ' + entry.files.length
                    + ' of ' + entry.totalFiles + ' files';
                fragment.appendChild(truncated);
            }
            var review = document.createElement('div');
            review.className = 'conversation-changes-commit-review-row';
            review.setAttribute('role', 'treeitem');
            review.setAttribute('tabindex', '-1');
            review.setAttribute('data-commit-sha', commit.sha);
            var reviewButton = document.createElement('button');
            reviewButton.type = 'button';
            reviewButton.className = 'conversation-changes-action';
            // The treeitem row is the single Tab stop (PRD §17); the
            // button activates via the row's Enter/Space handling.
            reviewButton.tabIndex = -1;
            reviewButton.textContent = 'Review this commit';
            reviewButton.addEventListener('click', function () {
                postAction({
                    type: 'conversation-viewer-commit-review',
                    version: 1,
                    requestId: nextCommitsRequestId(),
                    memberId: member.memberId,
                    sha: commit.sha,
                });
            });
            review.appendChild(reviewButton);
            fragment.appendChild(review);
            return fragment;
        }

        function toggleCommitExpanded(member, cache, sha) {
            if (cache.expanded[sha]) {
                delete cache.expanded[sha];
                // Collapsing cancels the pending detail: its response
                // must not resurrect the row.
                delete cache.latestDetailRequestIds[sha];
                cache.expandedOrder = cache.expandedOrder.filter(
                    function (entry) { return entry !== sha; });
            } else {
                cache.expanded[sha] = { status: 'loading' };
                cache.expandedOrder.push(sha);
                // Evict the oldest expanded detail beyond the bound.
                while (cache.expandedOrder.length > COMMITS_EXPANDED_LIMIT) {
                    var evicted = cache.expandedOrder.shift();
                    delete cache.expanded[evicted];
                    delete cache.latestDetailRequestIds[evicted];
                }
                requestCommitDetail(member.memberId, sha);
            }
            renderCommitsIfVisible();
        }

        function renderCommitsIfVisible() {
            if (activeSubTab === 'commits' && latestState) {
                renderCommits(latestState);
            }
        }

        function renderCommits(state) {
            if (!commitsView) {
                return;
            }
            // Re-rendering detaches every row: remember whether focus
            // lived inside the list so it lands back on the same key
            // (PRD §17 focus discipline).
            var refocusCommits = commitsList
                && commitsList.contains(document.activeElement);
            var member = selectedMemberOf(state);
            if (!member) {
                return;
            }
            var detail = state.detail
                && state.detail.memberId === member.memberId
                ? state.detail
                : null;
            var cache = commitsCacheFor(member, detail);

            // Header (PRD §15.5.1): the member's own ahead count — the
            // same source as the Files tab's commit count.
            if (commitsSummary) {
                var summaryText;
                if (member.availability === 'baselineUnavailable'
                    || member.availability === 'historyRewritten') {
                    summaryText = 'Current branch history';
                } else {
                    summaryText = 'Since start · '
                        + (member.aheadCount === undefined
                            ? '? commits'
                            : member.aheadCount === 1
                                ? '1 commit'
                                : member.aheadCount + ' commits');
                }
                commitsSummary.textContent = summaryText;
                commitsSummary.setAttribute('data-tooltip', summaryText);
            }
            if (commitsTracking) {
                var upstream = member.upstream;
                if (!upstream) {
                    commitsTracking.hidden = true;
                } else {
                    commitsTracking.hidden = false;
                    var text = upstream.status === 'tracked'
                        ? 'Tracking ' + shortUpstreamRef(upstream.fullRef)
                            + ' · ' + upstream.ahead + ' ahead · '
                            + upstream.behind + ' behind'
                        : upstream.status === 'none'
                            ? 'No tracking branch'
                            : 'Tracking unknown';
                    commitsTracking.textContent = text;
                    commitsTracking.setAttribute('data-tooltip', text);
                }
            }

            // Baseline-missing notice (PRD §15.5.9): the whole tab is one
            // history stream; no fabricated Since-start boundary.
            var noticeText = member.availability === 'unreadable'
                    || cache.degraded === 'unreadable'
                ? 'This repository is unavailable.'
                : member.availability === 'baselineUnavailable'
                    ? 'Baseline unavailable — showing the current branch history'
                    : member.availability === 'historyRewritten'
                        ? 'History rewritten — showing the current branch history'
                        : null;
            if (commitsNotice) {
                commitsNotice.hidden = !noticeText;
                if (noticeText) {
                    commitsNotice.textContent = noticeText;
                }
            }
            var listUsable = member.availability !== 'unreadable'
                && cache.degraded !== 'unreadable';

            clearChildren(commitsList);
            if (!listUsable) {
                commitsList.hidden = true;
            } else {
                commitsList.hidden = false;
                cache.commits.forEach(function (commit) {
                    var row = buildCommitRow(member, cache, commit);
                    commitsList.appendChild(row);
                    if (cache.expanded[commit.sha]) {
                        commitsList.appendChild(
                            buildCommitExpansion(member, cache, commit));
                    }
                });
                if (cache.baselineRow) {
                    var baseline = document.createElement('div');
                    baseline.className =
                        'conversation-changes-commit-baseline';
                    var label = '○ (baseline)'
                        + (cache.baselineRow.subject
                            ? ' ' + cache.baselineRow.subject
                            : ' ' + cache.baselineRow.sha.slice(0, 7));
                    baseline.textContent = label;
                    baseline.setAttribute('data-tooltip', cache.baselineRow.sha);
                    commitsList.appendChild(baseline);
                }
                // The Earlier section appends below the baseline closing
                // row (PRD §15.5.7).
                if (cache.earlierActive && cache.earlierCommits.length) {
                    var earlierHeader = document.createElement('div');
                    earlierHeader.className =
                        'conversation-changes-commit-earlier-header';
                    earlierHeader.textContent = 'Earlier commits';
                    commitsList.appendChild(earlierHeader);
                    cache.earlierCommits.forEach(function (commit) {
                        var row = buildCommitRow(member, cache, commit);
                        commitsList.appendChild(row);
                        if (cache.expanded[commit.sha]) {
                            commitsList.appendChild(buildCommitExpansion(
                                member, cache, commit));
                        }
                    });
                }
                // Per-member scroll memory (§15.2).
                if (cache.scrollTop) {
                    commitsList.scrollTop = cache.scrollTop;
                }
            }

            if (commitsEmpty) {
                commitsEmpty.hidden = !listUsable
                    || cache.status === 'loading'
                    || cache.commits.length > 0;
            }
            if (commitsLoading) {
                commitsLoading.hidden = cache.status !== 'loading';
            }
            if (commitsError) {
                var errored = cache.status === 'error'
                    && cache.degraded !== 'unreadable';
                commitsError.hidden = !errored;
            }

            // Footer actions (PRD §15.5.7).
            var baselineKnown = member.availability === 'available'
                && detail && detail.baselineSha;
            if (commitsMore) {
                commitsMore.hidden = !listUsable
                    || cache.status !== 'ready' || !cache.hasMore;
                commitsMore.disabled = !!cache.pageLoading;
            }
            if (commitsFull) {
                commitsFull.hidden = !listUsable || !baselineKnown
                    || !cache.sectionComplete || cache.earlierActive;
            }
            // The Earlier section reuses the same Load more button after
            // activation: its request switches scope to 'full'.
            if (commitsMore && cache.earlierActive) {
                commitsMore.textContent = 'Load earlier commits';
                commitsMore.hidden = !listUsable || !cache.earlierHasMore;
            } else if (commitsMore) {
                commitsMore.textContent = 'Load more';
            }
            setCommitsRowRoving();
            if (refocusCommits) {
                // The exact row may be gone after a refresh or cache
                // invalidation: fall back to its parent commit row, then
                // the first row, then the sub-tab itself — focus never
                // falls to the document body (PRD §17).
                var focusRow = rowByCommitsKey(commitsFocusKey)
                    || (commitsFocusKey
                        && rowByCommitsKey(
                            String(commitsFocusKey).split('\0')[0]))
                    || commitsRowRows()[0];
                if (focusRow) {
                    focusCommitsRow(focusRow);
                } else if (subtabsRoot) {
                    var activeTab = subtabsRoot.querySelector(
                        '[data-changes-subtab="' + activeSubTab + '"]');
                    if (activeTab) {
                        activeTab.focus();
                    }
                }
            }
        }

        function ensureCommits(state) {
            var member = selectedMemberOf(state);
            if (!member) {
                return;
            }
            var detail = state.detail
                && state.detail.memberId === member.memberId
                ? state.detail
                : null;
            var cache = commitsCacheFor(member, detail);
            if (cache.status === 'idle'
                && member.availability !== 'unreadable') {
                cache.status = 'loading';
                requestCommitsPage(member, cache, cache.scope, 0);
            }
        }

        // ---- sub-tab framework (PRD §15.4) ----

        function applySubTabVisibility() {
            var commitsActive = activeSubTab === 'commits';
            if (filesView) {
                filesView.hidden = commitsActive;
            }
            if (commitsView) {
                commitsView.hidden = !commitsActive;
            }
            if (subtabsRoot) {
                Array.prototype.forEach.call(
                    subtabsRoot.querySelectorAll('[data-changes-subtab]'),
                    function (tab) {
                        var selected =
                            tab.getAttribute('data-changes-subtab')
                                === activeSubTab;
                        tab.setAttribute('aria-selected',
                            selected ? 'true' : 'false');
                        tab.tabIndex = selected ? 0 : -1;
                    });
            }
            // The fold toggle stays visible in the Commits tab but is
            // inert there (PRD §15.3/§15.4); refresh and SCM keep working.
            updateFoldActions();
        }

        function setActiveSubTab(tab, focusTab) {
            if (tab !== 'files' && tab !== 'commits'
                || tab === activeSubTab) {
                return;
            }
            activeSubTab = tab;
            setSubTab(tab, true);
            applySubTabVisibility();
            if (tab === 'commits' && latestState) {
                ensureCommits(latestState);
                renderCommits(latestState);
            }
            if (focusTab && subtabsRoot) {
                var tabElement = subtabsRoot.querySelector(
                    '[data-changes-subtab="' + tab + '"]');
                if (tabElement) {
                    tabElement.focus();
                }
            }
        }

        function handleCommitsKeydown(event) {
            var rows = commitsRowRows();
            if (!rows.length) {
                return;
            }
            var current = document.activeElement;
            var index = rows.indexOf(current);
            if (index < 0) {
                return;
            }
            var member = latestState && selectedMemberOf(latestState);
            var cache = member && commitsCaches.get(member.memberId);
            var sha = current.getAttribute('data-commit-sha');
            var isCommitRow = current.classList
                && current.classList.contains(
                    'conversation-changes-commit-row');
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                var next = event.key === 'ArrowDown'
                    ? Math.min(index + 1, rows.length - 1)
                    : Math.max(index - 1, 0);
                focusCommitsRow(rows[next]);
                return;
            }
            if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                focusCommitsRow(event.key === 'Home'
                    ? rows[0]
                    : rows[rows.length - 1]);
                return;
            }
            if (!isCommitRow || !member || !cache) {
                // A leaf's ArrowLeft moves to its parent commit row
                // (PRD §17 — same rule as the Files tree).
                if (event.key === 'ArrowLeft' && !isCommitRow && sha) {
                    event.preventDefault();
                    var parentRow = rowByCommitsKey(sha);
                    if (parentRow) {
                        focusCommitsRow(parentRow);
                    }
                    return;
                }
                // File and review rows are leaves: Enter/Space activates.
                if ((event.key === 'Enter' || event.key === ' ')
                    && !isCommitRow) {
                    event.preventDefault();
                    var nestedButton = current.querySelector
                        ? current.querySelector('button')
                        : null;
                    if (nestedButton) {
                        nestedButton.click();
                    } else {
                        current.click();
                    }
                }
                return;
            }
            if (event.key === 'ArrowRight' || event.key === 'Enter'
                || event.key === ' ') {
                event.preventDefault();
                if (!cache.expanded[sha]) {
                    toggleCommitExpanded(member, cache, sha);
                }
                return;
            }
            if (event.key === 'ArrowLeft' && cache.expanded[sha]) {
                event.preventDefault();
                toggleCommitExpanded(member, cache, sha);
            }
        }

        function attach() {
            if (memberSelect) {
                memberSelect.addEventListener('change', function () {
                    pendingMemberId = memberSelect.value;
                    postAction({
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
                        pendingMemberId = target.memberId;
                        postAction({
                            type: 'conversation-viewer-changes-select',
                            version: 1,
                            memberId: target.memberId,
                        });
                    }
                });
            }
            if (refreshButton) {
                refreshButton.addEventListener('click', function () {
                    // ⟳ recollects both the changes snapshot and the
                    // current member's commits list — two independently
                    // degraded paths (PRD §14.3.1).
                    var member = latestState && selectedMemberOf(latestState);
                    if (member && activeSubTab === 'commits') {
                        var cache = commitsCaches.get(member.memberId);
                        if (cache) {
                            resetCommitsList(cache);
                        }
                        ensureCommits(latestState);
                        renderCommits(latestState);
                    }
                    postAction({
                        type: 'conversation-viewer-changes-refresh',
                        version: 1,
                    });
                });
            }
            if (reviewButton) {
                reviewButton.addEventListener('click', function () {
                    if (latestState && latestState.selectedMemberId) {
                        postAction({
                            type: 'conversation-viewer-changes-review',
                            version: 1,
                            memberId: latestState.selectedMemberId,
                        });
                    }
                });
            }
            if (foldToggleButton) {
                foldToggleButton.addEventListener('click', function () {
                    setAllCollapsed(!allCollapsedNow());
                });
            }
            if (groupsRoot) {
                groupsRoot.addEventListener('focusin', function (event) {
                    var row = event.target.closest
                        ? event.target.closest(TREE_ROW_SELECTOR)
                        : null;
                    if (row && groupsRoot.contains(row)) {
                        focusTreeRow(row);
                    }
                });
                groupsRoot.addEventListener('keydown', function (event) {
                    var row = event.target.closest
                        ? event.target.closest(TREE_ROW_SELECTOR)
                        : null;
                    if (!row || !groupsRoot.contains(row)) return;
                    var rows = treeRows();
                    var index = rows.indexOf(row);
                    if (event.key === 'ArrowDown') {
                        if (index >= 0 && index + 1 < rows.length) {
                            event.preventDefault();
                            focusTreeRow(rows[index + 1]);
                        }
                    } else if (event.key === 'ArrowUp') {
                        if (index > 0) {
                            event.preventDefault();
                            focusTreeRow(rows[index - 1]);
                        }
                    } else if (event.key === 'Home') {
                        if (rows.length) {
                            event.preventDefault();
                            focusTreeRow(rows[0]);
                        }
                    } else if (event.key === 'End') {
                        if (rows.length) {
                            event.preventDefault();
                            focusTreeRow(rows[rows.length - 1]);
                        }
                    } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        if (row.getAttribute('aria-expanded') === 'true') {
                            row.click();
                        } else {
                            var parent = parentRowOf(row);
                            if (parent && isRowVisible(parent)) {
                                focusTreeRow(parent);
                            }
                        }
                    } else if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        if (row.getAttribute('aria-expanded') === 'false') {
                            row.click();
                        } else if (row.getAttribute('aria-expanded')
                            === 'true') {
                            var rowKey = row.getAttribute(
                                'data-changes-node-key');
                            var child = treeRows().find(function (candidate) {
                                return candidate.getAttribute('data-parent-key')
                                    === rowKey;
                            });
                            if (child) {
                                focusTreeRow(child);
                            }
                        }
                    } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        row.click();
                    }
                });
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
                        postAction({
                            type: 'conversation-viewer-changes-open-scm',
                            version: 1,
                            memberId: latestState.selectedMemberId,
                        });
                    }
                });
            }
            if (subtabsRoot) {
                subtabsRoot.addEventListener('click', function (event) {
                    var tab = event.target && event.target.closest
                        ? event.target.closest('[data-changes-subtab]')
                        : null;
                    if (tab) {
                        setActiveSubTab(
                            tab.getAttribute('data-changes-subtab'), false);
                    }
                });
                // Tablist keyboard: ← → with automatic activation and a
                // roving tabindex across the two tabs (PRD §15.4).
                subtabsRoot.addEventListener('keydown', function (event) {
                    if (event.key !== 'ArrowLeft'
                        && event.key !== 'ArrowRight') {
                        return;
                    }
                    var tabs = Array.prototype.slice.call(
                        subtabsRoot.querySelectorAll(
                            '[data-changes-subtab]'));
                    var index = tabs.indexOf(document.activeElement);
                    if (index < 0) {
                        return;
                    }
                    event.preventDefault();
                    var next = event.key === 'ArrowRight'
                        ? (index + 1) % tabs.length
                        : (index + tabs.length - 1) % tabs.length;
                    setActiveSubTab(
                        tabs[next].getAttribute('data-changes-subtab'),
                        true);
                });
            }
            if (commitsList) {
                // Per-member scroll memory (§15.2): the list records its
                // position into the member's cache as it scrolls.
                commitsList.addEventListener('scroll', function () {
                    var member = latestState && selectedMemberOf(latestState);
                    var cache = member && commitsCaches.get(member.memberId);
                    if (cache) {
                        cache.scrollTop = commitsList.scrollTop;
                    }
                });
                // Track focus regardless of how it arrived (mouse,
                // keyboard, script) so re-renders can restore it.
                commitsList.addEventListener('focusin', function (event) {
                    var row = event.target && event.target.closest
                        ? event.target.closest(
                            '.conversation-changes-commit-row, '
                                + '.conversation-changes-commit-file-row, '
                                + '.conversation-changes-commit-review-row')
                        : null;
                    if (row) {
                        commitsFocusKey = commitsRowKeyOf(row);
                    }
                });
                commitsList.addEventListener('click', function (event) {
                    var row = event.target && event.target.closest
                        ? event.target.closest(
                            '.conversation-changes-commit-row')
                        : null;
                    if (!row || !latestState) {
                        return;
                    }
                    var member = selectedMemberOf(latestState);
                    var cache = member
                        && commitsCaches.get(member.memberId);
                    if (!member || !cache) {
                        return;
                    }
                    toggleCommitExpanded(member, cache,
                        row.getAttribute('data-commit-sha'));
                    focusCommitsRow(rowByCommitsKey(
                        row.getAttribute('data-commit-sha')));
                });
                commitsList.addEventListener('keydown', handleCommitsKeydown);
            }
            if (commitsRetry) {
                commitsRetry.addEventListener('click', function () {
                    var member = latestState && selectedMemberOf(latestState);
                    var cache = member && commitsCaches.get(member.memberId);
                    if (member && cache) {
                        resetCommitsList(cache);
                        ensureCommits(latestState);
                        renderCommits(latestState);
                    }
                });
            }
            if (commitsMore) {
                commitsMore.addEventListener('click', function () {
                    var member = latestState && selectedMemberOf(latestState);
                    var cache = member && commitsCaches.get(member.memberId);
                    if (!member || !cache || cache.status !== 'ready') {
                        return;
                    }
                    // One in-flight page at a time; renderCommits
                    // re-enables the button when the response lands
                    // (success or degraded — both settle the page).
                    cache.pageLoading = true;
                    if (cache.earlierActive) {
                        requestCommitsPage(member, cache, 'full',
                            cache.earlierOffset);
                    } else {
                        requestCommitsPage(member, cache, 'since-start',
                            cache.commits.length);
                    }
                    renderCommitsIfVisible();
                });
            }
            if (commitsFull) {
                commitsFull.addEventListener('click', function () {
                    var member = latestState && selectedMemberOf(latestState);
                    var cache = member && commitsCaches.get(member.memberId);
                    if (!member || !cache || !cache.sectionComplete) {
                        return;
                    }
                    cache.earlierActive = true;
                    cache.earlierOffset = 0;
                    // The Earlier section continues from the baseline's
                    // ancestors, never from HEAD (§14.3) — the closing
                    // row's sha is skipped by cross-page dedupe.
                    requestCommitsPage(member, cache, 'full', 0);
                    renderCommitsIfVisible();
                });
            }
            applySubTabVisibility();
        }

        attach();

        return {
            apply: apply,
            // The sidebar restores persisted state after this controller
            // is created: adopt a persisted Commits sub-tab then (PRD
            // §15.4 — the choice survives reloads and session switches).
            restoreSubTab: function () {
                var restored = getSubTab();
                if (restored === 'commits' || restored === 'files') {
                    activeSubTab = restored;
                }
                applySubTabVisibility();
                if (activeSubTab === 'commits' && latestState) {
                    ensureCommits(latestState);
                    renderCommits(latestState);
                }
            },
            // Session switches advance the viewer's generation without a
            // document rebuild — adopt it and drop the old session's
            // state, or every later changes message is rejected as stale.
            resetSession: function (generation, nextTarget) {
                subscriptionGeneration = generation;
                target = nextTarget || target;
                latestState = null;
                lastSelectSignature = '';
                lastLiveText = '';
                highestChangesVersion = 0;
                memberContexts.clear();
                commitsCaches.clear();
                commitsFocusKey = null;
                pendingMemberId = null;
                currentMemberId = null;
                lastFocusedTreeKey = null;
                pendingFocusRestore = null;
                updateFoldActions();
                tooltip.hide();
                clearAuthoritativeContent();
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
                postAction({
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
