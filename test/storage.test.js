import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { createCase, createDraft, createSuite } = await import('../src/schema.js');
const { RUN_VERSION } = await import('../src/constants.js');
const storage = await import('../src/storage.js');

function reset() {
    storage.__setStoreForTests(storage.createMemoryStore());
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test.after(() => removeStubContext());

test('cases round-trip through storage', async () => {
    reset();
    const saved = await storage.saveCase(createCase({ name: 'Aqua', pins: { characterAvatar: 'aqua.png' } }));
    const loaded = await storage.getCase(saved.id);
    assert.equal(loaded.name, 'Aqua');
    assert.equal(loaded.pins.characterAvatar, 'aqua.png');
    assert.deepEqual((await storage.listCases()).map(item => item.id), [saved.id]);
});

test('saving the same case twice does not duplicate the index entry', async () => {
    reset();
    const testCase = createCase({ name: 'One' });
    await storage.saveCase(testCase);
    await storage.saveCase({ ...testCase, name: 'One edited' });
    const cases = await storage.listCases();
    assert.equal(cases.length, 1);
    assert.equal(cases[0].name, 'One edited');
});

test('concurrent saves cannot overwrite each other in a delayed index', async () => {
    const base = storage.createMemoryStore();
    const entered = deferred();
    const release = deferred();
    let delayFirstRead = true;
    storage.__setStoreForTests({
        ...base,
        async getItem(key) {
            const value = await base.getItem(key);
            if (key === 'index:cases' && delayFirstRead) {
                delayFirstRead = false;
                entered.resolve();
                await release.promise;
            }
            return value;
        },
    });

    const first = storage.saveCase(createCase({ id: 'case-a', name: 'A' }));
    await entered.promise;
    const second = storage.saveCase(createCase({ id: 'case-b', name: 'B' }));
    await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([first, second]);

    assert.deepEqual((await storage.listCases()).map(item => item.id).sort(), ['case-a', 'case-b']);
});

test('a failed index write rolls its record back and does not poison the queue', async () => {
    const base = storage.createMemoryStore();
    let fail = true;
    storage.__setStoreForTests({
        ...base,
        async setItem(key, value) {
            if (key === 'index:cases' && fail) {
                fail = false;
                throw new Error('index write failed');
            }
            return base.setItem(key, value);
        },
    });

    await assert.rejects(
        storage.saveCase(createCase({ id: 'rolled-back', name: 'Lost' })),
        /index write failed/,
    );
    assert.equal(await storage.getCase('rolled-back'), null);
    assert.deepEqual(await storage.listCases(), []);

    await storage.saveCase(createCase({ id: 'after-failure', name: 'Kept' }));
    assert.equal((await storage.getCase('after-failure')).name, 'Kept');
});

test('an interrupted rollback is recovered before the next read', async () => {
    const base = storage.createMemoryStore();
    let failIndex = true;
    let failRollback = true;
    storage.__setStoreForTests({
        ...base,
        async setItem(key, value) {
            if (key === 'index:cases' && failIndex) {
                throw new Error('interrupted index write');
            }
            return base.setItem(key, value);
        },
        async removeItem(key) {
            if (key === 'case:interrupted' && failRollback) {
                throw new Error('interrupted rollback');
            }
            return base.removeItem(key);
        },
    });

    await assert.rejects(
        storage.saveCase(createCase({ id: 'interrupted', name: 'Partial' })),
        /interrupted index write/,
    );
    assert.ok(await base.getItem('case:interrupted'));

    failIndex = false;
    failRollback = false;
    assert.equal(await storage.getCase('interrupted'), null);
    assert.deepEqual(await base.keys(), []);

    await storage.saveCase(createCase({ id: 'after-recovery', name: 'Kept' }));
    assert.equal((await storage.getCase('after-recovery')).name, 'Kept');
});

test('getCase returns null for an unknown id', async () => {
    reset();
    assert.equal(await storage.getCase('missing'), null);
});

test('suites round-trip and can be deleted', async () => {
    reset();
    const suite = await storage.saveSuite(createSuite({ name: 'Preset check', caseIds: ['a'] }));
    assert.equal((await storage.getSuite(suite.id)).name, 'Preset check');
    await storage.deleteSuite(suite.id);
    assert.equal(await storage.getSuite(suite.id), null);
    assert.deepEqual(await storage.listSuites(), []);
});

test('updateSuite serializes membership and baseline changes', async () => {
    reset();
    await storage.saveSuite(createSuite({ id: 'atomic-suite' }));
    await Promise.all([
        storage.updateSuite('atomic-suite', suite => ({ ...suite, caseIds: [...suite.caseIds, 'a'] })),
        storage.updateSuite('atomic-suite', suite => ({
            ...suite,
            caseIds: [...suite.caseIds, 'b'],
            baselines: { ...suite.baselines, b: 'run-b' },
        })),
    ]);
    const suite = await storage.getSuite('atomic-suite');
    assert.deepEqual(suite.caseIds, ['a', 'b']);
    assert.deepEqual(suite.baselines, { b: 'run-b' });
});

test('runs are listed newest first', async () => {
    reset();
    await storage.saveRun({ id: 'r1', caseId: 'c1', startedAt: '2026-01-01T00:00:00.000Z' });
    await storage.saveRun({ id: 'r2', caseId: 'c1', startedAt: '2026-03-01T00:00:00.000Z' });
    await storage.saveRun({ id: 'r3', caseId: 'c1', startedAt: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual((await storage.listRuns('c1')).map(entry => entry.id), ['r2', 'r3', 'r1']);
    assert.equal((await storage.getLatestRun('c1')).id, 'r2');
});

test('re-saving a run replaces its index entry rather than adding one', async () => {
    reset();
    await storage.saveRun({ id: 'r1', caseId: 'c1', startedAt: '2026-01-01T00:00:00.000Z', status: 'pass' });
    await storage.saveRun({ id: 'r1', caseId: 'c1', startedAt: '2026-01-01T00:00:00.000Z', status: 'fail' });
    const runs = await storage.listRuns('c1');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'fail');
});

test('run indexes expose migrated record metadata and ignore missing records', async () => {
    storage.__setStoreForTests(storage.createMemoryStore({
        'index:runs:c1': [
            {
                id: 'legacy',
                status: 'pass',
                startedAt: '2099-01-01T00:00:00.000Z',
                suiteRunId: 'stale-suite-run',
                variantLabel: 'Stale label',
            },
            { id: 'missing', status: 'pass', startedAt: '2100-01-01T00:00:00.000Z' },
        ],
        'run:legacy': {
            v: 1,
            id: 'legacy',
            caseId: 'c1',
            status: 'pass',
            startedAt: '2026-01-01T00:00:00.000Z',
            suiteRunId: 'stored-suite-run',
            variantLabel: 'Stored label',
            assertionResults: [{ pass: null }],
        },
    }));

    const runs = await storage.listRuns('c1');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0], {
        id: 'legacy',
        status: 'unchecked',
        startedAt: '2026-01-01T00:00:00.000Z',
        suiteRunId: 'stored-suite-run',
        variantLabel: 'Stored label',
    });
});

test('runs preserve unchecked results and bounded volatile spans through storage', async () => {
    reset();
    await storage.saveRun({
        id: 'round-trip-run',
        caseId: 'c1',
        assertionResults: [{ pass: null, message: 'not measurable' }],
        cache: {
            volatileSpans: [{
                text: 'old',
                otherText: 'new',
                anchorBefore: 'x'.repeat(40),
                anchorAfter: 'y'.repeat(40),
            }],
        },
    });
    const loaded = await storage.getRun('round-trip-run');
    assert.equal(loaded.assertionResults[0].pass, null);
    assert.equal(loaded.cache.volatileSpans[0].anchorBefore.length, 24);
    assert.equal(loaded.cache.volatileSpans[0].anchorAfter.length, 24);
});

test('pruneRuns keeps the newest runs and always keeps pinned ones', async () => {
    reset();
    for (let index = 1; index <= 6; index++) {
        await storage.saveRun({
            id: `r${index}`,
            caseId: 'c1',
            startedAt: `2026-01-0${index}T00:00:00.000Z`,
        });
    }
    // r1 is the oldest, and is pinned as a baseline.
    const removed = await storage.pruneRuns('c1', 2, ['r1']);
    const remaining = (await storage.listRuns('c1')).map(entry => entry.id).sort();
    assert.equal(removed, 3);
    assert.deepEqual(remaining, ['r1', 'r5', 'r6']);
    assert.ok(await storage.getRun('r1'), 'a pinned baseline run must survive pruning');
});

test('pruneRuns sorts hydrated records instead of stale index metadata', async () => {
    storage.__setStoreForTests(storage.createMemoryStore({
        'index:runs:c1': [
            { id: 'newest', startedAt: '2000-01-01T00:00:00.000Z', status: 'fail' },
            { id: 'middle', startedAt: '2099-01-01T00:00:00.000Z', status: 'pass' },
            { id: 'oldest', startedAt: '2100-01-01T00:00:00.000Z', status: 'pass' },
        ],
        'run:newest': {
            v: RUN_VERSION,
            id: 'newest',
            caseId: 'c1',
            startedAt: '2026-03-01T00:00:00.000Z',
            status: 'pass',
        },
        'run:middle': {
            v: RUN_VERSION,
            id: 'middle',
            caseId: 'c1',
            startedAt: '2026-02-01T00:00:00.000Z',
            status: 'fail',
        },
        'run:oldest': {
            v: RUN_VERSION,
            id: 'oldest',
            caseId: 'c1',
            startedAt: '2026-01-01T00:00:00.000Z',
            status: 'error',
        },
    }));

    assert.equal(await storage.pruneRuns('c1', 1), 2);
    assert.deepEqual(await storage.listRuns('c1'), [{
        id: 'newest',
        startedAt: '2026-03-01T00:00:00.000Z',
        status: 'pass',
        suiteRunId: '',
        variantLabel: '',
    }]);
});

test('future run records survive pruning and run deletion', async () => {
    const future = {
        v: RUN_VERSION + 1,
        id: 'future',
        caseId: 'c1',
        startedAt: '2025-01-01T00:00:00.000Z',
        future: { keep: ['exactly', true] },
    };
    const base = storage.createMemoryStore({
        'index:runs:c1': [
            { id: 'future', startedAt: '1900-01-01T00:00:00.000Z', status: 'pass' },
            { id: 'current-new', startedAt: '2026-02-01T00:00:00.000Z', status: 'pass' },
            { id: 'current-old', startedAt: '2026-01-01T00:00:00.000Z', status: 'pass' },
        ],
        'run:future': future,
        'run:current-new': {
            v: RUN_VERSION,
            id: 'current-new',
            caseId: 'c1',
            startedAt: '2026-02-01T00:00:00.000Z',
            status: 'pass',
        },
        'run:current-old': {
            v: RUN_VERSION,
            id: 'current-old',
            caseId: 'c1',
            startedAt: '2026-01-01T00:00:00.000Z',
            status: 'pass',
        },
    });
    storage.__setStoreForTests(base);

    assert.equal(await storage.pruneRuns('c1', 1), 1);
    assert.deepEqual(await base.getItem('run:future'), future);
    assert.deepEqual((await base.getItem('index:runs:c1')).map(entry => entry.id), ['future', 'current-new']);

    await storage.deleteRun('c1', 'future');
    assert.deepEqual(await base.getItem('run:future'), future);

    await storage.deleteCase('c1');
    assert.deepEqual(await base.getItem('run:future'), future);
    assert.deepEqual(await base.getItem('index:runs:c1'), [
        { id: 'future', startedAt: '1900-01-01T00:00:00.000Z', status: 'pass' },
    ]);
});

test('pruneRuns does nothing when the case is under the limit', async () => {
    reset();
    await storage.saveRun({ id: 'r1', caseId: 'c1', startedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(await storage.pruneRuns('c1', 20, []), 0);
    assert.equal((await storage.listRuns('c1')).length, 1);
});

test('deleting a case removes its runs and run index', async () => {
    reset();
    const testCase = await storage.saveCase(createCase({ name: 'Aqua' }));
    await storage.saveRun({ id: 'r1', caseId: testCase.id, startedAt: '2026-01-01T00:00:00.000Z' });
    await storage.deleteCase(testCase.id);
    assert.equal(await storage.getCase(testCase.id), null);
    assert.equal(await storage.getRun('r1'), null);
    assert.deepEqual(await storage.listRuns(testCase.id), []);
});

test('deleting a case removes it and its baseline from every suite', async () => {
    reset();
    const testCase = await storage.saveCase(createCase({ name: 'Shared' }));
    await storage.saveSuite(createSuite({
        id: 'suite-a',
        caseIds: [testCase.id, 'other'],
        baselines: { [testCase.id]: 'run-a', other: 'run-other' },
    }));
    await storage.saveSuite(createSuite({
        id: 'suite-b',
        caseIds: [testCase.id],
        baselines: { [testCase.id]: 'run-b' },
    }));
    await storage.deleteCase(testCase.id);
    assert.deepEqual((await storage.getSuite('suite-a')).caseIds, ['other']);
    assert.deepEqual((await storage.getSuite('suite-a')).baselines, { other: 'run-other' });
    assert.deepEqual((await storage.getSuite('suite-b')).caseIds, []);
    assert.deepEqual((await storage.getSuite('suite-b')).baselines, {});
});

test('stored objects are snapshots, not live references', async () => {
    reset();
    const testCase = createCase({ name: 'Aqua' });
    await storage.saveCase(testCase);
    testCase.name = 'Mutated after saving';
    assert.equal((await storage.getCase(testCase.id)).name, 'Aqua');
});

test('clearAll empties the store', async () => {
    reset();
    await storage.saveCase(createCase({ name: 'Aqua' }));
    await storage.saveSuite(createSuite({ name: 'Suite' }));
    await storage.clearAll();
    assert.deepEqual(await storage.listCases(), []);
    assert.deepEqual(await storage.listSuites(), []);
});

test('clearAll uses native clear without reading or journaling values', async () => {
    const base = storage.createMemoryStore({
        'case:large': { body: 'large value' },
        'meta:transaction': { v: 1, entries: [{ key: 'case:large', value: null }] },
    });
    let clears = 0;
    storage.__setStoreForTests({
        ...base,
        async getItem() {
            assert.fail('clearAll must not read stored values');
        },
        async setItem() {
            assert.fail('clearAll must not write a rollback journal');
        },
        async removeItem() {
            assert.fail('clearAll must use native clear');
        },
        async keys() {
            assert.fail('clearAll must not enumerate records');
        },
        async clear() {
            clears += 1;
            await base.clear();
        },
    });

    await storage.clearAll();
    assert.equal(clears, 1);
    assert.deepEqual(await base.keys(), []);
});

test('clearAll propagates native clear failures', async () => {
    storage.__setStoreForTests({
        async clear() {
            throw new Error('native clear failed');
        },
    });
    await assert.rejects(storage.clearAll(), /native clear failed/);
});

test('saveImportBatch restores all earlier writes when a later write fails', async () => {
    const base = storage.createMemoryStore();
    let failSuite = false;
    storage.__setStoreForTests({
        ...base,
        async setItem(key, value) {
            if (key === 'suite:batch-suite' && failSuite) {
                throw new Error('suite write failed');
            }
            return base.setItem(key, value);
        },
    });
    await storage.saveCase(createCase({ id: 'existing', name: 'Existing' }));
    failSuite = true;

    await assert.rejects(storage.saveImportBatch({
        suite: createSuite({ id: 'batch-suite', caseIds: ['import-case'] }),
        cases: [createCase({ id: 'import-case', name: 'Imported' })],
        baselineRuns: [{ id: 'import-run', caseId: 'import-case' }],
        presets: [createDraft({ id: 'import-draft', apiId: 'openai', name: 'Imported', payload: {} })],
    }), /suite write failed/);

    assert.deepEqual((await storage.listCases()).map(item => item.id), ['existing']);
    assert.equal(await storage.getSuite('batch-suite'), null);
    assert.equal(await storage.getRun('import-run'), null);
    assert.equal(await storage.getDraft('import-draft'), null);
});

test('preset drafts round-trip and can be removed', async () => {
    reset();
    const draft = await storage.saveDraft(createDraft({
        apiId: 'openai',
        name: 'My preset',
        payload: { prompts: [] },
    }));
    assert.ok(draft.updatedAt);
    const loaded = await storage.getDraft(draft.id);
    assert.equal(loaded.name, 'My preset');
    assert.deepEqual((await storage.listDrafts()).map(item => item.id), [draft.id]);
    await storage.deleteDraft(draft.id);
    assert.equal(await storage.getDraft(draft.id), null);
    assert.deepEqual(await storage.listDrafts(), []);
});

test('a run remembers which setup produced it, in the index as well as the record', async () => {
    reset();
    const saved = await storage.saveRun({
        caseId: 'case-1',
        status: 'pass',
        startedAt: '2020-01-01T00:00:00.000Z',
        variantLabel: 'Preset 2 · Second connection',
    });

    assert.equal((await storage.getRun(saved.id)).variantLabel, 'Preset 2 · Second connection');
    // The comparison tab labels its run menus from the index alone.
    assert.equal((await storage.listRuns('case-1'))[0].variantLabel, 'Preset 2 · Second connection');
});
