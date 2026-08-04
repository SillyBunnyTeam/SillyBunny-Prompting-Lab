import { DEFAULT_SETTINGS, SETTINGS_KEY, SETTINGS_VERSION, TAB } from './constants.js';
import { getContext } from './host.js';

const TAB_VALUES = new Set(Object.values(TAB));

function integer(value, fallback, min, max) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/**
 * Repairs a stored settings object in place-safe fashion. Every field is
 * rebuilt from defaults, so a partially written or hand-edited blob cannot
 * leave the extension in a broken state.
 */
export function normalizeSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const dismissed = source.dismissedWarnings && typeof source.dismissedWarnings === 'object' && !Array.isArray(source.dismissedWarnings)
        ? source.dismissedWarnings
        : {};
    const dismissedWarnings = {};
    for (const [key, flag] of Object.entries(dismissed)) {
        if (flag === true) {
            dismissedWarnings[key] = true;
        }
    }
    const depth = source.manualCachingAtDepth;
    return {
        schemaVersion: SETTINGS_VERSION,
        lastTab: TAB_VALUES.has(source.lastTab) ? source.lastTab : DEFAULT_SETTINGS.lastTab,
        manualCachingAtDepth: Number.isInteger(Number(depth)) && Number(depth) >= 0
            ? Number(depth)
            : null,
        runRetention: integer(source.runRetention, DEFAULT_SETTINGS.runRetention, 1, 200),
        abMaxTokens: integer(source.abMaxTokens, DEFAULT_SETTINGS.abMaxTokens, 16, 4096),
        normalizeVolatile: typeof source.normalizeVolatile === 'boolean'
            ? source.normalizeVolatile
            : DEFAULT_SETTINGS.normalizeVolatile,
        dismissedWarnings,
    };
}

/**
 * Forward-only migration hook. Kept separate from normalizeSettings so future
 * versions can move fields before the generic repair pass runs.
 */
export function migrateSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    // v0 -> v1: first released schema; nothing to move yet.
    return normalizeSettings(source);
}

export function getSettings() {
    const context = getContext();
    const settings = migrateSettings(context?.extensionSettings?.[SETTINGS_KEY]);
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = settings;
    }
    return settings;
}

export function updateSettings(patch) {
    const context = getContext();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context?.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
        context.saveSettingsDebounced?.();
    }
    return next;
}

export function dismissWarning(key) {
    const settings = getSettings();
    return updateSettings({
        dismissedWarnings: { ...settings.dismissedWarnings, [key]: true },
    });
}

export function isWarningDismissed(key) {
    return getSettings().dismissedWarnings[key] === true;
}

export function clearSettings() {
    const context = getContext();
    if (context?.extensionSettings) {
        delete context.extensionSettings[SETTINGS_KEY];
        context.saveSettingsDebounced?.();
    }
}
