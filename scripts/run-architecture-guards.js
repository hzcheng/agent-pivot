'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { validateManifestPair } = require('./lib/brandIdentity');

function fail(id, risk, detail) {
    throw new assert.AssertionError({ message: `${id} risk: ${risk}; ${detail}` });
}

function read(root, relativePath, id, risk) {
    try {
        return fs.readFileSync(path.join(root, relativePath), 'utf8');
    } catch (error) {
        fail(id, risk, `cannot inspect ${relativePath}: ${error.message}`);
    }
}

function readJson(root, relativePath, id, risk) {
    try {
        return JSON.parse(read(root, relativePath, id, risk));
    } catch (error) {
        if (error instanceof assert.AssertionError) {
            throw error;
        }
        fail(id, risk, `${relativePath} must contain valid JSON: ${error.message}`);
    }
}

function parseTypescript(root, relativePath, id, risk) {
    const source = read(root, relativePath, id, risk);
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length) {
        fail(id, risk, `${relativePath} must parse as TypeScript`);
    }
    return sourceFile;
}

function parseJavascript(root, relativePath, id, risk) {
    const source = read(root, relativePath, id, risk);
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (sourceFile.parseDiagnostics.length) {
        fail(id, risk, `${relativePath} must parse as JavaScript`);
    }
    return sourceFile;
}

function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, child => walk(child, visit));
}

function findVariable(sourceFile, name, id, risk) {
    const matches = [];
    walk(sourceFile, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
            matches.push(node);
        }
    });
    if (matches.length !== 1) {
        fail(id, risk, `${name} must have exactly one real declaration`);
    }
    return matches[0];
}

function numericInitializer(sourceFile, name, id, risk) {
    const declaration = findVariable(sourceFile, name, id, risk);
    if (!declaration.initializer || !ts.isNumericLiteral(declaration.initializer)) {
        fail(id, risk, `${name} must use a numeric literal initializer`);
    }
    return Number(declaration.initializer.text);
}

function stringInitializer(sourceFile, name, id, risk) {
    const declaration = findVariable(sourceFile, name, id, risk);
    if (!declaration.initializer || !ts.isStringLiteral(declaration.initializer)) {
        fail(id, risk, `${name} must use a string-literal initializer`);
    }
    return declaration.initializer.text;
}

function stringArrayInitializer(sourceFile, name, id, risk) {
    const declaration = findVariable(sourceFile, name, id, risk);
    if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)
        || declaration.initializer.elements.some(element => !ts.isStringLiteral(element))) {
        fail(id, risk, `${name} must use a string-literal array initializer`);
    }
    return declaration.initializer.elements.map(element => element.text);
}

function callArguments(rootNode, calleeText) {
    const sourceFile = ts.isSourceFile(rootNode) ? rootNode : rootNode.getSourceFile();
    const calls = [];
    walk(rootNode, node => {
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === calleeText) {
            calls.push(node.arguments);
        }
    });
    return calls;
}

function stringArgument(argument) {
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : undefined;
}

function normalizedAstText(node, sourceFile) {
    return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
}

function uniqueAstNode(root, predicate, id, risk, label) {
    const matches = [];
    walk(root, node => {
        if (predicate(node)) matches.push(node);
    });
    if (matches.length !== 1) fail(id, risk, `${label} must exist exactly once`);
    return matches[0];
}

function classMethod(sourceFile, className, methodName, id, risk) {
    const declaration = uniqueAstNode(sourceFile,
        node => ts.isClassDeclaration(node) && node.name?.text === className,
        id, risk, `class ${className}`);
    return uniqueAstNode(declaration,
        node => ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === methodName,
        id, risk, `${className}.${methodName}`);
}

function protocolScope(sourceFile, descriptor, id, risk) {
    if (descriptor.kind === 'function') {
        return uniqueAstNode(sourceFile,
            node => ts.isFunctionDeclaration(node) && node.name?.text === descriptor.name,
            id, risk, `function ${descriptor.name}`);
    }
    if (descriptor.kind === 'class-method') {
        return classMethod(sourceFile, descriptor.className, descriptor.methodName, id, risk);
    }
    if (descriptor.kind === 'class-method-variable') {
        const method = classMethod(sourceFile, descriptor.className, descriptor.methodName, id, risk);
        const variable = uniqueAstNode(method,
            node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
                && node.name.text === descriptor.variableName,
            id, risk, `${descriptor.className}.${descriptor.methodName} variable ${descriptor.variableName}`);
        if (!variable.initializer || !ts.isArrowFunction(variable.initializer)) {
            fail(id, risk, `${descriptor.variableName} must remain an arrow callback`);
        }
        return variable.initializer;
    }
    if (descriptor.kind === 'registered-callback') {
        const variable = findVariable(sourceFile, descriptor.variableName, id, risk);
        if (!variable.initializer || !ts.isCallExpression(variable.initializer)
            || !variable.initializer.arguments[descriptor.argumentIndex]
            || !ts.isArrowFunction(variable.initializer.arguments[descriptor.argumentIndex])) {
            fail(id, risk, `${descriptor.variableName} must retain its registered callback`);
        }
        return variable.initializer.arguments[descriptor.argumentIndex];
    }
    if (descriptor.kind === 'class-method-call-callback') {
        const method = classMethod(sourceFile, descriptor.className, descriptor.methodName, id, risk);
        const call = uniqueAstNode(method,
            node => ts.isCallExpression(node)
                && node.expression.getText(sourceFile) === descriptor.callee,
            id, risk, `${descriptor.className}.${descriptor.methodName} ${descriptor.callee} callback`);
        const callback = call.arguments[descriptor.argumentIndex];
        if (!callback || !ts.isArrowFunction(callback)) {
            fail(id, risk, `${descriptor.callee} must retain its callback argument`);
        }
        return callback;
    }
    fail(id, risk, `unknown protocol scope ${descriptor.kind}`);
}

function walkOwnScope(root, visit) {
    const descend = node => {
        visit(node);
        ts.forEachChild(node, child => {
            if (child !== root && ts.isFunctionLike(child)) return;
            descend(child);
        });
    };
    descend(root);
}

const PROTOCOL_EXPECTATIONS = [
    { file: 'src/aiSessions/attentionBridgeClient.ts', site: 'attention client unregister writer',
        scope: { kind: 'class-method-variable', className: 'AttentionBridgeClient', methodName: 'shutdown', variableName: 'unregister' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' }] },
    { file: 'src/aiSessions/attentionBridgeClient.ts', site: 'attention client handshake writer',
        scope: { kind: 'class-method', className: 'AttentionBridgeClient', methodName: 'handshake' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' },
            { kind: ts.SyntaxKind.CallExpression, text: 'validateAttentionBridgeHandshakeResponse(response)' }] },
    { file: 'src/aiSessions/attentionBridgeClient.ts', site: 'attention client aggregate reader',
        scope: { kind: 'class-method', className: 'AttentionBridgeClient', methodName: 'receiveAggregate' },
        nodes: [{ kind: ts.SyntaxKind.CallExpression, text: 'validateAttentionAggregate(raw)' }] },
    ...['validateAttentionBridgeHandshakeRequest', 'validateAttentionBridgeHandshakeResponse', 'validateAttentionUnregisterRequest']
        .map(name => ({ file: 'src/aiSessions/attentionPayload.ts', site: `${name} validator and normalized return`,
            scope: { kind: 'function', name }, nodes: [
                { kind: ts.SyntaxKind.BinaryExpression, text: 'record.protocolVersion !== 1' },
                { kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' },
            ] })),
    { file: 'src/aiSessions/attentionAggregate.ts', site: 'attention aggregate validator and normalized return',
        scope: { kind: 'function', name: 'validateAttentionAggregate' }, nodes: [
            { kind: ts.SyntaxKind.BinaryExpression, text: 'record.protocolVersion !== 1' },
            { kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' },
        ] },
    { file: 'src/aiSessions/attentionAggregate.ts', site: 'attention aggregate writer',
        scope: { kind: 'function', name: 'aggregateAttentionSnapshots' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' }] },
    { file: 'extensions/attention-ui-bridge/src/extension.ts', site: 'bridge handshake reader and response writer',
        scope: { kind: 'registered-callback', variableName: 'productionHandshakeDisposable', argumentIndex: 1 }, nodes: [
            { kind: ts.SyntaxKind.CallExpression, text: 'validateAttentionBridgeHandshakeRequest(raw)' },
            { kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: 1' },
        ] },
    { file: 'extensions/attention-ui-bridge/src/extension.ts', site: 'bridge unregister reader',
        scope: { kind: 'registered-callback', variableName: 'productionUnregisterDisposable', argumentIndex: 1 },
        nodes: [{ kind: ts.SyntaxKind.CallExpression, text: 'validateAttentionUnregisterRequest(raw)' }] },
    { file: 'src/openWorkspaces/bridgeClient.ts', site: 'open-workspace client aggregate reader',
        scope: { kind: 'class-method', className: 'OpenWorkspaceBridgeClient', methodName: 'receiveAggregate' },
        nodes: [{ kind: ts.SyntaxKind.CallExpression, text: 'validateOpenWorkspaceAggregate(raw)' }] },
    { file: 'src/openWorkspaces/bridgeClient.ts', site: 'open-workspace client unregister writer',
        scope: { kind: 'class-method-call-callback', className: 'OpenWorkspaceBridgeClient', methodName: 'shutdown', callee: 'Promise.resolve().then', argumentIndex: 0 },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION' }] },
    { file: 'src/openWorkspaces/bridgeClient.ts', site: 'open-workspace client publication writer',
        scope: { kind: 'class-method', className: 'OpenWorkspaceBridgeClient', methodName: 'publishNow' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION' }] },
    ...['validateOpenWorkspacePublication', 'validateOpenWorkspaceRegistration', 'validateOpenWorkspaceAggregate']
        .map(name => ({ file: 'src/openWorkspaces/protocol.ts', site: `${name} validator and normalized return`,
            scope: { kind: 'function', name }, nodes: [
                { kind: ts.SyntaxKind.CallExpression,
                    text: `requireProtocolVersion(${name === 'validateOpenWorkspacePublication' ? 'publication' : name === 'validateOpenWorkspaceRegistration' ? 'registration' : 'aggregate'}.protocolVersion)` },
                { kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION' },
            ] })),
    { file: 'extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts', site: 'coordinator unregister version forwarding',
        scope: { kind: 'function', name: 'validateUnregisterRequest' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: request.protocolVersion' }] },
    { file: 'extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts', site: 'coordinator registration writer',
        scope: { kind: 'class-method-call-callback', className: 'OpenWorkspaceCoordinator', methodName: 'publish', callee: 'this.enqueueMutation', argumentIndex: 0 },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION' }] },
    { file: 'extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts', site: 'coordinator aggregate writer',
        scope: { kind: 'class-method', className: 'OpenWorkspaceCoordinator', methodName: 'scanOnce' },
        nodes: [{ kind: ts.SyntaxKind.PropertyAssignment, text: 'protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION' }] },
];

function validateProtocolExpectations(root, id, risk) {
    const parsed = new Map();
    for (const expectation of PROTOCOL_EXPECTATIONS) {
        const sourceFile = parsed.get(expectation.file)
            || parseTypescript(root, expectation.file, id, risk);
        parsed.set(expectation.file, sourceFile);
        const scope = protocolScope(sourceFile, expectation.scope, id, risk);
        for (const expectedNode of expectation.nodes) {
            const matches = [];
            walkOwnScope(scope, node => {
                if (node.kind === expectedNode.kind
                    && normalizedAstText(node, sourceFile) === expectedNode.text) matches.push(node);
            });
            if (matches.length !== 1) {
                fail(id, risk, `${expectation.site} must contain exactly one ${expectedNode.text}`);
            }
        }
    }
}

function newExpressionOptionCallback(sourceFile, variableName, constructorName, optionName, id, risk) {
    const variable = findVariable(sourceFile, variableName, id, risk);
    let constructor = variable.initializer;
    if (constructor && ts.isCallExpression(constructor)
        && constructor.expression.getText(sourceFile) === 'ownResource'
        && constructor.arguments.length === 1
        && ts.isArrowFunction(constructor.arguments[0])
        && constructor.arguments[0].parameters.length === 0
        && !constructor.arguments[0].modifiers?.some(
            modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        && ts.isNewExpression(constructor.arguments[0].body)) {
        constructor = constructor.arguments[0].body;
    }
    if (!constructor || !ts.isNewExpression(constructor)
        || constructor.expression.getText(sourceFile) !== constructorName
        || constructor.arguments?.length !== 1
        || !ts.isObjectLiteralExpression(constructor.arguments[0])) {
        fail(id, risk, `${variableName} must be constructed with one options object`);
    }
    const option = constructor.arguments[0].properties.filter(property =>
        ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === optionName);
    if (option.length !== 1 || !ts.isPropertyAssignment(option[0]) || !ts.isArrowFunction(option[0].initializer)) {
        fail(id, risk, `${variableName}.${optionName} must exist exactly once as an arrow callback`);
    }
    return option[0].initializer;
}

function listFiles(root, relativeDirectory, extension) {
    const directory = path.join(root, relativeDirectory);
    const files = [];
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && entry.name.endsWith(extension)) {
                files.push(path.relative(root, absolute));
            }
        }
    };
    visit(directory);
    return files.sort();
}

function importModules(sourceFile) {
    return sourceFile.statements
        .filter(ts.isImportDeclaration)
        .map(statement => statement.moduleSpecifier)
        .filter(ts.isStringLiteral)
        .map(moduleSpecifier => moduleSpecifier.text);
}

function moduleReferences(sourceFile) {
    const modules = importModules(sourceFile);
    walk(sourceFile, node => {
        if (ts.isExportDeclaration(node)
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)) {
            modules.push(node.moduleSpecifier.text);
            return;
        }
        if (ts.isImportEqualsDeclaration(node)
            && ts.isExternalModuleReference(node.moduleReference)
            && node.moduleReference.expression) {
            const moduleName = stringArgument(node.moduleReference.expression);
            if (moduleName !== undefined) modules.push(moduleName);
            return;
        }
        if (ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments.length === 1) {
            const moduleName = stringArgument(node.arguments[0]);
            if (moduleName !== undefined) modules.push(moduleName);
            return;
        }
        if (!ts.isCallExpression(node)
            || !ts.isIdentifier(node.expression)
            || node.expression.text !== 'require'
            || node.arguments.length !== 1) return;
        const moduleName = stringArgument(node.arguments[0]);
        if (moduleName !== undefined) modules.push(moduleName);
    });
    return modules;
}

function resolveRelativeTypescriptModule(
    root,
    importerPath,
    moduleName,
    id,
    risk
) {
    const unresolved = path.resolve(
        root,
        path.dirname(importerPath),
        moduleName
    );
    const rootWithSeparator = path.resolve(root) + path.sep;
    if (!unresolved.startsWith(rootWithSeparator)) {
        fail(id, risk,
            `Codex reachable module escapes the repository: ${moduleName}`);
    }
    const candidates = [
        unresolved,
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.js`,
        `${unresolved}.mjs`,
        `${unresolved}.cjs`,
        path.join(unresolved, 'index.ts'),
        path.join(unresolved, 'index.tsx'),
        path.join(unresolved, 'index.js'),
        path.join(unresolved, 'index.mjs'),
        path.join(unresolved, 'index.cjs'),
    ];
    const resolved = candidates.find(candidate => {
        try {
            return fs.statSync(candidate).isFile();
        } catch (_error) {
            return false;
        }
    });
    if (!resolved) {
        fail(id, risk,
            `cannot resolve Codex reachable module ${moduleName} from ${importerPath}`);
    }
    return path.relative(root, resolved);
}

function validateCodexReachableModules(root, id, risk) {
    const entry = 'src/aiSessions/conversation/codexAdapter.ts';
    const queue = [entry];
    const visited = new Set();
    while (queue.length) {
        const relativePath = queue.shift();
        if (visited.has(relativePath)) continue;
        visited.add(relativePath);
        const sourceFile = /\.[cm]?js$/i.test(relativePath)
            ? parseJavascript(root, relativePath, id, risk)
            : parseTypescript(root, relativePath, id, risk);
        for (const moduleName of moduleReferences(sourceFile)) {
            const filesystemModule =
                /^(?:node:)?fs(?:[/\\]|$)/i.test(moduleName);
            const transcriptReaderModule =
                /(?:^|[/\\])(?:source|jsonlReader)(?:\.[cm]?[jt]sx?)?(?:[/\\]|$)/i
                    .test(moduleName);
            if (filesystemModule || transcriptReaderModule) {
                if (relativePath !== entry) {
                    fail(id, risk,
                        'Codex reachable modules must not import filesystem or transcript readers');
                }
                if (filesystemModule) {
                    fail(id, risk,
                        'Codex conversation adapter must not import filesystem or transcript JSONL readers');
                }
                fail(id, risk,
                    'Codex production content must remain app-server-only');
            }
            if (moduleName.startsWith('.')) {
                queue.push(resolveRelativeTypescriptModule(
                    root,
                    relativePath,
                    moduleName,
                    id,
                    risk
                ));
            }
        }
    }
}

function memberPath(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(node)) {
        const parent = memberPath(node.expression);
        return parent ? `${parent}.${node.name.text}` : undefined;
    }
    if (ts.isElementAccessExpression(node)
        && node.argumentExpression
        && (ts.isStringLiteral(node.argumentExpression)
            || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
        const parent = memberPath(node.expression);
        return parent ? `${parent}.${node.argumentExpression.text}` : undefined;
    }
    return undefined;
}

function nodesMatching(root, predicate) {
    const matches = [];
    walk(root, node => {
        if (predicate(node)) matches.push(node);
    });
    return matches;
}

function validateProviderWatchOwnership(sourceFile, className, id, risk) {
    const ensureMethod = classMethod(sourceFile, className, 'ensureProviderWatch', id, risk);
    const watchMethod = classMethod(sourceFile, className, 'watch', id, risk);
    const releaseMethod = classMethod(sourceFile, className, 'releaseProviderWatchIfIdle', id, risk);
    if (!releaseMethod.body) {
        fail(id, risk, `${className}.releaseProviderWatchIfIdle must have a body`);
    }

    const providerWatchCalls = nodesMatching(sourceFile, node =>
        ts.isCallExpression(node)
        && memberPath(node.expression) === 'this.options.watchSessionChanges');
    const ensureProviderWatchCalls = nodesMatching(ensureMethod, node =>
        ts.isCallExpression(node)
        && memberPath(node.expression) === 'this.options.watchSessionChanges');
    if (providerWatchCalls.length !== 1
        || ensureProviderWatchCalls.length !== 1
        || !ts.isBinaryExpression(ensureProviderWatchCalls[0].parent)
        || ensureProviderWatchCalls[0].parent.right !== ensureProviderWatchCalls[0]
        || ensureProviderWatchCalls[0].parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        || memberPath(ensureProviderWatchCalls[0].parent.left) !== 'this.providerWatch') {
        fail(id, risk, 'provider watchers must remain bounded and releasable');
    }

    const watchEnsureCalls = nodesMatching(watchMethod, node =>
        ts.isCallExpression(node) && memberPath(node.expression) === 'this.ensureProviderWatch');
    const watchReleaseCalls = nodesMatching(watchMethod, node =>
        ts.isCallExpression(node) && memberPath(node.expression) === 'this.releaseProviderWatchIfIdle');
    if (watchEnsureCalls.length !== 1 || watchReleaseCalls.length !== 1) {
        fail(id, risk, 'provider watchers must remain bounded and releasable');
    }

    const statements = releaseMethod.body.statements;
    const subscriptionGuard = statements[0];
    if (!subscriptionGuard
        || !ts.isIfStatement(subscriptionGuard)
        || memberPath(subscriptionGuard.expression) !== 'this.subscriptions.size'
        || subscriptionGuard.elseStatement
        || !ts.isBlock(subscriptionGuard.thenStatement)
        || subscriptionGuard.thenStatement.statements.length !== 1
        || !ts.isReturnStatement(subscriptionGuard.thenStatement.statements[0])
        || subscriptionGuard.thenStatement.statements[0].expression) {
        fail(id, risk, 'provider watchers must remain bounded and releasable');
    }

    const disposeStatement = statements[1];
    const disposeCall = disposeStatement
        && ts.isExpressionStatement(disposeStatement)
        && ts.isCallExpression(disposeStatement.expression)
        ? disposeStatement.expression
        : undefined;
    if (!disposeCall
        || disposeCall.arguments.length
        || memberPath(disposeCall.expression) !== 'this.providerWatch.dispose'
        || !ts.isPropertyAccessExpression(disposeCall.expression)
        || !disposeCall.expression.questionDotToken) {
        fail(id, risk, 'provider watchers must remain bounded and releasable');
    }

    const clearStatement = statements[2];
    const clearAssignment = clearStatement
        && ts.isExpressionStatement(clearStatement)
        && ts.isBinaryExpression(clearStatement.expression)
        ? clearStatement.expression
        : undefined;
    if (!clearAssignment
        || clearAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        || memberPath(clearAssignment.left) !== 'this.providerWatch'
        || !ts.isIdentifier(clearAssignment.right)
        || clearAssignment.right.text !== 'undefined'
        || nodesMatching(releaseMethod, ts.isReturnStatement).length !== 1
        || nodesMatching(releaseMethod, node =>
            ts.isCallExpression(node)
            && memberPath(node.expression) === 'this.providerWatch.dispose').length !== 1
        || nodesMatching(releaseMethod, node =>
            ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && memberPath(node.left) === 'this.providerWatch'
            && ts.isIdentifier(node.right)
            && node.right.text === 'undefined').length !== 1) {
        fail(id, risk, 'provider watchers must remain bounded and releasable');
    }
}

function objectFreezeProperties(sourceFile, variableName, id, risk) {
    const declaration = findVariable(sourceFile, variableName, id, risk);
    const initializer = declaration.initializer;
    if (!initializer || !ts.isCallExpression(initializer)
        || initializer.expression.getText(sourceFile) !== 'Object.freeze'
        || initializer.arguments.length !== 1
        || !ts.isObjectLiteralExpression(initializer.arguments[0])) {
        fail(id, risk, `${variableName} must remain one frozen object literal`);
    }
    return new Map(initializer.arguments[0].properties.map(property => {
        if (!ts.isPropertyAssignment(property)) {
            fail(id, risk, `${variableName} must contain only property assignments`);
        }
        return [
            property.name.getText(sourceFile),
            normalizedAstText(property.initializer, sourceFile),
        ];
    }));
}

const guards = {
    // ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001
    'ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001'(root) {
        const risk = 'workspace root changes can rotate card and Conversation identity';
        const authority = parseTypescript(
            root,
            'src/workspaces/currentWorkspaceSessionAuthority.ts',
            this.id,
            risk
        );
        const controller = parseTypescript(
            root,
            'src/openWorkspaces/dashboardController.ts',
            this.id,
            risk
        );
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const getProjectId = classMethod(
            authority,
            'CurrentWorkspaceSessionAuthority',
            'getProjectId',
            this.id,
            risk
        );
        if (!normalizedAstText(getProjectId, authority).includes(
            'authorities.get( normalized.workspaceNavigationIdentity )'
        )) {
            fail(this.id, risk,
                'the authority must retain identity by workspace navigation, not current root scope');
        }

        const createCurrentCard = classMethod(
            controller,
            'OpenWorkspaceDashboardController',
            'createCurrentCard',
            this.id,
            risk
        );
        const navigationAssignments = [];
        walkOwnScope(createCurrentCard, node => {
            if (ts.isPropertyAssignment(node)
                && node.name.getText(controller)
                    === 'workspaceNavigationIdentity') {
                navigationAssignments.push(node);
            }
        });
        if (navigationAssignments.length !== 1
            || normalizedAstText(
                navigationAssignments[0].initializer,
                controller
            ) !== 'navigationIdentity'
            || !normalizedAstText(createCurrentCard, controller).includes(
                'id: projectId'
            )) {
            fail(this.id, risk,
                'the current card must consume the shared navigation-scoped authority exactly once');
        }

        const dashboardSource = dashboard.getFullText();
        if ((dashboardSource.match(/new CurrentWorkspaceSessionAuthority\s*\(/g) || []).length !== 1
            || (dashboardSource.match(
                /currentWorkspaceSessionAuthority\.getProjectId\s*\(/g
            ) || []).length !== 5
            || !dashboardSource.includes(
                'getCurrentWorkspaceSessionProjectId: identity =>'
            )
            || dashboardSource.includes(
                'function getCurrentWorkspaceConversationProjectId('
            )
            || (dashboardSource.match(
                /previous\.workspaceNavigationIdentity\s*!==\s*next\.workspaceNavigationIdentity/g
            ) || []).length !== 2
            || /previous\.workspaceScopeIdentity\s*!==\s*next\.workspaceScopeIdentity/
                .test(dashboardSource)
            ) {
            fail(this.id, risk,
                'cards and Conversation rebinds must share one Host-owned authority');
        }
    },

    // ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001
    'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001'(root) {
        const risk = 'separately sampled HTML and Presentation can publish conflicting state at adjacent revisions';
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const controller = parseTypescript(
            root,
            'src/aiSessions/dashboardController.ts',
            this.id,
            risk
        );
        const hydrationController = parseTypescript(
            root,
            'src/workspaces/sessionHydrationController.ts',
            this.id,
            risk
        );
        const hydration = parseTypescript(
            root,
            'src/workspaces/sessionHydration.ts',
            this.id,
            risk
        );
        const webview = parseJavascript(
            root,
            'src/webview/webviewProjectAiUpdateScripts.js',
            this.id,
            risk
        );
        const controllerSource = controller.getFullText();
        if (controllerSource.includes('nextSequence')
            || controllerSource.includes('beforeRefresh')) {
            fail(this.id, risk,
                'the incremental controller must begin one explicit projection transaction');
        }
        const cardCalls = callArguments(controller, 'this.options.getCards');
        const buildCalls = callArguments(controller, 'buildAiSessionsUpdatedMessage');
        const buildInput = buildCalls.length === 1 ? buildCalls[0][0] : null;
        const sequenceAssignment = buildInput && ts.isObjectLiteralExpression(buildInput)
            ? buildInput.properties.find(property =>
                ts.isPropertyAssignment(property)
                    && property.name.getText(controller) === 'sequence')
            : null;
        if (cardCalls.length !== 1
            || cardCalls[0].length !== 1
            || cardCalls[0][0].getText(controller) !== 'projection'
            || !sequenceAssignment
            || !ts.isPropertyAssignment(sequenceAssignment)
            || sequenceAssignment.initializer.getText(controller)
                !== 'projection.revision') {
            fail(this.id, risk,
                'cards and HTML must consume the transaction and publish its revision');
        }
        const dashboardSource = dashboard.getFullText();
        if (!/getCards:\s*projection\s*=>\s*getOpenWorkspaceCards\(projection\)/
            .test(dashboardSource)
            || !/postAiSessionPresentationState\(false,\s*transaction\);\s*return transaction;/
                .test(dashboardSource)) {
            fail(this.id, risk,
                'Dashboard composition must pass one captured transaction to both channels');
        }
        const hydrationControllerSource = hydrationController.getFullText();
        const hydrationSource = hydration.getFullText();
        if (!hydrationControllerSource.includes('activePresentation,')
            || !hydrationSource.includes('input.activePresentation')
            || !hydrationSource.includes('projectWorkspaceActiveSessions({')) {
            fail(this.id, risk,
                'hydration must consume the transaction presentation with only an explicit fallback');
        }
        const webviewSource = webview.getFullText();
        if (!webviewSource.includes('latestAiSessionDirectPresentationRevision')
            || !webviewSource.includes('revision < latestAiSessionProjectionRevision')
            || !webviewSource.includes('revision <= latestAiSessionDirectPresentationRevision')) {
            fail(this.id, risk,
                'the Webview must accept one same-revision direct Presentation after HTML');
        }
    },

    // ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001
    'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001'(root) {
        const risk = 'terminal-moving session commands can race and project different targets';
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const quickSwitch = parseTypescript(
            root,
            'src/dashboard/sessionQuickSwitch.ts',
            this.id,
            risk,
        );
        const coordinator = findVariable(
            dashboard,
            'sessionNavigationCoordinator',
            this.id,
            risk,
        );
        if (!coordinator.initializer
            || !ts.isCallExpression(coordinator.initializer)
            || coordinator.initializer.expression.getText(dashboard)
                !== 'createSessionNavigationCoordinator') {
            fail(this.id, risk,
                'dashboard composition must create exactly one session navigation coordinator');
        }
        for (const factoryName of [
            'createAttentionQueueJumpHandler',
            'createRunningSessionJumpHandler',
            'createAiSessionQuickSwitchHandlers',
        ]) {
            const calls = callArguments(dashboard, factoryName);
            const options = calls.length === 1 ? calls[0][0] : null;
            if (!options || !ts.isObjectLiteralExpression(options)) {
                fail(this.id, risk, `${factoryName} must have one options object`);
            }
            const navigationOwner = options.properties.find(property =>
                property.name?.getText(dashboard) === 'navigationCoordinator');
            if (!navigationOwner || !ts.isPropertyAssignment(navigationOwner)
                || navigationOwner.initializer.getText(dashboard)
                    !== 'sessionNavigationCoordinator') {
                fail(this.id, risk,
                    'every direct session command must use the shared navigation coordinator');
            }
            const localNavigator = options.properties.find(property =>
                property.name?.getText(dashboard) === 'navigateSession');
            if (!localNavigator || !ts.isPropertyAssignment(localNavigator)
                || callArguments(
                    localNavigator.initializer,
                    'sessionNavigationFocusExecutor.execute',
                ).length !== 1) {
                fail(this.id, risk,
                    'every direct session command must use the shared local focus executor');
            }
        }
        if (callArguments(quickSwitch, 'navigationCoordinator.enqueue').length !== 3
            || callArguments(quickSwitch, 'options.navigateSession').length !== 1
            || callArguments(quickSwitch, 'options.focusSession').length !== 0
            || callArguments(quickSwitch, 'options.openConversation').length !== 0) {
            fail(this.id, risk,
                'Quick Switch and Toggle must own no navigation path outside the shared transaction');
        }
        const commandHandlers = findVariable(
            dashboard,
            'commandHandlers',
            this.id,
            risk,
        );
        if (!commandHandlers.initializer
            || !ts.isObjectLiteralExpression(commandHandlers.initializer)) {
            fail(this.id, risk, 'dashboard command handlers must remain one object literal');
        }
        for (const [name, direction] of [
            ['previousActiveSession', 'previous'],
            ['nextActiveSession', 'next'],
        ]) {
            const handler = commandHandlers.initializer.properties.find(property =>
                property.name?.getText(dashboard) === name);
            if (!handler || !ts.isPropertyAssignment(handler)
                || callArguments(
                    handler.initializer,
                    'sessionNavigationCoordinator.enqueue',
                ).length !== 1) {
                fail(this.id, risk,
                    'Previous and Next Active Session commands must use the shared navigation coordinator');
            }
            const followCalls = callArguments(
                handler.initializer,
                'followAdjacentActiveConversationWithFeedback',
            );
            if (followCalls.length !== 1
                || stringArgument(followCalls[0][0]) !== direction) {
                fail(this.id, risk,
                    'Previous and Next Active Session commands must preserve their direction');
            }
        }
    },

    // ARCH-OPEN-WORKSPACE-FOCUS-TRANSPORT-OWNERSHIP-001
    'ARCH-OPEN-WORKSPACE-FOCUS-TRANSPORT-OWNERSHIP-001'(root) {
        const risk = 'Running and Attention focus transports can drift into incompatible delivery state machines';
        const sharedStore = parseTypescript(
            root,
            'extensions/attention-ui-bridge/src/openWorkspaceFocusMailboxStore.ts',
            this.id,
            risk,
        );
        const sharedCoordinator = parseTypescript(
            root,
            'extensions/attention-ui-bridge/src/openWorkspaceFocusMailboxCoordinator.ts',
            this.id,
            risk,
        );

        for (const methodName of [
            'submit', 'scan', 'claim', 'restore', 'complete', 'waitForDelivery', 'cancel',
        ]) {
            classMethod(
                sharedStore,
                'OpenWorkspaceFocusMailboxStore',
                methodName,
                this.id,
                risk,
            );
        }
        for (const methodName of ['submit', 'requestDelivery', 'scanAndDeliver', 'scanOnce']) {
            classMethod(
                sharedCoordinator,
                'OpenWorkspaceFocusMailboxCoordinator',
                methodName,
                this.id,
                risk,
            );
        }

        for (const protocol of ['Attention', 'Running']) {
            const storePath = `extensions/attention-ui-bridge/src/openWorkspace${protocol}FocusStore.ts`;
            const storeSource = parseTypescript(root, storePath, this.id, risk);
            const storeClass = uniqueAstNode(
                storeSource,
                node => ts.isClassDeclaration(node)
                    && node.name?.text === `OpenWorkspace${protocol}FocusStore`,
                this.id,
                risk,
                `${protocol} focus store wrapper`,
            );
            const extendsSharedStore = storeClass.heritageClauses?.some(clause =>
                clause.token === ts.SyntaxKind.ExtendsKeyword
                && clause.types.length === 1
                && clause.types[0].expression.getText(storeSource)
                    === 'OpenWorkspaceFocusMailboxStore');
            if (!extendsSharedStore) {
                fail(this.id, risk,
                    `${protocol} focus store must extend the shared mailbox store`);
            }
            if (protocol === 'Running') {
                const superCalls = callArguments(storeClass, 'super');
                const storeOptions = superCalls.length === 1 ? superCalls[0][1] : undefined;
                const temporaryFileStem = storeOptions && ts.isObjectLiteralExpression(storeOptions)
                    ? storeOptions.properties.find(property =>
                        property.name?.getText(storeSource) === 'temporaryFileStem')
                    : undefined;
                if (!temporaryFileStem || !ts.isPropertyAssignment(temporaryFileStem)
                    || !ts.isArrowFunction(temporaryFileStem.initializer)
                    || temporaryFileStem.initializer.getText(storeSource) !== 'requestId => requestId') {
                    fail(this.id, risk,
                        'Running focus store must preserve its v2 temporary-file naming');
                }
            }

            const coordinatorPath =
                `extensions/attention-ui-bridge/src/openWorkspace${protocol}FocusCoordinator.ts`;
            const coordinatorSource = parseTypescript(root, coordinatorPath, this.id, risk);
            const sharedCoordinatorConstructions = nodesMatching(coordinatorSource, node =>
                ts.isNewExpression(node)
                && node.expression.getText(coordinatorSource)
                    === 'OpenWorkspaceFocusMailboxCoordinator');
            if (sharedCoordinatorConstructions.length !== 1) {
                fail(this.id, risk,
                    `${protocol} focus coordinator must delegate to one shared mailbox coordinator`);
            }
            for (const forbiddenMethod of ['scanAndDeliver', 'runQueuedScans', 'scanOnce']) {
                if (nodesMatching(coordinatorSource, node =>
                    ts.isMethodDeclaration(node)
                    && node.name.getText(coordinatorSource) === forbiddenMethod).length) {
                    fail(this.id, risk,
                        `${protocol} focus coordinator must not duplicate ${forbiddenMethod}`);
                }
            }
        }
    },

    // ARCH-OPEN-WORKSPACE-FOCUS-CLIENT-OWNERSHIP-001
    'ARCH-OPEN-WORKSPACE-FOCUS-CLIENT-OWNERSHIP-001'(root) {
        const risk = 'Running and Attention client channels can drift on correlation, de-duplication, and retry semantics';
        const channel = parseTypescript(
            root,
            'src/openWorkspaces/focusBridgeChannel.ts',
            this.id,
            risk,
        );
        for (const methodName of ['receive', 'request']) {
            classMethod(
                channel,
                'OpenWorkspaceFocusBridgeChannel',
                methodName,
                this.id,
                risk,
            );
        }
        const bridgeClient = parseTypescript(
            root,
            'src/openWorkspaces/bridgeClient.ts',
            this.id,
            risk,
        );
        const channelConstructions = nodesMatching(bridgeClient, node =>
            ts.isNewExpression(node)
            && node.expression.getText(bridgeClient) === 'OpenWorkspaceFocusBridgeChannel');
        if (channelConstructions.length !== 2) {
            fail(this.id, risk,
                'bridge client must configure exactly two shared focus channels');
        }
        const delegations = [
            ['receiveRunningFocusRequest', 'this.runningFocusChannel.receive(raw);'],
            [
                'requestRunningFocus',
                'return this.runningFocusChannel.request('
                    + 'targetNavigationIdentity, sourceNavigationIdentity);',
            ],
            ['receiveAttentionFocusRequest', 'this.attentionFocusChannel.receive(raw);'],
            [
                'requestAttentionFocus',
                'return this.attentionFocusChannel.request(targetNavigationIdentity, target);',
            ],
        ];
        for (const [methodName, expectedStatement] of delegations) {
            const method = classMethod(
                bridgeClient,
                'OpenWorkspaceBridgeClient',
                methodName,
                this.id,
                risk,
            );
            const statements = method.body?.statements || [];
            if (statements.length !== 1
                || normalizedAstText(statements[0], bridgeClient) !== expectedStatement) {
                fail(this.id, risk,
                    `${methodName} must remain a thin shared-channel delegate`);
            }
        }
    },

    // ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001
    'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'(root) {
        const risk = 'conversation history can expose private content or exhaust the extension host';
        validateCodexReachableModules(root, this.id, risk);

        const codexService = parseTypescript(
            root,
            'src/services/codexSessionService.ts',
            this.id,
            risk
        );
        const codexFilesystemResolvers = nodesMatching(codexService, node =>
            ts.isMethodDeclaration(node)
            && node.name.getText(codexService) ===
                'resolveConversationSource');
        const composition = parseTypescript(
            root,
            'src/aiSessions/conversation/composition.ts',
            this.id,
            risk
        );
        const codexFilesystemRoutes = nodesMatching(composition, node =>
            memberPath(node) ===
                'options.services.codex.resolveConversationSource');
        if (codexFilesystemResolvers.length || codexFilesystemRoutes.length) {
            fail(this.id, risk,
                'Codex production content must remain app-server-only');
        }

        for (const relativePath of listFiles(root, 'src', '.ts')) {
            const sourceFile = parseTypescript(root, relativePath, this.id, risk);
            if (moduleReferences(sourceFile).some(moduleName =>
                /(?:^|[/\\])dompurify(?:[/\\]|$)/i.test(moduleName)
                || /(?:^|[/\\])purify\.min\.js$/i.test(moduleName))) {
                fail(this.id, risk,
                    'extension-host TypeScript must not import DOMPurify');
            }
        }

        const types = parseTypescript(
            root,
            'src/aiSessions/conversation/types.ts',
            this.id,
            risk
        );
        const limits = objectFreezeProperties(
            types,
            'CONVERSATION_LIMITS',
            this.id,
            risk
        );
        const expectedLimits = new Map([
            ['maxOutlineInteractions', '2_000'],
            ['maxPageInteractions', '20'],
            ['maxPageBytes', '512 * 1024'],
            ['maxSourceBytes', '64 * 1024 * 1024'],
            ['maxLineBytes', '1024 * 1024'],
            ['jsonlScanTimeoutMs', '5_000'],
            ['maxViewerInteractions', '100'],
            ['maxViewerBytes', '4 * 1024 * 1024'],
            ['maxCodexResponseBytes', '64 * 1024 * 1024'],
            ['codexRequestTimeoutMs', '10_000'],
            ['autoScrollThresholdPx', '8'],
            ['minRequestId', '1'],
            ['inactiveIndexLimitPerProvider', '8'],
            ['inactiveIndexTtlMs', '10 * 60 * 1000'],
        ]);
        if ([...expectedLimits].some(([name, expected]) =>
            limits.get(name) !== expected)) {
            fail(this.id, risk,
                'conversation resource and protocol limits must remain exact');
        }

        const appServer = parseTypescript(
            root,
            'src/aiSessions/conversation/codexAppServerClient.ts',
            this.id,
            risk
        );
        const unsafeLogCalls = nodesMatching(appServer, node =>
            ts.isCallExpression(node)
            && (memberPath(node.expression)?.startsWith('console.')
                || memberPath(node.expression) === 'process.stdout.write'
                || memberPath(node.expression) === 'process.stderr.write'));
        const onStderrData = uniqueAstNode(appServer,
            node => ts.isPropertyDeclaration(node)
                && node.name.getText(appServer) === 'onStderrData',
            this.id, risk, 'onStderrData');
        const stderrInitializer = onStderrData.initializer;
        const safeStderrSink = stderrInitializer
            && ts.isArrowFunction(stderrInitializer)
            && ((ts.isIdentifier(stderrInitializer.body)
                    && stderrInitializer.body.text === 'undefined')
                || (ts.isBlock(stderrInitializer.body)
                    && stderrInitializer.body.statements.length === 0));
        if (unsafeLogCalls.length
            || !safeStderrSink) {
            fail(this.id, risk,
                'app-server stderr and responses must never be logged');
        }

        for (const provider of ['codex', 'kimi', 'claude']) {
            const relativePath =
                `src/aiSessions/conversation/${provider}Adapter.ts`;
            const parsedAdapter = parseTypescript(
                root,
                relativePath,
                this.id,
                risk
            );
            const className =
                `${provider[0].toUpperCase()}${provider.slice(1)}ConversationAdapter`;
            validateProviderWatchOwnership(
                parsedAdapter,
                className,
                this.id,
                risk
            );
        }
    },

    // ARCH-AI-SESSION-SCAN-BOUNDARY-001
    'ARCH-AI-SESSION-SCAN-BOUNDARY-001'(root) {
        const risk = 'unbounded provider scans can block the extension host';
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const hydration = parseTypescript(root, 'src/workspaces/sessionHydrationController.ts', this.id, risk);
        if (numericInitializer(dashboard, 'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES', this.id, risk) <= 0) {
            fail(this.id, risk, 'incremental scans must keep a positive finite file budget');
        }
        const policyCalls = callArguments(hydration, 'getAiSessionScanMaxFiles');
        if (policyCalls.length !== 1 || policyCalls[0].map(argument => argument.getText(hydration)).join(',')
            !== 'reason,this.options.incrementalScanMaxFiles') {
            fail(this.id, risk, 'workspace hydration must apply the bounded scan policy exactly once');
        }
        const readCalls = callArguments(hydration, 'this.options.readCoordinator.getResults');
        if (readCalls.length !== 1 || readCalls[0].length !== 1
            || !ts.isObjectLiteralExpression(readCalls[0][0])
            || readCalls[0][0].properties.map(property => property.getText(hydration)).join(',')
                !== 'candidatePaths,reason,maxFiles') {
            fail(this.id, risk, 'the scan budget must reach every provider through the read coordinator');
        }
    },

    // ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001
    'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001'(root) {
        const risk = 'high-frequency watcher updates can trigger expensive full dashboard refreshes';
        const controller = parseTypescript(root, 'src/aiSessions/dashboardController.ts', this.id, risk);
        const watcherCalls = callArguments(controller, 'this.scheduleRefresh')
            .filter(args => stringArgument(args[0]) === 'watcher');
        if (watcherCalls.length !== 1) {
            fail(this.id, risk, 'provider watchers must use the coalesced incremental refresh path exactly once');
        }
        const fallbackReasons = callArguments(controller, 'this.options.refresh')
            .map(args => stringArgument(args[0]));
        const expected = [
            'ai-session-update-not-delivered',
            'ai-session-update-post-error',
            'ai-session-update-build-error',
        ];
        if (fallbackReasons.length !== expected.length || expected.some(reason => !fallbackReasons.includes(reason))) {
            fail(this.id, risk, `full refresh is allowed only for explicit delivery fallbacks: ${expected.join(', ')}`);
        }
    },

    // ARCH-AI-SESSION-FALLBACK-REASON-001
    'ARCH-AI-SESSION-FALLBACK-REASON-001'(root) {
        const risk = 'anonymous fallbacks and runtime-derived attention hide regressions and defeat diagnostics';
        const dashboard = parseTypescript(root, 'src/dashboard.ts', this.id, risk);
        const attentionEvents = parseTypescript(root, 'src/aiSessions/attentionEventCapability.ts', this.id, risk);
        const attentionController = parseTypescript(
            root, 'src/aiSessions/attentionController.ts', this.id, risk
        );
        const attentionSource = attentionController.getFullText();
        if (attentionSource.includes('terminal-exit:')
            || attentionSource.includes('suppressRuntimeCompletion')
            || attentionSource.includes('isRuntimeComplete')) {
            fail(this.id, risk,
                'runtime completion must not be converted into, or used to suppress, attention');
        }
        const lifecycleReasons = [
            ...callArguments(dashboard, 'runSafeAiSessionRuntimeLifecycleTask'),
            ...callArguments(attentionEvents, 'runSafeAiSessionRuntimeLifecycleTask'),
        ].map(args => stringArgument(args[0]));
        if (!lifecycleReasons.includes('evaluate-attention-closed-terminal')) {
            fail(this.id, risk, 'terminal-close provider-event reconciliation must have an explicit diagnostic reason');
        }
        const syncErrorCallback = newExpressionOptionCallback(dashboard, 'tmuxFocusedRuntimeMonitor',
            'TmuxFocusedRuntimeMonitor', 'onError', this.id, risk);
        const syncFailureCalls = callArguments(syncErrorCallback, 'logAiSessionRuntimeFailure');
        if (syncFailureCalls.length !== 1 || stringArgument(syncFailureCalls[0][0]) !== 'sync-focused-runtime') {
            fail(this.id, risk, 'focused-runtime fallback must have an explicit diagnostic reason');
        }
        const runtimeFailureArguments = callArguments(dashboard, 'logAiSessionRuntimeFailure');
        if (!runtimeFailureArguments.some(args => ts.isTemplateExpression(args[0])
            && args[0].getText(dashboard) === '`${fallback.operation}-fallback`')) {
            fail(this.id, risk, 'tmux choice fallback must derive its reason from the failing operation');
        }
    },

    // ARCH-PROVIDER-REGISTRY-COMPLETENESS-001
    'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001'(root) {
        const risk = 'an incomplete provider registry silently drops a supported provider';
        const providers = parseTypescript(root, 'src/aiSessions/providers.ts', this.id, risk);
        const expected = ['codex', 'kimi', 'claude'];
        if (stringArrayInitializer(providers, 'AI_SESSION_PROVIDER_IDS', this.id, risk).join(',') !== expected.join(',')) {
            fail(this.id, risk, 'the supported provider ID list must remain complete and ordered');
        }
        const definitions = findVariable(providers, 'AI_SESSION_PROVIDER_DEFINITIONS', this.id, risk).initializer;
        if (!definitions || !ts.isObjectLiteralExpression(definitions)) {
            fail(this.id, risk, 'provider definitions must be an object literal');
        }
        const actualDefinitions = definitions.properties.map(property => {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
                || !ts.isObjectLiteralExpression(property.initializer)) return null;
            const idProperty = property.initializer.properties.find(candidate =>
                ts.isPropertyAssignment(candidate) && candidate.name.getText(providers) === 'id');
            return idProperty && ts.isPropertyAssignment(idProperty) && ts.isStringLiteral(idProperty.initializer)
                ? `${property.name.text}:${idProperty.initializer.text}` : null;
        });
        if (actualDefinitions.join(',') !== expected.map(id => `${id}:${id}`).join(',')) {
            fail(this.id, risk, 'provider definitions must match every supported provider exactly');
        }
        const registryMaps = callArguments(providers, 'AI_SESSION_PROVIDER_IDS.map');
        if (registryMaps.length !== 1 || !registryMaps[0][0]
            || !registryMaps[0][0].getText(providers).includes('service: services[id]')) {
            fail(this.id, risk, 'registry construction must cover every declared provider and service');
        }
    },

    // ARCH-PROTOCOL-001
    'ARCH-PROTOCOL-001'(root) {
        const risk = 'protocol drift breaks compatibility between workspace and UI extension hosts';
        const openProtocol = parseTypescript(root, 'src/openWorkspaces/protocol.ts', this.id, risk);
        const attentionProtocol = parseTypescript(root, 'src/aiSessions/attentionPayload.ts', this.id, risk);
        if (numericInitializer(openProtocol, 'OPEN_WORKSPACE_PROTOCOL_VERSION', this.id, risk) !== 4) {
            fail(this.id, risk, 'open-workspace protocol version must remain 4 until an explicit migration exists');
        }
        if (numericInitializer(attentionProtocol, 'ATTENTION_PAYLOAD_VERSION', this.id, risk) !== 1) {
            fail(this.id, risk, 'attention payload version must remain 1 until an explicit migration exists');
        }
        validateProtocolExpectations(root, this.id, risk);
    },

    // ARCH-RELEASE-IDENTITY-001
    'ARCH-RELEASE-IDENTITY-001'(root) {
        const risk = 'release identity drift produces uninstallable or disconnected VSIX artifacts';
        try {
            validateManifestPair(
                readJson(root, 'package.json', this.id, risk),
                readJson(root, 'extensions/attention-ui-bridge/package.json', this.id, risk)
            );
        } catch (error) {
            if (error instanceof assert.AssertionError
                && error.message.startsWith(`${this.id} risk:`)) {
                throw error;
            }
            fail(this.id, risk, error.message);
        }

        const constants = parseTypescript(root, 'src/constants.ts', this.id, risk);
        const expectedConstants = {
            AGENT_PIVOT_CONFIG_SECTION: 'agentPivot',
            AGENT_PIVOT_EXTENSION_ID: 'hzcheng.agent-pivot',
            AGENT_PIVOT_VIEW_CONTAINER_ID: 'agentPivot',
            AGENT_PIVOT_DASHBOARD_VIEW_ID: 'agentPivot.dashboard',
            AGENT_PIVOT_CONVERSATION_VIEW_TYPE: 'agentPivot.aiConversation',
        };
        for (const [name, expected] of Object.entries(expectedConstants)) {
            if (stringInitializer(constants, name, this.id, risk) !== expected) {
                fail(this.id, risk, `${name} must remain ${expected}`);
            }
        }
    },
};

function validateArchitectureGuards(root, options = {}) {
    const ids = options.ids || Object.keys(guards);
    for (const id of ids) {
        if (!guards[id]) {
            throw new Error(`unknown architecture guard ${id}`);
        }
        guards[id].call({ id }, root);
    }
}

if (require.main === module) {
    validateArchitectureGuards(path.resolve(__dirname, '..'));
    console.log('Architecture guards passed.');
}

module.exports = { validateArchitectureGuards };
