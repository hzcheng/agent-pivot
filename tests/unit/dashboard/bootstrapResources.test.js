'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DashboardBootstrapResources,
} = require('../../../out/dashboard/bootstrapResources');

function trackedDisposable(name, releases) {
    return {
        name,
        dispose() {
            releases.push(name);
        },
    };
}

test('dashboard bootstrap resources release disposables in reverse construction order at most once', () => {
    const releases = [];
    const resources = new DashboardBootstrapResources();
    resources.own(trackedDisposable('first', releases));
    resources.own(trackedDisposable('second', releases));
    resources.own(trackedDisposable('third', releases));

    resources.dispose();
    resources.dispose();

    assert.deepEqual(releases, ['third', 'second', 'first']);
});

test('a failed dashboard bootstrap generation can dispose its partial resource scope', () => {
    const releases = [];
    const resources = new DashboardBootstrapResources();
    resources.own(trackedDisposable('catalog', releases));
    resources.own(trackedDisposable('watcher', releases));

    resources.dispose();

    assert.deepEqual(releases, ['watcher', 'catalog']);
});

test('transferTo moves dashboard bootstrap ownership exactly once', () => {
    const releases = [];
    const target = [];
    const resources = new DashboardBootstrapResources();
    const first = resources.own(trackedDisposable('first', releases));
    const second = resources.own(trackedDisposable('second', releases));

    resources.transferTo(target);
    resources.dispose();

    assert.deepEqual(target, [first, second]);
    assert.deepEqual(releases, []);
    assert.throws(
        () => resources.transferTo([]),
        {
            name: 'Error',
            message: 'Dashboard bootstrap resources have already been transferred.',
        }
    );

    for (const disposable of target) {
        disposable.dispose();
    }
    assert.deepEqual(releases, ['first', 'second']);
});

test('ownership and transfer after disposal throw a stable programmer error', () => {
    const resources = new DashboardBootstrapResources();
    resources.dispose();

    for (const operation of [
        () => resources.own({ dispose() {} }),
        () => resources.transferTo([]),
    ]) {
        assert.throws(
            operation,
            {
                name: 'Error',
                message: 'Dashboard bootstrap resources have already been disposed.',
            }
        );
    }
});

test('resource disposal preserves throw undefined while releasing every resource exactly once', () => {
    const releases = [];
    const resources = new DashboardBootstrapResources();
    resources.own(trackedDisposable('first', releases));
    resources.own({
        dispose() {
            releases.push('throws-undefined');
            throw undefined;
        },
    });
    resources.own(trackedDisposable('last', releases));

    let didThrow = false;
    let thrownValue = 'not-thrown';
    try {
        resources.dispose();
    } catch (error) {
        didThrow = true;
        thrownValue = error;
    }
    resources.dispose();

    assert.equal(didThrow, true);
    assert.equal(thrownValue, undefined);
    assert.deepEqual(releases, ['last', 'throws-undefined', 'first']);
});
