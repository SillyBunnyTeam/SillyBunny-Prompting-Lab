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

test('repeated single-run batches retain exactly N normal runs while protecting the current run and baseline', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const context = globalThis.SillyTavern.getContext();
    context.extensionSettings.SillyBunnyPromptingLab = { runRetention: 2 };
    const baseline = await storage.saveRun({
        id: 'run-retention-baseline',
        caseId: 'case-retention',
        status: 'pass',
        startedAt: '2020-01-01T00:00:00.000Z',
    });
    const suite = await storage.saveSuite(createSuite({
        id: 'suite-retention',
        caseIds: ['case-retention'],
        baselines: { 'case-retention': baseline.id },
    }));

    let currentRun;
    for (let batch = 1; batch <= 3; batch++) {
        const result = await lab.runSuite(suite, {
            cases: [],
            blocked: [{ caseId: 'case-retention', caseName: `Batch ${batch}`, reason: 'blocked' }],
        });
        [currentRun] = result.runs;
        assert.ok(await storage.getRun(currentRun.id), 'the current output must survive its pruning call');
    }

    const normalRunIds = (await storage.listRuns('case-retention'))
        .map(run => run.id)
        .filter(id => id !== baseline.id);
    assert.equal(normalRunIds.length, 2, 'retention must include the protected current run');
    assert.ok(normalRunIds.includes(currentRun.id));
    assert.ok(await storage.getRun(baseline.id), 'the pinned baseline must not count against retention');
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

test('retention counts and protects current setup runs per case', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const context = globalThis.SillyTavern.getContext();
    context.extensionSettings.SillyBunnyPromptingLab = { runRetention: 2 };
    for (const caseId of ['case-a', 'case-b']) {
        await storage.saveRun({ id: `${caseId}-old-1`, caseId, startedAt: '2020-01-01T00:00:00.000Z' });
        await storage.saveRun({ id: `${caseId}-old-2`, caseId, startedAt: '2020-01-02T00:00:00.000Z' });
    }
    const suite = createSuite({ id: 'suite-setup', caseIds: ['case-a', 'case-b'] });
    const result = await lab.runSuite(suite, {
        cases: [],
        blocked: [
            { caseId: 'case-a', caseName: 'Setup A1', reason: 'A1' },
            { caseId: 'case-a', caseName: 'Setup A2', reason: 'A2' },
            { caseId: 'case-b', caseName: 'Setup B', reason: 'B' },
        ],
    });
    const currentA = result.runs.filter(run => run.caseId === 'case-a').map(run => run.id).sort();
    const currentB = result.runs.find(run => run.caseId === 'case-b').id;
    assert.deepEqual((await storage.listRuns('case-a')).map(run => run.id).sort(), currentA);
    assert.deepEqual(
        (await storage.listRuns('case-b')).map(run => run.id).sort(),
        ['case-b-old-2', currentB].sort(),
    );
    delete context.extensionSettings.SillyBunnyPromptingLab;
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
        { id: 'r0', caseId: 'case-1', variantLabel: 'Missing preset', status: 'error', error: { message: 'Preset gone.' } },
        {
            id: 'r1',
            caseId: 'case-1',
            variantLabel: 'Preset 1',
            status: 'pass',
            capture: {
                messages: [{ role: 'system', content: 'one' }],
                sections: [{ id: 'main' }],
                tokenTable: { total: 3000 },
            },
            assertionResults: [{ pass: true }, { pass: null }],
        },
        {
            id: 'r2',
            caseId: 'case-1',
            variantLabel: 'Preset 2',
            status: 'fail',
            capture: {
                messages: [{ role: 'system', content: 'two' }],
                sections: [{ id: 'main' }],
                tokenTable: { total: 3400 },
            },
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

test('baseline promotion requires a stored matching canonical run', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const suite = await storage.saveSuite(createSuite({ id: 'suite-baseline', caseIds: ['case-a'] }));
    const usable = await storage.saveRun({
        id: 'run-usable',
        caseId: 'case-a',
        status: 'pass',
        capture: { messages: [{ role: 'system', content: 'prompt' }] },
    });
    await assert.rejects(() => lab.promoteBaseline(suite, 'case-a', 'missing'), /cannot be used/);
    await assert.rejects(() => lab.promoteBaseline(suite, 'case-b', usable.id), /cannot be used/);

    const saved = await lab.promoteBaseline(suite, 'case-a', usable.id);
    assert.equal(saved.baselines['case-a'], usable.id);
});

test('unchecked canonical runs remain comparison yardsticks but cannot be promoted', async () => {
    const unchecked = {
        id: 'run-unchecked',
        caseId: 'case-a',
        status: 'unchecked',
        capture: { combinedPrompt: 'old', tokenTable: { total: 10 } },
    };
    const rows = lab.summarizeSetups([
        unchecked,
        {
            id: 'run-next',
            caseId: 'case-a',
            status: 'pass',
            capture: { combinedPrompt: 'new', tokenTable: { total: 15 } },
        },
    ]);
    assert.deepEqual(rows.map(row => row.delta), [null, 5]);

    storage.__setStoreForTests(storage.createMemoryStore());
    const suite = await storage.saveSuite(createSuite({ id: 'suite-unchecked', caseIds: ['case-a'] }));
    await storage.saveRun(unchecked);
    await assert.rejects(
        () => lab.promoteBaseline(suite, 'case-a', unchecked.id),
        /cannot be used/,
    );
});

test('bulk baseline promotion excludes unchecked and unsaved runs', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const suite = await storage.saveSuite(createSuite({
        id: 'suite-bulk',
        caseIds: ['case-pass', 'case-unchecked', 'case-unsaved'],
    }));
    const pass = await storage.saveRun({
        id: 'run-pass',
        caseId: 'case-pass',
        status: 'pass',
        capture: { combinedPrompt: 'prompt' },
    });
    const unchecked = await storage.saveRun({
        id: 'run-unchecked',
        caseId: 'case-unchecked',
        status: 'unchecked',
        capture: { combinedPrompt: 'prompt' },
    });
    const saved = await lab.promoteAllPassing(suite, [
        pass,
        unchecked,
        {
            id: 'run-unsaved',
            caseId: 'case-unsaved',
            status: 'pass',
            capture: { combinedPrompt: 'prompt' },
        },
    ]);
    assert.deepEqual(saved.baselines, { 'case-pass': pass.id });
});

test('baseline mutations merge into the latest suite and honor current membership', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const stale = await storage.saveSuite(createSuite({
        id: 'suite-stale',
        name: 'Stale',
        caseIds: ['case-a', 'case-b'],
        baselines: { 'case-b': 'run-old-b' },
    }));
    const runA = await storage.saveRun({
        id: 'run-a',
        caseId: 'case-a',
        status: 'pass',
        capture: { combinedPrompt: 'A' },
    });
    const runB = await storage.saveRun({
        id: 'run-b',
        caseId: 'case-b',
        status: 'pass',
        capture: { combinedPrompt: 'B' },
    });
    await storage.updateSuite(stale.id, suite => ({
        ...suite,
        name: 'Latest',
        caseIds: [...suite.caseIds, 'case-c'],
        baselines: { ...suite.baselines, 'case-c': 'run-c' },
    }));

    let saved = await lab.promoteBaseline(stale, 'case-a', runA.id);
    assert.equal(saved.name, 'Latest');
    assert.deepEqual(saved.baselines, {
        'case-a': runA.id,
        'case-b': 'run-old-b',
        'case-c': 'run-c',
    });

    saved = await lab.promoteAllPassing(stale, [runB]);
    assert.deepEqual(saved.baselines, {
        'case-a': runA.id,
        'case-b': runB.id,
        'case-c': 'run-c',
    });

    saved = await lab.clearBaseline(stale, 'case-b');
    assert.deepEqual(saved.baselines, { 'case-a': runA.id, 'case-c': 'run-c' });

    await storage.updateSuite(stale.id, suite => ({
        ...suite,
        caseIds: suite.caseIds.filter(id => id !== 'case-a'),
        baselines: { ...suite.baselines, 'case-a': 'current-a' },
    }));
    await assert.rejects(
        () => lab.promoteBaseline(stale, 'case-a', runA.id),
        /no longer belongs/,
    );
    saved = await lab.promoteAllPassing(stale, [runA]);
    assert.equal(saved.baselines['case-a'], 'current-a', 'bulk promotion must not rewrite removed membership');

    await storage.updateSuite(stale.id, suite => ({
        ...suite,
        caseIds: suite.caseIds.filter(id => id !== 'case-b'),
        baselines: { ...suite.baselines, 'case-b': 'current-b' },
    }));
    saved = await lab.clearBaseline(stale, 'case-b');
    assert.equal(saved.baselines['case-b'], 'current-b', 'clearing must honor removed membership');
});
