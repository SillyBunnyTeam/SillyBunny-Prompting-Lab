import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { STATUS } = await import('../src/constants.js');
const { createCase } = await import('../src/schema.js');
const {
    RUNNER_STATE,
    orderCasesByCharacter,
    preflight,
    runCase,
    runSuite,
    summarize,
} = await import('../src/runner.js');

test.after(() => removeStubContext());

function fakeCapture(overrides = {}) {
    return async () => ({
        apiType: 'cc',
        messages: [{ role: 'system', content: 'You are Aqua.' }],
        combinedPrompt: null,
        sections: [{ id: 'main', label: 'Main prompt', content: 'You are Aqua.', tokens: 5 }],
        tokenTable: { total: 5, perSection: { main: 5 } },
        wiPasses: [],
        cacheScope: 'main',
        caveats: ['no-interceptors'],
        ...overrides,
    });
}

function makeContext() {
    return {
        characterId: 0,
        characters: [{ avatar: 'aqua.png', name: 'Aqua' }],
        mainApi: 'openai',
        name1: 'You',
        extensionSettings: {},
    };
}

test('cases are grouped so each character is opened once', () => {
    const cases = [
        { id: '1', pins: { characterAvatar: 'a.png' } },
        { id: '2', pins: { characterAvatar: 'b.png' } },
        { id: '3', pins: { characterAvatar: 'a.png' } },
        { id: '4', pins: { characterAvatar: 'b.png' } },
    ];
    assert.deepEqual(orderCasesByCharacter(cases).map(item => item.id), ['1', '3', '2', '4']);
});

test('runCase produces a passing record with capture data', async () => {
    const run = await runCase(createCase({ name: 'Aqua', pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(run.status, STATUS.PASS);
    assert.equal(run.caseName, 'Aqua');
    assert.equal(run.capture.sections[0].id, 'main');
    assert.equal(run.capture.tokenTable.total, 5);
    assert.ok(run.caveats.includes('no-interceptors'));
    assert.equal(run.error, null);
});

test('runCase records the selected connection profile name', async () => {
    const context = {
        ...makeContext(),
        extensionSettings: {
            connectionManager: {
                profiles: [{ id: 'p2', name: 'Claude' }],
                selectedProfile: 'p2',
            },
        },
    };
    const run = await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context,
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(run.environment.profileName, 'Claude');
});

test('runCase prefers the host model resolver over cached settings metadata', async () => {
    const context = {
        ...makeContext(),
        chatCompletionSettings: { openai_model: 'stale-model' },
        getChatCompletionModel: () => 'live-model',
    };
    const run = await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context,
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(run.environment.model, 'live-model');
});

test('runCase captures twice by default so volatile content can be spotted', async () => {
    let captures = 0;
    await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        captureFn: async () => {
            captures += 1;
            return (await fakeCapture()());
        },
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(captures, 2);
});

test('runCase can be asked for a single capture', async () => {
    let captures = 0;
    await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        doubleRun: false,
        captureFn: async () => {
            captures += 1;
            return (await fakeCapture()());
        },
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(captures, 1);
});

test('a failure while applying a case is recorded, not thrown', async () => {
    const run = await runCase(createCase({ name: 'Broken', pins: { characterAvatar: 'gone.png' } }), {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => {
            throw new Error('The character is not installed any more.');
        },
    });
    assert.equal(run.status, STATUS.ERROR);
    assert.match(run.error.message, /not installed any more/);
});

test('a failure while capturing is recorded against that case', async () => {
    const run = await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        captureFn: async () => {
            throw new Error('did not receive a prompt');
        },
        applyFn: async () => ({ caveats: [] }),
    });
    assert.equal(run.status, STATUS.ERROR);
    assert.match(run.error.message, /did not receive a prompt/);
});

test('caveats from applying and from capturing are merged without duplicates', async () => {
    const run = await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        captureFn: fakeCapture({ caveats: ['no-interceptors', 'tokenizer-fallback'] }),
        applyFn: async () => ({ caveats: ['prompt-tags-missing', 'no-interceptors'] }),
    });
    assert.deepEqual(
        [...run.caveats].sort(),
        ['no-interceptors', 'prompt-tags-missing', 'tokenizer-fallback'],
    );
});

test('runCase merges second-capture quality while storing the first prompt', async () => {
    const first = await fakeCapture({
        messages: [{ role: 'system', content: 'First.' }],
        caveats: ['no-interceptors'],
        metricsComplete: true,
        capabilities: {
            syntheticMessagesIsolated: true,
            macroStateSandboxed: false,
            localMacroStateRestored: true,
        },
    })();
    const second = await fakeCapture({
        messages: [{ role: 'system', content: 'Second.' }],
        caveats: ['macro-rollback-unconfirmed', 'final-metrics-incomplete'],
        metricsComplete: false,
        capabilities: {
            syntheticMessagesIsolated: false,
            macroStateSandboxed: true,
            localMacroStateRestored: true,
        },
    })();
    let captures = 0;
    let analyzedBoth = false;
    const run = await runCase(createCase({ pins: { characterAvatar: 'aqua.png' } }), {
        context: makeContext(),
        captureFn: async () => [first, second][captures++],
        applyFn: async () => ({ caveats: [] }),
        analyze: async ({ run: pending, first: analyzedFirst, second: analyzedSecond }) => {
            analyzedBoth = analyzedFirst === first && analyzedSecond === second;
            return pending;
        },
    });

    assert.deepEqual(run.capture.messages, first.messages);
    assert.equal(analyzedBoth, true);
    assert.equal(run.capture.metricsComplete, false);
    assert.equal(run.capture.capabilities.syntheticMessagesIsolated, false);
    assert.equal(run.capture.capabilities.macroStateSandboxed, false);
    assert.equal(run.capture.capabilities.localMacroStateRestored, true);
    assert.ok(run.caveats.includes('macro-rollback-unconfirmed'));
    assert.ok(run.caveats.includes('final-metrics-incomplete'));
});

test('runSuite restores the user configuration after a normal run', async () => {
    let restored = false;
    const result = await runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({ characterAvatar: 'aqua.png' }),
        restoreFn: async () => { restored = true; return []; },
    });
    assert.equal(restored, true);
    assert.equal(result.runs.length, 1);
    assert.equal(result.summary.pass, 1);
    assert.equal(result.state, RUNNER_STATE.DONE);
});

test('runSuite restores the configuration even when every case fails', async () => {
    let restored = false;
    const result = await runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        captureFn: async () => { throw new Error('backend exploded'); },
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({ characterAvatar: 'aqua.png' }),
        restoreFn: async () => { restored = true; return []; },
    });
    assert.equal(restored, true, 'restore must run even when the cases fail');
    assert.equal(result.summary.error, 1);
});

test('runSuite restores the configuration when the snapshot itself is the only good state', async () => {
    let restored = false;
    await assert.rejects(
        () => runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
            context: makeContext(),
            captureFn: fakeCapture(),
            applyFn: async () => ({ caveats: [] }),
            snapshotFn: () => ({ characterAvatar: 'aqua.png' }),
            restoreFn: async () => { restored = true; return []; },
            persistRun: async () => { throw new Error('storage is full'); },
        }),
        /storage is full/,
    );
    assert.equal(restored, true, 'an unexpected error must still restore the configuration');
});

test('a restore failure is reported rather than thrown', async () => {
    const result = await runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({}),
        restoreFn: async () => { throw new Error('profile service unavailable'); },
    });
    assert.deepEqual(result.restoreProblems, ['profile service unavailable']);
});

test('aborting mid-suite skips the remaining cases and still restores', async () => {
    const controller = new AbortController();
    const cases = [
        createCase({ name: 'one', pins: { characterAvatar: 'aqua.png' } }),
        createCase({ name: 'two', pins: { characterAvatar: 'aqua.png' } }),
        createCase({ name: 'three', pins: { characterAvatar: 'aqua.png' } }),
    ];
    let restored = false;
    const result = await runSuite(cases, {
        context: makeContext(),
        signal: controller.signal,
        applyFn: async () => ({ caveats: [] }),
        captureFn: async () => {
            controller.abort();
            return (await fakeCapture()());
        },
        snapshotFn: () => ({}),
        restoreFn: async () => { restored = true; return []; },
    });
    assert.equal(restored, true);
    assert.equal(result.aborted, true);
    assert.equal(result.state, RUNNER_STATE.ABORTED);
    assert.equal(result.summary.skipped, 3, 'the in-flight capture and remaining cases must be skipped');
});

test('an aborted in-flight capture is never handed to persistence', async () => {
    const controller = new AbortController();
    const saved = [];
    const result = await runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        signal: controller.signal,
        applyFn: async () => ({ caveats: [] }),
        captureFn: async () => {
            controller.abort();
            return fakeCapture()();
        },
        snapshotFn: () => ({}),
        restoreFn: async () => [],
        persistRun: async run => saved.push(run.id),
    });
    assert.equal(result.runs[0].status, STATUS.SKIPPED);
    assert.deepEqual(saved, []);
});

test('runSuite restores the original snapshot before every case', async () => {
    const context = { ...makeContext(), sampler: 'original' };
    const seen = [];
    let applied = 0;
    let restores = 0;
    await runSuite([
        createCase({ name: 'pinned', pins: { characterAvatar: 'aqua.png' } }),
        createCase({ name: 'unpinned', pins: { characterAvatar: 'aqua.png' } }),
    ], {
        context,
        doubleRun: false,
        snapshotFn: () => ({ sampler: 'original' }),
        restoreFn: async (_context, snapshot) => {
            restores += 1;
            context.sampler = snapshot.sampler;
            return [];
        },
        applyFn: async () => {
            if (applied++ === 0) context.sampler = 'pinned';
            return { caveats: [] };
        },
        captureFn: async () => {
            seen.push(context.sampler);
            return fakeCapture()();
        },
    });
    assert.deepEqual(seen, ['pinned', 'original']);
    assert.equal(restores, 3, 'two pre-case restores plus the final restore');
});

test('runSuite rejects a concurrent host operation immediately', async () => {
    let releaseCapture;
    const waiting = new Promise(resolve => { releaseCapture = resolve; });
    const first = runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        doubleRun: false,
        snapshotFn: () => ({}),
        restoreFn: async () => [],
        applyFn: async () => ({ caveats: [] }),
        captureFn: async () => {
            await waiting;
            return fakeCapture()();
        },
    });
    await assert.rejects(() => runSuite([], {}), error => error.code === 'SBPL_BUSY');
    releaseCapture();
    await first;
});

test('progress is reported before and after each case', async () => {
    const events = [];
    await runSuite([createCase({ name: 'Aqua', pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({}),
        restoreFn: async () => [],
        onProgress: event => events.push(event.status),
    });
    assert.deepEqual(events, ['running', STATUS.PASS]);
});

test('state changes are reported in order', async () => {
    const states = [];
    await runSuite([createCase({ pins: { characterAvatar: 'aqua.png' } })], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({}),
        restoreFn: async () => [],
        onStateChange: state => states.push(state),
    });
    assert.deepEqual(states, [
        RUNNER_STATE.PREFLIGHT,
        RUNNER_STATE.RUNNING,
        RUNNER_STATE.RESTORING,
        RUNNER_STATE.DONE,
    ]);
});

test('every finished run is handed to the caller to persist', async () => {
    const saved = [];
    await runSuite([
        createCase({ name: 'one', pins: { characterAvatar: 'aqua.png' } }),
        createCase({ name: 'two', pins: { characterAvatar: 'aqua.png' } }),
    ], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({}),
        restoreFn: async () => [],
        persistRun: async run => saved.push(run.caseName),
    });
    assert.deepEqual(saved, ['one', 'two']);
});

test('all runs in one suite share a suite run id', async () => {
    const result = await runSuite([
        createCase({ pins: { characterAvatar: 'aqua.png' } }),
        createCase({ pins: { characterAvatar: 'aqua.png' } }),
    ], {
        context: makeContext(),
        captureFn: fakeCapture(),
        applyFn: async () => ({ caveats: [] }),
        snapshotFn: () => ({}),
        restoreFn: async () => [],
    });
    const ids = new Set(result.runs.map(run => run.suiteRunId));
    assert.equal(ids.size, 1);
    assert.equal([...ids][0], result.suiteRunId);
});

test('preflight separates runnable cases from ones that cannot run', async () => {
    const context = makeContext();
    const good = createCase({ name: 'good', pins: { characterAvatar: 'aqua.png' } });
    const missingCharacter = createCase({ name: 'gone', pins: { characterAvatar: 'gone.png' } });
    const noCharacter = createCase({ name: 'blank' });

    const report = await preflight([good, missingCharacter, noCharacter], { context });
    assert.deepEqual(report.runnable.map(item => item.name), ['good']);
    assert.equal(report.blocked.length, 2);
    assert.equal(report.blocked[0].caseName, 'gone');
    assert.equal(report.blocked[1].caseName, 'blank');
    assert.match(report.blocked[0].reason, /not installed any more/);
    assert.match(report.blocked[1].reason, /No character is chosen/);
});

test('preflight blocks a case whose preset is not installed', async () => {
    const context = makeContext();
    context.getPresetManager = apiId => ({
        getAllPresets: () => (apiId === 'openai' ? ['Default'] : []),
    });
    const testCase = createCase({
        name: 'pinned',
        pins: { characterAvatar: 'aqua.png', presets: [{ apiId: 'openai', name: 'Gone' }] },
    });
    const report = await preflight([testCase], { context });
    assert.equal(report.runnable.length, 0);
    assert.match(report.blocked[0].reason, /the chat completion preset "Gone"/i);
});

test('preflight blocks wrong-mode and mixed preset pins before applying anything', async () => {
    const context = makeContext();
    const wrongMode = createCase({
        name: 'text on chat',
        pins: { characterAvatar: 'aqua.png', presets: [{ apiId: 'context', name: 'Story' }] },
    });
    const mixed = createCase({
        name: 'mixed',
        pins: {
            characterAvatar: 'aqua.png',
            presets: [
                { apiId: 'openai', name: 'Chat' },
                { apiId: 'context', name: 'Story' },
            ],
        },
    });

    const report = await preflight([wrongMode, mixed], { context });

    assert.equal(report.runnable.length, 0);
    assert.match(report.blocked[0].reason, /Text Completion presets.*Chat Completion/);
    assert.match(report.blocked[1].reason, /both Chat Completion and Text Completion/);
});

test('preflight blocks a character switch when the original empty persona cannot be restored', async () => {
    const context = {
        ...makeContext(),
        userAvatar: '',
        characters: [
            { avatar: 'aqua.png', name: 'Aqua' },
            { avatar: 'megumin.png', name: 'Megumin' },
        ],
    };
    const testCase = createCase({ pins: { characterAvatar: 'megumin.png' } });

    const report = await preflight([testCase], { context, chatFileChecker: async () => false });

    assert.equal(report.runnable.length, 0);
    assert.match(report.blocked[0].reason, /empty persona while switching conversations/);
});

test('preflight does not trust a selected profile id when its live fields differ', async () => {
    const connection = { api: 'openai', model: 'manual-model', proxy: 'None' };
    const context = {
        ...makeContext(),
        extensionSettings: {
            connectionManager: {
                selectedProfile: 'p1',
                profiles: [{ id: 'p1', name: 'Current', mode: 'cc', api: 'openai', model: 'profile-model' }],
            },
        },
        SlashCommandParser: {
            commands: new Proxy({}, {
                get: (_target, field) => ({ callback: async () => connection[field] ?? '' }),
            }),
        },
    };
    const testCase = createCase({
        pins: { characterAvatar: 'aqua.png', connectionProfileId: 'p1' },
    });

    const report = await preflight([testCase], { context, chatFileChecker: async () => false });

    assert.equal(report.runnable.length, 0);
    assert.match(report.blocked[0].reason, /cannot be restored exactly from the live host state/);
});

test('preflight accepts a chat-file checker and calls it once per avatar', async () => {
    const context = makeContext();
    let checks = 0;
    const cases = [
        createCase({ pins: { characterAvatar: 'aqua.png' } }),
        createCase({ pins: { characterAvatar: 'aqua.png' } }),
    ];
    const report = await preflight(cases, {
        context,
        chatFileChecker: async () => {
            checks += 1;
            return false;
        },
    });
    assert.equal(checks, 1);
    assert.equal(report.runnable.length, 2);
});

test('preflight warns about unsaved preset edits when SillyBunny no longer offers the check', async () => {
    const context = makeContext();
    // A preset panel exists, but this build dropped the dirty-state helper.
    context.getPresetManager = () => ({ getSelectedPresetName: () => 'Mine' });
    const report = await preflight([], { context });
    assert.equal(report.unsavedPresetEdits, true);
    assert.equal(report.unsavedPresetEditsCertain, false, 'the warning must be marked as a guess');
});

test('preflight reports a clean preset panel without warning', async () => {
    const context = makeContext();
    context.getPresetManager = () => ({ _dirty: false, _checkDirty: () => undefined });
    const report = await preflight([], { context });
    assert.equal(report.unsavedPresetEdits, false);
    assert.equal(report.unsavedPresetEditsCertain, true);
});

test('preflight reports genuinely unsaved preset edits', async () => {
    const context = makeContext();
    context.getPresetManager = () => ({ _dirty: true, _checkDirty: () => undefined });
    const report = await preflight([], { context });
    assert.equal(report.unsavedPresetEdits, true);
    assert.equal(report.unsavedPresetEditsCertain, true);
});

test('preflight checks every preset manager a connection profile can touch', async () => {
    const context = makeContext();
    context.extensionSettings.connectionManager = {
        selectedProfile: 'current',
        profiles: [{ id: 'current', name: 'Current' }, { id: 'other', name: 'Other' }],
    };
    context.getPresetManager = apiId => ({
        getAllPresets: () => [],
        _dirty: apiId === 'instruct',
        _checkDirty() {},
    });
    const report = await preflight([createCase({
        pins: { characterAvatar: 'aqua.png', connectionProfileId: 'other' },
    })], { context, chatFileChecker: async () => false });
    assert.equal(report.unsavedPresetEdits, true);
    assert.equal(report.unsavedPresetEditsCertain, true);
});

test('preflight does not warn when there is no preset panel to lose edits from', async () => {
    const report = await preflight([], { context: makeContext() });
    assert.equal(report.unsavedPresetEdits, false);
});

test('summarize counts every status', () => {
    const summary = summarize([
        { status: STATUS.PASS },
        { status: STATUS.PASS },
        { status: STATUS.FAIL },
        { status: STATUS.CHANGED },
        { status: STATUS.UNCHECKED },
        { status: STATUS.ERROR },
        { status: STATUS.SKIPPED },
    ]);
    assert.equal(summary.total, 7);
    assert.equal(summary.pass, 2);
    assert.equal(summary.fail, 1);
    assert.equal(summary.changed, 1);
    assert.equal(summary.unchecked, 1);
    assert.equal(summary.error, 1);
    assert.equal(summary.skipped, 1);
});
