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
    const applyOptions = [];
    const built = [];
    const captureOptions = [];
    const sent = [];
    const snapshot = { token: 'snapshot' };
    let restored = 0;

    return {
        applied,
        applyOptions,
        built,
        captureOptions,
        sent,
        snapshot,
        get restored() {
            return restored;
        },
        options: {
            snapshotFn: () => snapshot,
            restoreFn: (context, restoredSnapshot) => {
                assert.equal(restoredSnapshot, snapshot, 'restore must be handed the snapshot');
                restored += 1;
                return [];
            },
            applyFn: async (context, pins, options) => {
                applied.push(pins);
                applyOptions.push(options);
                return { caveats: [] };
            },
            captureFn: async (options) => {
                const { scene } = options;
                built.push(scene.map(entry => `${entry.role}:${entry.text}`));
                captureOptions.push(options);
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

test('scripted turns keep their exact text, skip blanks, and are capped', () => {
    assert.deepEqual(
        sceneTurns({ mode: SCENE_MODE.SCRIPTED, turns: ['  one  ', '', 'two', 'three', 'four', 'five'] }),
        ['  one  ', 'two', 'three', 'four'],
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
    assert.equal(harness.restored, 2, 'settings are put back between columns and at the end');
});

test('every apply receives the initial state and every capture receives the abort signal', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    await runSceneComparison({ ...BASE, ...harness.options, signal: controller.signal });

    assert.ok(harness.applyOptions.every(options => options.originalState === harness.snapshot));
    assert.ok(harness.applyOptions.every(options => options.signal === controller.signal));
    assert.ok(harness.captureOptions.every(options => options.signal === controller.signal));
});

test('each column starts from the initial host state', async () => {
    const state = { preset: 'original' };
    const starts = [];
    const sent = [];
    let restores = 0;

    const result = await runSceneComparison({
        ...BASE,
        turns: ['One turn.'],
        snapshotFn: () => ({ ...state }),
        restoreFn: (_context, snapshot) => {
            restores += 1;
            state.preset = snapshot.preset;
            return [];
        },
        applyFn: async (_context, pins) => {
            starts.push(state.preset);
            state.preset = pins.presets[0].name;
        },
        captureFn: async () => ({ messages: [] }),
        sendFn: async () => {
            sent.push(state.preset);
            return { text: 'reply' };
        },
    });

    assert.deepEqual(starts, ['original', 'original']);
    assert.deepEqual(sent, ['Preset 1', 'Preset 2']);
    assert.equal(restores, 2);
    assert.equal(state.preset, 'original');
    assert.equal(result.incomplete, false);
});

test('an inter-column restore failure prevents the next send and stays reported', async () => {
    const harness = makeHarness();
    let restoreCalls = 0;
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        turns: ['One turn.'],
        restoreFn: () => {
            restoreCalls += 1;
            return restoreCalls === 1 ? ['preset: original state unavailable'] : [];
        },
    });

    assert.deepEqual(harness.applied.map(pins => pins.presets[0].name), ['Preset 1']);
    assert.equal(harness.sent.length, 1);
    assert.equal(restoreCalls, 2, 'the final restore still runs');
    assert.deepEqual(result.restoreProblems, ['preset: original state unavailable']);
    assert.equal(result.completedRequests, 1);
    assert.equal(result.expectedRequests, 2);
    assert.equal(result.incomplete, true);
    assert.equal(result.aborted, false);
});

test('blank turns do not trim text or renumber later turns', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        turns: ['  first line  ', ' \n ', 'third line\n'],
    });
    assert.deepEqual(harness.built, [
        ['user:  first line  '],
        ['user:  first line  ', 'assistant:P1 reply 1', 'user:third line\n'],
    ]);
    assert.deepEqual(result.columns[0].turns.map(turn => turn.index), [1, 3]);
    assert.deepEqual(result.columns[0].turns.map(turn => turn.userText), ['  first line  ', 'third line\n']);
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
    assert.equal(harness.restored, 2);
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
    assert.equal(harness.restored, 2);
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
    assert.equal(harness.restored, 2);
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

test('an abort during capture is checked before the paid send', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        signal: controller.signal,
        captureFn: async ({ scene }) => {
            controller.abort();
            return {
                messages: [{ role: 'user', content: scene.at(-1).text }],
                tokenTable: { total: 10 },
            };
        },
    });
    assert.equal(result.aborted, true);
    assert.equal(result.completedRequests, 0);
    assert.deepEqual(harness.sent, []);
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

test('a failed streamed turn keeps its partial text and its error', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        turns: ['One turn.'],
        live: true,
        sendFn: async (profileId, prompt, { onDelta }) => {
            onDelta('Partial reply');
            return { profileId, text: '', error: 'stream disconnected' };
        },
    });
    assert.equal(result.columns[0].turns[0].text, 'Partial reply');
    assert.equal(result.columns[0].turns[0].error, 'stream disconnected');
    const saved = formatScene(result, { format: 'md' });
    assert.match(saved, /Partial reply/);
    assert.match(saved, /stream disconnected/);
});

test('a whitespace-only scene reply is treated as empty but preserved', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        sendFn: async profileId => ({ profileId, text: ' \n ', error: null }),
    });
    const turn = result.columns[0].turns[0];
    assert.equal(turn.text, ' \n ');
    assert.match(turn.error, /empty reply/);
    assert.equal(result.columns[0].turns.length, 1);
});

test('scene sends use the tested sampler preset and only suppress tested instruct settings', async () => {
    const harness = makeHarness();
    const flags = [];
    await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [
            { apiId: 'openai', name: 'Chat preset' },
            { apiId: 'textgenerationwebui', name: 'Sampler' },
            { apiId: 'instruct', name: 'Instruct' },
        ],
        turns: ['One turn.'],
        sendFn: async (profileId, prompt, options) => {
            flags.push([options.presetName, options.includePreset, options.includeInstruct]);
            return { profileId, text: 'reply', error: null };
        },
    });
    assert.deepEqual(flags, [
        ['Chat preset', true, true],
        ['Sampler', true, true],
        [undefined, true, false],
    ]);
});

test('durations are read in the units a person thinks in', () => {
    assert.equal(describeDuration(0), '0.0 seconds');
    assert.equal(describeDuration(8400), '8.4 seconds');
    assert.equal(describeDuration(42000), '42 seconds');
    assert.equal(describeDuration(72000), '1 minute 12 seconds');
    assert.equal(describeDuration(605000), '10 minutes 5 seconds');
    assert.equal(describeDuration(119600), '2 minutes 0 seconds');
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

test('every export records completeness and each caveat once', () => {
    const result = {
        ...FINISHED,
        aborted: true,
        incomplete: true,
        expectedRequests: 4,
        completedRequests: 1,
        columns: FINISHED.columns.map(column => ({ ...column, caveats: ['existing-chat'] })),
    };
    for (const format of ['md', 'txt', 'html']) {
        const output = formatScene(result, { format });
        assert.match(output, /Aborted \(incomplete\)/);
        assert.match(output, /1 of 4 completed/);
        assert.equal((output.match(/This character already had a chat open/g) ?? []).length, 1);
    }
    assert.match(formatScene({ ...result, aborted: false }, { format: 'md' }), /Status:\*\* Incomplete/);
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

test('the non-DOM web export shows reply markup as escaped plain text', () => {
    const page = formatScene(WITH_MARKUP, { format: 'html', characterName: 'Aqua' });

    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /&lt;div class=&quot;tracker&quot; style=&quot;color:red&quot;&gt;Mood: &lt;b&gt;wary&lt;\/b&gt;&lt;\/div&gt;/);
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
                text: '</div></section><form action="https://example.test">'
                    + '<script>fetch("http://example.test")</script>'
                    + '<img src=x onerror="alert(1)">'
                    + '<a href="javascript:alert(2)">tap</a>'
                    + '<button formaction="https://example.test">go</button>'
                    + '<style>body{display:none}</style></form>',
                error: null,
                promptTokens: 10,
                durationMs: 1000,
            }],
        }],
    }, { format: 'html' });

    assert.doesNotMatch(page, /<script>/i);
    assert.doesNotMatch(page, /<form\b/i);
    assert.doesNotMatch(page, /<button\b/i);
    assert.equal((page.match(/<style>/gi) ?? []).length, 1, 'only the export page stylesheet remains');
    // Belt and braces: even markup that got past the strip cannot run or fetch.
    assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
    assert.match(page, /form-action 'none'; base-uri 'none'/);
});

test('the non-DOM sanitizer conservatively escapes ordinary markup', () => {
    const kept = '<div class="card"><style>.card{color:red}</style><b>Mood</b>: wary</div>';
    assert.equal(
        sanitizeReplyHtml(kept),
        '&lt;div class=&quot;card&quot;&gt;&lt;style&gt;.card{color:red}&lt;/style&gt;&lt;b&gt;Mood&lt;/b&gt;: wary&lt;/div&gt;',
    );
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
    assert.match(page, /&lt;font color=&quot;#CC79A7&quot;&gt;&quot;There&#39;s tape on the counter,&quot;&lt;\/font&gt; she says\.<br>/);
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

/* ------------------------------------------------------------ the opening */

test('the chosen greeting opens every column, before the first turn', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        greeting: 'She looks up from the bar.',
        turns: ['I open the door.'],
    });

    // Both presets answer the same opening, and it is in the prompt built for
    // the first turn rather than tacked on afterwards.
    assert.deepEqual(harness.built, [
        ['assistant:She looks up from the bar.', 'user:I open the door.'],
        ['assistant:She looks up from the bar.', 'user:I open the door.'],
    ]);
    assert.equal(result.opening, 'She looks up from the bar.');
    // It is the scene's opening, not a turn: no reply of its own, no timing.
    assert.deepEqual(result.columns[0].turns.map(turn => turn.index), [1]);
});

test('a greeting costs no extra request', () => {
    const withGreeting = estimateScene({ ...BASE, maxTokens: 300 });
    assert.equal(withGreeting.requests, 4);
    assert.equal(estimateScene({ ...BASE, maxTokens: 300, greeting: 'Hello.' }).requests, 4);
});

test('a scene with no greeting starts at the first turn as before', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({ ...BASE, ...harness.options, turns: ['Only this.'], greeting: '   ' });
    assert.deepEqual(harness.built[0], ['user:Only this.']);
    assert.equal(result.opening, '');
});

test('a character with a chat already open says so on every column', async () => {
    const harness = makeHarness();
    const context = globalThis.SillyTavern.getContext();
    context.chat = [{ mes: 'an older conversation' }];
    try {
        const result = await runSceneComparison({ ...BASE, ...harness.options, turns: ['One turn.'] });
        assert.ok(result.columns[0].caveats.includes('existing-chat'));
        assert.ok(result.columns[1].caveats.includes('existing-chat'));
    } finally {
        context.chat = [];
    }
});

test('a saved comparison says what the scene opened with', () => {
    const finished = {
        opening: 'She looks up from the bar.',
        columns: [{
            label: 'Preset 1',
            error: '',
            caveats: [],
            turns: [{ index: 1, userText: 'I open the door.', text: 'She nods.', error: null, promptTokens: 10, durationMs: 1000 }],
        }],
    };
    assert.match(formatScene(finished, { format: 'md' }), /## The scene opened with\n\nShe looks up from the bar\./);
    assert.match(formatScene(finished, { format: 'txt' }), /THE SCENE OPENED WITH\n\nShe looks up from the bar\./);
    assert.match(formatScene(finished, { format: 'html' }), /class="opening"[\s\S]*She looks up from the bar\./);
});

test('a saved scene names the model as well as the connection', () => {
    const details = {
        characterName: 'Aqua',
        connectionName: 'Local',
        modelName: 'claude-sonnet-4',
        savedAt: '9 August 2026',
    };

    assert.match(formatScene(FINISHED, { ...details, format: 'md' }), /- \*\*Model:\*\* claude-sonnet-4/);
    assert.match(formatScene(FINISHED, { ...details, format: 'txt' }), /Model: claude-sonnet-4/);
    assert.match(formatScene(FINISHED, { ...details, format: 'html' }), /Connection: Local · Model: claude-sonnet-4/);

    // A connection that does not name a model says nothing rather than nothing
    // useful: no empty "Model:" line to read past.
    assert.doesNotMatch(formatScene(FINISHED, { ...details, modelName: '', format: 'md' }), /Model:/);
    assert.doesNotMatch(formatScene(FINISHED, { ...details, modelName: '', format: 'html' }), /Model:/);
});

/* --------------------------------------------------------- playing again */

test('one turn can be played again without paying for the ones before it', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        greeting: 'She looks up.',
        turns: ['I open the door.', '"Who sent you?"', 'I wait.'],
        startAt: 2,
        history: [
            { role: 'user', text: 'I open the door.' },
            { role: 'assistant', text: 'She says nothing.' },
        ],
    });

    // The opening and what was already said are handed back as they stand, and
    // only the turns from the second onwards are sent again.
    assert.deepEqual(harness.built, [
        [
            'assistant:She looks up.',
            'user:I open the door.',
            'assistant:She says nothing.',
            'user:"Who sent you?"',
        ],
        [
            'assistant:She looks up.',
            'user:I open the door.',
            'assistant:She says nothing.',
            'user:"Who sent you?"',
            'assistant:P1 reply 1',
            'user:I wait.',
        ],
    ]);

    // The turns keep the numbers they had, so a retry does not renumber a scene.
    assert.deepEqual(result.columns[0].turns.map(turn => turn.index), [2, 3]);
    assert.deepEqual(result.columns[0].turns.map(turn => turn.userText), ['"Who sent you?"', 'I wait.']);
});

test('the progress of a retry counts against the whole scene, not the part being replayed', async () => {
    const harness = makeHarness();
    const seen = [];
    await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        turns: ['One.', 'Two.', 'Three.'],
        startAt: 3,
        onProgress: event => seen.push(`${event.turn} of ${event.turnTotal}`),
    });
    assert.deepEqual(seen, ['3 of 3']);
});

test('a turn number outside the scene is pulled back to one that exists', async () => {
    const harness = makeHarness();
    const result = await runSceneComparison({
        ...BASE,
        ...harness.options,
        presets: [{ apiId: 'openai', name: 'Preset 1' }],
        turns: ['One.', 'Two.'],
        startAt: 9,
    });
    assert.deepEqual(result.columns[0].turns.map(turn => turn.index), [2]);
});
