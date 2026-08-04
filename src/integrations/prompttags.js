import { ctxOf } from '../host.js';

/**
 * Reads the Prompt Tags extension's configuration.
 *
 * Prompt Tags publishes no API and raises no events, so its settings blob is
 * read directly and its slash command is used to switch profiles. Everything
 * here degrades quietly when the extension is not installed.
 */

const SETTINGS_KEY = 'promptTags';

export function isPromptTagsAvailable(hostRef) {
    return Boolean(ctxOf(hostRef)?.extensionSettings?.[SETTINGS_KEY]);
}

export function listPromptTagsProfiles(hostRef) {
    const profiles = ctxOf(hostRef)?.extensionSettings?.[SETTINGS_KEY]?.profiles;
    if (!profiles || typeof profiles !== 'object') {
        return [];
    }
    return Object.entries(profiles).map(([name, profile]) => ({
        name,
        id: typeof profile?.id === 'string' ? profile.id : '',
    }));
}

/**
 * Records which Prompt Tags profile was in force, and which sections it wraps.
 * The wrapping itself is already visible in the captured prompt, because Prompt
 * Tags rewrites the prompt while it is being built.
 */
export function readPromptTags(hostRef) {
    const settings = ctxOf(hostRef)?.extensionSettings?.[SETTINGS_KEY];
    if (!settings) {
        return null;
    }
    const activeName = typeof settings.activeProfile === 'string' ? settings.activeProfile : '';
    const profile = settings.profiles?.[activeName] ?? null;
    const enabledSections = Object.entries(profile?.rules ?? {})
        .filter(([, rule]) => rule?.enabled)
        .map(([section]) => section)
        .sort();
    return {
        enabled: settings.enabled !== false,
        profileName: activeName,
        profileId: typeof settings.activeProfileId === 'string' ? settings.activeProfileId : (profile?.id ?? ''),
        enabledSections,
    };
}
