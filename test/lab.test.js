import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { createSuite } = await import('../src/schema.js');
const lab = await import('../src/lab.js');
const storage = await import('../src/storage.js');

test.after(() => removeStubContext());

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
