function initSkillPanel(options) {
    options = options || {};

    function revealSkillCard(dirPath) {
        if (!options.aiPanel || typeof options.aiPanel.querySelector !== 'function') {
            return false;
        }
        var skillsTab = options.aiPanel.querySelector('#ai-tab-skills');
        if (skillsTab && skillsTab.getAttribute('aria-selected') !== 'true' && typeof skillsTab.click === 'function') {
            skillsTab.click();
        }
        var cards = options.aiPanel.querySelectorAll('.skill-card[data-skill-dir]');
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].getAttribute('data-skill-dir') !== dirPath) {
                continue;
            }
            var detail = cards[i].querySelector('.skill-detail');
            if (detail) {
                detail.hidden = false;
                cards[i].classList.add('skill-detail-open');
            }
            if (typeof cards[i].scrollIntoView === 'function') {
                cards[i].scrollIntoView({ block: 'center' });
            }
            return true;
        }
        return false;
    }

    var skillAgentFilter = 'all';
    var skillScopeActionSequence = 0;
    var skillScopeActionPending = {};

    function nextSkillScopeActionRequestId() {
        skillScopeActionSequence += 1;
        return 'skill-scope-' + Date.now().toString(36) + '-' + skillScopeActionSequence.toString(36);
    }

    function findSkillScopeActionButton(dirPath, operation) {
        var buttons = document.querySelectorAll
            ? document.querySelectorAll('[data-skill-scope-action]')
            : [];
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-skill-scope-action') === dirPath
                && buttons[i].getAttribute('data-skill-scope-operation') === operation) {
                return buttons[i];
            }
        }
        return null;
    }

    function markSkillScopeActionPending(button, pending) {
        if (!button || !pending) {
            return;
        }
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('pending');
        button.textContent = pending.operation === 'move-to-global' ? 'Moving…' : 'Applying…';
    }

    function restorePendingSkillScopeActions() {
        Object.keys(skillScopeActionPending).forEach(function (requestId) {
            var pending = skillScopeActionPending[requestId];
            markSkillScopeActionPending(
                findSkillScopeActionButton(pending.dirPath, pending.operation),
                pending
            );
        });
    }

    function isMatchingSkillScopeSettlement(settlement, pending) {
        return Boolean(settlement && settlement.version === 1
            && settlement.requestId === pending.requestId
            && settlement.dirPath === pending.dirPath
            && settlement.operation === pending.operation
            && typeof settlement.ok === 'boolean');
    }

    function announceSkillScopeSettlement(settlement, pending) {
        var status = document.querySelector ? document.querySelector('[data-skill-scope-status]') : null;
        if (!status || !settlement || !pending) {
            return;
        }
        status.textContent = settlement.ok
            ? (pending.operation === 'move-to-global'
                ? 'Skill moved to Global management.'
                : 'Project skill access updated.')
            : (settlement.code === 'cancelled' ? 'Skill action cancelled.' : 'Skill action failed.');
    }

    // Scroll anchors keep each pane's list at its scrolled card/folder across
    // authoritative HTML replacements (window.__agentPivotScrollState is
    // optional: fall back to a clamped scrollTop when it is not loaded).
    var SKILLS_SCROLL_ITEM_SELECTOR = '.skill-card[data-skill-dir], .skill-folder[data-skill-folder]';

    function getSkillsScrollItemKey(el) {
        var dir = el.getAttribute('data-skill-dir');
        if (dir) {
            return 'card:' + dir;
        }
        return 'folder:' + (el.getAttribute('data-skill-store') || '')
            + '|' + (el.getAttribute('data-skill-folder') || '');
    }

    function getSkillsPaneList(pane) {
        return pane && pane.querySelector
            ? pane.querySelector(':scope > .group.steward-section > .group-list')
            : null;
    }

    function captureSkillsListScroll(wrapper) {
        var state = {};
        if (!wrapper || !wrapper.querySelectorAll) {
            return state;
        }
        var panes = wrapper.querySelectorAll('[data-skills-pane]');
        for (var i = 0; i < panes.length; i++) {
            var scope = panes[i].getAttribute('data-skills-pane') || '';
            var list = getSkillsPaneList(panes[i]);
            if (!scope || !list) {
                continue;
            }
            if (window.__agentPivotScrollState
                && typeof window.__agentPivotScrollState.capture === 'function') {
                state[scope] = {
                    anchor: window.__agentPivotScrollState.capture(list, {
                        itemSelector: SKILLS_SCROLL_ITEM_SELECTOR,
                        getKey: getSkillsScrollItemKey,
                    }),
                };
            } else {
                state[scope] = { scrollTop: list.scrollTop };
            }
        }
        return state;
    }

    function restoreSkillsListScroll(wrapper, state) {
        if (!wrapper || !wrapper.querySelectorAll || !state) {
            return;
        }
        var panes = wrapper.querySelectorAll('[data-skills-pane]');
        for (var i = 0; i < panes.length; i++) {
            var scope = panes[i].getAttribute('data-skills-pane') || '';
            var saved = state[scope];
            var list = getSkillsPaneList(panes[i]);
            if (!saved || !list) {
                continue;
            }
            if (saved.anchor && window.__agentPivotScrollState
                && typeof window.__agentPivotScrollState.restore === 'function'
                && window.__agentPivotScrollState.restore(list, saved.anchor, {
                    itemSelector: SKILLS_SCROLL_ITEM_SELECTOR,
                    getKey: getSkillsScrollItemKey,
                })) {
                continue;
            }
            var maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
            var fallback = saved.anchor ? saved.anchor.scrollTop : saved.scrollTop;
            list.scrollTop = Math.min(Math.max(0, Number(fallback) || 0), maxScrollTop);
        }
    }

    function replaceSkillsHtml(html, settlement) {
        var skillsWrapper = document.querySelector
            ? document.querySelector('#ai-panel-skills .sticky-groups-wrapper')
            : null;
        if (!skillsWrapper || typeof html !== 'string') {
            return false;
        }
        var collapsedSkillGroups = captureSkillCollapsedGroups(skillsWrapper);
        var expandedSkillCards = captureSkillExpandedCards(skillsWrapper);
        var listScroll = captureSkillsListScroll(skillsWrapper);
        var folderMenuState = captureSkillFolderMenuState();
        var focused = document.activeElement && document.activeElement.getAttribute
            ? {
                dirPath: document.activeElement.getAttribute('data-skill-scope-action'),
                operation: document.activeElement.getAttribute('data-skill-scope-operation'),
            }
            : null;
        var candidatePending = settlement ? skillScopeActionPending[settlement.requestId] : null;
        var settledPending = candidatePending && isMatchingSkillScopeSettlement(settlement, candidatePending)
            ? candidatePending
            : null;
        if (settledPending) {
            delete skillScopeActionPending[settlement.requestId];
        }
        skillsWrapper.outerHTML = html;
        var nextSkillsWrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
        restoreSkillCollapsedGroups(nextSkillsWrapper, collapsedSkillGroups);
        restoreSkillExpandedCards(nextSkillsWrapper, expandedSkillCards);
        restoreSkillFolderMenuState(folderMenuState);
        restorePendingSkillScopeActions();
        applySkillAgentFilter();
        layoutSkillsSplit();
        restoreSkillsListScroll(nextSkillsWrapper, listScroll);
        announceSkillScopeSettlement(settlement, settledPending);
        if (focused && focused.dirPath) {
            var nextFocused = findSkillScopeActionButton(focused.dirPath, focused.operation);
            if (!nextFocused && settledPending && settlement.ok && settlement.resultDirPath) {
                nextFocused = findSkillScopeActionButton(settlement.resultDirPath, 'apply-to-project');
            }
            if (nextFocused && typeof nextFocused.focus === 'function') {
                nextFocused.focus();
            } else if (settledPending && nextSkillsWrapper && typeof nextSkillsWrapper.focus === 'function') {
                nextSkillsWrapper.setAttribute('tabindex', '-1');
                nextSkillsWrapper.focus();
            }
        }
        return true;
    }

    function settleSkillScopeActionWithoutHtml(settlement) {
        var pending = settlement && skillScopeActionPending[settlement.requestId];
        if (!pending || !isMatchingSkillScopeSettlement(settlement, pending) || settlement.ok) {
            return false;
        }
        delete skillScopeActionPending[settlement.requestId];
        var button = findSkillScopeActionButton(pending.dirPath, pending.operation);
        if (button) {
            button.removeAttribute('aria-disabled');
            button.classList.remove('pending');
            button.textContent = pending.label;
        }
        announceSkillScopeSettlement(settlement, pending);
        return true;
    }

    function applySkillAgentFilter() {
        var panel = document.querySelector
            ? document.querySelector('#ai-panel-skills')
            : null;
        if (!panel) {
            return;
        }
        var row = panel.querySelector('[data-skill-filter-row]');
        if (!row) {
            return;
        }
        var buttons = row.querySelectorAll('[data-skill-filter]');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-skill-filter') === skillAgentFilter);
        }
        // NOTE: the `hidden` attribute cannot hide .project-container/.group
        // (author display rules beat the UA [hidden] rule) — use a class.
        var cards = panel.querySelectorAll('.skill-card[data-skill-dir]');
        for (var c = 0; c < cards.length; c++) {
            var agents = cards[c].getAttribute('data-skill-agents') || '';
            var show = skillAgentFilter === 'all'
                || (' ' + agents + ' ').indexOf(' ' + skillAgentFilter + ' ') !== -1;
            var container = cards[c].closest('.project-container') || cards[c];
            container.classList.toggle('skill-filter-hidden', !show);
        }
        // Children first (reverse document order) so parent folders see their
        // children's computed visibility.
        var sections = panel.querySelectorAll('.group.steward-section, .skill-source-group');
        for (var s = sections.length - 1; s >= 0; s--) {
            var section = sections[s];
            var sectionCards = section.querySelectorAll('.skill-card[data-skill-dir]');
            var sectionVisible = 0;
            for (var sc = 0; sc < sectionCards.length; sc++) {
                var scContainer = sectionCards[sc].closest('.project-container') || sectionCards[sc];
                if (!scContainer.classList.contains('skill-filter-hidden')) {
                    sectionVisible += 1;
                }
            }
            if (section.classList.contains('skill-source-group')) {
                section.classList.toggle('skill-filter-hidden', sectionVisible === 0);
            } else {
                var childFolders = section.querySelectorAll('.skill-folder');
                var visibleChildFolders = 0;
                for (var cf = 0; cf < childFolders.length; cf++) {
                    if (!childFolders[cf].classList.contains('skill-filter-hidden')) {
                        visibleChildFolders += 1;
                    }
                }
                // Empty leaf folders (created via "+") always stay visible; a folder
                // or section hides only when nothing inside it — cards or child
                // folders — is visible.
                var emptyLeaf = section.classList.contains('skill-folder')
                    && sectionCards.length === 0 && childFolders.length === 0;
                section.classList.toggle('skill-filter-hidden',
                    sectionVisible === 0 && visibleChildFolders === 0 && !emptyLeaf);
            }
            var countEl = section.querySelector(':scope > .group-title > .group-title-badge')
                || section.querySelector(':scope > .skill-source-header > .skill-source-count');
            if (countEl) {
                countEl.textContent = String(sectionVisible);
            }
        }
    }

    function captureSkillCollapsedGroups(wrapper) {
        // Folder nodes are keyed by store + folder path (stable across re-renders);
        // every other section keeps its data-group-id key.
        var ids = [];
        var folders = [];
        if (wrapper && wrapper.querySelectorAll) {
            var collapsed = wrapper.querySelectorAll('.group.steward-section.collapsed');
            for (var i = 0; i < collapsed.length; i++) {
                if (collapsed[i].classList.contains('skill-folder')) {
                    continue;
                }
                ids.push(collapsed[i].getAttribute('data-group-id'));
            }
            var folderNodes = wrapper.querySelectorAll('.skill-folder[data-skill-folder]');
            for (var f = 0; f < folderNodes.length; f++) {
                if (folderNodes[f].classList.contains('collapsed')) {
                    folders.push(folderNodes[f].getAttribute('data-skill-store') + '|' + folderNodes[f].getAttribute('data-skill-folder'));
                }
            }
        }
        return { ids: ids, folders: folders };
    }

    function restoreSkillCollapsedGroups(wrapper, state) {
        if (!wrapper || !state) {
            return;
        }
        var ids = state.ids || [];
        for (var i = 0; i < ids.length; i++) {
            var group = wrapper.querySelector('.group.steward-section[data-group-id="' + ids[i] + '"]');
            if (group) {
                group.classList.add('collapsed');
            }
        }
        var folderKeys = state.folders || [];
        if (!folderKeys.length || !wrapper.querySelectorAll) {
            return;
        }
        var folderNodes = wrapper.querySelectorAll('.skill-folder[data-skill-folder]');
        for (var f = 0; f < folderNodes.length; f++) {
            var key = folderNodes[f].getAttribute('data-skill-store') + '|' + folderNodes[f].getAttribute('data-skill-folder');
            if (folderKeys.indexOf(key) !== -1) {
                folderNodes[f].classList.add('collapsed');
            }
        }
    }

    function onSkillMoveInputKeydown(event) {
        var input = event.target && event.target.closest ? event.target.closest('[data-skill-move-folder]') : null;
        if (!input || event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        var detail = input.closest('.skill-detail');
        var button = detail && detail.querySelector('[data-skill-move-set]');
        if (button && typeof button.click === 'function') {
            button.click();
        }
    }

    // Scope is positional: switches in the global section act on user-level agent
    // roots, switches in the project section on the current project's agent roots.
    // There is no panel-level scope selector anymore.
    function skillSwitchScope(el) {
        return el.closest && el.closest('[data-group-id="project-skills"]') ? 'project' : 'user';
    }

    var skillFolderMenu = null;

    function closeSkillFolderMenu() {
        if (skillFolderMenu) {
            skillFolderMenu.remove();
            skillFolderMenu = null;
        }
    }

    function onSkillFolderMenuKeydown(event) {
        if (event.key === 'Escape') {
            closeSkillFolderMenu();
        }
    }

    // One shared context menu for folder batch actions (VS Code "More Actions"
    // style): agent switches + delete, built from the ⋯ button's data attributes.
    function positionSkillFolderMenu(menu, button) {
        var rect = menu.getBoundingClientRect();
        var anchor = button.getBoundingClientRect();
        var viewportPadding = 4;
        var left = anchor.right - rect.width;
        var top = anchor.bottom + 2;
        if (left + rect.width + viewportPadding > window.innerWidth) {
            left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
        }
        if (left < viewportPadding) {
            left = viewportPadding;
        }
        if (top + rect.height + viewportPadding > window.innerHeight) {
            top = Math.max(viewportPadding, anchor.top - rect.height - 2);
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    function appendMenuAgentToggles(menu, button, folder, scope) {
        var agents = ['kimi', 'claude', 'codex'];
        for (var i = 0; i < agents.length; i++) {
            var agent = agents[i];
            var state = button.getAttribute('data-state-' + agent) || 'off';
            var item = document.createElement('div');
            item.className = 'custom-context-menu-item skill-folder-menu-item';
            var label = document.createElement('span');
            label.className = 'skill-folder-menu-agent';
            label.textContent = agent;
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'skill-ios-toggle' + (state === 'on' ? '' : ' ' + state);
            toggle.title = (state === 'on' ? 'Disable every skill under ' : 'Enable every skill under ')
                + (folder || 'this section') + ' for ' + agent;
            toggle.setAttribute('data-folder-toggle', folder);
            toggle.setAttribute('data-folder-agent', agent);
            toggle.setAttribute('data-folder-scope', scope);
            item.appendChild(label);
            item.appendChild(toggle);
            menu.appendChild(item);
        }
        var separator = document.createElement('div');
        separator.className = 'custom-context-menu-separator';
        menu.appendChild(separator);
    }

    function appendMenuAction(menu, className, text) {
        var item = document.createElement('div');
        item.className = 'custom-context-menu-item ' + className;
        item.textContent = text;
        menu.appendChild(item);
        return item;
    }

    function openSkillFolderMenu(button) {
        closeSkillFolderMenu();
        var folder = button.getAttribute('data-folder-menu') || '';
        var scope = button.getAttribute('data-folder-scope') || 'user';
        var storeNode = button.closest('[data-skill-store]');
        var menu = document.createElement('div');
        menu.className = 'custom-context-menu skill-folder-menu visible';
        if (storeNode) {
            menu.setAttribute('data-skill-store', storeNode.getAttribute('data-skill-store'));
        }
        // DOM construction (not innerHTML) so disk-derived folder names can
        // never break out of attributes and inject markup.
        appendMenuAgentToggles(menu, button, folder, scope);
        var newItem = appendMenuAction(menu, 'skill-folder-menu-new', 'New subfolder');
        newItem.setAttribute('data-skill-menu-new-folder', folder);
        newItem.setAttribute('data-folder-scope', scope);
        var removeItem = appendMenuAction(menu, 'skill-folder-menu-remove', 'Delete empty folder');
        removeItem.setAttribute('data-skill-remove-folder', folder);
        document.body.appendChild(menu);
        positionSkillFolderMenu(menu, button);
        menu.__sourceButton = button;
        menu.__identity = { section: false, folder: folder, scope: scope };
        skillFolderMenu = menu;
    }

    // Section (global / project) ⋯ menu: store-level actions.
    function openSkillSectionMenu(button) {
        closeSkillFolderMenu();
        var scope = button.getAttribute('data-section-menu') || 'user';
        var menu = document.createElement('div');
        menu.className = 'custom-context-menu skill-folder-menu visible';
        var storeNode = button.closest('[data-skill-store]');
        if (storeNode) {
            menu.setAttribute('data-skill-store', storeNode.getAttribute('data-skill-store'));
        }
        appendMenuAgentToggles(menu, button, '', scope);
        var newItem = appendMenuAction(menu, 'skill-folder-menu-new', 'New folder');
        newItem.setAttribute('data-skill-menu-new-folder', '');
        newItem.setAttribute('data-folder-scope', scope);
        var migrateItem = appendMenuAction(menu, 'skill-folder-menu-migrate', 'Migrate to central…');
        migrateItem.setAttribute('data-skill-menu-migrate', scope);
        if (scope === 'user') {
            var locationItem = appendMenuAction(
                menu,
                'skill-folder-menu-location',
                'Change Global Skills Location…'
            );
            locationItem.setAttribute('data-change-global-skills-location', '');
        }
        document.body.appendChild(menu);
        positionSkillFolderMenu(menu, button);
        menu.__sourceButton = button;
        menu.__identity = { section: true, folder: '', scope: scope };
        skillFolderMenu = menu;
    }

    // Keep the ⋯ menu open across per-agent toggles: the switch gets a pending
    // look (never an optimistic committed state) and the authoritative
    // skills-updated re-syncs it afterwards. Popup state stays webview-local.
    function captureSkillFolderMenuState() {
        if (!skillFolderMenu || !skillFolderMenu.__identity) {
            return null;
        }
        return { identity: skillFolderMenu.__identity };
    }

    function restoreSkillFolderMenuState(state) {
        if (!state || !skillFolderMenu) {
            return;
        }
        var identity = state.identity;
        var candidates = document.querySelectorAll(identity.section ? '[data-section-menu]' : '[data-folder-menu]');
        var button = null;
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            if (identity.section) {
                if (candidate.getAttribute('data-section-menu') === identity.scope) {
                    button = candidate;
                    break;
                }
            } else if (candidate.getAttribute('data-folder-menu') === identity.folder
                && candidate.getAttribute('data-folder-scope') === identity.scope) {
                button = candidate;
                break;
            }
        }
        if (!button) {
            closeSkillFolderMenu();
            return;
        }
        var menu = skillFolderMenu;
        var agents = ['kimi', 'claude', 'codex'];
        for (var j = 0; j < agents.length; j++) {
            var agent = agents[j];
            var sw = menu.querySelector('[data-folder-agent="' + agent + '"]');
            if (!sw) {
                continue;
            }
            var next = button.getAttribute('data-state-' + agent) || 'off';
            sw.classList.remove('off', 'indeterminate', 'skill-toggle-pending');
            sw.disabled = false;
            if (next !== 'on') {
                sw.classList.add(next);
            }
            var folder = sw.getAttribute('data-folder-toggle') || '';
            var target = folder ? 'every skill under ' + folder : 'every skill in this section';
            sw.setAttribute('title', (next === 'on' ? 'Disable ' : 'Enable ') + target + ' for ' + agent);
        }
        menu.__sourceButton = button;
        positionSkillFolderMenu(menu, button);
    }

    function captureSkillExpandedCards(wrapper) {
        var dirs = [];
        if (wrapper && wrapper.querySelectorAll) {
            var open = wrapper.querySelectorAll('.skill-card.skill-detail-open');
            for (var i = 0; i < open.length; i++) {
                dirs.push(open[i].getAttribute('data-skill-dir'));
            }
        }
        return dirs;
    }

    function restoreSkillExpandedCards(wrapper, dirs) {
        if (!wrapper || !dirs || !dirs.length) {
            return;
        }
        var cards = wrapper.querySelectorAll('.skill-card[data-skill-dir]');
        for (var i = 0; i < cards.length; i++) {
            if (dirs.indexOf(cards[i].getAttribute('data-skill-dir')) === -1) {
                continue;
            }
            var detail = cards[i].querySelector('.skill-detail');
            if (detail) {
                detail.hidden = false;
                cards[i].classList.add('skill-detail-open');
            }
        }
    }

    // --- Global / Project split panes -------------------------------------
    // Each scope section lives in a .skills-pane so the two sections scroll
    // independently; the resizer sizes the project pane. The split container
    // gets an explicit viewport-fitting height (document offset is scroll
    // invariant, so one pass is enough and body scroll clamps to ~0). A null
    // ratio means "auto": the project pane is content-sized up to a CSS cap.
    var SKILLS_PANE_MIN_PX = 72;
    var SKILLS_SPLIT_BOTTOM_GAP_PX = 6;
    var SKILLS_PANE_KEY_STEP_PX = 24;
    // The dragged project-pane share persists in webview view state (same
    // pattern as aiSessionTabs) so it survives window reloads.
    var SKILLS_PANEL_STATE_KEY = 'skillsPanel';

    function readSkillsPanelState() {
        var api = window.vscode;
        if (!api || typeof api.getState !== 'function') {
            return {};
        }
        var state = api.getState() || {};
        var panel = state[SKILLS_PANEL_STATE_KEY];
        return panel && typeof panel === 'object' && !Array.isArray(panel) ? panel : {};
    }

    function readPersistedProjectPaneRatio() {
        var ratio = Number(readSkillsPanelState().projectPaneRatio);
        return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : null;
    }

    function persistSkillsProjectPaneRatio() {
        var api = window.vscode;
        if (!api || typeof api.setState !== 'function') {
            return;
        }
        var state = typeof api.getState === 'function' ? api.getState() || {} : {};
        var panel = Object.assign({}, readSkillsPanelState());
        if (skillsProjectPaneRatio === null) {
            delete panel.projectPaneRatio;
        } else {
            panel.projectPaneRatio = skillsProjectPaneRatio;
        }
        var patch = {};
        patch[SKILLS_PANEL_STATE_KEY] = panel;
        api.setState(Object.assign({}, state, patch));
    }

    var skillsProjectPaneRatio = readPersistedProjectPaneRatio();
    var skillsPaneDragState = null;
    var skillsLayoutScheduled = false;

    function findSkillsSplit() {
        return document.querySelector
            ? document.querySelector('#ai-panel-skills [data-skills-split]')
            : null;
    }

    function getSkillsPaneParts(split) {
        var panes = [];
        var resizers = [];
        if (!split || !split.children) {
            return { panes: panes, resizers: resizers };
        }
        for (var i = 0; i < split.children.length; i++) {
            var child = split.children[i];
            if (!child.getAttribute) {
                continue;
            }
            if (child.hasAttribute('data-skills-pane')) {
                panes.push(child);
            } else if (child.hasAttribute('data-skills-pane-resizer')) {
                resizers.push(child);
            }
        }
        return { panes: panes, resizers: resizers };
    }

    function getSkillsPaneSection(pane) {
        return pane.querySelector
            ? pane.querySelector(':scope > .group.steward-section')
            : null;
    }

    // A pane is "sized" (participates in the split) only while its section is
    // actually visible: collapsed or agent-filtered-out sections collapse their
    // pane to header height / zero so the other pane gets the space.
    function isSkillsPaneSized(pane) {
        var section = getSkillsPaneSection(pane);
        return Boolean(section)
            && !section.classList.contains('collapsed')
            && !section.classList.contains('skill-filter-hidden');
    }

    // Natural content height of a pane's section: header plus the full list
    // content (list.scrollHeight reports the content even while constrained).
    function measureSkillsPaneContentHeight(pane) {
        var section = getSkillsPaneSection(pane);
        if (!section || !section.querySelector) {
            return 0;
        }
        var header = section.querySelector(':scope > .group-title');
        var list = section.querySelector(':scope > .group-list');
        var height = 4; // grid gap + header border
        if (header) {
            height += header.offsetHeight || 0;
        }
        if (list) {
            height += list.scrollHeight || 0;
        }
        return height;
    }

    // Explicit pixel height for the sized project pane: the dragged share when
    // set, otherwise the content height capped to the auto share of the split.
    function computeSkillsProjectPaneHeight(projectPane, inner) {
        var max = Math.max(inner - SKILLS_PANE_MIN_PX, SKILLS_PANE_MIN_PX);
        var px;
        if (skillsProjectPaneRatio !== null) {
            px = Math.round(inner * skillsProjectPaneRatio);
            px = Math.max(px, SKILLS_PANE_MIN_PX);
        } else {
            px = Math.min(measureSkillsPaneContentHeight(projectPane), Math.floor(inner * 0.45));
        }
        return Math.min(px, max);
    }

    function layoutSkillsSplit() {
        var split = findSkillsSplit();
        if (!split || typeof split.getBoundingClientRect !== 'function'
            || !split.getClientRects().length) {
            return false; // hidden (another tab) — keep the last applied state
        }
        var parts = getSkillsPaneParts(split);
        if (!parts.panes.length) {
            split.style.height = '';
            return false;
        }
        var rect = split.getBoundingClientRect();
        var scrollY = window.scrollY || window.pageYOffset || 0;
        var docTop = rect.top + scrollY;
        var resizerHeight = 0;
        for (var r = 0; r < parts.resizers.length; r++) {
            resizerHeight += parts.resizers[r].getBoundingClientRect().height;
        }
        var available = Math.max(
            window.innerHeight - docTop - SKILLS_SPLIT_BOTTOM_GAP_PX,
            SKILLS_PANE_MIN_PX * parts.panes.length + resizerHeight
        );
        split.style.height = Math.round(available) + 'px';

        var sized = parts.panes.map(isSkillsPaneSized);
        var sizedCount = sized.filter(Boolean).length;
        for (var i = 0; i < parts.panes.length; i++) {
            var pane = parts.panes[i];
            pane.classList.toggle('skills-pane-sized', sized[i]);
            // Both sized: the global pane grows around the sized project pane.
            // Only one sized: that pane takes the whole split.
            var grow = sized[i] && (sizedCount === 1
                || pane.getAttribute('data-skills-pane') === 'user');
            pane.classList.toggle('skills-pane-grow', grow);
        }
        var inner = Math.max(available - resizerHeight, SKILLS_PANE_MIN_PX);
        for (var p = 0; p < parts.panes.length; p++) {
            var projectPane = parts.panes[p];
            if (projectPane.getAttribute('data-skills-pane') !== 'project') {
                continue;
            }
            if (sized[p] && sizedCount > 1) {
                projectPane.style.height = computeSkillsProjectPaneHeight(projectPane, inner) + 'px';
            } else {
                projectPane.style.height = '';
            }
        }
        for (var z = 0; z < parts.resizers.length; z++) {
            var resizer = parts.resizers[z];
            resizer.hidden = sizedCount < 2;
            if (sizedCount > 1) {
                var projectSizedPane = null;
                for (var q = 0; q < parts.panes.length; q++) {
                    if (parts.panes[q].getAttribute('data-skills-pane') === 'project') {
                        projectSizedPane = parts.panes[q];
                    }
                }
                if (projectSizedPane) {
                    var percent = Math.round(projectSizedPane.getBoundingClientRect().height / inner * 100);
                    resizer.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, percent))));
                }
            }
        }
        return true;
    }

    function scheduleSkillsLayout() {
        if (skillsLayoutScheduled) {
            return;
        }
        skillsLayoutScheduled = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
                skillsLayoutScheduled = false;
                layoutSkillsSplit();
            });
            return;
        }
        skillsLayoutScheduled = false;
        layoutSkillsSplit();
    }

    function applySkillsProjectPaneHeight(projectPane, inner, nextPx) {
        var clamped = Math.min(Math.max(nextPx, SKILLS_PANE_MIN_PX),
            Math.max(inner - SKILLS_PANE_MIN_PX, SKILLS_PANE_MIN_PX));
        skillsProjectPaneRatio = clamped / inner;
        projectPane.style.height = Math.round(clamped) + 'px';
    }

    function onSkillsPaneResizerPointerDown(event) {
        var resizer = event.target && event.target.closest
            ? event.target.closest('[data-skills-pane-resizer]')
            : null;
        if (!resizer || (event.button !== 0 && event.button !== undefined)) {
            return;
        }
        var split = resizer.closest('[data-skills-split]');
        var parts = getSkillsPaneParts(split);
        var projectPane = null;
        for (var i = 0; i < parts.panes.length; i++) {
            if (parts.panes[i].getAttribute('data-skills-pane') === 'project') {
                projectPane = parts.panes[i];
            }
        }
        if (!projectPane || resizer.hidden) {
            return;
        }
        event.preventDefault();
        var resizerHeight = resizer.getBoundingClientRect().height;
        skillsPaneDragState = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: projectPane.getBoundingClientRect().height,
            inner: Math.max(split.getBoundingClientRect().height - resizerHeight, SKILLS_PANE_MIN_PX),
            projectPane: projectPane,
            resizer: resizer,
        };
        resizer.classList.add('skills-pane-resizer-active');
        if (document.body) {
            document.body.classList.add('skills-pane-resizing');
        }
        if (event.pointerId !== undefined && typeof resizer.setPointerCapture === 'function') {
            try {
                resizer.setPointerCapture(event.pointerId);
            } catch (_error) { /* capture is best-effort */ }
        }
    }

    function onSkillsPaneResizerPointerMove(event) {
        if (!skillsPaneDragState
            || (skillsPaneDragState.pointerId !== undefined && event.pointerId !== skillsPaneDragState.pointerId)) {
            return;
        }
        // The project pane sits below the resizer: dragging down shrinks it.
        var next = skillsPaneDragState.startHeight - (event.clientY - skillsPaneDragState.startY);
        applySkillsProjectPaneHeight(skillsPaneDragState.projectPane, skillsPaneDragState.inner, next);
        var percent = Math.round(skillsPaneDragState.projectPane.getBoundingClientRect().height
            / skillsPaneDragState.inner * 100);
        skillsPaneDragState.resizer.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, percent))));
    }

    function onSkillsPaneResizerPointerUp(event) {
        if (!skillsPaneDragState
            || (skillsPaneDragState.pointerId !== undefined && event.pointerId !== skillsPaneDragState.pointerId)) {
            return;
        }
        skillsPaneDragState.resizer.classList.remove('skills-pane-resizer-active');
        if (document.body) {
            document.body.classList.remove('skills-pane-resizing');
        }
        if (event.pointerId !== undefined
            && typeof skillsPaneDragState.resizer.releasePointerCapture === 'function') {
            try {
                skillsPaneDragState.resizer.releasePointerCapture(event.pointerId);
            } catch (_error) { /* capture is best-effort */ }
        }
        skillsPaneDragState = null;
        persistSkillsProjectPaneRatio();
        layoutSkillsSplit();
    }

    function onSkillsPaneResizerKeydown(event) {
        var resizer = event.target && event.target.closest
            ? event.target.closest('[data-skills-pane-resizer]')
            : null;
        if (!resizer || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
            return;
        }
        var split = resizer.closest('[data-skills-split]');
        var projectPane = split && split.querySelector
            ? split.querySelector('[data-skills-pane="project"]')
            : null;
        if (!projectPane || resizer.hidden) {
            return;
        }
        event.preventDefault();
        var direction = event.key === 'ArrowUp' ? 1 : -1;
        var inner = Math.max(split.getBoundingClientRect().height
            - resizer.getBoundingClientRect().height, SKILLS_PANE_MIN_PX);
        applySkillsProjectPaneHeight(projectPane, inner,
            projectPane.getBoundingClientRect().height + direction * SKILLS_PANE_KEY_STEP_PX);
        persistSkillsProjectPaneRatio();
        layoutSkillsSplit();
    }

    var skillDragState = null;

    function findSkillDropFolder(event) {
        if (!skillDragState) {
            return null;
        }
        var folder = event.target && event.target.closest
            ? event.target.closest('.skill-folder')
            : null;
        var section = event.target && event.target.closest
            ? event.target.closest('.group.steward-section[data-skill-store]')
            : null;
        var target = folder || section;
        if (!target) {
            return null;
        }
        // A card can only move inside its own store: user skills in the global
        // section, project skills in the project section.
        var targetScope = folder
            ? folder.getAttribute('data-skill-folder-scope')
            : (section.getAttribute('data-group-id') === 'project-skills' ? 'project' : 'user');
        if (targetScope !== skillDragState.scope) {
            return null;
        }
        return {
            element: target,
            folder: folder ? folder.getAttribute('data-skill-folder') || '' : '',
        };
    }

    function onSkillDragStart(event) {
        var container = event.target && event.target.closest
            ? event.target.closest('.project-container[data-skill-scope]')
            : null;
        if (!container) {
            return;
        }
        var card = container.querySelector('.skill-card[data-skill-dir]');
        if (!card) {
            return;
        }
        skillDragState = {
            dirPath: card.getAttribute('data-skill-dir'),
            scope: container.getAttribute('data-skill-scope'),
        };
        container.classList.add('skill-card-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', skillDragState.dirPath);
        }
    }

    function onSkillDragOver(event) {
        var target = findSkillDropFolder(event);
        if (!target) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        target.element.classList.add('skill-drop-target');
    }

    function onSkillDragLeave(event) {
        var target = findSkillDropFolder(event);
        if (target && event.relatedTarget && target.element.contains(event.relatedTarget)) {
            return;
        }
        if (target) {
            target.element.classList.remove('skill-drop-target');
        }
    }

    function onSkillDrop(event) {
        var target = findSkillDropFolder(event);
        if (!target) {
            return;
        }
        event.preventDefault();
        target.element.classList.remove('skill-drop-target');
        options.postMessage({
            type: 'move-skill-to-folder',
            dirPath: skillDragState.dirPath,
            folder: target.folder,
        });
    }

    function onSkillDragEnd(event) {
        if (skillDragState) {
            var dragging = document.querySelectorAll('.skill-card-dragging');
            for (var i = 0; i < dragging.length; i++) {
                dragging[i].classList.remove('skill-card-dragging');
            }
        }
        skillDragState = null;
        var targets = document.querySelectorAll('.skill-drop-target');
        for (var t = 0; t < targets.length; t++) {
            targets[t].classList.remove('skill-drop-target');
        }
    }

    function onSkillCardClick(event) {
        var filter = event.target && event.target.closest ? event.target.closest('[data-skill-filter]') : null;
        if (filter) {
            event.preventDefault();
            skillAgentFilter = filter.getAttribute('data-skill-filter') || 'all';
            applySkillAgentFilter();
            return;
        }
        if (skillFolderMenu && !(event.target && event.target.closest && event.target.closest('.skill-folder-menu'))) {
            closeSkillFolderMenu();
        }
        var scopeAction = event.target && event.target.closest ? event.target.closest('[data-skill-scope-action]') : null;
        if (scopeAction) {
            event.preventDefault();
            event.stopPropagation();
            if (scopeAction.disabled || scopeAction.getAttribute('aria-disabled') === 'true'
                || scopeAction.classList.contains('pending')) {
                return;
            }
            var requestId = nextSkillScopeActionRequestId();
            var pending = {
                requestId: requestId,
                dirPath: scopeAction.getAttribute('data-skill-scope-action') || '',
                operation: scopeAction.getAttribute('data-skill-scope-operation') || '',
                label: scopeAction.textContent || '',
            };
            skillScopeActionPending[requestId] = pending;
            markSkillScopeActionPending(scopeAction, pending);
            options.postMessage({
                type: 'skill-scope-action',
                version: 1,
                requestId: requestId,
                dirPath: pending.dirPath,
                operation: pending.operation,
            });
            return;
        }
        var sectionMenuButton = event.target && event.target.closest ? event.target.closest('[data-section-menu]') : null;
        if (sectionMenuButton) {
            event.preventDefault();
            event.stopPropagation();
            if (skillFolderMenu && skillFolderMenu.__sourceButton === sectionMenuButton) {
                closeSkillFolderMenu();
            } else {
                openSkillSectionMenu(sectionMenuButton);
            }
            return;
        }
        var folderMenuButton = event.target && event.target.closest ? event.target.closest('[data-folder-menu]') : null;
        if (folderMenuButton) {
            event.preventDefault();
            event.stopPropagation();
            if (skillFolderMenu && skillFolderMenu.__sourceButton === folderMenuButton) {
                closeSkillFolderMenu();
            } else {
                openSkillFolderMenu(folderMenuButton);
            }
            return;
        }
        var folderToggle = event.target && event.target.closest ? event.target.closest('[data-folder-toggle]') : null;
        if (folderToggle) {
            event.preventDefault();
            event.stopPropagation();
            var folderNode = folderToggle.closest('[data-skill-store]');
            // The menu stays open for multi-agent changes; pending ≠ committed,
            // the authoritative skills-updated re-syncs the switch.
            folderToggle.classList.add('skill-toggle-pending');
            folderToggle.disabled = true;
            options.postMessage({
                type: 'folder-toggle-skill-links',
                storeRoot: folderNode ? folderNode.getAttribute('data-skill-store') : '',
                folder: folderToggle.getAttribute('data-folder-toggle'),
                scope: folderToggle.getAttribute('data-folder-scope'),
                agent: folderToggle.getAttribute('data-folder-agent'),
                enabled: !folderToggle.classList.contains('off') && !folderToggle.classList.contains('indeterminate'),
            });
            return;
        }
        var moveSet = event.target && event.target.closest ? event.target.closest('[data-skill-move-set]') : null;
        if (moveSet) {
            event.preventDefault();
            event.stopPropagation();
            var moveDetail = moveSet.closest('.skill-detail');
            var moveInput = moveDetail && moveDetail.querySelector('[data-skill-move-folder]');
            options.postMessage({
                type: 'move-skill-to-folder',
                dirPath: moveSet.getAttribute('data-skill-move-set'),
                folder: moveInput ? moveInput.value : '',
            });
            return;
        }
        var newFolder = event.target && event.target.closest ? event.target.closest('[data-skill-menu-new-folder]') : null;
        if (newFolder) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({
                type: 'create-skill-folder',
                scope: newFolder.getAttribute('data-folder-scope'),
                parentFolder: newFolder.getAttribute('data-skill-menu-new-folder'),
            });
            return;
        }
        var removeFolder = event.target && event.target.closest ? event.target.closest('[data-skill-remove-folder]') : null;
        if (removeFolder) {
            event.preventDefault();
            event.stopPropagation();
            var menuFolder = removeFolder.closest('.skill-folder-menu');
            var removeNode = menuFolder
                ? (skillFolderMenu && skillFolderMenu.__sourceButton
                    ? skillFolderMenu.__sourceButton.closest('[data-skill-store]')
                    : null)
                : removeFolder.closest('[data-skill-store]');
            closeSkillFolderMenu();
            options.postMessage({
                type: 'remove-skill-folder',
                storeRoot: removeNode ? removeNode.getAttribute('data-skill-store') : '',
                folder: removeFolder.getAttribute('data-skill-remove-folder'),
            });
            return;
        }
        var deleteSkill = event.target && event.target.closest ? event.target.closest('[data-skill-delete]') : null;
        if (deleteSkill) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'delete-skill', dirPath: deleteSkill.getAttribute('data-skill-delete') });
            return;
        }
        var applySuggestion = event.target && event.target.closest ? event.target.closest('[data-skill-apply-suggestion]') : null;
        if (applySuggestion) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'apply-skill-collection', name: applySuggestion.getAttribute('data-skill-apply-suggestion') });
            return;
        }
        var dismissSuggestion = event.target && event.target.closest ? event.target.closest('[data-skill-dismiss-suggestion]') : null;
        if (dismissSuggestion) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'dismiss-skill-collection', name: dismissSuggestion.getAttribute('data-skill-dismiss-suggestion') });
            return;
        }
        var centralToggle = event.target && event.target.closest ? event.target.closest('[data-central-toggle]') : null;
        if (centralToggle) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'central-toggle-skill',
                dirPath: centralToggle.getAttribute('data-central-toggle'),
                source: centralToggle.getAttribute('data-central-source'),
                scope: skillSwitchScope(centralToggle),
                enabled: !centralToggle.classList.contains('off'),
            });
            return;
        }
        var centralize = event.target && event.target.closest ? event.target.closest('[data-skill-centralize]') : null;
        if (centralize) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'centralize-skill', dirPath: centralize.getAttribute('data-skill-centralize') });
            return;
        }
        var migrateCentral = event.target && event.target.closest ? event.target.closest('[data-skill-menu-migrate]') : null;
        if (migrateCentral) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({ type: 'migrate-skills-to-central', scope: migrateCentral.getAttribute('data-skill-menu-migrate') });
            return;
        }
        var changeGlobalSkillsLocation = event.target && event.target.closest
            ? event.target.closest('[data-change-global-skills-location]')
            : null;
        if (changeGlobalSkillsLocation) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({ type: 'change-global-skills-location' });
            return;
        }
        var sync = event.target && event.target.closest ? event.target.closest('[data-skill-sync]') : null;
        if (sync) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'sync-skill',
                sourceDir: sync.getAttribute('data-skill-sync'),
                targetDir: sync.getAttribute('data-skill-sync-target'),
            });
            return;
        }
        var copy = event.target && event.target.closest ? event.target.closest('[data-skill-copy]') : null;
        if (copy) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'copy-skill',
                sourceDir: copy.getAttribute('data-skill-copy'),
                targetRoot: copy.getAttribute('data-skill-copy-root'),
            });
            return;
        }
        var fix = event.target && event.target.closest ? event.target.closest('[data-skill-fix]') : null;
        if (fix) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'fix-skill-diagnostic',
                dirPath: fix.getAttribute('data-skill-fix'),
                code: fix.getAttribute('data-skill-fix-code'),
            });
            return;
        }
        var openButton = event.target && event.target.closest ? event.target.closest('[data-skill-open]') : null;
        if (openButton) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'open-skill-file', skillFilePath: openButton.getAttribute('data-skill-open') });
            return;
        }
        var skillCard = event.target && event.target.closest ? event.target.closest('.skill-card[data-skill-dir]') : null;
        if (skillCard) {
            if (event.target.closest && event.target.closest('.skill-detail')) {
                return;
            }
            var detail = skillCard.querySelector('.skill-detail');
            if (detail) {
                detail.hidden = !detail.hidden;
                skillCard.classList.toggle('skill-detail-open', !detail.hidden);
            }
        }
    }

    function setSkillAgentFilter(value) {
        skillAgentFilter = value;
        applySkillAgentFilter();
    }

    if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', onSkillCardClick);
        document.addEventListener('keydown', onSkillMoveInputKeydown);
        document.addEventListener('keydown', onSkillFolderMenuKeydown);
        document.addEventListener('keydown', onSkillsPaneResizerKeydown);
        document.addEventListener('dragstart', onSkillDragStart);
        document.addEventListener('dragover', onSkillDragOver);
        document.addEventListener('dragleave', onSkillDragLeave);
        document.addEventListener('drop', onSkillDrop);
        document.addEventListener('dragend', onSkillDragEnd);
        document.addEventListener('pointerdown', onSkillsPaneResizerPointerDown);
        document.addEventListener('pointermove', onSkillsPaneResizerPointerMove);
        document.addEventListener('pointerup', onSkillsPaneResizerPointerUp);
        document.addEventListener('pointercancel', onSkillsPaneResizerPointerUp);
    }

    if (typeof window.addEventListener === 'function') {
        window.addEventListener('resize', scheduleSkillsLayout);
    }

    // Re-layout when pane content visibility changes (collapse, agent filter)
    // or when an ancestor panel's hidden attribute toggles (tab switches).
    // Attribute-only: authoritative HTML replacements call layout explicitly.
    if (typeof MutationObserver === 'function' && document.body) {
        var skillsSplitObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var target = mutations[i].target;
                if (!target || target.nodeType !== 1) {
                    continue;
                }
                if (mutations[i].attributeName === 'hidden') {
                    scheduleSkillsLayout();
                    return;
                }
                if (mutations[i].attributeName === 'class'
                    && target.closest
                    && target.closest('[data-skills-split]')) {
                    scheduleSkillsLayout();
                    return;
                }
            }
        });
        skillsSplitObserver.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['hidden', 'class'],
        });
    }
    scheduleSkillsLayout();

    return {
        applySkillAgentFilter,
        captureSkillCollapsedGroups,
        captureSkillExpandedCards,
        captureSkillFolderMenuState,
        layoutSkillsSplit,
        replaceSkillsHtml,
        restoreSkillCollapsedGroups,
        restoreSkillExpandedCards,
        restoreSkillFolderMenuState,
        revealSkillCard,
        setSkillAgentFilter,
        settleSkillScopeActionWithoutHtml,
    };
}
