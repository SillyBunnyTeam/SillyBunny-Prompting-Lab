import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { CAVEAT } = await import('../src/constants.js');
const {
    captureOnce,
    createCaptureSession,
    readChatCompletionSections,
    readTextCompletionSections,
    withTransientUserMessage,
} = await import('../src/capture.js');

test.after(() => removeStubContext());

/** Stand-in for the host's event emitter, including makeLast ordering. */
function makeEventSource() {
    const listeners = new Map();
    const order = [];
    return {
        order,
        on(type, handler) {
            order.push(['on', type]);
            const set = listeners.get(type) ?? new Set();
            set.add(handler);
            listeners.set(type, set);
        },
        makeLast(type, handler) {
            order.push(['makeLast', type]);
            const set = listeners.get(type) ?? new Set();
            set.add(handler);
            listeners.set(type, set);
        },
        removeListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        async emit(type, ...args) {
            for (const handler of [...(listeners.get(type) ?? [])]) {
                await handler(...args);
            }
        },
        count(type) {
            return listeners.get(type)?.size ?? 0;
        },
    };
}

const EVENTS = {
    GENERATION_STARTED: 'generation_started',
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
};

/** Minimal stand-ins for the host's Message / MessageCollection classes. */
function message(content, tokens) {
    return { content, getTokens: () => tokens };
}

function collection(identifier, items) {
    return {
        identifier,
        collection: items,
        getCollection: () => items,
        getTokens: () => items.reduce((sum, item) => sum + item.getTokens(), 0),
        flatten() {
            return items.flatMap(item => (Array.isArray(item.collection) ? item.flatten() : [item]));
        },
    };
}

test('withTransientUserMessage adds the message then removes it', async () => {
    const context = { chat: [{ mes: 'existing' }], name1: 'You' };
    let seen = null;
    await withTransientUserMessage(context, 'Hello there', async () => {
        seen = context.chat.map(entry => entry.mes);
    });
    assert.deepEqual(seen, ['existing', 'Hello there']);
    assert.deepEqual(context.chat.map(entry => entry.mes), ['existing']);
});

test('withTransientUserMessage removes the message even when the run throws', async () => {
    const context = { chat: [], name1: 'You' };
    await assert.rejects(
        () => withTransientUserMessage(context, 'Hello', async () => {
            throw new Error('assembly failed');
        }),
        /assembly failed/,
    );
    assert.deepEqual(context.chat, []);
});

test('withTransientUserMessage removes its own entry, not whatever is last', async () => {
    const context = { chat: [], name1: 'You' };
    await withTransientUserMessage(context, 'Mine', async () => {
        // Something else appends during assembly, as an extension might.
        context.chat.push({ mes: 'from another extension' });
    });
    assert.deepEqual(context.chat.map(entry => entry.mes), ['from another extension']);
});

test('withTransientUserMessage does nothing when there is no message', async () => {
    const context = { chat: [], name1: 'You' };
    let ran = false;
    await withTransientUserMessage(context, '', async () => { ran = true; });
    assert.equal(ran, true);
    assert.deepEqual(context.chat, []);
});

test('the capture session subscribes last and detaches completely', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    assert.ok(eventSource.order.every(([method]) => method === 'makeLast'));
    assert.equal(eventSource.count(EVENTS.GENERATE_AFTER_DATA), 1);
    session.detach();
    for (const type of Object.values(EVENTS)) {
        assert.equal(eventSource.count(type), 0, `${type} listener should be removed`);
    }
});

test('the capture session records a chat-completion prompt', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    await eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', {}, true);
    await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
        chat: [{ role: 'system', content: 'You are Aqua.' }],
        dryRun: true,
    });
    await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, {
        prompt: [{ role: 'system', content: 'You are Aqua.' }],
        cacheScope: 'main',
    }, true);
    const state = session.getState();
    assert.equal(state.dryRun, true);
    assert.equal(state.cacheScope, 'main');
    assert.deepEqual(state.ccMessages, [{ role: 'system', content: 'You are Aqua.' }]);
    session.detach();
});

test('captured messages are copies, so later host changes cannot alter them', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    const live = [{ role: 'system', content: 'original' }];
    await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, { chat: live, dryRun: true });
    live[0].content = 'changed afterwards';
    live.push({ role: 'user', content: 'added afterwards' });
    assert.deepEqual(session.getState().ccMessages, [{ role: 'system', content: 'original' }]);
    session.detach();
});

test('only the first before-combine pass is kept, so the CFG pass cannot overwrite it', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    await eventSource.emit(EVENTS.GENERATE_BEFORE_COMBINE_PROMPTS, { storyString: 'real prompt' });
    await eventSource.emit(EVENTS.GENERATE_BEFORE_COMBINE_PROMPTS, { storyString: 'negative prompt' });
    assert.equal(session.getState().beforeCombine.storyString, 'real prompt');
    session.detach();
});

test('world info passes are accumulated across recursion rounds', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    await eventSource.emit(EVENTS.WORLDINFO_SCAN_DONE, {
        activated: { entries: new Set([{ world: 'Book', uid: 1, comment: 'Dragon', key: ['dragon'] }]) },
    });
    await eventSource.emit(EVENTS.WORLDINFO_SCAN_DONE, {
        activated: { entries: new Set([{ world: 'Book', uid: 2, comment: 'Map', key: ['map'] }]) },
    });
    await eventSource.emit(EVENTS.WORLDINFO_SCAN_DONE, { activated: { entries: new Set() } });
    const passes = session.getState().wiPasses;
    assert.equal(passes.length, 2);
    assert.equal(passes[0][0].comment, 'Dragon');
    assert.equal(passes[1][0].uid, 2);
    session.detach();
});

test('a world info payload holding uncopyable objects is still read safely', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    class TimedEffects {
        constructor() {
            this.tick = () => {};
        }
    }
    await eventSource.emit(EVENTS.WORLDINFO_SCAN_DONE, {
        activated: { entries: new Set([{ world: 'Book', uid: 7, comment: 'Vault', key: ['vault'] }]) },
        timedEffects: new TimedEffects(),
    });
    assert.equal(session.getState().wiPasses[0][0].uid, 7);
    session.detach();
});

test('readChatCompletionSections reports one row per prompt section', () => {
    const root = collection('root', [
        collection('main', [message('You are Aqua.', 5)]),
        collection('chatHistory', [message('Hello.', 2), message('Hi.', 1)]),
        collection('empty', []),
    ]);
    const promptManager = { messages: root, tokenHandler: { counts: {} } };
    const { sections, tokenTable } = readChatCompletionSections(null, promptManager);
    assert.deepEqual(sections.map(section => section.id), ['main', 'chatHistory']);
    assert.equal(sections[0].label, 'Main prompt');
    assert.equal(sections[1].content, 'Hello.\nHi.');
    assert.equal(sections[1].tokens, 3);
    assert.equal(tokenTable.total, 8);
    assert.deepEqual(tokenTable.perSection, { main: 5, chatHistory: 3 });
});

test('readChatCompletionSections prefers the host token helper when present', () => {
    const root = collection('root', [collection('main', [message('You are Aqua.', 5)])]);
    const host = { tokenCounts: { getPromptDisplayTokenCounts: () => ({ main: 42 }) } };
    const { tokenTable } = readChatCompletionSections(host, { messages: root });
    assert.equal(tokenTable.perSection.main, 42);
});

test('readChatCompletionSections survives a missing prompt manager', () => {
    assert.deepEqual(readChatCompletionSections(null, null).sections, []);
    assert.deepEqual(readChatCompletionSections(null, {}).sections, []);
});

test('readTextCompletionSections counts each piece separately', async () => {
    const { sections, tokenTable } = await readTextCompletionSections({
        storyString: 'Aqua is a goddess.',
        mesSendString: 'You: hello',
        empty: '',
        notText: 42,
    });
    assert.deepEqual(sections.map(section => section.id), ['storyString', 'mesSendString']);
    assert.equal(sections[0].label, 'Story string');
    assert.ok(tokenTable.total > 0);
});

test('readTextCompletionSections returns nothing when the pass was not seen', async () => {
    const { sections, tokenTable } = await readTextCompletionSections(null);
    assert.deepEqual(sections, []);
    assert.equal(tokenTable.total, 0);
});

test('captureOnce assembles a chat-completion prompt and reports the caveat', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('You are Aqua.', 5)])]);
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        name1: 'You',
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        async generate(type, options, dryRun) {
            assert.equal(dryRun, true, 'the lab must only ever run a dry run');
            assert.equal(context.chat.at(-1).mes, 'Hello Aqua', 'the example message must be in the chat during assembly');
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'You are Aqua.' }],
                dryRun,
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, {
                prompt: [{ role: 'system', content: 'You are Aqua.' }],
            }, dryRun);
        },
    };

    const result = await captureOnce({ userMessage: 'Hello Aqua', context, host: null });
    assert.equal(result.apiType, 'cc');
    assert.deepEqual(result.messages, [{ role: 'system', content: 'You are Aqua.' }]);
    assert.equal(result.sections[0].id, 'main');
    assert.equal(result.tokenTable.total, 5);
    assert.ok(result.caveats.includes(CAVEAT.NO_INTERCEPTORS));
    assert.deepEqual(context.chat, [], 'the example message must be removed afterwards');
    assert.equal(eventSource.count(EVENTS.GENERATE_AFTER_DATA), 0, 'listeners must be detached');
});

test('captureOnce assembles a text-completion prompt', async () => {
    const eventSource = makeEventSource();
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'textgenerationwebui',
        chat: [],
        name1: 'You',
        getTokenCountAsync: async text => String(text).length,
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.GENERATE_BEFORE_COMBINE_PROMPTS, {
                storyString: 'Aqua is a goddess.',
                mesSendString: 'You: hi',
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_COMBINE_PROMPTS, {
                prompt: 'Aqua is a goddess.You: hi',
                dryRun,
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, { prompt: 'Aqua is a goddess.You: hi' }, dryRun);
        },
    };
    globalThis.SillyTavern = { getContext: () => context };

    const result = await captureOnce({ userMessage: 'hi', context, host: null });
    assert.equal(result.apiType, 'tc');
    assert.equal(result.combinedPrompt, 'Aqua is a goddess.You: hi');
    assert.deepEqual(result.sections.map(section => section.id), ['storyString', 'mesSendString']);
});

test('captureOnce explains itself when no prompt arrives', async () => {
    const eventSource = makeEventSource();
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        promptManager: null,
        async generate() {},
    };
    await assert.rejects(
        () => captureOnce({ context, host: null }),
        /did not receive a prompt/,
    );
});

test('captureOnce refuses to run without the host generate function', async () => {
    await assert.rejects(
        () => captureOnce({ context: { chat: [] }, host: null }),
        /generate function is unavailable/,
    );
});

test('captureOnce detaches its listeners even when assembly throws', async () => {
    const eventSource = makeEventSource();
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        name1: 'You',
        async generate() {
            throw new Error('backend exploded');
        },
    };
    await assert.rejects(() => captureOnce({ userMessage: 'hi', context, host: null }), /backend exploded/);
    for (const type of Object.values(EVENTS)) {
        assert.equal(eventSource.count(type), 0, `${type} listener leaked after a failure`);
    }
    assert.deepEqual(context.chat, []);
});
