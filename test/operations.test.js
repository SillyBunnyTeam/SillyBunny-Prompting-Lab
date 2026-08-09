import assert from 'node:assert/strict';
import test from 'node:test';

import {
    abortActiveOperations,
    acquireHostOperation,
    activeOperation,
    activeTaskNames,
    closeOperationRegistry,
    openOperationRegistry,
    registerActiveTask,
    waitForQuiescence,
} from '../src/operations.js';

test.beforeEach(() => openOperationRegistry());
test.afterEach(() => openOperationRegistry());

test('the host operation lease fails fast, aborts, and reports quiescence', async () => {
    const first = acquireHostOperation('first task');
    assert.deepEqual(activeOperation(), { name: 'first task', aborted: false });
    assert.throws(() => acquireHostOperation('second task'), error => error.code === 'SBPL_BUSY');

    let idle = false;
    const waiting = waitForQuiescence().then(() => { idle = true; });
    abortActiveOperations();
    assert.equal(first.signal.aborted, true);
    assert.equal(idle, false);
    first.release();
    await waiting;
    assert.equal(idle, true);
    assert.equal(activeOperation(), null);
});

test('an external abort signal is forwarded into the lease', () => {
    const controller = new AbortController();
    const lease = acquireHostOperation('forwarded task', { signal: controller.signal });
    controller.abort();
    assert.equal(lease.signal.aborted, true);
    lease.release();
});

test('non-exclusive tasks participate in abort and quiescence tracking', async () => {
    const task = registerActiveTask('storage tail');
    assert.deepEqual(activeTaskNames(), ['storage tail']);
    abortActiveOperations();
    assert.equal(task.signal.aborted, true);
    let idle = false;
    const waiting = waitForQuiescence().then(() => { idle = true; });
    await Promise.resolve();
    assert.equal(idle, false);
    task.release();
    await waiting;
    assert.equal(idle, true);
});

test('a closed registry rejects late work until the next activation', async () => {
    const task = registerActiveTask('finishing write');
    closeOperationRegistry();
    assert.equal(task.signal.aborted, false);
    abortActiveOperations();
    assert.equal(task.signal.aborted, true);

    assert.throws(
        () => registerActiveTask('late write'),
        error => error.code === 'SBPL_INACTIVE',
    );
    assert.throws(
        () => acquireHostOperation('late host change'),
        error => error.code === 'SBPL_INACTIVE',
    );

    let idle = false;
    const waiting = waitForQuiescence().then(() => { idle = true; });
    await Promise.resolve();
    assert.equal(idle, false);
    task.release();
    await waiting;

    openOperationRegistry();
    const next = registerActiveTask('next activation');
    next.release();
});
