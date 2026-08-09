import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

const { ctx } = installStubContext();
const { SETTINGS_KEY } = await import('../src/constants.js');
const storage = await import('../src/storage.js');
const operations = await import('../src/operations.js');
const extension = await import('../index.js');

test.beforeEach(() => operations.openOperationRegistry());

test.after(() => {
    storage.__setStoreForTests(storage.createMemoryStore());
    removeStubContext();
});

test('clean rejects a storage clear failure and preserves settings', async () => {
    ctx.extensionSettings[SETTINGS_KEY] = { schemaVersion: 1, runRetention: 20 };
    storage.__setStoreForTests({
        async keys() { return []; },
        async getItem() { return null; },
        async setItem() {},
        async removeItem() {},
        async clear() { throw new Error('disk failed'); },
    });

    await assert.rejects(() => extension.clean(), /disk failed/);
    assert.ok(ctx.extensionSettings[SETTINGS_KEY]);
});

test('clean closes new work and waits for complete quiescence before clearing', async () => {
    let clears = 0;
    storage.__setStoreForTests({
        async keys() { return []; },
        async getItem() { return null; },
        async setItem() {},
        async removeItem() {},
        async clear() { clears += 1; },
    });
    const task = operations.registerActiveTask('delayed mutation');

    const cleaning = extension.clean();
    assert.equal(task.signal.aborted, true);
    assert.throws(
        () => operations.registerActiveTask('too late'),
        error => error.code === 'SBPL_INACTIVE',
    );
    await Promise.resolve();
    assert.equal(clears, 0);

    task.release();
    await cleaning;
    assert.equal(clears, 1);
});

test('init reopens the registry after deactivation', () => {
    assert.equal(extension.deactivate(), undefined);
    assert.throws(
        () => operations.registerActiveTask('inactive'),
        error => error.code === 'SBPL_INACTIVE',
    );

    extension.init();
    const task = operations.registerActiveTask('reactivated');
    task.release();
    extension.deactivate();
});
