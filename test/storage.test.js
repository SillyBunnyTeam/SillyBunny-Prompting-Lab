import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { createCase, createSuite } = await import('../src/schema.js');
const storage = await import('../src/storage.js');

function reset() {
    storage.__setStoreForTests(storage.createMemoryStore());
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
