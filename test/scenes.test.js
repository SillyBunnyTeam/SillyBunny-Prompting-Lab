import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const {
    CONTINUE_NUDGE,
    describeEstimate,
    estimateScene,
    runSceneComparison,
    SCENE_MODE,
    sceneTurns,
} = await import('../src/scenes.js');

test.after(() => removeStubContext());

/** Records what each column was asked to build and send. */
function makeHarness({ reply = (preset, turn) => `${preset} reply ${turn}`, capture = null } = {}) {
    const applied = [];
    const built = [];
    const sent = [];
    let restored = 0;

    return {
        applied,
        built,
        sent,
        get restored() {
            return restored;
        },
        options: {
            snapshotFn: () => ({ token: 'snapshot' }),
            restoreFn: (context, snapshot) => {
                assert.deepEqual(snapshot, { token: 'snapshot' }, 'restore must be handed the snapshot');
                restored += 1;
                return [];
            },
            applyFn: async (context, pins) => {
                applied.push(pins);
                return { caveats: [] };
            },
            captureFn: async ({ scene }) => {
                built.push(scene.map(entry => `${entry.role}:${entry.text}`));
                return capture ?? {
                    messages: [{ role: 'user', content: scene[scene.length - 1].text }],
                    tokenTable: { total: 100 + scene.length },
                    caveats: ['no-interceptors'],
                };
            },
            sendFn: async (profileId, prompt) => {
                sent.push({ profileId, prompt });
                const column = applied.length;
                const turn = built.length;
                return { profileId, text: reply(`P${column}`, turn), error: null };
            },
        },
    };
}

const BASE = {
    presets: [{ apiId: 'openai', name: 'Preset 1' }, { apiId: 'openai', name: 'Preset 2' }],
    characterAvatar: 'aqua.png',
    connectionProfileId: 'profile-1',
    turns: ['I open the door.', '"Who sent you?"'],
};

/* ------------------------------------------------------------- the script */

test('scripted turns are sent as written, trimmed and capped', () => {
    assert.deepEqual(
        sceneTurns({ mode: SCENE_MODE.SCRIPTED, turns: ['  one  ', '', 'two', 'three', 'four', 'five'] }),
        ['one', 'two', 'three', 'four'],
    );
});

test('continue mode sends the opening once and then the same nudge', () => {
    assert.deepEqual(
        sceneTurns({ mode: SCENE_MODE.CONTINUE, turns: ['Opening', 'ignored'], exchanges: 3 }),
        ['Opening', CONTINUE_NUDGE, CONTINUE_NUDGE],
    );
    assert.deepEqual(sceneTurns({ mode: SCENE_MODE.CONTINUE, turns: [''], exchanges: 3 }), []);
    // Out-of-range counts are pulled back into what the tab allows.
    assert.equal(sceneTurns({ mode: SCENE_MODE.CONTINUE, turns: ['Opening'], exchanges: 99 }).length, 4);
});

test('the estimate counts every request before any is made', () => {
    const estimate = estimateScene({ ...BASE, maxTokens: 300 });
    assert.deepEqual(estimate, { turns: 2, presets: 2, requests: 4, replyTokenCeiling: 1200 });
    assert.match(describeEstimate(estimate), /^4 requests: 2 turns for each of 2 presets/);
    assert.match(describeEstimate(estimateScene({ presets: [], turns: [] })), /Choose at least two presets/);
});

/* ------------------------------------------------------------ the running */

test('every preset faces the same scripted turns, each built on the scene so far', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({ ...BASE, ...harness.options });

    assert.deepEqual(harness.applied.map(pins => pins.presets[0].name), ['Preset 1', 'Preset 2']);
    assert.deepEqual(harness.applied[0].characterAvatar, 'aqua.png');

    // Turn two is built with turn one and its reply already in the scene, and
    // both columns are handed the same user words.
    assert.deepEqual(harness.built, [
        ['user:I open the door.'],
        ['user:I open the door.', 'assistant:P1 reply 1', 'user:"Who sent you?"'],
        ['user:I open the door.'],
        ['user:I open the door.', 'assistant:P2 reply 3', 'user:"Who sent you?"'],
    ]);
    assert.deepEqual(
        result.columns.map(column => column.turns.map(turn => turn.userText)),
        [['I open the door.', '"Who sent you?"'], ['I open the door.', '"Who sent you?"']],
    );
    assert.deepEqual(result.columns.map(column => column.label), ['Preset 1', 'Preset 2']);
    assert.deepEqual(result.columns[0].caveats, ['no-interceptors']);
    assert.equal(result.columns[0].turns[0].promptTokens, 101);
    assert.equal(harness.restored, 1, 'settings are put back once, at the end');
});

test('a failed reply ends that column instead of answering a reply that never came', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        sendFn: async (profileId) => ({ profileId, text: '', error: 'The model returned an empty reply.' }),
    });

    assert.deepEqual(result.columns.map(column => column.turns.length), [1, 1]);
    assert.equal(result.columns[0].turns[0].error, 'The model returned an empty reply.');
    assert.equal(harness.restored, 1);
});

test('a preset that cannot be applied is reported without stopping the others', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        applyFn: async (context, pins) => {
            if (pins.presets[0].name === 'Preset 1') {
                throw new Error('That preset is not installed any more.');
            }
            return { caveats: [] };
        },
    });

    assert.equal(result.columns[0].error, 'That preset is not installed any more.');
    assert.deepEqual(result.columns[0].turns, []);
    assert.equal(result.columns[1].turns.length, 2, 'the second preset still played the scene');
    assert.equal(harness.restored, 1);
});

test('settings are put back even when building the prompt throws', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        captureFn: async () => {
            throw new Error('SillyBunny did not return a prompt.');
        },
    });

    assert.equal(result.columns[0].error, 'SillyBunny did not return a prompt.');
    assert.equal(harness.restored, 1);
    assert.deepEqual(harness.sent, [], 'nothing is sent, so nothing is paid for');
});

test('stopping leaves the presets that had not started alone', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        signal: controller.signal,
        sendFn: async (profileId) => {
            controller.abort();
            return { profileId, text: 'first reply', error: null };
        },
    });

    assert.equal(result.aborted, true);
    assert.equal(result.columns.length, 1, 'the second preset was never applied');
    assert.equal(result.columns[0].turns.length, 1);
    assert.equal(harness.restored, 1);
});

test('nothing is applied or sent when there is no scene to play', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({ ...BASE, ...harness.options, turns: ['   '] });

    assert.deepEqual(result.columns, []);
    assert.deepEqual(harness.applied, []);
    assert.equal(harness.restored, 0, 'nothing was changed, so nothing needs putting back');
});
