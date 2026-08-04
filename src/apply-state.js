import { CAVEAT } from './constants.js';
import { ctxOf, getContext } from './host.js';
import { PRESET_API_IDS as WORKSHOP_API_IDS, describePresetRef } from './presets.js';

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

/**
 * Preset managers a run can change behind the user's back, either because a
 * connection profile carries them or because a test case pins them.
 */
export const PRESET_API_IDS = Object.freeze([
    ...new Set(['instruct', 'context', 'sysprompt', 'reasoning', ...WORKSHOP_API_IDS]),
]);

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

export function getConnectionProfiles(hostRef = getContext) {
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
export function resolveProfile(hostRef = getContext, value = '') {
    return getProfileById(hostRef, value) ?? getProfileByName(hostRef, value);
}

export function getSelectedProfileId(hostRef = getContext) {
    return ctxOf(hostRef)?.extensionSettings?.connectionManager?.selectedProfile ?? '';
}

/* -------------------------------------------------------- preset helpers */

export function getPresetName(hostRef = getContext, apiId = '') {
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
    const selected = manager.getSelectedPresetName?.();
    return selected === undefined || selected === presetName;
}

/**
 * Reports whether the preset panel holds edits the user has not saved.
 * Selecting a preset discards them, so the runner warns first. The dirty check
 * is a private helper in SillyBunny; if it disappears, assume the worst.
 */
export function hasUnsavedPresetEdits(hostRef = getContext, apiId = '') {
    const manager = ctxOf(hostRef)?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (!manager) {
        return false;
    }
    if (typeof manager._checkDirty !== 'function') {
        return null;
    }
    try {
        manager._checkDirty({ force: true });
        return typeof manager._dirty === 'boolean' ? manager._dirty : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------ character helpers */

export function findCharacterIndex(hostRef = getContext, avatar = '') {
    if (!avatar) {
        return -1;
    }
    const context = ctxOf(hostRef);
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    return characters.findIndex(character => character?.avatar === avatar);
}

/** Always resolved fresh: characterId is copied by value into the context. */
export function getCharacterAvatar(hostRef = getContext) {
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
export function snapshotState(hostRef = getContext) {
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
    if (!avatar) {
        throw new Error('No character is chosen for this test case.');
    }
    const index = findCharacterIndex(hostRef, avatar);
    if (index < 0) {
        throw new Error(`This test case uses a character that is not installed any more (${avatar}). Choose a different character or reinstall that card.`);
    }
    if (getCharacterAvatar(hostRef) === avatar) {
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

/** Reads a case's pinned presets, including the pre-v2 single-preset shape. */
export function presetRefs(pins) {
    const list = Array.isArray(pins?.presets) ? pins.presets : [];
    const legacy = pins?.preset?.name ? [pins.preset] : [];
    return [...list, ...legacy].filter(ref => ref?.name);
}

/**
 * Applies every pinned preset and checks afterwards that each one really is
 * selected. SillyBunny links some templates together (choosing a context
 * template can pull in the instruct template of the same name), so a pin that
 * was applied first can be replaced by a later one without any error.
 */
async function applyPresets(hostRef, refs) {
    for (const ref of refs) {
        const applied = await selectPreset(hostRef, ref.apiId, ref.name);
        if (!applied) {
            throw new Error(`This test case uses a preset that is not available any more (${describePresetRef(ref)}). Choose a different preset for the test case.`);
        }
    }
    for (const ref of refs) {
        const selected = getPresetName(hostRef, ref.apiId);
        if (selected && selected !== ref.name) {
            throw new Error(`SillyBunny replaced the pinned preset ${describePresetRef(ref)} with "${selected}" while applying the other presets in this test case. Templates that are linked to each other cannot be pinned separately.`);
        }
    }
}

/**
 * Applies one test case's pins. Throws when a pin cannot be honoured, so the
 * runner can record the case as unrunnable rather than measure the wrong thing.
 */
export async function applyCase(hostRef = getContext, pins = null, { signal = null } = {}) {
    const caveats = [];
    await applyCharacter(hostRef, pins?.characterAvatar, { signal });
    if (signal?.aborted) {
        return { caveats };
    }
    await applyPersona(hostRef, pins?.personaKey);
    await applyProfile(hostRef, pins?.connectionProfileId);
    await applyPromptTagsProfile(hostRef, pins?.promptTags, caveats);
    await applyPresets(hostRef, presetRefs(pins));
    return { caveats };
}

/* ---------------------------------------------------------------- restore */

function sameId(left, right) {
    return left !== undefined && left !== null
        && right !== undefined && right !== null
        && String(left) === String(right);
}

function hasConversation(context) {
    return (context?.groupId !== undefined && context?.groupId !== null && context?.groupId !== '')
        || (context?.characterId !== undefined && context?.characterId !== null)
        || Boolean(context?.chatId);
}

function groupForSnapshot(context, groupId) {
    return (Array.isArray(context?.groups) ? context.groups : [])
        .find(group => sameId(group?.id, groupId)) ?? null;
}

async function restoreConversation(hostRef, snapshot, problems) {
    const hasOriginalGroup = snapshot.groupId !== undefined
        && snapshot.groupId !== null
        && snapshot.groupId !== '';
    if (hasOriginalGroup) {
        const initial = ctxOf(hostRef);
        const group = groupForSnapshot(initial, snapshot.groupId);
        if (!group) {
            problems.push(`group: the original group (${snapshot.groupId}) is no longer available.`);
            return;
        }

        const targetChatId = String(snapshot.chatId ?? '');
        if (targetChatId) {
            const availableChats = Array.isArray(group.chats) ? group.chats : [];
            if (!availableChats.some(chatId => String(chatId) === targetChatId)) {
                problems.push(`group chat: chat "${targetChatId}" is no longer available in "${group.name}".`);
                return;
            }
        }

        let current = initial;
        if (!sameId(current.groupId, snapshot.groupId)) {
            let slashFailure = null;
            if (typeof current.executeSlashCommandsWithOptions === 'function') {
                try {
                    await current.executeSlashCommandsWithOptions(`/go ${quoteSlashArg(group.name)}`);
                } catch (error) {
                    slashFailure = `group: selecting "${group.name}" failed: ${error?.message ?? error}`;
                }
            } else {
                slashFailure = 'group: the host cannot select a group because its slash-command API is unavailable.';
            }

            current = ctxOf(hostRef);
            // /go resolves characters before groups. If a character has the
            // same name as the saved group, use the exact group API as a
            // recovery path instead of accepting the wrong conversation.
            if (!sameId(current.groupId, snapshot.groupId)
                && typeof current.openGroupChat === 'function') {
                try {
                    const opened = await current.openGroupChat(group.id, snapshot.chatId);
                    if (opened === false) {
                        slashFailure = `${slashFailure ?? 'group: opening the original group failed.'} The exact group chat was refused.`;
                    }
                } catch (error) {
                    slashFailure = `${slashFailure ?? 'group: opening the original group failed.'} The exact group chat failed: ${error?.message ?? error}`;
                }
            }

            current = ctxOf(hostRef);
            if (!sameId(current.groupId, snapshot.groupId)) {
                problems.push(slashFailure ?? `group: selecting "${group.name}" did not restore the original group.`);
                return;
            }
        }

        current = ctxOf(hostRef);
        if (!sameId(current.groupId, snapshot.groupId)) {
            problems.push(`group: selecting "${group.name}" did not restore the original group.`);
            return;
        }

        if (targetChatId) {
            if (String(current.chatId ?? '') !== targetChatId) {
                if (typeof current.openGroupChat !== 'function') {
                    problems.push('group chat: the host cannot reopen the original group chat because openGroupChat is unavailable.');
                    return;
                }
                try {
                    const opened = await current.openGroupChat(group.id, snapshot.chatId);
                    if (opened === false) {
                        problems.push(`group chat: opening "${targetChatId}" was refused.`);
                        return;
                    }
                } catch (error) {
                    problems.push(`group chat: opening "${targetChatId}" failed: ${error?.message ?? error}`);
                    return;
                }
            }
        }

        const verified = ctxOf(hostRef);
        if (!sameId(verified.groupId, snapshot.groupId)) {
            problems.push(`group: the restored conversation is not in "${group.name}".`);
        }
        if (String(verified.chatId ?? '') !== targetChatId) {
            problems.push(`group chat: the restored chat is "${verified.chatId ?? ''}", not "${targetChatId}".`);
        }
        return;
    }

    if (snapshot.characterAvatar) {
        let current = ctxOf(hostRef);
        const needsCharacter = getCharacterAvatar(hostRef) !== snapshot.characterAvatar
            || hasConversation(current) && (current.groupId !== undefined && current.groupId !== null && current.groupId !== '');
        if (needsCharacter) {
            const index = findCharacterIndex(hostRef, snapshot.characterAvatar);
            if (index < 0) {
                problems.push(`character: the original character (${snapshot.characterAvatar}) is no longer available.`);
                return;
            }
            if (typeof current.selectCharacterById !== 'function') {
                problems.push('character: the host cannot restore the original character because selectCharacterById is unavailable.');
                return;
            }
            try {
                const settled = waitForEvent(hostRef, current.eventTypes?.CHAT_CHANGED);
                const selected = await current.selectCharacterById(index, { switchMenu: false });
                if (selected === false) {
                    problems.push('character: SillyBunny refused to restore the original character.');
                    return;
                }
                await settled;
                await delay(SETTLE_TICK_MS);
            } catch (error) {
                problems.push(`character: restoring "${snapshot.characterAvatar}" failed: ${error?.message ?? error}`);
                return;
            }
        }

        current = ctxOf(hostRef);
        if (getCharacterAvatar(hostRef) !== snapshot.characterAvatar
            || (current.groupId !== undefined && current.groupId !== null && current.groupId !== '')) {
            problems.push(`character: the restored conversation is not the original character (${snapshot.characterAvatar}).`);
            return;
        }

        const targetChatId = String(snapshot.chatId ?? '');
        if (targetChatId && String(current.chatId ?? '') !== targetChatId) {
            if (typeof current.openCharacterChat !== 'function') {
                problems.push('character chat: the host cannot reopen the original chat because openCharacterChat is unavailable.');
                return;
            }
            try {
                const opened = await current.openCharacterChat(snapshot.chatId);
                if (opened === false) {
                    problems.push(`character chat: opening "${targetChatId}" was refused.`);
                    return;
                }
            } catch (error) {
                problems.push(`character chat: opening "${targetChatId}" failed: ${error?.message ?? error}`);
                return;
            }
        }
        const verified = ctxOf(hostRef);
        if (getCharacterAvatar(hostRef) !== snapshot.characterAvatar) {
            problems.push(`character: the restored conversation is not the original character (${snapshot.characterAvatar}).`);
        }
        if (String(verified.chatId ?? '') !== targetChatId) {
            problems.push(`character chat: the restored chat is "${verified.chatId ?? ''}", not "${targetChatId}".`);
        }
        return;
    }

    const current = ctxOf(hostRef);
    if (typeof current.closeCurrentChat !== 'function') {
        problems.push('conversation: the host cannot close the current conversation because closeCurrentChat is unavailable.');
        return;
    }
    try {
        const closed = await current.closeCurrentChat();
        if (closed === false) {
            problems.push('conversation: the host refused to close the current conversation.');
            return;
        }
    } catch (error) {
        problems.push(`conversation: closing the current conversation failed: ${error?.message ?? error}`);
        return;
    }
    if (hasConversation(ctxOf(hostRef))) {
        problems.push('conversation: closing the current conversation did not leave an empty context.');
    }
}

/**
 * Puts the user's configuration back. Every step is guarded: a failure to
 * restore one thing must not stop the others from being restored.
 * Returns the list of things that could not be put back.
 */
export async function restoreState(hostRef = getContext, snapshot = null) {
    const problems = [];
    if (!snapshot) {
        return problems;
    }

    // Restore the conversation first. Opening it can re-apply a chat-locked
    // persona or preset, so those settings are deliberately restored below.
    try {
        await restoreConversation(hostRef, snapshot, problems);
    } catch (error) {
        problems.push(`conversation: ${error?.message ?? error}`);
    }

    try {
        if (snapshot.personaKey && ctxOf(hostRef)?.userAvatar !== snapshot.personaKey) {
            if (typeof ctxOf(hostRef)?.executeSlashCommandsWithOptions !== 'function') {
                problems.push('persona: the host cannot restore the original persona because its slash-command API is unavailable.');
            } else {
                await runSlash(hostRef, `/persona-set mode=lookup ${quoteSlashArg(snapshot.personaKey)}`);
                if (ctxOf(hostRef)?.userAvatar !== snapshot.personaKey) {
                    problems.push(`persona: the restored persona is "${ctxOf(hostRef)?.userAvatar ?? ''}", not "${snapshot.personaKey}".`);
                }
            }
        }
    } catch (error) {
        problems.push(`persona: ${error?.message ?? error}`);
    }

    try {
        if (getSelectedProfileId(hostRef) !== snapshot.profileId) {
            const profile = snapshot.profileId ? resolveProfile(hostRef, snapshot.profileId) : null;
            if (snapshot.profileId && !profile) {
                problems.push(`connection profile: the original profile (${snapshot.profileId}) is no longer available.`);
            } else if (typeof ctxOf(hostRef)?.executeSlashCommandsWithOptions !== 'function') {
                problems.push('connection profile: the host cannot restore the original profile because its slash-command API is unavailable.');
            } else {
                const loaded = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CONNECTION_PROFILE_LOADED);
                await runSlash(hostRef, `/profile await=true ${quoteSlashArg(profile?.name ?? NONE_PROFILE)}`);
                await loaded;
                if (getSelectedProfileId(hostRef) !== snapshot.profileId) {
                    problems.push(`connection profile: the restored profile is "${getSelectedProfileId(hostRef)}", not "${snapshot.profileId}".`);
                }
            }
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
            const restored = await selectPreset(hostRef, apiId, presetName);
            if (!restored) {
                problems.push(`preset "${presetName}" (${apiId}) is no longer available.`);
            }
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
export async function willCreateChatFile(hostRef = getContext, avatar = '') {
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
