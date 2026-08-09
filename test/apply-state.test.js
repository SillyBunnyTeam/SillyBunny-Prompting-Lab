import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const {
    applyCase,
    canRestoreProfileOverride,
    findCharacterIndex,
    getCharacterAvatar,
    getPresetName,
    getProfileById,
    hasUnsavedPresetEdits,
    normalizeApiId,
    quoteSlashArg,
    resolveProfile,
    restoreState,
    snapshotState,
    waitForEvent,
    willCreateChatFile,
} = await import('../src/apply-state.js');

test.after(() => removeStubContext());

/** Host stand-in that records every command and switch it is asked to make. */
function makeHost({ characterId = 0, profiles = [], selectedProfile = 'p1', presets = {}, mainApi = 'openai' } = {}) {
    profiles = profiles.map(profile => ({
        mode: profile.mode ?? (profile.mainApi && profile.mainApi !== 'openai' ? 'tc' : 'cc'),
        ...profile,
    }));
    const commands = [];
    const listeners = new Map();
    const presetState = { ...presets };
    const connectionState = { api: mainApi, proxy: 'None' };
    const presetField = {
        openai: 'preset',
        textgenerationwebui: 'preset',
        context: 'context',
        instruct: 'instruct',
        sysprompt: 'sysprompt',
        reasoning: 'reasoning-template',
    };
    const context = {
        commands,
        connectionState,
        characterId,
        characters: [
            { avatar: 'aqua.png', name: 'Aqua' },
            { avatar: 'megumin.png', name: 'Megumin' },
        ],
        chatId: 'chat-1',
        userAvatar: 'user-a.png',
        mainApi,
        name1: 'You',
        extensionSettings: {
            connectionManager: { profiles, selectedProfile },
        },
        eventSource: {
            once(type, handler) {
                listeners.set(type, handler);
            },
            emit(type) {
                listeners.get(type)?.();
                listeners.delete(type);
            },
            removeListener(type, handler) {
                if (listeners.get(type) === handler) {
                    listeners.delete(type);
                }
            },
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
        },
        async selectCharacterById(index) {
            commands.push(`select:${index}`);
            context.characterId = index;
            // The host raises CHAT_CHANGED as part of the switch.
            context.eventSource.emit('chat_changed');
            return true;
        },
        async executeSlashCommandsWithOptions(command) {
            commands.push(command);
            if (command.startsWith('/profile')) {
                const name = command.match(/"(.*)"/)?.[1] ?? '';
                const profile = profiles.find(item => item.name === name);
                context.extensionSettings.connectionManager.selectedProfile = profile?.id ?? '';
                applyProfileValues(profile);
                context.eventSource.emit('connection_profile_loaded');
            }
            if (command.startsWith('/persona-set')) {
                context.userAvatar = command.match(/"(.*)"/)?.[1] ?? context.userAvatar;
            }
            if (command.startsWith('/prompttags-profile')) {
                const name = command.match(/"(.*)"/)?.[1] ?? '';
                const profile = context.extensionSettings.promptTags?.profiles?.[name];
                if (profile) {
                    context.extensionSettings.promptTags.activeProfile = name;
                    context.extensionSettings.promptTags.activeProfileId = profile.id;
                }
            }
            if (command.startsWith('/prompttags ')) {
                context.extensionSettings.promptTags.enabled = command.endsWith('on');
            }
            return { pipe: '' };
        },
        getPresetManager(apiId) {
            return {
                _dirty: false,
                _checkDirty() {},
                getSelectedPresetName: () => presetState[apiId] ?? '',
                getSelectedPreset: () => presetState[apiId] ? `value:${presetState[apiId]}` : '',
                findPreset: name => (name === 'Missing preset' ? '' : `value:${name}`),
                async selectPreset(value) {
                    commands.push(`preset:${apiId}:${value}`);
                    presetState[apiId] = String(value).replace('value:', '');
                    if (presetField[apiId]) {
                        connectionState[presetField[apiId]] = presetState[apiId];
                    }
                },
            };
        },
        SlashCommandParser: {
            commands: new Proxy({}, {
                get(_target, field) {
                    return {
                        async callback(args, value) {
                            if (args?._hasUnnamedArgument) {
                                connectionState[field] = String(value ?? '');
                                if (field === 'api') {
                                    context.mainApi = value === 'textgenerationwebui' ? 'textgenerationwebui' : 'openai';
                                }
                            }
                            return connectionState[field] ?? '';
                        },
                    };
                },
            }),
        },
    };

    function applyProfileValues(profile) {
        if (!profile) {
            return;
        }
        context.mainApi = profile.mainApi ?? (profile.mode === 'cc' ? 'openai' : 'textgenerationwebui');
        for (const [field, value] of Object.entries(profile)) {
            if (['id', 'name', 'mode', 'exclude', 'folderId', 'fav', 'mainApi'].includes(field)
                || profile.exclude?.includes(field)) {
                continue;
            }
            connectionState[field] = String(value);
        }
        if (profile.mode === 'cc' && !profile.exclude?.includes('proxy') && !profile.proxy) {
            connectionState.proxy = 'None';
        }
    }

    applyProfileValues(profiles.find(profile => profile.id === selectedProfile));
    for (const [apiId, name] of Object.entries(presetState)) {
        if (presetField[apiId]) {
            connectionState[presetField[apiId]] = name;
        }
    }
    return context;
}

test('quoteSlashArg escapes quotes, backslashes and newlines', () => {
    assert.equal(quoteSlashArg('plain'), '"plain"');
    assert.equal(quoteSlashArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteSlashArg('a\\b'), '"a\\\\b"');
    assert.equal(quoteSlashArg('one\ntwo'), '"one\\ntwo"');
});

test('normalizeApiId falls back to the main api and folds koboldhorde', () => {
    assert.equal(normalizeApiId({ mainApi: 'openai' }), 'openai');
    assert.equal(normalizeApiId({ mainApi: 'koboldhorde' }), 'kobold');
    assert.equal(normalizeApiId({ mainApi: 'openai' }, 'instruct'), 'instruct');
});

test('characters are found by avatar, not by position', () => {
    const context = makeHost();
    assert.equal(findCharacterIndex(context, 'megumin.png'), 1);
    assert.equal(findCharacterIndex(context, 'gone.png'), -1);
    assert.equal(findCharacterIndex(context, ''), -1);
    assert.equal(getCharacterAvatar(context), 'aqua.png');
});

test('profiles resolve by id and by name', () => {
    const profiles = [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Claude' }];
    const context = makeHost({ profiles });
    assert.equal(getProfileById(context, 'p2').name, 'Claude');
    assert.equal(resolveProfile(context, 'Claude').id, 'p2');
    assert.equal(resolveProfile(context, 'nothing'), null);
});

test('profile overrides are blocked when the original cannot round-trip target fields', () => {
    const context = makeHost({
        profiles: [
            { id: 'p1', name: 'Original', mode: 'cc', api: 'openai', exclude: ['model'] },
            { id: 'p2', name: 'Target', mode: 'cc', api: 'claude', model: 'sonnet' },
            { id: 'p3', name: 'Text', mode: 'tc', api: 'textgenerationwebui' },
        ],
    });
    assert.equal(canRestoreProfileOverride(context, 'p2'), false);
    assert.equal(canRestoreProfileOverride(context, 'p3'), false);
    assert.equal(canRestoreProfileOverride(context, 'p1'), true);
});

test('an implicit proxy reset is blocked when the exact empty proxy cannot be restored', async () => {
    const context = makeHost({
        profiles: [
            { id: 'original', name: 'Original', mode: 'cc', api: 'openai', exclude: ['proxy'] },
            { id: 'reset', name: 'Reset proxy', mode: 'cc', api: 'openai' },
            { id: 'untouched', name: 'Leave proxy', mode: 'cc', api: 'openai', exclude: ['proxy'] },
        ],
        selectedProfile: 'original',
    });
    context.connectionState.proxy = '';
    const snapshot = await snapshotState(context);
    assert.equal(canRestoreProfileOverride(context, 'reset', snapshot), false);
    assert.equal(canRestoreProfileOverride(context, 'untouched', snapshot), true);
});

test('waitForEvent resolves on the event and also on a timeout', async () => {
    const context = makeHost();
    const waited = waitForEvent(context, 'chat_changed', 1000);
    context.eventSource.emit('chat_changed');
    await waited;

    const start = Date.now();
    await waitForEvent(context, 'never_fires', 30);
    assert.ok(Date.now() - start >= 25, 'a missing event must not hang the run');
});

test('waitForEvent removes a timed-out listener', async () => {
    const listeners = new Map();
    const context = {
        eventSource: {
            on: (type, handler) => listeners.set(type, handler),
            removeListener(type, handler) {
                if (listeners.get(type) === handler) listeners.delete(type);
            },
        },
    };
    await waitForEvent(context, 'never', 5);
    assert.equal(listeners.size, 0);
});

test('snapshotState records everything a run can change', async () => {
    const context = makeHost({
        profiles: [{ id: 'p1', name: 'Local' }],
        presets: { openai: 'My preset', instruct: 'Alpaca' },
    });
    const snapshot = await snapshotState(context);
    assert.equal(snapshot.characterAvatar, 'aqua.png');
    assert.equal(snapshot.personaKey, 'user-a.png');
    assert.equal(snapshot.profileId, 'p1');
    assert.equal(snapshot.presets.openai, 'My preset');
    assert.equal(snapshot.presets.instruct, 'Alpaca');
    assert.equal(snapshot.presetValues.openai, 'value:My preset');
    assert.equal(snapshot.connection.fields.api, 'openai');
});

test('restoreState restores live connection fields even when the selected profile id never changed', async () => {
    const context = makeHost({
        profiles: [{ id: 'p1', name: 'Local', mode: 'cc', api: 'openai', model: 'saved-model' }],
    });
    context.connectionState.model = 'manual-model';
    const snapshot = await snapshotState(context);

    context.connectionState.model = 'changed-model';
    const problems = await restoreState(context, snapshot);

    assert.deepEqual(problems, []);
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, 'p1');
    assert.equal(context.connectionState.model, 'manual-model');
});

test('applyCase applies the character first and the preset last', async () => {
    const context = makeHost({
        profiles: [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Claude' }],
        presets: { openai: 'Old preset' },
    });
    await applyCase(context, {
        characterAvatar: 'megumin.png',
        personaKey: 'user-b.png',
        connectionProfileId: 'p2',
        preset: { apiId: 'openai', name: 'Deep' },
    });

    const order = context.commands;
    const characterStep = order.findIndex(item => item.startsWith('select:'));
    const personaStep = order.findIndex(item => item.startsWith('/persona-set'));
    const profileStep = order.findIndex(item => item.startsWith('/profile'));
    const presetStep = order.findIndex(item => item.startsWith('preset:'));

    assert.ok(characterStep >= 0 && personaStep > characterStep, 'persona must follow the character switch');
    assert.ok(profileStep > personaStep, 'profile must follow the persona');
    assert.ok(presetStep > profileStep, 'the preset must be applied last so nothing overwrites it');
});

test('applyCase skips a character switch that is already in place', async () => {
    const context = makeHost({ characterId: 0 });
    await applyCase(context, { characterAvatar: 'aqua.png' });
    assert.equal(context.commands.filter(item => item.startsWith('select:')).length, 0);
});

test('applyCase explains a missing character in plain language', async () => {
    const context = makeHost();
    await assert.rejects(
        () => applyCase(context, { characterAvatar: 'deleted.png' }),
        /not installed any more/,
    );
});

test('applyCase explains a missing profile and a missing preset', async () => {
    const context = makeHost({ profiles: [{ id: 'p1', name: 'Local' }] });
    await assert.rejects(
        () => applyCase(context, { characterAvatar: 'aqua.png', connectionProfileId: 'gone' }),
        /no longer exists/,
    );
    await assert.rejects(
        () => applyCase(context, {
            characterAvatar: 'aqua.png',
            preset: { apiId: 'openai', name: 'Missing preset' },
        }),
        /not available any more/,
    );
});

test('applyCase rejects presets from the wrong or mixed live generation mode', async () => {
    const context = makeHost();
    await assert.rejects(() => applyCase(context, {
        characterAvatar: 'aqua.png',
        presets: [{ apiId: 'context', name: 'Story' }],
    }), /Text Completion presets.*Chat Completion/);
    await assert.rejects(() => applyCase(context, {
        characterAvatar: 'aqua.png',
        presets: [
            { apiId: 'openai', name: 'Chat' },
            { apiId: 'context', name: 'Story' },
        ],
    }), /both Chat Completion and Text Completion/);
});

test('applyCase blocks a conversation switch that could replace an unrestorable empty persona', async () => {
    const context = makeHost();
    context.userAvatar = '';
    await assert.rejects(
        () => applyCase(context, { characterAvatar: 'megumin.png' }),
        /empty persona while switching conversations/,
    );
    assert.equal(context.characterId, 0);
});

test('applyCase verifies profile fields after a pinned preset is applied', async () => {
    const context = makeHost({
        profiles: [
            { id: 'p1', name: 'Original', mode: 'cc', api: 'openai', model: 'mine' },
            { id: 'p2', name: 'Target', mode: 'cc', api: 'openai', model: 'target' },
        ],
    });
    const snapshot = await snapshotState(context);
    const getPresetManager = context.getPresetManager;
    context.getPresetManager = (apiId) => {
        const manager = getPresetManager(apiId);
        return {
            ...manager,
            async selectPreset(value) {
                await manager.selectPreset(value);
                if (apiId === 'openai') {
                    context.connectionState.model = 'preset-model';
                }
            },
        };
    };

    await assert.rejects(() => applyCase(context, {
        characterAvatar: 'aqua.png',
        connectionProfileId: 'p2',
        presets: [{ apiId: 'openai', name: 'Deep' }],
    }, { originalState: snapshot }), /conflict.*\/model.*preset-model.*target/);
});

test('a pinned sampler preset may override the profile preset while other fields are verified', async () => {
    const context = makeHost({
        profiles: [{
            id: 'p1',
            name: 'Ordinary',
            mode: 'cc',
            api: 'openai',
            preset: 'Profile preset',
            model: 'profile-model',
            proxy: 'https://proxy.test',
        }],
        presets: { openai: 'Profile preset' },
    });
    const snapshot = await snapshotState(context);
    const commands = context.SlashCommandParser.commands;
    const verified = [];
    context.SlashCommandParser.commands = new Proxy(commands, {
        get(target, field) {
            const command = target[field];
            return {
                ...command,
                async callback(args, value) {
                    if (!args?._hasUnnamedArgument) {
                        verified.push(field);
                    }
                    return command.callback(args, value);
                },
            };
        },
    });

    await applyCase(context, {
        characterAvatar: 'aqua.png',
        connectionProfileId: 'p1',
        presets: [{ apiId: 'openai', name: 'Test preset' }],
    }, { originalState: snapshot });

    assert.equal(getPresetName(context, 'openai'), 'Test preset');
    assert.equal(context.connectionState.model, 'profile-model');
    assert.equal(context.connectionState.proxy, 'https://proxy.test');
    assert.deepEqual(verified, ['api', 'model', 'proxy']);
});

test('applyCase refuses a selected profile whose live fields have drifted', async () => {
    const context = makeHost({
        profiles: [{ id: 'p1', name: 'Current', mode: 'cc', api: 'openai', model: 'profile-model' }],
    });
    context.connectionState.model = 'manual-model';

    await assert.rejects(() => applyCase(context, {
        characterAvatar: 'megumin.png',
        connectionProfileId: 'p1',
    }), /cannot be restored exactly from the live host state/);
    assert.equal(context.characterId, 0, 'the refusal must happen before switching conversations');
});

test('applyCase applies every pinned Text Completion preset', async () => {
    const context = makeHost({ mainApi: 'textgenerationwebui', presets: { context: 'Old', instruct: 'Old' } });
    await applyCase(context, {
        characterAvatar: 'aqua.png',
        presets: [
            { apiId: 'context', name: 'Story' },
            { apiId: 'instruct', name: 'ChatML' },
        ],
    });
    const applied = context.commands.filter(item => item.startsWith('preset:'));
    assert.deepEqual(applied, ['preset:context:value:Story', 'preset:instruct:value:ChatML']);
});

test('applyCase refuses templates that overwrite each other', async () => {
    const context = makeHost({ mainApi: 'textgenerationwebui' });
    let bound = false;
    const original = context.getPresetManager;
    context.getPresetManager = (apiId) => {
        const manager = original(apiId);
        return {
            ...manager,
            // The host links context and instruct, so picking one replaces the other.
            getSelectedPresetName: () => (bound && apiId === 'context' ? 'ChatML' : manager.getSelectedPresetName()),
            async selectPreset(value) {
                await manager.selectPreset(value);
                if (apiId === 'instruct') {
                    bound = true;
                }
            },
        };
    };
    await assert.rejects(
        () => applyCase(context, {
            characterAvatar: 'aqua.png',
            presets: [
                { apiId: 'context', name: 'Story' },
                { apiId: 'instruct', name: 'ChatML' },
            ],
        }),
        /linked to each other/,
    );
});

test('applyCase refuses a pinned Prompt Tags profile when the extension is missing', async () => {
    const context = makeHost();
    await assert.rejects(() => applyCase(context, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    }), /not installed or enabled/);
});

test('applyCase applies a Prompt Tags profile when the extension is present', async () => {
    const context = makeHost();
    context.extensionSettings.promptTags = {
        enabled: true,
        activeProfile: 'Other',
        activeProfileId: 'y',
        profiles: { Other: { id: 'y' }, Tagged: { id: 'x' } },
    };
    const { caveats } = await applyCase(context, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    });
    assert.deepEqual(caveats, []);
    assert.ok(context.commands.includes('/prompttags-profile "Tagged"'));
    assert.equal(context.extensionSettings.promptTags.activeProfileId, 'x');
});

test('applyCase refuses disabled or overridden Prompt Tags profiles', async () => {
    const disabled = makeHost();
    disabled.extensionSettings.promptTags = {
        enabled: false,
        activeProfile: 'Tagged',
        activeProfileId: 'x',
        profiles: { Tagged: { id: 'x' } },
    };
    await assert.rejects(() => applyCase(disabled, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    }), /disabled/);

    const overridden = makeHost();
    overridden.chatMetadata = { promptTags: { profileId: 'y' } };
    overridden.extensionSettings.promptTags = {
        enabled: true,
        activeProfile: 'Other',
        activeProfileId: 'y',
        profiles: { Other: { id: 'y' }, Tagged: { id: 'x' } },
    };
    await assert.rejects(() => applyCase(overridden, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    }), /not effective/);
});

test('restoreState puts the character, persona, profile and preset back', async () => {
    const profiles = [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Claude' }];
    const context = makeHost({ profiles, presets: { openai: 'Mine' } });
    const snapshot = await snapshotState(context);

    await applyCase(context, {
        characterAvatar: 'megumin.png',
        personaKey: 'user-b.png',
        connectionProfileId: 'p2',
        preset: { apiId: 'openai', name: 'Deep' },
    });
    assert.notEqual(getCharacterAvatar(context), snapshot.characterAvatar);

    const problems = await restoreState(context, snapshot);
    assert.deepEqual(problems, []);
    assert.equal(getCharacterAvatar(context), 'aqua.png');
    assert.equal(context.userAvatar, 'user-a.png');
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, 'p1');
    assert.equal(getPresetName(context, 'openai'), 'Mine');
});

test('restoreState reapplies a clean chat preset after model sampling profile side effects', async () => {
    const context = makeHost({
        profiles: [
            { id: 'p1', name: 'Original', mode: 'cc' },
            { id: 'p2', name: 'Target', mode: 'cc' },
        ],
        presets: { openai: 'Mine' },
    });
    context.chatCompletionSettings = { model_sampling_profiles_enabled: true };
    const snapshot = await snapshotState(context);

    await applyCase(context, {
        characterAvatar: 'aqua.png',
        connectionProfileId: 'p2',
    }, { originalState: snapshot });
    context.commands.length = 0;
    assert.deepEqual(await restoreState(context, snapshot), []);

    assert.ok(context.commands.includes('preset:openai:value:Mine'));
});

test('restoreState restores Prompt Tags global state and an empty preset selection', async () => {
    const context = makeHost({ presets: { openai: '' } });
    context.extensionSettings.promptTags = {
        enabled: false,
        activeProfile: 'Original',
        activeProfileId: 'one',
        profiles: { Original: { id: 'one' }, Other: { id: 'two' } },
    };
    const snapshot = await snapshotState(context);
    await context.getPresetManager('openai').selectPreset('value:Other');
    context.extensionSettings.promptTags.enabled = true;
    context.extensionSettings.promptTags.activeProfile = 'Other';
    context.extensionSettings.promptTags.activeProfileId = 'two';

    const problems = await restoreState(context, snapshot);
    assert.deepEqual(problems, []);
    assert.equal(getPresetName(context, 'openai'), '');
    assert.equal(context.extensionSettings.promptTags.enabled, false);
    assert.equal(context.extensionSettings.promptTags.activeProfileId, 'one');
});

test('restoreState reports an exact empty persona instead of skipping it', async () => {
    const context = makeHost();
    context.userAvatar = '';
    const snapshot = await snapshotState(context);
    context.userAvatar = 'changed.png';
    const problems = await restoreState(context, snapshot);
    assert.ok(problems.some(problem => /empty persona/.test(problem)));
});

test('applyCase rejects host command errors and unsafe unprofiled overrides', async () => {
    const commandError = makeHost();
    commandError.executeSlashCommandsWithOptions = async () => ({ error: true, message: 'No chat is open.' });
    await assert.rejects(() => applyCase(commandError, {
        characterAvatar: 'aqua.png',
        personaKey: 'other.png',
    }), /No chat is open/);

    const unprofiled = makeHost({
        selectedProfile: '',
        profiles: [{ id: 'p2', name: 'Other', mode: 'cc' }],
    });
    const originalState = await snapshotState(unprofiled);
    await assert.rejects(() => applyCase(unprofiled, {
        characterAvatar: 'aqua.png',
        connectionProfileId: 'p2',
    }, { originalState }), /cannot be restored exactly/);
});

test('applyCase conservatively rejects a cross-mode profile switch', async () => {
    const profiles = [
        { id: 'p1', name: 'Local', mainApi: 'openai' },
        { id: 'p2', name: 'Text', mainApi: 'textgenerationwebui' },
    ];
    const context = makeHost({ profiles, selectedProfile: 'p1' });
    await assert.rejects(
        () => applyCase(context, { characterAvatar: 'aqua.png', connectionProfileId: 'p2' }),
        /cannot be restored exactly/,
    );
    assert.equal(context.mainApi, 'openai');
});

test('restoreState keeps going when one step fails', async () => {
    const profiles = [{ id: 'p1', name: 'Local' }];
    const context = makeHost({ profiles, presets: { openai: 'Mine' } });
    const snapshot = await snapshotState(context);
    context.characterId = 1;
    context.extensionSettings.connectionManager.selectedProfile = 'other';
    // Break the persona step only.
    const original = context.executeSlashCommandsWithOptions;
    context.executeSlashCommandsWithOptions = async (command) => {
        if (command.startsWith('/persona-set')) {
            throw new Error('persona service unavailable');
        }
        return original(command);
    };
    context.userAvatar = 'someone-else.png';

    const problems = await restoreState(context, snapshot);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /persona/);
    // The character was still restored despite the persona failure.
    assert.equal(getCharacterAvatar(context), 'aqua.png');
});

test('restoreState does nothing without a snapshot', async () => {
    const context = makeHost();
    assert.deepEqual(await restoreState(context, null), []);
});

test('restore works when the host hands out a fresh context object each call', async () => {
    // SillyBunny copies characterId, userAvatar and chatId into every context it
    // builds. A held context therefore reports the character it was built with
    // for ever, which once made restore believe there was nothing to put back.
    const profiles = [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Claude' }];
    const backing = makeHost({ profiles, presets: { openai: 'Mine' } });
    const provider = () => ({
        ...backing,
        // The copied-by-value fields, re-read at the moment of the call.
        characterId: backing.characterId,
        userAvatar: backing.userAvatar,
        chatId: backing.chatId,
        mainApi: backing.mainApi,
    });

    const snapshot = await snapshotState(provider);
    assert.equal(snapshot.characterAvatar, 'aqua.png');

    await applyCase(provider, {
        characterAvatar: 'megumin.png',
        connectionProfileId: 'p2',
        preset: { apiId: 'openai', name: 'Deep' },
    });
    assert.equal(getCharacterAvatar(provider), 'megumin.png');

    const problems = await restoreState(provider, snapshot);
    assert.deepEqual(problems, []);
    assert.equal(getCharacterAvatar(provider), 'aqua.png', 'the character must be restored');
    assert.equal(backing.extensionSettings.connectionManager.selectedProfile, 'p1');
    assert.equal(getPresetName(provider, 'openai'), 'Mine');
});

test('a stale context snapshot cannot make restore skip the character', async () => {
    const backing = makeHost();
    // A context captured before the switch: exactly what a held object looks like.
    const stale = { ...backing, characterId: 0 };
    const snapshot = await snapshotState(stale);

    backing.characterId = 1;
    // Reading through the stale object still claims the original character...
    assert.equal(getCharacterAvatar(stale), 'aqua.png');
    // ...but reading through a provider sees the truth.
    assert.equal(getCharacterAvatar(() => backing), 'megumin.png');

    await restoreState(() => backing, snapshot);
    assert.equal(backing.characterId, 0, 'restore must act on the live character');
});

test('restoreState returns the original group and exact group chat', async () => {
    const context = makeHost();
    context.characters = [
        { avatar: 'aqua.png', name: 'Aqua' },
        { avatar: 'megumin.png', name: 'Megumin' },
    ];
    context.groups = [
        { id: 'group-1', name: 'Guild', chats: ['group-chat-old', 'group-chat-new'], chat_id: 'group-chat-old' },
        { id: 'group-2', name: 'Other', chats: ['other-chat'], chat_id: 'other-chat' },
    ];
    context.groupId = 'group-1';
    context.characterId = undefined;
    context.chatId = 'group-chat-old';
    context.executeSlashCommandsWithOptions = async (command) => {
        context.commands.push(command);
        if (command === '/go "Guild"') {
            context.groupId = 'group-1';
            context.chatId = 'group-chat-new';
        }
    };
    context.openGroupChat = async (groupId, chatId) => {
        context.groupId = groupId;
        context.chatId = chatId;
    };

    const snapshot = await snapshotState(context);
    context.groupId = 'group-2';
    context.chatId = 'other-chat';
    const problems = await restoreState(context, snapshot);

    assert.deepEqual(problems, []);
    assert.equal(context.groupId, 'group-1');
    assert.equal(context.chatId, 'group-chat-old');
    assert.ok(context.commands.includes('/go "Guild"'));
});

test('restoreState recovers a same-named group through the exact group-chat API', async () => {
    const context = makeHost();
    context.groups = [{ id: 'group-1', name: 'Guild', chats: ['group-chat'] }];
    context.groupId = 'group-1';
    context.characterId = undefined;
    context.chatId = 'group-chat';
    const snapshot = await snapshotState(context);
    context.groupId = 'character-with-same-name';
    context.chatId = 'other-chat';
    context.executeSlashCommandsWithOptions = async command => context.commands.push(command);
    context.openGroupChat = async (groupId, chatId) => {
        context.groupId = groupId;
        context.chatId = chatId;
    };

    const problems = await restoreState(context, snapshot);

    assert.deepEqual(problems, []);
    assert.equal(context.groupId, 'group-1');
    assert.equal(context.chatId, 'group-chat');
});

test('restoreState reopens an exact non-default character chat', async () => {
    const context = makeHost();
    context.chatId = 'character-chat-old';
    context.openCharacterChat = async chatId => { context.chatId = chatId; };
    const snapshot = await snapshotState(context);
    context.chatId = 'character-chat-current';

    const problems = await restoreState(context, snapshot);

    assert.deepEqual(problems, []);
    assert.equal(context.chatId, 'character-chat-old');
});

test('restoreState reports missing groups and chat APIs instead of silently continuing', async () => {
    const missingGroup = makeHost();
    missingGroup.groupId = 'deleted-group';
    missingGroup.characterId = undefined;
    missingGroup.chatId = 'group-chat';
    missingGroup.groups = [];
    const groupProblems = await restoreState(missingGroup, await snapshotState(missingGroup));
    assert.ok(groupProblems.some(problem => problem.startsWith('group:')));

    const missingChatApi = makeHost();
    missingChatApi.chatId = 'old-chat';
    const snapshot = await snapshotState(missingChatApi);
    missingChatApi.chatId = 'current-chat';
    const chatProblems = await restoreState(missingChatApi, snapshot);
    assert.ok(chatProblems.some(problem => problem.startsWith('character chat:')));
});

test('restoreState reports unavailable or no-op setting restorations', async () => {
    const context = makeHost({ profiles: [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Other' }], presets: { openai: 'Mine' } });
    const snapshot = await snapshotState(context);
    context.userAvatar = 'someone-else.png';
    context.extensionSettings.connectionManager.selectedProfile = 'p2';
    context.executeSlashCommandsWithOptions = undefined;
    context.getPresetManager = () => ({
        getSelectedPresetName: () => 'Other preset',
        findPreset: () => undefined,
    });

    const problems = await restoreState(context, snapshot);

    assert.ok(problems.some(problem => problem.startsWith('persona:')));
    assert.ok(problems.some(problem => problem.startsWith('connection profile:')));
    assert.ok(problems.some(problem => problem.startsWith('preset')));
});

test('restoreState reports a preset that cannot be selected', async () => {
    const context = makeHost({ presets: { openai: 'Mine' } });
    const snapshot = await snapshotState(context);
    context.getPresetManager = () => ({
        getSelectedPresetName: () => 'Other preset',
        findPreset: () => undefined,
    });

    const problems = await restoreState(context, snapshot);

    assert.ok(problems.some(problem => problem.includes('preset "Mine"')));
});

test('restoreState reports a preset manager that ignores the selection', async () => {
    const context = makeHost({ presets: { openai: 'Mine' } });
    const snapshot = await snapshotState(context);
    context.getPresetManager = () => ({
        getSelectedPresetName: () => 'Other preset',
        findPreset: () => 'value:Mine',
        async selectPreset() {},
    });

    const problems = await restoreState(context, snapshot);

    assert.ok(problems.some(problem => problem.includes('preset "Mine"')));
});

test('restore puts the character back before the preset', async () => {
    const backing = makeHost({ presets: { openai: 'Mine' } });
    const provider = () => ({ ...backing, characterId: backing.characterId, userAvatar: backing.userAvatar });
    const snapshot = await snapshotState(provider);
    backing.characterId = 1;
    backing.commands.length = 0;

    await restoreState(provider, snapshot);
    const characterStep = backing.commands.findIndex(item => item.startsWith('select:'));
    const presetStep = backing.commands.findIndex(item => item.startsWith('preset:'));
    if (presetStep >= 0) {
        assert.ok(
            characterStep >= 0 && characterStep < presetStep,
            'opening a character re-applies presets, so it must happen before the preset is restored',
        );
    }
});

test('an unavailable dirty check is reported as unknown rather than clean', () => {
    const context = makeHost();
    context.getPresetManager = () => ({});
    assert.equal(hasUnsavedPresetEdits(context), null);
    context.getPresetManager = () => ({
        _dirty: true,
        _checkDirty(options) {
            assert.deepEqual(options, { force: true });
        },
    });
    assert.equal(hasUnsavedPresetEdits(context), true);
    context.getPresetManager = () => ({
        _dirty: false,
        _checkDirty() {},
    });
    assert.equal(hasUnsavedPresetEdits(context), false);
    context.getPresetManager = () => ({ _checkDirty() {} });
    assert.equal(hasUnsavedPresetEdits(context), null);
    context.getPresetManager = () => ({ _checkDirty: () => { throw new Error('gone'); } });
    assert.equal(hasUnsavedPresetEdits(context), null);
});

test('the host no-chat response is treated as a chat file that would be created', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ error: true }),
    });
    try {
        assert.equal(await willCreateChatFile({ getRequestHeaders: () => ({}) }, 'aqua.png'), true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
