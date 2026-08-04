import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const {
    applyCase,
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
} = await import('../src/apply-state.js');
const { CAVEAT } = await import('../src/constants.js');

test.after(() => removeStubContext());

/** Host stand-in that records every command and switch it is asked to make. */
function makeHost({ characterId = 0, profiles = [], selectedProfile = 'p1', presets = {} } = {}) {
    const commands = [];
    const listeners = new Map();
    const presetState = { ...presets };
    const context = {
        commands,
        characterId,
        characters: [
            { avatar: 'aqua.png', name: 'Aqua' },
            { avatar: 'megumin.png', name: 'Megumin' },
        ],
        chatId: 'chat-1',
        userAvatar: 'user-a.png',
        mainApi: 'openai',
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
                context.eventSource.emit('connection_profile_loaded');
            }
            if (command.startsWith('/persona-set')) {
                context.userAvatar = command.match(/"(.*)"/)?.[1] ?? context.userAvatar;
            }
            return { pipe: '' };
        },
        getPresetManager(apiId) {
            return {
                getSelectedPresetName: () => presetState[apiId] ?? '',
                findPreset: name => (name === 'Missing preset' ? '' : `value:${name}`),
                async selectPreset(value) {
                    commands.push(`preset:${apiId}:${value}`);
                    presetState[apiId] = String(value).replace('value:', '');
                },
            };
        },
    };
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

test('waitForEvent resolves on the event and also on a timeout', async () => {
    const context = makeHost();
    const waited = waitForEvent(context, 'chat_changed', 1000);
    context.eventSource.emit('chat_changed');
    await waited;

    const start = Date.now();
    await waitForEvent(context, 'never_fires', 30);
    assert.ok(Date.now() - start >= 25, 'a missing event must not hang the run');
});

test('snapshotState records everything a run can change', () => {
    const context = makeHost({
        profiles: [{ id: 'p1', name: 'Local' }],
        presets: { openai: 'My preset', instruct: 'Alpaca' },
    });
    const snapshot = snapshotState(context);
    assert.equal(snapshot.characterAvatar, 'aqua.png');
    assert.equal(snapshot.personaKey, 'user-a.png');
    assert.equal(snapshot.profileId, 'p1');
    assert.equal(snapshot.presets.openai, 'My preset');
    assert.equal(snapshot.presets.instruct, 'Alpaca');
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

test('applyCase applies every pinned Text Completion preset', async () => {
    const context = makeHost({ presets: { context: 'Old', instruct: 'Old' } });
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
    const context = makeHost();
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

test('applyCase reports a missing Prompt Tags extension as a caveat, not a failure', async () => {
    const context = makeHost();
    const { caveats } = await applyCase(context, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    });
    assert.deepEqual(caveats, [CAVEAT.PROMPT_TAGS_MISSING]);
});

test('applyCase applies a Prompt Tags profile when the extension is present', async () => {
    const context = makeHost();
    context.extensionSettings.promptTags = { profiles: { Tagged: { id: 'x' } } };
    const { caveats } = await applyCase(context, {
        characterAvatar: 'aqua.png',
        promptTags: { profileId: 'x', profileName: 'Tagged' },
    });
    assert.deepEqual(caveats, []);
    assert.ok(context.commands.includes('/prompttags-profile "Tagged"'));
});

test('restoreState puts the character, persona, profile and preset back', async () => {
    const profiles = [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Claude' }];
    const context = makeHost({ profiles, presets: { openai: 'Mine' } });
    const snapshot = snapshotState(context);

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

test('restoreState keeps going when one step fails', async () => {
    const profiles = [{ id: 'p1', name: 'Local' }];
    const context = makeHost({ profiles, presets: { openai: 'Mine' } });
    const snapshot = snapshotState(context);
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

    const snapshot = snapshotState(provider);
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
    const snapshot = snapshotState(stale);

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

    const snapshot = snapshotState(context);
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
    const snapshot = snapshotState(context);
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
    const snapshot = snapshotState(context);
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
    const groupProblems = await restoreState(missingGroup, snapshotState(missingGroup));
    assert.ok(groupProblems.some(problem => problem.startsWith('group:')));

    const missingChatApi = makeHost();
    missingChatApi.chatId = 'old-chat';
    const snapshot = snapshotState(missingChatApi);
    missingChatApi.chatId = 'current-chat';
    const chatProblems = await restoreState(missingChatApi, snapshot);
    assert.ok(chatProblems.some(problem => problem.startsWith('character chat:')));
});

test('restoreState reports unavailable or no-op setting restorations', async () => {
    const context = makeHost({ profiles: [{ id: 'p1', name: 'Local' }, { id: 'p2', name: 'Other' }], presets: { openai: 'Mine' } });
    const snapshot = snapshotState(context);
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
    const snapshot = snapshotState(context);
    context.getPresetManager = () => ({
        getSelectedPresetName: () => 'Other preset',
        findPreset: () => undefined,
    });

    const problems = await restoreState(context, snapshot);

    assert.ok(problems.some(problem => problem.includes('preset "Mine"')));
});

test('restoreState reports a preset manager that ignores the selection', async () => {
    const context = makeHost({ presets: { openai: 'Mine' } });
    const snapshot = snapshotState(context);
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
    const snapshot = snapshotState(provider);
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
