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

test('a setup swaps the preset of its own kind and leaves the scenario alone', () => {
    const testCase = {
        id: 'case-1',
        name: 'Opening scene',
        userMessage: 'Hello',
        pins: {
            characterAvatar: 'seraphina.png',
            personaKey: 'me',
            connectionProfileId: 'profile-a',
            presets: [
                { apiId: 'textgenerationwebui', name: 'Sampler 1' },
                { apiId: 'instruct', name: 'Instruct 1' },
            ],
        },
    };

    const variant = lab.caseWithSetup(testCase, {
        presetApiId: 'textgenerationwebui',
        presetName: 'Sampler 2',
        connectionProfileId: 'profile-b',
        profileName: 'Second connection',
    });

    assert.deepEqual(variant.pins.presets, [
        { apiId: 'instruct', name: 'Instruct 1' },
        { apiId: 'textgenerationwebui', name: 'Sampler 2' },
    ]);
    assert.equal(variant.pins.connectionProfileId, 'profile-b');
    assert.equal(variant.pins.characterAvatar, 'seraphina.png');
    assert.equal(variant.pins.personaKey, 'me');
    assert.equal(variant.userMessage, 'Hello');
    assert.equal(variant.variantLabel, 'Sampler 2 · Second connection');

    // The case itself must be untouched, or the second setup would inherit
    // whatever the first one changed.
    assert.deepEqual(testCase.pins.presets, [
        { apiId: 'textgenerationwebui', name: 'Sampler 1' },
        { apiId: 'instruct', name: 'Instruct 1' },
    ]);
    assert.equal(testCase.pins.connectionProfileId, 'profile-a');
});

test('a setup that changes nothing keeps the pins and says so', () => {
    const testCase = {
        id: 'case-2',
        pins: { presets: [{ apiId: 'openai', name: 'Kept' }], connectionProfileId: 'profile-a' },
    };
    const variant = lab.caseWithSetup(testCase, {});

    assert.deepEqual(variant.pins.presets, [{ apiId: 'openai', name: 'Kept' }]);
    assert.equal(variant.pins.connectionProfileId, 'profile-a');
    assert.equal(variant.variantLabel, 'As the test case is saved');
});

test('the setup summary measures every setup against the first one that built', () => {
    const rows = lab.summarizeSetups([
        // The first setup failed before a prompt existed, so it cannot be the
        // yardstick; the next one that built is.
        { id: 'r0', variantLabel: 'Missing preset', status: 'error', error: { message: 'Preset gone.' } },
        {
            id: 'r1',
            variantLabel: 'Preset 1',
            status: 'pass',
            capture: { sections: [{ id: 'main' }], tokenTable: { total: 3000 } },
            assertionResults: [{ pass: true }, { pass: null }],
        },
        {
            id: 'r2',
            variantLabel: 'Preset 2',
            status: 'fail',
            capture: { sections: [{ id: 'main' }], tokenTable: { total: 3400 } },
            assertionResults: [{ pass: false }],
        },
    ]);

    assert.deepEqual(rows.map(row => row.label), ['Missing preset', 'Preset 1', 'Preset 2']);
    assert.equal(rows[0].built, false);
    assert.equal(rows[0].delta, null);
    assert.equal(rows[0].error, 'Preset gone.');
    assert.equal(rows[1].delta, null, 'the yardstick has nothing to differ from');
    assert.equal(rows[1].passed, 1);
    assert.equal(rows[1].unchecked, 1);
    assert.equal(rows[2].delta, 400);
    assert.equal(rows[2].failed, 1);
});
