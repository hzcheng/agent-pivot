'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDirectRuntimeHarness,
    createTmuxRuntimeHarness,
    defineRuntimeContract,
    fakeCreateRequest,
    fakeResumeRequest,
} = require('../../helpers/runtimeContract');

function createLaunchProbe(request) {
    const { launch, ...requestWithoutLaunch } = request;
    let builds = 0;
    let eagerReads = 0;
    const probedRequest = {
        ...requestWithoutLaunch,
        launchMarkerPath: launch.markerPath || '',
        createLaunchSpec: () => {
            builds += 1;
            return { ...launch, args: [...launch.args] };
        },
    };
    Object.defineProperty(probedRequest, 'launch', {
        enumerable: true,
        get: () => {
            eagerReads += 1;
            return { ...launch, args: [...launch.args] };
        },
    });
    return {
        request: probedRequest,
        builds: () => builds,
        eagerReads: () => eagerReads,
    };
}

function plainRestoredTerminal(name, processId) {
    return {
        name,
        processId: Promise.resolve(processId),
        shown: false,
        disposed: false,
        show() { this.shown = true; },
        dispose() { this.disposed = true; },
    };
}

// SESSION-DIRECT-BACKEND-001
defineRuntimeContract({
    backendId: 'vscode',
    layout: 'direct',
    createHarness: createDirectRuntimeHarness,
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 direct focus can reveal a terminal without stealing keyboard focus', async () => {
    const harness = createDirectRuntimeHarness();
    const runtime = await harness.backend.ensureResume(fakeResumeRequest('preserve-direct'));

    await harness.backend.focus(runtime, { preserveFocus: true });

    assert.equal(harness.operations.at(-1).type, 'focus');
    assert.equal(harness.operations.at(-1).preserveFocus, true);
});

// RUNTIME-TMUX-BACKEND-001
for (const layout of ['project', 'session']) {
    defineRuntimeContract({
        backendId: 'tmux',
        layout,
        createHarness: () => createTmuxRuntimeHarness(layout),
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] focus after reload reuses the current-window attach terminal`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeResumeRequest(`reload-focus-${layout}`);
        const runtime = await harness.backend.ensureResume(request, layout);
        await harness.dependencies.attachStore.flush();
        const viewerCount = harness.viewerCount();
        harness.terminals[0].shown = false;

        const reloadedBackend = harness.createReloadedBackend();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);

        assert.equal(harness.viewerCount(), viewerCount);
        assert.equal(harness.terminals[0].shown, true);
    });

    test(`CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 [tmux ${layout}] focus can select a runtime without stealing keyboard focus`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const runtime = await harness.backend.ensureResume(
            fakeResumeRequest(`preserve-focus-${layout}`),
            layout
        );

        await harness.backend.focus(runtime, { preserveFocus: true });

        const show = harness.operations.filter(operation =>
            operation.type === 'show-terminal'
        ).at(-1);
        assert.equal(show.preserveFocus, true);
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] focus after reload recovers the live tmux client when VS Code drops terminal metadata`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeResumeRequest(`reload-live-client-${layout}`);
        const runtime = await harness.backend.ensureResume(request, layout);
        await harness.dependencies.attachStore.flush();
        const originalTerminal = harness.terminals[0];
        const viewerCount = harness.viewerCount();
        originalTerminal.shown = false;
        harness.loseReloadAttachMetadata(originalTerminal);

        const reloadedBackend = harness.createReloadedBackend();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);

        assert.equal(
            harness.viewerCount(),
            viewerCount,
            'a reload must not open a second terminal for the same live tmux client'
        );
        assert.equal(originalTerminal.shown, true);
        assert.equal(
            harness.operations.some(operation => operation.type === 'get-client-sessions'),
            true,
            'reload recovery must use the live terminal process when VS Code metadata is unavailable'
        );
    });

    test(`RUNTIME-TMUX-ATTACH-RESTORE-CONCURRENCY-001 [tmux ${layout}] reload restore subscribes to every terminal process ID before any of them resolves`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const runtime = await harness.backend.ensureResume(fakeResumeRequest(`concurrent-${layout}`), layout);
        await harness.dependencies.attachStore.flush();
        assert.equal(harness.terminals.length, 1);
        harness.terminals.push(plainRestoredTerminal('bash', 9421));

        const reloadedBackend = harness.createReloadedBackend();
        const subscriptions = [];
        const releases = [];
        harness.terminals.forEach((terminal, index) => {
            const originalProcessId = terminal.processId;
            let unblocked = false;
            terminal.processId = {
                then: (onFulfilled, onRejected) => {
                    if (unblocked) {
                        return Promise.resolve(originalProcessId).then(onFulfilled, onRejected);
                    }
                    subscriptions.push(index);
                    const released = new Promise(resolve => releases.push(() => {
                        unblocked = true;
                        resolve(originalProcessId);
                    }));
                    return released.then(onFulfilled, onRejected);
                },
            };
        });

        const restore = reloadedBackend.restoreAttachTerminals(harness.terminals);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual([...subscriptions].sort(), [0, 1],
            'restore must start resolving every terminal process ID before any of them settles');

        for (const release of releases) {
            release();
        }
        await restore;

        const viewerCount = harness.viewerCount();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);
        assert.equal(harness.viewerCount(), viewerCount,
            'attach terminals restored after reload must be reused instead of recreated');
        assert.equal(harness.terminals[0].shown, true);
        assert.equal(harness.terminals[1].shown, false,
            'plain terminals must not be attached');
    });

    test(`RUNTIME-TMUX-ATTACH-RESTORE-CONCURRENCY-001 [tmux ${layout}] reload restore shares one live-client list across terminals`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const runtime = await harness.backend.ensureResume(fakeResumeRequest(`batch-${layout}`), layout);
        await harness.dependencies.attachStore.flush();
        harness.loseReloadAttachMetadata(harness.terminals[0]);
        harness.terminals.push(
            plainRestoredTerminal('bash', 9501),
            plainRestoredTerminal('zsh', 9502),
        );

        const reloadedBackend = harness.createReloadedBackend();
        await reloadedBackend.restoreAttachTerminals(harness.terminals);

        assert.equal(
            harness.operations.filter(operation => operation.type === 'get-client-sessions').length,
            1,
            'live client recovery must reuse one list-clients snapshot per restore pass'
        );
        assert.equal(
            harness.operations.some(operation => operation.type === 'get-client-session'),
            false,
            'restore must not spawn one tmux list-clients invocation per terminal'
        );

        const viewerCount = harness.viewerCount();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);
        assert.equal(harness.viewerCount(), viewerCount,
            'the attach terminal recovered through the live client list must be reused');
        assert.equal(harness.terminals[0].shown, true);
        assert.equal(harness.terminals[1].shown, false);
        assert.equal(harness.terminals[2].shown, false);
    });

    test(`RUNTIME-TMUX-ATTACH-RESTORE-CONCURRENCY-001 [tmux ${layout}] terminals without process IDs are skipped without blocking the rest`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const runtime = await harness.backend.ensureResume(fakeResumeRequest(`unresolved-pid-${layout}`), layout);
        await harness.dependencies.attachStore.flush();

        const reloadedBackend = harness.createReloadedBackend();
        const plainTerminal = plainRestoredTerminal('bash', 9377);
        plainTerminal.processId = Promise.resolve(undefined);

        await reloadedBackend.restoreAttachTerminals([plainTerminal, ...harness.terminals]);

        assert.equal(plainTerminal.shown, false,
            'a terminal whose process ID never resolves must not be attached');
        const viewerCount = harness.viewerCount();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);
        assert.equal(harness.viewerCount(), viewerCount,
            'the attach terminal with a live process must still be restored and reused');
        assert.equal(harness.terminals[0].shown, true);
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] creates a recoverable tmux attach terminal`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        await harness.backend.ensureResume(
            fakeResumeRequest(`recoverable-attach-${layout}`),
            layout
        );
        const attach = harness.operations.find(operation =>
            operation.type === 'create-terminal'
        );

        assert.deepEqual(
            attach.creationOptions.shellArgs.slice(0, 2),
            ['attach-session', '-t']
        );
        assert.equal(
            harness.backend.isAttachTerminalCandidate({
                creationOptions: attach.creationOptions,
            }),
            true,
            'managed attach terminals must remain recoverable after extension reload'
        );
        assert.equal(
            harness.backend.isAttachTerminalCandidate({
                creationOptions: {
                    ...attach.creationOptions,
                    shellArgs: [
                        'attach-session',
                        '-d',
                        '-t',
                        attach.creationOptions.shellArgs[2],
                    ],
                },
            }),
            true,
            'terminals created by the previous exclusive-attach build must remain recoverable'
        );
    });

    test(`RUNTIME-TMUX-BACKEND-001 RUNTIME-TMUX-THREAD-SWITCH-001 [tmux ${layout}] focuses a durably rebound Codex thread when tmux metadata still names the original thread`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const originalRequest = fakeResumeRequest(`original-thread-${layout}`);
        const original = await harness.backend.ensureResume(originalRequest, layout);
        const originalBinding = await harness.store.getKnown(
            original.identity.provider,
            original.identity.sessionId
        );
        const reboundSessionId = `rebound-thread-${layout}`;

        assert.equal(
            await harness.store.rebindKnown(originalBinding, reboundSessionId),
            'rebound'
        );
        await harness.backend.refresh(true);
        const reboundIdentity = {
            ...original.identity,
            sessionId: reboundSessionId,
        };
        const rebound = harness.backend.find(reboundIdentity);
        assert.equal(rebound.length, 1);
        const focusCount = harness.focusCount();

        await harness.backend.focus(rebound[0]);

        assert.equal(harness.focusCount(), focusCount + 1);
        const runtimeWindow = harness.windows.find(window =>
            window.sessionName === rebound[0].tmux.sessionName
            && (!rebound[0].tmux.windowName
                || window.windowName === rebound[0].tmux.windowName)
        );
        assert.equal(
            runtimeWindow.metadata.sessionId,
            original.identity.sessionId,
            'thread switching does not rewrite the live tmux metadata'
        );

        await harness.store.removeKnown(
            reboundIdentity.provider,
            reboundIdentity.sessionId
        );
        await assert.rejects(
            harness.backend.focus(rebound[0]),
            error => error?.name === 'AiSessionRuntimeTargetChangedError'
        );
        assert.equal(
            harness.focusCount(),
            focusCount + 1,
            'metadata mismatch is accepted only while the exact durable rebind exists'
        );
    });

    test(`RUNTIME-TMUX-TERMINATE-SESSION-001 [tmux ${layout}] terminates a pending runtime before promotion`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeCreateRequest(`terminate-pending-${layout}`);
        const pending = await harness.backend.ensurePending(request, layout);
        assert.equal(harness.backend.getPending().length, 1);

        await harness.backend.terminate(pending);

        assert.equal(harness.terminateCount(), 1);
        assert.equal(harness.backend.getPending().length, 0,
            'a terminated pending runtime must disappear from the pending list');
        await harness.backend.terminate(pending);
        assert.equal(harness.terminateCount(), 1,
            'a vanished pending terminate target is treated as already terminated');
    });

    test(`RUNTIME-TMUX-TERMINATE-SESSION-001 [tmux ${layout}] refuses to terminate a window whose metadata names another workspace`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeResumeRequest(`terminate-guard-${layout}`);
        const runtime = await harness.backend.ensureResume(request, layout);
        harness.windows.forEach(window => {
            window.metadata = { ...window.metadata, workspaceScopeIdentity: 'foreign-scope' };
        });

        await assert.rejects(
            harness.backend.terminate(runtime),
            error => error?.name === 'AiSessionRuntimeTargetChangedError'
        );
        assert.equal(harness.terminateCount(), 0, 'a metadata mismatch must not kill the window');
        assert.equal(harness.backend.find(request.identity).length, 1);
    });
}

test('RUNTIME-TMUX-PROJECT-FIRST-WINDOW-001 creates the first project runtime in the initial tmux window', async () => {
    const harness = createTmuxRuntimeHarness('project');
    const runtime = await harness.backend.ensureResume(
        fakeResumeRequest('first-project-window'),
        'project'
    );
    const newSessionOperations = harness.operations.filter(item => item.type === 'new-session');
    const newWindowOperations = harness.operations.filter(item => item.type === 'new-window');

    assert.equal(harness.windows.length, 1);
    assert.equal(newSessionOperations.length, 1);
    assert.equal(newWindowOperations.length, 0);
    assert.equal(harness.windows[0].sessionName, runtime.tmux.sessionName);
    assert.equal(harness.windows[0].windowName, runtime.tmux.windowName);
    assert.equal(newSessionOperations[0].windowName, runtime.tmux.windowName);
    assert.notEqual(harness.windows[0].windowName, 'agent-pivot');
});

for (const runtime of [{
    label: 'Direct',
    layout: 'direct',
    createHarness: createDirectRuntimeHarness,
}, {
    label: 'tmux project',
    layout: 'project',
    createHarness: () => createTmuxRuntimeHarness('project'),
}, {
    label: 'tmux session',
    layout: 'session',
    createHarness: () => createTmuxRuntimeHarness('session'),
}]) {
    const invoke = (backend, method, request) => runtime.layout === 'direct'
        ? backend[method](request)
        : backend[method](request, runtime.layout);

    test(`SESSION-AI-SESSION-YOLO-LAZY-005 [${runtime.label}] materializes at final provider dispatch only`, async () => {
        const resumeHarness = runtime.createHarness();
        const firstResume = createLaunchProbe(fakeResumeRequest(`lazy-backend-${runtime.layout}`));
        await invoke(resumeHarness.backend, 'ensureResume', firstResume.request);
        assert.equal(firstResume.builds(), 1);
        assert.equal(firstResume.eagerReads(), 0);
        const reusedResume = createLaunchProbe(fakeResumeRequest(`lazy-backend-${runtime.layout}`));
        await invoke(resumeHarness.backend, 'ensureResume', reusedResume.request);
        assert.equal(reusedResume.builds(), 0, 'runtime reuse must not build a provider spec');
        assert.equal(reusedResume.eagerReads(), 0);

        const pendingHarness = runtime.createHarness();
        const firstPending = createLaunchProbe(fakeCreateRequest(`lazy-pending-${runtime.layout}`));
        await invoke(pendingHarness.backend, 'ensurePending', firstPending.request);
        assert.equal(firstPending.builds(), 1);
        assert.equal(firstPending.eagerReads(), 0);
        const reusedPending = createLaunchProbe(fakeCreateRequest(`lazy-pending-${runtime.layout}`));
        await invoke(pendingHarness.backend, 'ensurePending', reusedPending.request);
        assert.equal(reusedPending.builds(), 0, 'pending reuse must not build a provider spec');
        assert.equal(reusedPending.eagerReads(), 0);

        const collisionHarness = runtime.createHarness();
        const collision = createLaunchProbe(fakeResumeRequest(`lazy-collision-${runtime.layout}`));
        collisionHarness.installCollision(collision.request.identity);
        await assert.rejects(
            invoke(collisionHarness.backend, 'ensureResume', collision.request),
            /conflict|multiple/i
        );
        assert.equal(collision.builds(), 0, 'collision preflight must not build a provider spec');
        assert.equal(collision.eagerReads(), 0);

        if (runtime.layout !== 'direct') {
            const unavailableHarness = runtime.createHarness();
            unavailableHarness.setUnavailable();
            const unavailable = createLaunchProbe(fakeResumeRequest(
                `lazy-unavailable-${runtime.layout}`
            ));
            await assert.rejects(
                invoke(unavailableHarness.backend, 'ensureResume', unavailable.request),
                error => error?.name === 'TmuxRuntimeUnavailableError'
            );
            assert.equal(
                unavailable.builds(), 0,
                'tmux availability preflight must not build a provider spec'
            );
            assert.equal(unavailable.eagerReads(), 0);
        }
    });
}

test('RUNTIME-TMUX-WORKTREE-RELOAD-001 preserves v3 identity through metadata, store, and discovery', async () => {
    const harness = createTmuxRuntimeHarness('session');
    const identity = {
        provider: 'codex',
        workspaceScopeIdentity: 'scope:worktree',
        workspaceNavigationIdentity: 'navigation:worktree',
        workspaceRootHostPaths: ['/repos/frontend', '/repos/backend'],
        writableRootHostPaths: ['/managed/frontend-feature', '/repos/backend'],
        worktreeKey: {
            repositoryKey: '/repos/frontend/.git',
            canonicalWorktreePath: '/managed/frontend-feature',
        },
        cwd: '/managed/frontend-feature',
        sessionId: 'worktree-runtime',
    };
    const request = fakeResumeRequest(identity.sessionId, {
        identity,
        directoryScope: {
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            writableRootHostPaths: [...identity.writableRootHostPaths],
            worktreeKey: { ...identity.worktreeKey },
            primaryRootId: 'root:frontend',
            primaryCwd: identity.cwd,
            additionalDirectories: ['/repos/backend'],
        },
    });

    const runtime = await harness.backend.ensureResume(request, 'session');
    assert.deepEqual(runtime.identity, identity);
    assert.equal(harness.windows[0].sessionMetadata.version, '3');
    assert.deepEqual(
        JSON.parse(harness.windows[0].sessionMetadata.writableRootHostPaths),
        identity.writableRootHostPaths
    );
    assert.deepEqual(
        JSON.parse(harness.windows[0].sessionMetadata.worktreeKey),
        identity.worktreeKey
    );
    const [known] = await harness.store.listKnown();
    assert.equal(known.version, 3);
    assert.deepEqual(known.writableRootHostPaths, identity.writableRootHostPaths);
    assert.deepEqual(known.worktreeKey, identity.worktreeKey);

    await harness.discovery.refresh(true);
    assert.deepEqual(harness.discovery.getActive()[0].identity, identity);
});
