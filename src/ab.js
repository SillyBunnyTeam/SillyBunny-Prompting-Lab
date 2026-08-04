import { ctxOf, getContext } from './host.js';

/**
 * Sends a captured prompt to one or more connection profiles and returns the
 * replies side by side.
 *
 * Everything here spends tokens, so it only ever runs when the user asks for
 * it. The request goes out under a chosen profile without switching the
 * profile the user is on, and nothing is written to any chat.
 */

/** Profile modes that can be used for a comparison. */
export function isProfileUsable(hostRef, profile) {
    const service = ctxOf(hostRef)?.ConnectionManagerRequestService;
    if (!service || !profile) {
        return false;
    }
    try {
        if (typeof service.isProfileSupported === 'function') {
            return Boolean(service.isProfileSupported(profile));
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * The profiles a comparison can use, each marked with whether it is usable and
 * why not when it is not.
 */
export function listComparableProfiles(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const profiles = context?.extensionSettings?.connectionManager?.profiles ?? [];
    return profiles
        .filter(profile => profile?.id)
        .map(profile => ({
            id: profile.id,
            name: profile.name ?? profile.id,
            mode: profile.mode ?? '',
            model: profile.model ?? '',
            usable: isProfileUsable(hostRef, profile),
        }));
}

/**
 * Sends a prompt, either a message list or one long string, under one
 * profile. Every send this extension makes goes through here.
 *
 * @returns {Promise<{profileId: string, text: string, error: string|null}>}
 */
export async function sendPrompt(profileId, prompt, {
    hostRef = getContext,
    maxTokens = 300,
    signal = null,
} = {}) {
    const context = ctxOf(hostRef);
    const service = context?.ConnectionManagerRequestService;
    if (typeof service?.sendRequest !== 'function') {
        return {
            profileId,
            text: '',
            error: 'Side-by-side replies need the Connection Manager extension, which is not available.',
        };
    }
    if (!prompt || (Array.isArray(prompt) && !prompt.length)) {
        return { profileId, text: '', error: 'There is nothing to send.' };
    }

    try {
        const response = await service.sendRequest(profileId, prompt, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
        const text = typeof response === 'string'
            ? response
            : String(response?.content ?? response?.text ?? '');
        return { profileId, text, error: text ? null : 'The model returned an empty reply.' };
    } catch (error) {
        return { profileId, text: '', error: describeSendError(error) };
    }
}

/**
 * Sends one captured prompt under one profile.
 *
 * @returns {Promise<{profileId: string, text: string, error: string|null}>}
 */
export async function sendUnderProfile(run, profileId, options = {}) {
    const prompt = run?.capture?.messages ?? run?.capture?.combinedPrompt ?? '';
    if (!prompt || (Array.isArray(prompt) && !prompt.length)) {
        return {
            profileId,
            text: '',
            error: 'This run did not capture a prompt, so there is nothing to send.',
        };
    }
    return sendPrompt(profileId, prompt, options);
}

function describeSendError(error) {
    const message = String(error?.message ?? error ?? 'Unknown problem');
    if (/Connection Manager is not available/i.test(message)) {
        return 'The Connection Manager extension is turned off, so a profile cannot be used.';
    }
    if (/does not support chat completions/i.test(message)) {
        return 'This connection profile cannot be used to compare model replies.';
    }
    if (/aborted|AbortError/i.test(message)) {
        return 'Stopped before the model replied.';
    }
    return message;
}

/**
 * Sends the same prompt under two profiles and returns both replies.
 * Requests run at the same time, so one slow backend does not hold up the
 * other, and a failure on one side still returns the other.
 */
export async function compareProfiles(run, profileIds, options = {}) {
    const ids = [...new Set((profileIds ?? []).filter(Boolean))];
    if (!ids.length) {
        return [];
    }
    return Promise.all(ids.map(id => sendUnderProfile(run, id, options)));
}
