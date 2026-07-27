'use strict';

const ts = require('typescript');

function parseDashboard(source) {
    return ts.createSourceFile(
        'dashboard.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

function collectNodes(root, predicate) {
    const matches = [];
    const visit = node => {
        if (predicate(node)) {
            matches.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
}

function initializeDashboardBody(sourceFile) {
    const functions = collectNodes(
        sourceFile,
        node => ts.isFunctionDeclaration(node)
            && node.name?.text === 'initializeDashboard',
    );
    if (functions.length !== 1 || !functions[0].body) {
        throw new Error('dashboard must define exactly one initializeDashboard body');
    }
    return functions[0].body;
}

function ownedVariableName(call) {
    const parent = call.parent;
    if (ts.isVariableDeclaration(parent)
        && parent.initializer === call
        && ts.isIdentifier(parent.name)) {
        return parent.name.text;
    }
    if (ts.isBinaryExpression(parent)
        && parent.right === call
        && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(parent.left)) {
        return parent.left.text;
    }
    return undefined;
}

function isSynchronousZeroArgumentArrow(node) {
    return ts.isArrowFunction(node)
        && node.parameters.length === 0
        && !node.modifiers?.some(
            modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        );
}

function matchesFactory(arrow, sourceFile, factoryKind, factoryName) {
    if (!isSynchronousZeroArgumentArrow(arrow)) {
        return false;
    }
    if (factoryKind === 'new') {
        return ts.isNewExpression(arrow.body)
            && arrow.body.expression.getText(sourceFile) === factoryName;
    }
    if (factoryKind === 'call') {
        return ts.isCallExpression(arrow.body)
            && arrow.body.expression.getText(sourceFile) === factoryName;
    }
    throw new Error(`unsupported bootstrap factory kind: ${factoryKind}`);
}

function isContextSubscriptionPush(call, sourceFile) {
    return ts.isPropertyAccessExpression(call.expression)
        && call.expression.getText(sourceFile) === 'context.subscriptions.push';
}

function assertBootstrapOwnedResource(source, options) {
    const {
        variableName,
        factoryKind,
        factoryName,
    } = options;
    const sourceFile = parseDashboard(source);
    const body = initializeDashboardBody(sourceFile);
    const ownedCalls = collectNodes(
        body,
        node => ts.isCallExpression(node)
            && node.expression.getText(sourceFile) === 'ownResource'
            && ownedVariableName(node) === variableName,
    );
    const matchingFactories = ownedCalls.filter(call =>
        call.arguments.length === 1
        && matchesFactory(
            call.arguments[0],
            sourceFile,
            factoryKind,
            factoryName,
        ));
    if (ownedCalls.length !== 1 || matchingFactories.length !== 1) {
        throw new Error(
            `${variableName} must have exactly one bootstrap-owned ${factoryName} factory`,
        );
    }

    const duplicatePushes = collectNodes(
        body,
        node => ts.isCallExpression(node)
            && isContextSubscriptionPush(node, sourceFile)
            && node.arguments.some(argument =>
                ts.isIdentifier(argument) && argument.text === variableName),
    );
    if (duplicatePushes.length !== 0) {
        throw new Error(
            `${variableName} must not also be pushed directly to context subscriptions`,
        );
    }
}

function withRenamedBootstrapFactory(source, options, replacementFactoryName) {
    const {
        variableName,
        factoryKind,
        factoryName,
    } = options;
    const sourceFile = parseDashboard(source);
    const body = initializeDashboardBody(sourceFile);
    const factories = collectNodes(
        body,
        node => ts.isCallExpression(node)
            && node.expression.getText(sourceFile) === 'ownResource'
            && ownedVariableName(node) === variableName
            && node.arguments.length === 1
            && matchesFactory(
                node.arguments[0],
                sourceFile,
                factoryKind,
                factoryName,
            ),
    );
    if (factories.length !== 1) {
        throw new Error(
            `${variableName} must have one ${factoryName} factory to mutate`,
        );
    }
    const factory = factories[0].arguments[0].body.expression;
    return source.slice(0, factory.getStart(sourceFile))
        + replacementFactoryName
        + source.slice(factory.end);
}

function withDuplicateBootstrapPush(source, variableName) {
    const sourceFile = parseDashboard(source);
    const body = initializeDashboardBody(sourceFile);
    const insertAt = body.end - 1;
    return `${source.slice(0, insertAt)}`
        + `\n    context.subscriptions.push(${variableName});\n`
        + source.slice(insertAt);
}

module.exports = {
    assertBootstrapOwnedResource,
    withDuplicateBootstrapPush,
    withRenamedBootstrapFactory,
};
