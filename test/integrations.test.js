import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { collectIntegrations } = await import('../src/integrations/index.js');
const { isPromptTagsAvailable, listPromptTagsProfiles, readPromptTags } = await import('../src/integrations/prompttags.js');
const { macroConfigDiffers, readMacroEnhanced } = await import('../src/integrations/macroenhanced.js');
const { CLASS_STABLE, CLASS_STATE, classifyName } = await import('../src/vendor/volatility.js');

test.after(() => removeStubContext());

function contextWith(extensionSettings, extras = {}) {
    return {
        extensionSettings,
        characterId: 0,
        characters: [{ avatar: 'aqua.png', data: { extensions: {} } }],
        chatMetadata: {},
        ...extras,
    };
}

/* ------------------------------------------------------------ prompt tags */

test('Prompt Tags is reported as absent when it is not installed', () => {
    const context = contextWith({});
    assert.equal(isPromptTagsAvailable(context), false);
    assert.equal(readPromptTags(context), null);
    assert.deepEqual(listPromptTagsProfiles(context), []);
});

test('Prompt Tags is unavailable when the host has disabled the extension', () => {
    const context = contextWith({
        disabledExtensions: ['third-party/SillyBunny-PromptTags'],
        promptTags: { enabled: true, profiles: {} },
    });
    assert.equal(isPromptTagsAvailable(context), false);
    assert.equal(readPromptTags(context).enabled, false);
});

test('the active Prompt Tags profile and its wrapped sections are recorded', () => {
    const context = contextWith({
        promptTags: {
            enabled: true,
            activeProfile: 'Tagged',
            activeProfileId: 'uuid-1',
            profiles: {
                Tagged: {
                    id: 'uuid-1',
                    rules: {
                        charDescription: { enabled: true, tag: 'char' },
                        worldInfoBefore: { enabled: false, tag: 'lore' },
                        main: { enabled: true, tag: 'system' },
                    },
                },
            },
        },
    });
    const recorded = readPromptTags(context);
    assert.equal(recorded.profileName, 'Tagged');
    assert.equal(recorded.profileId, 'uuid-1');
    assert.equal(recorded.enabled, true);
    assert.deepEqual(recorded.enabledSections, ['charDescription', 'main']);
});

test('Prompt Tags profiles can be listed for the case editor', () => {
    const context = contextWith({
        promptTags: { profiles: { A: { id: '1' }, B: { id: '2' } } },
    });
    assert.deepEqual(listPromptTagsProfiles(context), [
        { name: 'A', id: '1' },
        { name: 'B', id: '2' },
    ]);
});

test('a Prompt Tags blob with no active profile is still readable', () => {
    const recorded = readPromptTags(contextWith({ promptTags: { enabled: false, profiles: {} } }));
    assert.equal(recorded.enabled, false);
    assert.equal(recorded.profileName, '');
    assert.deepEqual(recorded.enabledSections, []);
});

test('Prompt Tags reports the effective scoped profile, not only the global one', () => {
    const recorded = readPromptTags(contextWith({
        promptTags: {
            enabled: true,
            activeProfile: 'Global',
            activeProfileId: 'one',
            profiles: {
                Global: { id: 'one', rules: {} },
                Chat: { id: 'two', rules: { main: { enabled: true } } },
            },
        },
    }, {
        chatMetadata: { promptTags: { profileId: 'two' } },
    }));
    assert.equal(recorded.profileName, 'Chat');
    assert.equal(recorded.profileId, 'two');
    assert.equal(recorded.scope, 'chat');
    assert.deepEqual(recorded.enabledSections, ['main']);
});

/* --------------------------------------------------------- macro enhanced */

test('Macro Enhanced is reported as absent when it is not installed', () => {
    assert.equal(readMacroEnhanced(contextWith({})), null);
});

test('macro configuration is recorded across all three scopes', () => {
    const context = contextWith(
        {
            MacroEnhanced: {
                settingsVersion: 3,
                compatExpressions: true,
                auditor: { manualCachingAtDepth: 2 },
                customMacros: [
                    { name: 'greeting', template: 'hello', enabled: true },
                    { name: 'disabled', template: 'x', enabled: false },
                ],
            },
        },
        {
            characters: [{
                avatar: 'aqua.png',
                data: { extensions: { MacroEnhanced: { customMacros: [{ name: 'cardMacro', template: 'c' }] } } },
            }],
            chatMetadata: {
                MacroEnhanced: {
                    customMacros: [{ name: 'chatMacro', template: 'z' }],
                    frozen: { mood: {} },
                    sticky: {},
                    daily: { quest: {} },
                    rolls: { luck: {} },
                    chatVars: { arc: 'two' },
                },
            },
        },
    );

    const recorded = readMacroEnhanced(context);
    assert.equal(recorded.settingsVersion, 3);
    assert.equal(recorded.compatExpressions, true);
    assert.equal(recorded.manualCachingAtDepth, 2);
    assert.deepEqual(recorded.globalMacros, [{ name: 'greeting', template: 'hello', args: [] }]);
    assert.deepEqual(recorded.characterMacros, [{ name: 'cardMacro', template: 'c', args: [] }]);
    assert.deepEqual(recorded.chatMacros, [{ name: 'chatMacro', template: 'z', args: [] }]);
    assert.deepEqual(recorded.frozenKeys, ['mood']);
    assert.deepEqual(recorded.dailyKeys, ['quest']);
    assert.deepEqual(recorded.rollKeys, ['luck']);
    assert.deepEqual(recorded.chatVarNames, ['arc']);
    assert.equal(recorded.chatVarValues[0].key, 'arc');
    assert.match(recorded.chatVarValues[0].hash, /^[0-9a-f]{8}$/);
});

test('macro names are recorded in a stable order so a reorder is not a change', () => {
    const first = readMacroEnhanced(contextWith({
        MacroEnhanced: { customMacros: [{ name: 'b', template: '2' }, { name: 'a', template: '1' }] },
    }));
    const second = readMacroEnhanced(contextWith({
        MacroEnhanced: { customMacros: [{ name: 'a', template: '1' }, { name: 'b', template: '2' }] },
    }));
    assert.equal(macroConfigDiffers(first, second), false);
});

test('a changed macro template is reported as a difference', () => {
    const before = readMacroEnhanced(contextWith({
        MacroEnhanced: { customMacros: [{ name: 'a', template: 'one' }] },
    }));
    const after = readMacroEnhanced(contextWith({
        MacroEnhanced: { customMacros: [{ name: 'a', template: 'two' }] },
    }));
    assert.equal(macroConfigDiffers(before, after), true);
});

test('macro argument definitions and state values affect the fingerprint', () => {
    const before = readMacroEnhanced(contextWith({
        MacroEnhanced: {
            customMacros: [{
                name: 'greet',
                template: 'Hello {{who}}',
                args: [{ name: 'who', optional: true, defaultValue: 'friend' }],
            }],
        },
    }, {
        chatMetadata: { MacroEnhanced: { chatVars: { mood: 'calm' } } },
    }));
    const after = readMacroEnhanced(contextWith({
        MacroEnhanced: {
            customMacros: [{
                name: 'greet',
                template: 'Hello {{who}}',
                args: [{ name: 'who', optional: true, defaultValue: 'stranger' }],
            }],
        },
    }, {
        chatMetadata: { MacroEnhanced: { chatVars: { mood: 'angry' } } },
    }));
    assert.equal(macroConfigDiffers(before, after), true);
});

test('vendored volatility rules include current pronoun macros', () => {
    assert.equal(classifyName('setpronouns').cls, CLASS_STATE);
    assert.equal(classifyName('charpronouns').cls, CLASS_STABLE);
});

test('macroConfigDiffers copes with one side missing', () => {
    assert.equal(macroConfigDiffers(null, null), false);
    assert.equal(macroConfigDiffers({ a: 1 }, null), true);
});

/* --------------------------------------------------------------- combined */

test('collectIntegrations records both neighbours without caveating optional absence', async () => {
    const context = contextWith({
        promptTags: { activeProfile: 'Tagged', profiles: { Tagged: { id: '1', rules: {} } } },
    });
    const collected = await collectIntegrations(context);
    assert.equal(collected.promptTags.profileName, 'Tagged');
    assert.equal(collected.macroEnhanced, null);
    assert.deepEqual(collected.caveats, []);
});

test('collectIntegrations is quiet when both neighbours are installed', async () => {
    const context = contextWith({
        promptTags: { activeProfile: 'A', profiles: { A: { id: '1', rules: {} } } },
        MacroEnhanced: { settingsVersion: 3, customMacros: [] },
    });
    const collected = await collectIntegrations(context);
    assert.deepEqual(collected.caveats, []);
    assert.ok(collected.macroEnhanced);
});

test('collectIntegrations works when neither neighbour is installed', async () => {
    const collected = await collectIntegrations(contextWith({}));
    assert.equal(collected.promptTags, null);
    assert.equal(collected.macroEnhanced, null);
});
