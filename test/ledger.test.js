import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { SETTINGS_KEY } from '../src/constants.js';
import { createLedger, isLedgerRecordingEnabled, setLedgerRecordingEnabled } from '../src/ledger.js';
import { migrateLedgerEntry, normalizeLedgerEntry } from '../src/schema.js';
import { summarizeLedger } from '../src/ui/ledger-tab.js';
import { __setStoreForTests, countLedger, createMemoryStore, listLedger } from '../src/storage.js';
import { installStubContext, removeStubContext } from './helpers/stub-context.js';

function makeEventSource() {
    const handlers = new Map();
    const add = (type, handler) => {
        if (!handlers.has(type)) {
            handlers.set(type, []);
        }
        handlers.get(type).push(handler);
    };
    return {
        on: add,
        makeLast: add,
        removeListener(type, handler) {
            handlers.set(type, (handlers.get(type) ?? []).filter(item => item !== handler));
        },
        async emit(type, ...args) {
            for (const handler of [...(handlers.get(type) ?? [])]) {
                await handler(...args);
            }
        },
        handlerCount() {
            return [...handlers.values()].reduce((total, list) => total + list.length, 0);
        },
    };
}

function ccNode(identifier, tokens, content) {
    return { identifier, getTokens: () => tokens, content };
}

let ctx;
let events;

beforeEach(() => {
    __setStoreForTests(createMemoryStore());
    events = makeEventSource();
    ({ ctx } = installStubContext({
        ctx: {
            eventSource: events,
            characterId: 0,
            characters: [{ name: 'Aqua', avatar: 'aqua.png' }],
            promptManager: {
                messages: {
                    getCollection: () => [
                        ccNode('main', 5, 'You are Aqua.'),
                        ccNode('chatHistory', 3, 'Hello there.'),
                    ],
                },
            },
        },
    }));
});

afterEach(() => {
    __setStoreForTests(null);
    removeStubContext();
});

test('records a real chat-completion send with per-section tokens', async () => {
    const ledger = createLedger();
    ledger.setEnabled(true);
    await events.emit('GENERATION_STARTED', 'normal', {}, false);
    await events.emit('GENERATE_AFTER_DATA', { prompt: [{ role: 'user', content: 'hi' }] }, false);
    await ledger.whenIdle();
    const entries = await listLedger();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.apiType, 'cc');
    assert.equal(entry.characterName, 'Aqua');
    assert.equal(entry.kind, 'normal');
    assert.equal(entry.total, 8);
    assert.deepEqual(
        entry.sections.map(section => [section.id, section.tokens]),
        [['main', 5], ['chatHistory', 3]],
    );
    ledger.dispose();
});

test('skips dry runs and its own detached state', async () => {
    const ledger = createLedger();
    ledger.setEnabled(true);
    await events.emit('GENERATION_STARTED', 'normal', {}, true);
    await events.emit('GENERATE_AFTER_DATA', { prompt: [{ role: 'user', content: 'hi' }] }, true);
    await ledger.whenIdle();
    assert.equal(await countLedger(), 0);

    ledger.setEnabled(false);
    assert.equal(events.handlerCount(), 0);
    await events.emit('GENERATION_STARTED', 'normal', {}, false);
    await events.emit('GENERATE_AFTER_DATA', { prompt: [{ role: 'user', content: 'hi' }] }, false);
    await ledger.whenIdle();
    assert.equal(await countLedger(), 0);
    ledger.dispose();
});

test('records a text-completion send from the before-combine sections', async () => {
    const ledger = createLedger();
    ledger.setEnabled(true);
    await events.emit('GENERATION_STARTED', 'quiet', {}, false);
    await events.emit('GENERATE_BEFORE_COMBINE_PROMPTS', {
        worldInfoBefore: 'lore text',
        mesSendString: 'chat text',
        ignored: 42,
    });
    // The CFG negative pass re-emits with different text; the first pass wins.
    await events.emit('GENERATE_BEFORE_COMBINE_PROMPTS', { worldInfoBefore: 'negative' });
    await events.emit('WORLDINFO_SCAN_DONE', {
        activated: { entries: new Set([{ world: 'Book', uid: 1 }, { world: 'Book', uid: 2 }]) },
    });
    await events.emit('WORLDINFO_SCAN_DONE', {
        activated: { entries: new Set([{ world: 'Book', uid: 2 }]) },
    });
    await events.emit('GENERATE_AFTER_DATA', { prompt: 'full prompt string' }, false);
    await ledger.whenIdle();
    const [entry] = await listLedger();
    assert.equal(entry.apiType, 'tc');
    assert.equal(entry.kind, 'quiet');
    assert.equal(entry.wiEntryCount, 2);
    assert.equal(entry.total, 'full prompt string'.length);
    assert.deepEqual(
        entry.sections.map(section => [section.id, section.tokens]),
        [['worldInfoBefore', 'lore text'.length], ['mesSendString', 'chat text'.length]],
    );
    ledger.dispose();
});

test('prunes recordings down to the retention setting', async () => {
    ctx.extensionSettings[SETTINGS_KEY] = { ledgerRetention: 10 };
    const ledger = createLedger();
    ledger.setEnabled(true);
    for (let index = 0; index < 12; index++) {
        await events.emit('GENERATION_STARTED', 'normal', {}, false);
        await events.emit('GENERATE_AFTER_DATA', { prompt: [{ role: 'user', content: 'hi' }] }, false);
        await ledger.whenIdle();
    }
    assert.equal(await countLedger(), 10);
    ledger.dispose();
});

test('the recording switch is stored per device in accountStorage', async () => {
    const data = new Map();
    ctx.accountStorage = {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
    };
    assert.equal(isLedgerRecordingEnabled(ctx), false);
    setLedgerRecordingEnabled(true, ctx);
    assert.equal(isLedgerRecordingEnabled(ctx), true);
    assert.equal(data.get('SBPromptingLab_ledgerEnabled'), 'true');
    assert.ok(!('ledgerEnabled' in (ctx.extensionSettings[SETTINGS_KEY] ?? {})));

    const ledger = createLedger();
    ledger.sync();
    assert.equal(ledger.isEnabled(), true);
    setLedgerRecordingEnabled(false, ctx);
    ledger.sync();
    assert.equal(ledger.isEnabled(), false);
    assert.equal(events.handlerCount(), 0);
    ledger.dispose();
});

test('normalizeLedgerEntry keeps counts and drops everything else', () => {
    const entry = normalizeLedgerEntry({
        id: 'x',
        at: '2026-08-11T00:00:00.000Z',
        apiType: 'weird',
        total: -5,
        sections: [
            { id: 'main', label: 'Main prompt', tokens: 3.7, content: 'secret text' },
            { label: 'no id', tokens: 4 },
        ],
        wiEntryCount: '2',
    });
    assert.equal(entry.apiType, 'cc');
    assert.equal(entry.total, 0);
    assert.equal(entry.wiEntryCount, 2);
    assert.deepEqual(entry.sections, [{ id: 'main', label: 'Main prompt', tokens: 3 }]);
    assert.equal(migrateLedgerEntry({ v: 999 }), null);
});

test('summarizeLedger averages totals and ranks sections by mean cost', () => {
    const summary = summarizeLedger([
        {
            total: 100,
            sections: [
                { id: 'chatHistory', label: 'Chat history', tokens: 80 },
                { id: 'main', label: 'Main prompt', tokens: 20 },
            ],
        },
        {
            total: 200,
            sections: [
                { id: 'chatHistory', label: 'Chat history', tokens: 180 },
                { id: 'main', label: 'Main prompt', tokens: 20 },
            ],
        },
        { total: 0, sections: [] },
    ]);
    assert.equal(summary.count, 3);
    assert.equal(summary.meanTotal, 150);
    assert.deepEqual(
        summary.sections.map(section => [section.id, section.mean]),
        [['chatHistory', 130], ['main', 20]],
    );
});
