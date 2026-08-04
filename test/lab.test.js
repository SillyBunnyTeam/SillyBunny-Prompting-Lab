import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { createSuite } = await import('../src/schema.js');
const lab = await import('../src/lab.js');
const storage = await import('../src/storage.js');

test.after(() => removeStubContext());

test('running one suite never prunes a run another suite uses as a baseline', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const context = globalThis.SillyTavern.getContext();
    context.extensionSettings.SillyBunnyPromptingLab = { runRetention: 1 };

    // Case X belongs to suites A and B; only B holds a baseline for it.
    const baseline = await storage.saveRun({
        id: 'run-baseline',
        caseId: 'case-x',
        status: 'pass',
        startedAt: '2020-01-01T00:00:00.000Z',
    });
    await storage.saveSuite(createSuite({
        id: 'suite-b',
        caseIds: ['case-x'],
        baselines: { 'case-x': baseline.id },
    }));
    const suiteA = await storage.saveSuite(createSuite({ id: 'suite-a', caseIds: ['case-x'] }));

    // Running suite A persists a newer run for case X; with a retention of 1,
    // pruning would remove the baseline unless suite B's pin is honoured.
    await lab.runSuite(suiteA, {
        cases: [],
        blocked: [{ caseId: 'case-x', caseName: 'X', reason: 'blocked for the test' }],
    });

    assert.ok(await storage.getRun(baseline.id), "suite B's baseline run must survive");
    delete context.extensionSettings.SillyBunnyPromptingLab;
});

test('blocked cases become persisted Could not run results without entering the runner', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const suite = createSuite({ id: 'suite-1', caseIds: ['case-blocked'] });
    const result = await lab.runSuite(suite, {
        cases: [],
        blocked: [{
            caseId: 'case-blocked',
            caseName: 'Missing character',
            reason: 'No character is chosen for this test case.',
        }],
    });

    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].suiteRunId, result.suiteRunId);
    assert.equal(result.runs[0].suiteId, suite.id);
    assert.equal(result.runs[0].caseId, 'case-blocked');
    assert.equal(result.runs[0].caseName, 'Missing character');
    assert.equal(result.runs[0].status, 'error');
    assert.equal(result.runs[0].error.message, 'No character is chosen for this test case.');
    assert.equal(result.summary.error, 1);
    assert.deepEqual((await storage.listRuns('case-blocked')).map(item => item.id), [result.runs[0].id]);
});
