import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const {
    breakReplyLines,
    CONTINUE_NUDGE,
    describeDuration,
    describeEstimate,
    estimateScene,
    formatScene,
    runSceneComparison,
    sanitizeReplyHtml,
    SCENE_MODE,
    sceneFileName,
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

/* ------------------------------------------------------- live and timing */

test('a turn is recorded before the reply arrives, so it can be watched filling in', async () => {
    const harness = makeHarness();
    const seen = [];
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        turns: ['I open the door.'],
        live: true,
        onUpdate: ({ columns, streaming }) => {
            const turn = columns[0].turns[0];
            seen.push({
                text: turn?.text ?? null,
                waiting: turn?.waiting ?? null,
                streaming: Boolean(streaming),
            });
        },
        sendFn: async (profileId, prompt, { onDelta }) => {
            onDelta('Half a');
            onDelta('Half a sentence.');
            return { profileId, text: 'Half a sentence.', error: null };
        },
    });

    assert.deepEqual(seen, [
        { text: null, waiting: null, streaming: false },     // the column exists
        { text: '', waiting: true, streaming: false },       // the turn is waiting
        { text: 'Half a', waiting: true, streaming: true },
        { text: 'Half a sentence.', waiting: true, streaming: true },
        { text: 'Half a sentence.', waiting: false, streaming: false },
        { text: 'Half a sentence.', waiting: false, streaming: false },
    ]);
    assert.equal(result.columns[0].turns[0].waiting, false);
    assert.ok(Number.isFinite(result.columns[0].turns[0].durationMs), 'a turn records how long it took');
});

test('nothing is streamed when nobody is watching', async () => {
    const harness = makeHarness();
    let asked = null;
    await runSceneComparison({
        ...BASE,
        ...harness.options,
        turns: ['One turn.'],
        sendFn: async (profileId, prompt, options) => {
            asked = options.onDelta;
            return { profileId, text: 'reply', error: null };
        },
    });
    assert.equal(asked, null);
});

test('durations are read in the units a person thinks in', () => {
    assert.equal(describeDuration(0), '0.0 seconds');
    assert.equal(describeDuration(8400), '8.4 seconds');
    assert.equal(describeDuration(42000), '42 seconds');
    assert.equal(describeDuration(72000), '1 minute 12 seconds');
    assert.equal(describeDuration(605000), '10 minutes 5 seconds');
});

/* ------------------------------------------------------------- exporting */

const FINISHED = {
    columns: [
        {
            label: 'Preset 1',
            error: '',
            caveats: [],
            turns: [
                { index: 1, userText: 'I open the door.', text: 'She looks up.', error: null, promptTokens: 3120, durationMs: 8400 },
            ],
        },
        {
            label: 'Preset 2',
            error: '',
            caveats: [],
            turns: [
                { index: 1, userText: 'I open the door.', text: '', error: 'The connection timed out.', promptTokens: 3500, durationMs: 61000 },
            ],
        },
    ],
};

test('a saved scene keeps who said what, how long it took, and what went wrong', () => {
    const markdown = formatScene(FINISHED, {
        format: 'md',
        characterName: 'Aqua',
        connectionName: 'Local',
        savedAt: '9 August 2026',
    });

    assert.match(markdown, /^# Scene comparison/);
    assert.match(markdown, /- \*\*Character:\*\* Aqua/);
    assert.match(markdown, /## Preset 1/);
    assert.match(markdown, /\*\*You:\*\* I open the door\./);
    assert.match(markdown, /\*\*Preset 1:\*\* She looks up\./);
    assert.match(markdown, /\*8\.4 seconds, prompt 3,120 tokens\*/);
    // A failed turn is written down as a failure rather than as an empty reply.
    assert.match(markdown, /\*\*Preset 2:\*\* \(The connection timed out\.\)/);
    assert.ok(markdown.endsWith('\n'));
});

test('the plain text version carries the same facts without the markup', () => {
    const text = formatScene(FINISHED, { format: 'txt', characterName: 'Aqua' });
    assert.doesNotMatch(text, /\*\*/);
    assert.doesNotMatch(text, /^#/m);
    assert.match(text, /^SCENE COMPARISON/);
    assert.match(text, /Character: Aqua/);
    assert.match(text, /You: I open the door\./);
    assert.match(text, /Preset 1: She looks up\./);
    assert.match(text, /\(8\.4 seconds, prompt 3,120 tokens\)/);
});

test('the file name says what the file holds and stays safe', () => {
    assert.equal(
        sceneFileName({ characterName: 'Aqua / Goddess!', format: 'md', savedAt: '2026-08-09T12:00:00.000Z' }),
        'prompting-lab-scene-aqua-goddess-2026-08-09.md',
    );
    assert.equal(sceneFileName({ format: 'txt' }), 'prompting-lab-scene-scene.txt');
});

/* ---------------------------------------------------------- the web page */

const WITH_MARKUP = {
    columns: [{
        label: 'Preset 1',
        error: '',
        caveats: [],
        turns: [{
            index: 1,
            userText: 'Show me the <tracker> & stats',
            text: '<div class="tracker" style="color:red">Mood: <b>wary</b></div>',
            error: null,
            promptTokens: 3120,
            durationMs: 8400,
        }],
    }],
};

test('a saved web page keeps the markup a reply carried', () => {
    const page = formatScene(WITH_MARKUP, { format: 'html', characterName: 'Aqua' });

    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /<div class="tracker" style="color:red">Mood: <b>wary<\/b><\/div>/);
    // What the user typed is text, so its angle brackets stay visible rather
    // than becoming an element in the saved page.
    assert.match(page, /Show me the &lt;tracker&gt; &amp; stats/);
    assert.match(page, /8\.4 seconds · prompt 3,120 tokens/);
});

test('a saved web page cannot run what a model wrote', () => {
    const page = formatScene({
        columns: [{
            label: 'Preset 1',
            error: '',
            caveats: [],
            turns: [{
                index: 1,
                userText: 'go',
                text: '<script>fetch("http://example.test")</script>'
                    + '<img src=x onerror="alert(1)">'
                    + '<a href="javascript:alert(2)">tap</a>'
                    + '<iframe src="http://example.test"></iframe>',
                error: null,
                promptTokens: 10,
                durationMs: 1000,
            }],
        }],
    }, { format: 'html' });

    assert.doesNotMatch(page, /<script>/i);
    assert.doesNotMatch(page, /<iframe/i);
    assert.doesNotMatch(page, /onerror/i);
    assert.doesNotMatch(page, /javascript:/i);
    // Belt and braces: even markup that got past the strip cannot run or fetch.
    assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
});

test('the stripper leaves ordinary markup alone', () => {
    const kept = '<div class="card"><style>.card{color:red}</style><b>Mood</b>: wary</div>';
    assert.equal(sanitizeReplyHtml(kept), kept);
});

test('a web page export is named as one', () => {
    assert.equal(
        sceneFileName({ characterName: 'Aqua', format: 'html', savedAt: '2026-08-09T12:00:00.000Z' }),
        'prompting-lab-scene-aqua-2026-08-09.html',
    );
});

test('a saved web page keeps the line breaks the prose depends on', () => {
    const reply = 'She turns away.\n\n<font color="#CC79A7">"There\'s tape on the counter,"</font> she says.\n\nThe tape goes on crooked.';
    const page = formatScene({
        columns: [{
            label: 'Preset 1',
            error: '',
            caveats: [],
            turns: [{ index: 1, userText: 'Line one.\nLine two.', text: reply, error: null, promptTokens: 10, durationMs: 1000 }],
        }],
    }, { format: 'html' });

    // Three paragraphs of prose, so the breaks between them have to survive.
    assert.equal((page.match(/<br>/g) ?? []).length, 4);
    assert.match(page, /She turns away\.<br>/);
    assert.match(page, /<font color="#CC79A7">"There's tape on the counter,"<\/font> she says\.<br>/);
    // The typed turn is escaped text, kept by the page's own white-space rule.
    assert.match(page, /white-space: pre-wrap/);
    assert.match(page, /Line one\.\nLine two\./);
});

test('markup laid out across lines does not gain blank lines of its own', () => {
    // Every line here ends between tags, so a tracker card written across
    // several lines comes out exactly as it went in.
    const tracker = '<details>\n  <summary>States</summary>\n  <b>Mood</b>\n</details>';
    assert.equal(breakReplyLines(tracker), tracker);

    // A line that ends in the middle of prose is a break the model meant.
    assert.equal(
        breakReplyLines('<b>Mara</b> looks up.\nShe says nothing.'),
        '<b>Mara</b> looks up.<br>\nShe says nothing.',
    );
});

test('the lines inside a style block are left exactly as written', () => {
    const styled = '<style>\n.card { color: red;\n}\n</style>\nAfter the card.';
    const broken = breakReplyLines(styled);
    assert.match(broken, /<style>\n\.card \{ color: red;\n\}\n<\/style>/);
    assert.doesNotMatch(broken.slice(0, broken.indexOf('</style>')), /<br>/);
});
