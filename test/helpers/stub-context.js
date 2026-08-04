/**
 * Minimal stand-in for SillyTavern.getContext() so src modules can run under
 * `node --test`. Install with installStubContext() before importing modules
 * that read the host context.
 */

export function installStubContext(overrides = {}) {
    const ctx = {
        extensionSettings: {},
        chatMetadata: {},
        chat: [],
        chatId: 'stub-chat',
        characters: [],
        characterId: undefined,
        groupId: undefined,
        userAvatar: 'stub-user.png',
        mainApi: 'openai',
        powerUserSettings: { personas: {}, persona_descriptions: {} },
        eventSource: {
            on: () => {},
            makeLast: () => {},
            removeListener: () => {},
            emit: async () => {},
        },
        eventTypes: new Proxy({}, { get: (_target, prop) => String(prop) }),
        saveSettingsDebounced: () => {},
        saveMetadataDebounced: () => {},
        getTokenCountAsync: async text => String(text ?? '').length,
        executeSlashCommandsWithOptions: async () => ({ pipe: '' }),
        selectCharacterById: async () => true,
        unshallowCharacter: async () => {},
        getCharacterCardFields: () => ({}),
        writeExtensionField: async (characterId, key, value) => {
            const character = ctx.characters[characterId];
            if (!character) {
                throw new Error(`No character at index ${characterId}`);
            }
            character.data ??= {};
            character.data.extensions ??= {};
            character.data.extensions[key] = value;
        },
        promptManager: null,
        ...overrides.ctx,
    };

    globalThis.SillyTavern = { getContext: () => ctx };
    return { ctx };
}

export function removeStubContext() {
    delete globalThis.SillyTavern;
}

/** Builds a RunRecord-shaped object for assertion and diff tests. */
export function makeRunFixture(patch = {}) {
    return {
        v: 1,
        id: 'run-1',
        caseId: 'case-1',
        status: 'pass',
        startedAt: '2026-01-01T00:00:00.000Z',
        capture: {
            messages: [
                { role: 'system', content: 'You are Aqua.' },
                { role: 'user', content: 'Hello there.' },
            ],
            combinedPrompt: null,
            sections: [
                { id: 'main', label: 'Main prompt', content: 'You are Aqua.', tokens: 5 },
                { id: 'chatHistory', label: 'Chat history', content: 'Hello there.', tokens: 3 },
            ],
            tokenTable: { total: 8, perSection: { main: 5, chatHistory: 3 } },
            wiPasses: [],
            squashedMessages: null,
        },
        cache: {
            predictedBreakpoints: [],
            prefixHash: 'abc',
            volatileSpans: [],
            source: 'manual',
        },
        caveats: [],
        assertionResults: [],
        ...patch,
    };
}
