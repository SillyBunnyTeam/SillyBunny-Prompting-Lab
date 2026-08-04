import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { PROMPT_DRAFT_VERSION } = await import('../src/constants.js');
const {
    createPromptDraft,
    migratePromptDraft,
    normalizePromptDraft,
    validatePromptDraft,
} = await import('../src/schema.js');
const {
    addVersion,
    draftToModule,
    getSelectedVersion,
    moduleToDraft,
    pastePromptModule,
    removeVersion,
    selectVersion,
    updateVersion,
} = await import('../src/prompt-drafts.js');
const { getPromptOrder, listPromptModules } = await import('../src/presets.js');
const storage = await import('../src/storage.js');

test.after(() => removeStubContext());

/* ------------------------------------------------------------- schema */

test('createPromptDraft starts with one selected draft version', () => {
    const draft = createPromptDraft({ title: 'Greeting' });
    assert.equal(draft.v, PROMPT_DRAFT_VERSION);
    assert.equal(draft.title, 'Greeting');
    assert.equal(draft.role, 'system');
    assert.equal(draft.versions.length, 1);
    assert.equal(draft.selectedVersionId, draft.versions[0].id);
});

test('a prompt draft with no versions is repaired rather than left empty', () => {
    const draft = normalizePromptDraft({ title: 'Bare', versions: [] });
    assert.equal(draft.versions.length, 1);
    assert.equal(draft.selectedVersionId, draft.versions[0].id);
});

test('a stale selected version falls back to the first version', () => {
    const draft = normalizePromptDraft({
        versions: [{ id: 'a', label: 'One', content: 'x' }],
        selectedVersionId: 'gone',
    });
    assert.equal(draft.selectedVersionId, 'a');
});

test('an unknown role becomes system', () => {
    assert.equal(normalizePromptDraft({ role: 'wizard' }).role, 'system');
    assert.equal(normalizePromptDraft({ role: 'assistant' }).role, 'assistant');
});

test('a prompt draft from a newer version is refused', () => {
    assert.equal(migratePromptDraft({ v: PROMPT_DRAFT_VERSION + 1 }), null);
    assert.ok(migratePromptDraft({ v: PROMPT_DRAFT_VERSION, title: 'ok' }));
});

test('validation asks for a title and distinct version labels', () => {
    assert.ok(validatePromptDraft({ title: '   ' }).some(text => /title/i.test(text)));
    const clash = {
        title: 'Fine',
        versions: [
            { id: 'a', label: 'Draft', content: '' },
            { id: 'b', label: 'draft', content: '' },
        ],
    };
    assert.ok(validatePromptDraft(clash).some(text => /share the label/.test(text)));
    assert.deepEqual(validatePromptDraft(createPromptDraft({ title: 'Fine' })), []);
});

/* ----------------------------------------------------------- versions */

test('addVersion starts from the selected text and selects the new draft', () => {
    let draft = createPromptDraft({ title: 'Greeting' });
    draft = updateVersion(draft, draft.selectedVersionId, { content: 'Be kind.' });
    draft = addVersion(draft);
    assert.equal(draft.versions.length, 2);
    assert.equal(getSelectedVersion(draft).content, 'Be kind.');
    assert.equal(draft.versions[1].id, draft.selectedVersionId);
    assert.equal(draft.versions[1].label, 'Draft 2');
});

test('addVersion can carry its own label and content', () => {
    const draft = addVersion(createPromptDraft({}), { label: 'Terse', content: 'Short.' });
    assert.equal(getSelectedVersion(draft).label, 'Terse');
    assert.equal(getSelectedVersion(draft).content, 'Short.');
});

test('updateVersion cannot change a version id', () => {
    const draft = createPromptDraft({});
    const versionId = draft.selectedVersionId;
    const next = updateVersion(draft, versionId, { id: 'hijack', content: 'x' });
    assert.equal(next.versions[0].id, versionId);
    assert.equal(next.versions[0].content, 'x');
});

test('the last version cannot be removed', () => {
    const draft = createPromptDraft({});
    assert.equal(removeVersion(draft, draft.selectedVersionId).versions.length, 1);
});

test('removing the selected version selects another one', () => {
    let draft = addVersion(createPromptDraft({}), { content: 'b' });
    const removedId = draft.selectedVersionId;
    draft = removeVersion(draft, removedId);
    assert.equal(draft.versions.length, 1);
    assert.notEqual(draft.selectedVersionId, removedId);
    assert.equal(draft.selectedVersionId, draft.versions[0].id);
});

test('selecting an unknown version changes nothing', () => {
    const draft = createPromptDraft({});
    assert.equal(selectVersion(draft, 'missing').selectedVersionId, draft.selectedVersionId);
});

/* ------------------------------------------- prompts <-> preset modules */

test('draftToModule carries the title, role, and selected text', () => {
    let draft = createPromptDraft({ title: 'Tone', role: 'assistant' });
    draft = updateVersion(draft, draft.selectedVersionId, { content: 'Stay dry.' });
    const module = draftToModule(draft);
    assert.equal(module.name, 'Tone');
    assert.equal(module.role, 'assistant');
    assert.equal(module.content, 'Stay dry.');
    assert.notEqual(draftToModule(draft).identifier, module.identifier, 'each send mints a fresh identifier');
});

test('moduleToDraft keeps the module text and names its source', () => {
    const draft = moduleToDraft(
        { identifier: 'x', name: 'Style', role: 'user', content: 'Write short.' },
        { sourceName: 'My preset' },
    );
    assert.equal(draft.title, 'Style');
    assert.equal(draft.role, 'user');
    assert.equal(getSelectedVersion(draft).content, 'Write short.');
    assert.match(draft.notes, /My preset/);
});

/* ---------------------------------------------------------------- paste */

function ccPayload() {
    return {
        prompts: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'Be helpful.' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
        ],
        prompt_order: [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
            ],
        }],
    };
}

test('pasting an ordinary prompt mints a fresh identifier and appends it', () => {
    const source = { identifier: 'main', name: 'Main', role: 'system', content: 'Be helpful.' };
    const { payload, problem } = pastePromptModule(ccPayload(), source);
    assert.equal(problem, null);
    const modules = listPromptModules(payload);
    assert.equal(modules.length, 3);
    const pasted = modules[2].prompt;
    assert.equal(pasted.name, 'Main');
    assert.notEqual(pasted.identifier, 'main');
    const order = getPromptOrder(payload);
    assert.equal(order[2].identifier, pasted.identifier);
});

test('a host-filled module is not pasted twice into the same preset', () => {
    const marker = { identifier: 'chatHistory', name: 'Chat History', marker: true };
    const { payload, problem } = pastePromptModule(ccPayload(), marker);
    assert.match(problem, /already has/);
    assert.equal(listPromptModules(payload).length, 2, 'the payload is unchanged');
});

test('a host-filled module keeps its identifier when the preset lacks it', () => {
    const marker = { identifier: 'worldInfoBefore', name: 'World Info', marker: true };
    const { payload, problem } = pastePromptModule(ccPayload(), marker);
    assert.equal(problem, null);
    assert.ok(listPromptModules(payload).some(module => module.prompt.identifier === 'worldInfoBefore'));
});

test('pasting with an empty clipboard is refused in plain language', () => {
    const { problem } = pastePromptModule(ccPayload(), null);
    assert.match(problem, /no copied prompt/i);
});

/* -------------------------------------------------------------- storage */

test('prompt drafts round-trip through storage', async () => {
    storage.__setStoreForTests(storage.createMemoryStore());
    const saved = await storage.savePromptDraft(createPromptDraft({ title: 'Greeting' }));
    const loaded = await storage.getPromptDraft(saved.id);
    assert.equal(loaded.title, 'Greeting');
    assert.deepEqual((await storage.listPromptDrafts()).map(item => item.id), [saved.id]);
    await storage.deletePromptDraft(saved.id);
    assert.deepEqual(await storage.listPromptDrafts(), []);
    assert.equal(await storage.getPromptDraft(saved.id), null);
});
