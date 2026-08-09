import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CC_API_ID,
    GLOBAL_PROMPT_ORDER_ID,
    MODE,
    addPromptModule,
    apiIdsForMode,
    canonicalJson,
    canEditPrompt,
    canRemovePrompt,
    describePresetRef,
    fingerprint,
    getPromptOrder,
    isReservedPrompt,
    listPromptModules,
    modeOf,
    movePromptModule,
    removePromptModule,
    reviewConnectionFields,
    setPromptModuleEnabled,
    updatePromptModule,
    validatePresetPayload,
    withCanonicalName,
    withPromptOrder,
    withoutFields,
} from '../src/presets.js';

function ccPreset() {
    return {
        prompts: [
            { identifier: 'main', name: 'Main', content: 'Hello' },
            { identifier: 'jailbreak', name: 'Jailbreak', content: 'Stay in character' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
        ],
        prompt_order: [
            { character_id: 5, order: [{ identifier: 'main', enabled: true }] },
            {
                character_id: GLOBAL_PROMPT_ORDER_ID,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'jailbreak', enabled: false },
                    { identifier: 'chatHistory', enabled: true },
                ],
            },
        ],
    };
}

test('modes map to the preset types SillyBunny actually keeps apart', () => {
    assert.equal(modeOf(CC_API_ID), MODE.CC);
    assert.equal(modeOf('instruct'), MODE.TC);
    assert.deepEqual(apiIdsForMode(MODE.CC), ['openai']);
    assert.deepEqual(apiIdsForMode(MODE.TC), ['textgenerationwebui', 'context', 'instruct', 'sysprompt', 'reasoning']);
    assert.equal(describePresetRef({ apiId: 'instruct', name: 'ChatML' }), 'Instruct template: ChatML');
    assert.equal(describePresetRef({ apiId: 'instruct', name: '' }), '');
});

test('the global prompt order is the one the prompt is built from', () => {
    const order = getPromptOrder(ccPreset());
    assert.deepEqual(order.map(entry => entry.identifier), ['main', 'jailbreak', 'chatHistory']);
});

test('listPromptModules follows the order, then reports prompts left out of it', () => {
    const payload = ccPreset();
    payload.prompts.push({ identifier: 'unused', name: 'Unused' });
    const modules = listPromptModules(payload);
    assert.deepEqual(modules.map(item => item.prompt.identifier), ['main', 'jailbreak', 'chatHistory', 'unused']);
    assert.equal(modules[1].enabled, false);
    assert.equal(modules[3].inOrder, false);
});

test('moving a module rewrites only the global order', () => {
    const moved = movePromptModule(ccPreset(), 'jailbreak', -1);
    assert.deepEqual(getPromptOrder(moved).map(entry => entry.identifier), ['jailbreak', 'main', 'chatHistory']);
    assert.deepEqual(
        moved.prompt_order.find(entry => entry.character_id === 5).order.map(item => item.identifier),
        ['main'],
    );
});

test('moving past either end leaves the order alone', () => {
    const same = movePromptModule(ccPreset(), 'main', -1);
    assert.deepEqual(getPromptOrder(same).map(entry => entry.identifier), ['main', 'jailbreak', 'chatHistory']);
});

test('enabling, adding, updating and removing modules keep the pair in step', () => {
    let payload = setPromptModuleEnabled(ccPreset(), 'jailbreak', true);
    assert.equal(getPromptOrder(payload).find(entry => entry.identifier === 'jailbreak').enabled, true);

    payload = addPromptModule(payload, { identifier: 'extra', name: 'Extra', content: 'More' });
    assert.equal(getPromptOrder(payload).at(-1).identifier, 'extra');

    payload = updatePromptModule(payload, 'extra', { content: 'Changed' });
    assert.equal(payload.prompts.find(prompt => prompt.identifier === 'extra').content, 'Changed');
    assert.equal(payload.prompts.find(prompt => prompt.identifier === 'extra').name, 'Extra');

    payload = removePromptModule(payload, 'extra');
    assert.equal(payload.prompts.some(prompt => prompt.identifier === 'extra'), false);
    assert.equal(getPromptOrder(payload).some(entry => entry.identifier === 'extra'), false);
});

test('withPromptOrder adds the global entry when a preset has none', () => {
    const payload = withPromptOrder({ prompts: [] }, [{ identifier: 'main', enabled: true }]);
    assert.deepEqual(payload.prompt_order, [
        { character_id: GLOBAL_PROMPT_ORDER_ID, order: [{ identifier: 'main', enabled: true }] },
    ]);
});

test('reserved identity is separate from PromptManager edit and remove rules', () => {
    assert.equal(isReservedPrompt({ marker: true }), true);
    assert.equal(isReservedPrompt({ system_prompt: true }), true);
    assert.equal(isReservedPrompt({ identifier: 'custom' }), false);
    assert.equal(canEditPrompt({ marker: true }), false);
    assert.equal(canRemovePrompt({ marker: true }), true);
    assert.equal(canEditPrompt({ system_prompt: true }), true);
    assert.equal(canRemovePrompt({ system_prompt: true }), false);
});

test('markers cannot be edited and system prompts cannot be removed', () => {
    const payload = ccPreset();
    payload.prompts.push({ identifier: 'system', name: 'System', content: 'Built in', system_prompt: true });
    getPromptOrder(payload).push({ identifier: 'system', enabled: true });

    assert.deepEqual(updatePromptModule(payload, 'chatHistory', { content: 'Changed' }), payload);
    const withoutMarker = removePromptModule(payload, 'chatHistory');
    assert.equal(withoutMarker.prompts.some(prompt => prompt.identifier === 'chatHistory'), false);

    const updatedSystem = updatePromptModule(payload, 'system', { content: 'Changed' });
    assert.equal(updatedSystem.prompts.find(prompt => prompt.identifier === 'system').content, 'Changed');
    assert.deepEqual(removePromptModule(payload, 'system'), payload);

    const disabled = setPromptModuleEnabled(payload, 'chatHistory', false);
    assert.equal(getPromptOrder(disabled).find(item => item.identifier === 'chatHistory').enabled, false);
    const moved = movePromptModule(payload, 'chatHistory', -1);
    assert.notDeepEqual(getPromptOrder(moved), getPromptOrder(payload));
});

test('validation names the damage instead of failing silently', () => {
    assert.deepEqual(validatePresetPayload('openai', ccPreset()), []);
    assert.deepEqual(validatePresetPayload('nonsense', {}), ['This preset type is not supported.']);
    assert.deepEqual(validatePresetPayload('openai', 'text'), ['The preset must be a set of settings.']);
    assert.deepEqual(
        validatePresetPayload('openai', { prompts: [{ identifier: 'a' }, { identifier: 'a' }] }),
        ['Two prompts share the identifier "a".'],
    );
    assert.deepEqual(
        validatePresetPayload('openai', {
            prompts: [],
            prompt_order: [{ character_id: GLOBAL_PROMPT_ORDER_ID, order: [{ identifier: 'gone' }] }],
        }),
        ['The order refers to a prompt that is missing: "gone".'],
    );
});

test('connection review lists secrets first and skips empty settings', () => {
    const review = reviewConnectionFields('openai', {
        reverse_proxy: 'https://proxy.example',
        proxy_password: '',
        openai_model: 'gpt-4',
        temperature: 0.7,
    });
    assert.deepEqual(review.map(entry => entry.field), ['reverse_proxy', 'openai_model']);
    assert.equal(review[0].sensitive, true);
    assert.equal(review[1].sensitive, false);
    assert.deepEqual(reviewConnectionFields('instruct', { reverse_proxy: 'x' }), []);
});

test('withoutFields copies the preset instead of editing it', () => {
    const payload = { reverse_proxy: 'x', temperature: 1 };
    const stripped = withoutFields(payload, ['reverse_proxy']);
    assert.deepEqual(stripped, { temperature: 1 });
    assert.equal(payload.reverse_proxy, 'x');
});

test('formatting presets carry the saved name inside the file', () => {
    assert.deepEqual(withCanonicalName('instruct', { wrap: true }, 'My template'), { wrap: true, name: 'My template' });
    assert.deepEqual(withCanonicalName('openai', { temperature: 1 }, 'My preset'), { temperature: 1 });
});

test('the fingerprint ignores key order so a reordered file is not a change', async () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    const one = await fingerprint({ b: 1, a: 2 });
    const two = await fingerprint({ a: 2, b: 1 });
    const other = await fingerprint({ a: 2, b: 3 });
    assert.equal(one, two);
    assert.notEqual(one, other);
});
