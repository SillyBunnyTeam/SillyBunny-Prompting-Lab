import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { ASSERTION, CAVEAT, STATUS } = await import('../src/constants.js');
const { evaluateAssertions } = await import('../src/assertions.js');
const { resolveStatus } = await import('../src/schema.js');
const {
    captureOnce,
    createCaptureSession,
    readChatCompletionSections,
    readTextCompletionSections,
    withTransientMessages,
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
            const list = listeners.get(type) ?? [];
            list.push(handler);
            listeners.set(type, list);
        },
        makeLast(type, handler) {
            order.push(['makeLast', type]);
            const list = listeners.get(type) ?? [];
            const index = list.indexOf(handler);
            if (index !== -1) list.splice(index, 1);
            list.push(handler);
            listeners.set(type, list);
        },
        makeFirst(type, handler) {
            order.push(['makeFirst', type]);
            const list = listeners.get(type) ?? [];
            const index = list.indexOf(handler);
            if (index !== -1) list.splice(index, 1);
            list.unshift(handler);
            listeners.set(type, list);
        },
        removeListener(type, handler) {
            const list = listeners.get(type);
            const index = list?.indexOf(handler) ?? -1;
            if (index !== -1) list.splice(index, 1);
        },
        async emit(type, ...args) {
            for (const handler of [...(listeners.get(type) ?? [])]) {
                await handler(...args);
            }
        },
        count(type) {
            return listeners.get(type)?.length ?? 0;
        },
    };
}

const EVENTS = {
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
};

/** Minimal stand-ins for the host's Message / MessageCollection classes. */
function message(content, tokens, role = 'system', identifier = 'message') {
    return { role, identifier, content, getTokens: () => tokens };
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

test('withTransientMessages replays a whole exchange and takes all of it back out', async () => {
    const context = { chat: [{ mes: 'existing' }], name1: 'You', name2: 'Aqua' };
    let seen = [];
    await withTransientMessages(context, [
        { role: 'user', text: 'I open the door.' },
        { role: 'assistant', text: 'She looks up.' },
        { role: 'user', text: '"Who sent you?"' },
    ], async () => {
        seen = context.chat.map(entry => [entry.mes, entry.is_user, entry.name]);
    });

    assert.deepEqual(seen, [
        ['existing', undefined, undefined],
        ['I open the door.', true, 'You'],
        ['She looks up.', false, 'Aqua'],
        ['"Who sent you?"', true, 'You'],
    ]);
    assert.deepEqual(context.chat.map(entry => entry.mes), ['existing']);
});

test('withTransientMessages clears the exchange even when the build throws', async () => {
    const context = { chat: [], name1: 'You', name2: 'Aqua' };
    await assert.rejects(
        () => withTransientMessages(context, [
            { role: 'user', text: 'One' },
            { role: 'assistant', text: 'Two' },
        ], async () => {
            throw new Error('assembly failed');
        }),
        /assembly failed/,
    );
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
    const ownedSignal = new AbortController().signal;
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS }, ownedSignal);
    session.attach();
    await eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', { signal: ownedSignal }, true);
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

test('the capture session ignores a foreign dry-run generation', async () => {
    const eventSource = makeEventSource();
    const ownedSignal = new AbortController().signal;
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS }, ownedSignal);
    session.attach();

    await eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', {
        signal: new AbortController().signal,
    }, true);
    await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
        chat: [{ role: 'system', content: 'Foreign.' }],
        dryRun: true,
    });
    assert.equal(session.getState().ccMessages, null);

    await eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', { signal: ownedSignal }, true);
    await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
        chat: [{ role: 'system', content: 'Owned.' }],
        dryRun: true,
    });
    assert.deepEqual(session.getState().ccMessages, [{ role: 'system', content: 'Owned.' }]);
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

test('captured messages preserve complete protocol objects without mutating the event payload', async () => {
    const eventSource = makeEventSource();
    const session = createCaptureSession({ eventSource, eventTypes: EVENTS });
    session.attach();
    const payload = {
        chat: [{
            role: 'tool',
            content: [{ type: 'text', text: '4' }],
            tool_call_id: 'call-1',
            reasoning: 'reason',
            signature: 'sig',
            future_field: { nested: true },
        }],
        dryRun: true,
    };
    const before = structuredClone(payload);
    await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, payload);
    assert.deepEqual(payload, before);
    assert.deepEqual(session.getState().ccMessages, before.chat);
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
    assert.equal(passes.length, 3);
    assert.equal(passes[0][0].comment, 'Dragon');
    assert.equal(passes[1][0].uid, 2);
    // An empty pass is kept: a scan that activated nothing is a definite
    // answer, which is what lets an "entry activates" check fail rather than
    // come back unanswerable.
    assert.deepEqual(passes[2], []);
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

test('readTextCompletionSections counts the final combined prompt once for the total', async () => {
    const context = { getTokenCountAsync: async text => String(text).length };
    globalThis.SillyTavern = { getContext: () => context };
    const { tokenTable, estimated } = await readTextCompletionSections({
        storyString: 'abc',
        mesSendString: 'def',
    }, 'abc\ndef');
    assert.equal(tokenTable.total, 7);
    assert.equal(estimated, false);
});

test('readTextCompletionSections marks a summed total as estimated when final counting fails', async () => {
    const context = { getTokenCountAsync: async () => { throw new Error('no tokenizer'); } };
    globalThis.SillyTavern = { getContext: () => context };
    const { tokenTable, estimated } = await readTextCompletionSections({ storyString: 'abc' }, 'abc');
    assert.equal(tokenTable.total, 1);
    assert.equal(estimated, true);
});

test('readTextCompletionSections returns nothing when the pass was not seen', async () => {
    const { sections, tokenTable } = await readTextCompletionSections(null);
    assert.deepEqual(sections, []);
    assert.equal(tokenTable.total, 0);
});

test('captureOnce assembles a chat-completion prompt and reports isolation capabilities', async () => {
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
            await eventSource.emit(EVENTS.GENERATION_AFTER_COMMANDS, type, options, dryRun);
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
    assert.ok(result.caveats.includes(CAVEAT.LIVE_CHAT_DRY_RUN));
    assert.ok(result.caveats.includes(CAVEAT.MACRO_SANDBOX_UNAVAILABLE));
    assert.equal(result.capabilities.syntheticMessagesIsolated, false);
    assert.equal(result.capabilities.macroStateSandboxed, false);
    assert.equal(result.capabilities.finalPromptExact, false);
    assert.equal(result.metricsComplete, true);
    assert.equal(result.tokenTable.metricsComplete, true);
    const assertionResults = await evaluateAssertions([
        { type: ASSERTION.SECTION_PRESENT, section: 'main' },
    ], { capture: result });
    assert.equal(assertionResults[0].pass, true);
    assert.equal(resolveStatus({ assertionResults }), STATUS.PASS);
    assert.deepEqual(context.chat, [], 'the example message must be removed afterwards');
    assert.equal(eventSource.count(EVENTS.GENERATE_AFTER_DATA), 0, 'listeners must be detached');
});

test('captureOnce clears the send textarea and restores accessible macro state', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Final.', 2)])]);
    const textarea = {
        value: 'unsent draft',
        readOnly: false,
        selectionStart: 2,
        selectionEnd: 7,
        selectionDirection: 'forward',
        restoredSelection: null,
        events: 0,
        dispatchEvent() { this.events += 1; },
        setSelectionRange(...selection) { this.restoredSelection = selection; },
    };
    const previousDocument = globalThis.document;
    globalThis.document = { querySelector: selector => selector === '#send_textarea' ? textarea : null };
    let metadataSaves = 0;
    let settingsSaves = 0;
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        chatMetadata: {
            variables: { local: 'before' },
            MacroEnhanced: { chatVars: { mood: 'before' } },
        },
        extensionSettings: { variables: { global: { shared: 'before' } } },
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        async saveMetadata() { metadataSaves += 1; return true; },
        async saveSettings() { settingsSaves += 1; },
        async generate(type, options, dryRun) {
            assert.equal(dryRun, true);
            assert.equal(textarea.value, '');
            assert.equal(textarea.readOnly, true);
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            context.chatMetadata.variables.local = 'after';
            context.chatMetadata.MacroEnhanced.chatVars.mood = 'after';
            context.extensionSettings.variables.global.shared = 'after';
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Final.' }],
                dryRun,
            });
        },
    };
    try {
        const result = await captureOnce({ context });
        assert.equal(textarea.value, 'unsent draft');
        assert.equal(textarea.readOnly, false);
        assert.deepEqual(textarea.restoredSelection, [2, 7, 'forward']);
        assert.equal(textarea.events, 2);
        assert.deepEqual(context.chatMetadata.variables, { local: 'before' });
        assert.deepEqual(context.chatMetadata.MacroEnhanced.chatVars, { mood: 'before' });
        assert.deepEqual(context.extensionSettings.variables.global, { shared: 'before' });
        assert.equal(result.capabilities.localMacroStateRestored, true);
        assert.equal(result.capabilities.macroRollbackPersisted, true);
        assert.equal(metadataSaves, 1);
        assert.equal(settingsSaves, 1);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});

test('captureOnce records when changed macro state cannot be persisted', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Final.', 2)])]);
    let settingsSaveRequests = 0;
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        chatMetadata: { variables: { local: 'before' } },
        extensionSettings: { variables: { global: { shared: 'before' } } },
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        saveSettingsDebounced() { settingsSaveRequests += 1; },
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            context.chatMetadata.variables.local = 'after';
            context.extensionSettings.variables.global.shared = 'after';
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Final.' }],
                dryRun,
            });
        },
    };
    const result = await captureOnce({ context });
    assert.deepEqual(context.chatMetadata.variables, { local: 'before' });
    assert.deepEqual(context.extensionSettings.variables.global, { shared: 'before' });
    assert.equal(settingsSaveRequests, 1);
    assert.equal(result.capabilities.macroRollbackPersisted, false);
    assert.ok(result.caveats.includes(CAVEAT.MACRO_ROLLBACK_UNCONFIRMED));
});

test('captureOnce blocks a real generation, removes transients, and discards the capture', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Final.', 2)])]);
    const previousDocument = globalThis.document;
    const body = { dataset: {} };
    globalThis.document = { body, querySelector: () => null };
    let sendPressed = false;
    let realSawChat = null;
    let realEvent = null;
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        isGenerating: () => sendPressed,
        setSendButtonState(value) { sendPressed = value; },
        deactivateSendButtons() { body.dataset.generating = 'true'; },
        activateSendButtons() { delete body.dataset.generating; },
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            realEvent = eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', {}, false);
            await Promise.resolve();
            assert.equal(realSawChat, null, 'the real generation must still be blocked');
            await eventSource.emit(EVENTS.GENERATION_AFTER_COMMANDS, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Final.' }],
                dryRun,
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, {
                prompt: [{ role: 'system', content: 'Final.' }],
            }, dryRun);
        },
    };
    eventSource.on(EVENTS.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!dryRun) realSawChat = context.chat.map(entry => entry.mes);
    });
    try {
        await assert.rejects(
            () => captureOnce({ userMessage: 'synthetic', context }),
            /Another SillyBunny generation overlapped/,
        );
        await realEvent;
        assert.deepEqual(realSawChat, []);
        assert.equal(sendPressed, false);
        assert.equal(body.dataset.generating, undefined);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});

test('captureOnce blocks and discards a foreign extension dry run', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Owned.', 2)])]);
    const previousDocument = globalThis.document;
    const body = { dataset: {} };
    globalThis.document = { body, querySelector: () => null };
    let foreignEvent;
    let foreignContinued = false;
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        deactivateSendButtons() { body.dataset.generating = 'true'; },
        activateSendButtons() { delete body.dataset.generating; },
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            foreignEvent = eventSource.emit(EVENTS.GENERATION_STARTED, 'normal', {
                signal: new AbortController().signal,
            }, true).then(() => { foreignContinued = true; });
            await Promise.resolve();
            assert.equal(foreignContinued, false, 'the foreign dry run must wait for cleanup');
            await eventSource.emit(EVENTS.GENERATION_AFTER_COMMANDS, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Owned.' }],
                dryRun,
            });
        },
    };
    try {
        await assert.rejects(
            () => captureOnce({ userMessage: 'synthetic', context }),
            /Another SillyBunny generation overlapped/,
        );
        await foreignEvent;
        assert.equal(foreignContinued, true);
        assert.deepEqual(context.chat, []);
        assert.equal(body.dataset.generating, undefined);
        assert.equal(eventSource.count(EVENTS.GENERATION_STARTED), 0);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});

test('captureOnce fails closed when browser generation locking is unavailable', async () => {
    const previousDocument = globalThis.document;
    globalThis.document = { body: { dataset: {} }, querySelector: () => null };
    const context = {
        eventSource: makeEventSource(),
        eventTypes: EVENTS,
        chat: [],
        async generate() {},
    };
    try {
        await assert.rejects(() => captureOnce({ userMessage: 'synthetic', context }), /generation lock APIs/);
        assert.deepEqual(context.chat, []);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});

test('captureOnce does not overwrite textarea input changed during capture', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Final.', 2)])]);
    const textarea = {
        value: 'old draft',
        readOnly: false,
        events: 0,
        dispatchEvent() { this.events += 1; },
    };
    const previousDocument = globalThis.document;
    globalThis.document = { querySelector: selector => selector === '#send_textarea' ? textarea : null };
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        async generate(type, options, dryRun) {
            assert.equal(textarea.readOnly, true);
            textarea.value = 'new draft';
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Final.' }],
                dryRun,
            });
        },
    };
    try {
        await captureOnce({ context });
        assert.equal(textarea.value, 'new draft');
        assert.equal(textarea.readOnly, false);
        assert.equal(textarea.events, 1);
    } finally {
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});

test('captureOnce marks section metrics incomplete after a final interceptor rewrite', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Before.', 2)])]);
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        extensionSettings: {},
        chatMetadata: {},
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'After.' }],
                dryRun,
            });
        },
    };
    const result = await captureOnce({ context });
    assert.equal(result.metricsComplete, false);
    assert.ok(result.caveats.includes(CAVEAT.FINAL_METRICS_INCOMPLETE));
    assert.equal(result.sections.at(-1).id, 'finalInterceptors');
    assert.equal(result.sections.at(-1).content, 'After.');
    const assertionResults = await evaluateAssertions([
        { type: ASSERTION.SECTION_PRESENT, section: 'main' },
    ], { capture: result });
    assert.equal(assertionResults[0].pass, null);
    assert.equal(resolveStatus({ assertionResults }), STATUS.UNCHECKED);
});

test('captureOnce fills missing event metadata from the authoritative live context', async () => {
    const eventSource = makeEventSource();
    const root = collection('root', [collection('main', [message('Final.', 2)])]);
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'openai',
        chat: [],
        extensionSettings: {},
        chatMetadata: {},
        name1: 'Kazuma',
        name2: 'Aqua',
        chatCompletionSettings: { use_sysprompt: false, assistant_prefill: 'Live prefill' },
        isToolCallingSupported: () => false,
        promptManager: { messages: root, tokenHandler: { counts: {} } },
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.CHAT_COMPLETION_PROMPT_READY, {
                chat: [{ role: 'system', content: 'Final.' }],
                dryRun,
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, {
                prompt: [{ role: 'system', content: 'Final.' }],
            }, dryRun);
        },
    };
    const result = await captureOnce({ context });
    assert.equal(result.cacheScope, 'main');
    assert.equal(result.useSysPrompt, false);
    assert.equal(result.useTools, false);
    assert.equal(result.prefillString, 'Live prefill');
    assert.deepEqual(result.promptNames, { charName: 'Aqua', userName: 'Kazuma', groupNames: [] });
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

test('text-completion identity uses the final outbound GENERATE_AFTER_DATA prompt', async () => {
    const eventSource = makeEventSource();
    const context = {
        eventSource,
        eventTypes: EVENTS,
        mainApi: 'textgenerationwebui',
        chat: [],
        extensionSettings: {},
        chatMetadata: {},
        async generate(type, options, dryRun) {
            await eventSource.emit(EVENTS.GENERATION_STARTED, type, options, dryRun);
            await eventSource.emit(EVENTS.GENERATE_AFTER_COMBINE_PROMPTS, {
                prompt: 'before adapter',
                dryRun,
            });
            await eventSource.emit(EVENTS.GENERATE_AFTER_DATA, { prompt: 'final outbound' }, dryRun);
        },
    };
    const result = await captureOnce({ context });
    assert.equal(result.combinedPrompt, 'final outbound');
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
