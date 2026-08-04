import { CAVEAT } from './constants.js';
import { ctxOf } from './host.js';

/**
 * Applies a test case's pinned configuration, and puts the user's own
 * configuration back afterwards.
 *
 * Order matters. Opening a character raises CHAT_CHANGED, and SillyBunny reacts
 * to that by selecting a preset named after the character and by applying any
 * persona locked to the chat. Anything applied before the character switch
 * would be silently undone, so the character goes first and the preset last.
 */

const NONE_PROFILE = '<None>';
const SETTLE_TIMEOUT_MS = 5000;
/** Reactions to CHAT_CHANGED are queued, not immediate; let them land. */
const SETTLE_TICK_MS = 300;

/** Preset managers that a connection profile can change behind our back. */
export const PRESET_API_IDS = Object.freeze(['instruct', 'context', 'sysprompt', 'reasoning']);

export function quoteSlashArg(value) {
    return `"${String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')}"`;
}

export function normalizeApiId(source, apiId = '') {
    const value = String(apiId || '').trim();
    if (value) {
        return value === 'koboldhorde' ? 'kobold' : value;
    }
    const main = String(ctxOf(source)?.mainApi ?? '');
    return main === 'koboldhorde' ? 'kobold' : main;
}

function delay(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

/**
 * Waits for a host event, but never longer than the timeout. A missing event is
 * not treated as a failure: some hosts skip it, and the run should continue.
 */
export function waitForEvent(hostRef, eventType, timeoutMs = SETTLE_TIMEOUT_MS) {
    const source = ctxOf(hostRef)?.eventSource;
    if (!eventType || typeof source?.once !== 'function') {
        return delay(0);
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        try {
            source.once(eventType, finish);
        } catch {
            finish();
            return;
        }
        setTimeout(finish, timeoutMs);
    });
}

/* ------------------------------------------------------- profile helpers */

export function getConnectionProfiles(hostRef) {
    const profiles = ctxOf(hostRef)?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

export function getProfileById(hostRef, id) {
    if (!id) {
        return null;
    }
    return getConnectionProfiles(hostRef).find(profile => profile?.id === id) ?? null;
}

export function getProfileByName(hostRef, name) {
    if (!name) {
        return null;
    }
    return getConnectionProfiles(hostRef).find(profile => profile?.name === name) ?? null;
}

/** Accepts an id or, for settings written by hand, a name. */
export function resolveProfile(hostRef, value) {
    return getProfileById(hostRef, value) ?? getProfileByName(hostRef, value);
}

export function getSelectedProfileId(hostRef) {
    return ctxOf(hostRef)?.extensionSettings?.connectionManager?.selectedProfile ?? '';
}

/* -------------------------------------------------------- preset helpers */

export function getPresetName(hostRef, apiId) {
    try {
        const context = ctxOf(hostRef);
        return context?.getPresetManager?.(normalizeApiId(hostRef, apiId))?.getSelectedPresetName?.() ?? '';
    } catch {
        return '';
    }
}

async function selectPreset(hostRef, apiId, presetName) {
    if (!presetName) {
        return false;
    }
    const context = ctxOf(hostRef);
    const manager = context?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (!manager?.findPreset) {
        return false;
    }
    if (manager.getSelectedPresetName?.() === presetName) {
        return true;
    }
    const value = manager.findPreset(presetName);
    if (value === undefined || value === null || value === '') {
        return false;
    }
    await manager.selectPreset(value);
    return true;
}

/**
 * Reports whether the preset panel holds edits the user has not saved.
 * Selecting a preset discards them, so the runner warns first. The dirty check
 * is a private helper in SillyBunny; if it disappears, assume the worst.
 */
export function hasUnsavedPresetEdits(hostRef, apiId = '') {
    const manager = ctxOf(hostRef)?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (!manager) {
        return false;
    }
    if (typeof manager._checkDirty !== 'function') {
        return null;
    }
    try {
        return Boolean(manager._checkDirty());
    } catch {
        return null;
    }
}

/* ------------------------------------------------------ character helpers */

export function findCharacterIndex(hostRef, avatar) {
    if (!avatar) {
        return -1;
    }
    const context = ctxOf(hostRef);
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    return characters.findIndex(character => character?.avatar === avatar);
}

/** Always resolved fresh: characterId is copied by value into the context. */
export function getCharacterAvatar(hostRef) {
    const context = ctxOf(hostRef);
    const index = context?.characterId;
    if (index === undefined || index === null) {
        return '';
    }
    return context?.characters?.[index]?.avatar ?? '';
}

/* ---------------------------------------------------------------- snapshot */

/**
 * Records everything a run can change, so it can all be put back.
 * Read live rather than from a cached context: several of these fields are
 * copied by value when the context object is built.
 */
export function snapshotState(hostRef) {
    const context = ctxOf(hostRef);
    const presets = {};
    const mainApiId = normalizeApiId(hostRef);
    if (mainApiId) {
        presets[mainApiId] = getPresetName(hostRef, mainApiId);
    }
    for (const apiId of PRESET_API_IDS) {
        presets[apiId] = getPresetName(hostRef, apiId);
    }
    return {
        characterAvatar: getCharacterAvatar(hostRef),
        characterId: context?.characterId ?? undefined,
        groupId: context?.groupId ?? undefined,
        chatId: context?.chatId ?? '',
        personaKey: context?.userAvatar ?? '',
        profileId: getSelectedProfileId(hostRef),
        mainApi: context?.mainApi ?? '',
        presets,
    };
}

/* ------------------------------------------------------------------ apply */

async function runSlash(hostRef, command) {
    const context = ctxOf(hostRef);
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        return null;
    }
    return context.executeSlashCommandsWithOptions(command);
}

async function applyCharacter(hostRef, avatar, { signal } = {}) {
    const index = findCharacterIndex(hostRef, avatar);
    if (index < 0) {
        throw new Error(`This test case uses a character that is not installed any more (${avatar}). Choose a different character or reinstall that card.`);
    }
    if (ctxOf(hostRef).characterId === index) {
        return;
    }
    const settled = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CHAT_CHANGED);
    const ok = await ctxOf(hostRef).selectCharacterById(index, { switchMenu: false });
    if (ok === false) {
        throw new Error('SillyBunny would not switch character, usually because a reply is still being generated. Wait for it to finish and run the tests again.');
    }
    await settled;
    // Let SillyBunny's own reactions to the chat change finish before the
    // persona and preset below are applied, or they will be overwritten.
    await delay(SETTLE_TICK_MS, signal);
}

async function applyPersona(hostRef, personaKey) {
    if (!personaKey) {
        return;
    }
    await runSlash(hostRef, `/persona-set mode=lookup ${quoteSlashArg(personaKey)}`);
}

async function applyProfile(hostRef, profileId) {
    if (!profileId) {
        return;
    }
    const profile = resolveProfile(hostRef, profileId);
    if (!profile) {
        throw new Error('This test case uses a connection profile that no longer exists. Choose a different profile for the test case.');
    }
    if (getSelectedProfileId(hostRef) === profile.id) {
        return;
    }
    const loaded = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CONNECTION_PROFILE_LOADED);
    await runSlash(hostRef, `/profile await=true ${quoteSlashArg(profile.name)}`);
    await loaded;
}

async function applyPromptTagsProfile(hostRef, promptTags, caveats) {
    if (!promptTags?.profileName && !promptTags?.profileId) {
        return;
    }
    const available = ctxOf(hostRef)?.extensionSettings?.promptTags?.profiles;
    if (!available) {
        caveats.push(CAVEAT.PROMPT_TAGS_MISSING);
        return;
    }
    const name = promptTags.profileName && available[promptTags.profileName]
        ? promptTags.profileName
        : Object.keys(available).find(key => available[key]?.id === promptTags.profileId);
    if (!name) {
        caveats.push(CAVEAT.PROMPT_TAGS_MISSING);
        return;
    }
    await runSlash(hostRef, `/prompttags-profile ${quoteSlashArg(name)}`);
}

/**
 * Applies one test case's pins. Throws when a pin cannot be honoured, so the
 * runner can record the case as unrunnable rather than measure the wrong thing.
 */
export async function applyCase(hostRef, pins, { signal = null } = {}) {
    const caveats = [];
    await applyCharacter(hostRef, pins?.characterAvatar, { signal });
    if (signal?.aborted) {
        return { caveats };
    }
    await applyPersona(hostRef, pins?.personaKey);
    await applyProfile(hostRef, pins?.connectionProfileId);
    await applyPromptTagsProfile(hostRef, pins?.promptTags, caveats);
    if (pins?.preset?.name) {
        const applied = await selectPreset(hostRef, pins.preset.apiId, pins.preset.name);
        if (!applied) {
            throw new Error(`This test case uses a preset that is not available any more (${pins.preset.name}). Choose a different preset for the test case.`);
        }
    }
    return { caveats };
}

/* ---------------------------------------------------------------- restore */

/**
 * Puts the user's configuration back. Every step is guarded: a failure to
 * restore one thing must not stop the others from being restored.
 * Returns the list of things that could not be put back.
 */
export async function restoreState(hostRef, snapshot) {
    const problems = [];
    if (!snapshot) {
        return problems;
    }

    // The character is restored first. Opening a character raises CHAT_CHANGED,
    // which makes SillyBunny re-apply a chat-locked persona and a preset named
    // after the character; doing it last would undo everything below it.
    try {
        if (snapshot.characterAvatar && getCharacterAvatar(hostRef) !== snapshot.characterAvatar) {
            const index = findCharacterIndex(hostRef, snapshot.characterAvatar);
            if (index >= 0) {
                const settled = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CHAT_CHANGED);
                await ctxOf(hostRef).selectCharacterById(index, { switchMenu: false });
                await settled;
                await delay(SETTLE_TICK_MS);
            }
        }
    } catch (error) {
        problems.push(`character: ${error?.message ?? error}`);
    }

    try {
        if (snapshot.personaKey && ctxOf(hostRef)?.userAvatar !== snapshot.personaKey) {
            await runSlash(hostRef, `/persona-set mode=lookup ${quoteSlashArg(snapshot.personaKey)}`);
        }
    } catch (error) {
        problems.push(`persona: ${error?.message ?? error}`);
    }

    try {
        if (getSelectedProfileId(hostRef) !== snapshot.profileId) {
            const profile = getProfileById(hostRef, snapshot.profileId);
            const loaded = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CONNECTION_PROFILE_LOADED);
            await runSlash(hostRef, `/profile await=true ${quoteSlashArg(profile?.name ?? NONE_PROFILE)}`);
            await loaded;
        }
    } catch (error) {
        problems.push(`connection profile: ${error?.message ?? error}`);
    }

    // Presets go last so nothing above can overwrite them.
    for (const [apiId, presetName] of Object.entries(snapshot.presets ?? {})) {
        if (!presetName) {
            continue;
        }
        try {
            await selectPreset(hostRef, apiId, presetName);
        } catch (error) {
            problems.push(`preset "${presetName}" (${apiId}): ${error?.message ?? error}`);
        }
    }

    // A dry run can leave the send buttons disabled if it exited early.
    try {
        ctxOf(hostRef)?.unblockGeneration?.();
    } catch {
        // Nothing to do; this is a courtesy call.
    }

    return problems;
}

/**
 * Asks the server whether a character already has a saved chat. Used only to
 * warn the user that running tests will create one. Any failure answers "no
 * warning", because a preflight notice is not worth blocking a run over.
 */
export async function willCreateChatFile(hostRef, avatar) {
    try {
        const context = ctxOf(hostRef);
        if (typeof globalThis.fetch !== 'function' || typeof context?.getRequestHeaders !== 'function') {
            return false;
        }
        const response = await globalThis.fetch('/api/characters/chats', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!response.ok) {
            return false;
        }
        const chats = await response.json();
        return Array.isArray(chats) && chats.length === 0;
    } catch {
        return false;
    }
}
