import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { SETTINGS_KEY, TAB } = await import('../src/constants.js');
const {
    clearSettings,
    dismissWarning,
    getSettings,
    isWarningDismissed,
    migrateSettings,
    normalizeSettings,
    updateSettings,
} = await import('../src/settings.js');

function freshContext() {
    const { ctx } = installStubContext();
    return ctx;
}

test.after(() => removeStubContext());

test('normalizeSettings fills in defaults for junk input', () => {
    const settings = normalizeSettings(null);
    assert.equal(settings.schemaVersion, 1);
    assert.equal(settings.lastTab, TAB.CASES);
    assert.equal(settings.manualCachingAtDepth, null);
    assert.equal(settings.runRetention, 20);
    assert.equal(settings.normalizeVolatile, true);
    assert.deepEqual(settings.dismissedWarnings, {});
});

test('normalizeSettings clamps numbers into supported ranges', () => {
    assert.equal(normalizeSettings({ runRetention: 9999 }).runRetention, 200);
    assert.equal(normalizeSettings({ runRetention: 0 }).runRetention, 1);
    assert.equal(normalizeSettings({ abMaxTokens: 1 }).abMaxTokens, 16);
    assert.equal(normalizeSettings({ abMaxTokens: 999999 }).abMaxTokens, 4096);
});

test('normalizeSettings only accepts a whole, non-negative caching depth', () => {
    assert.equal(normalizeSettings({ manualCachingAtDepth: 2 }).manualCachingAtDepth, 2);
    assert.equal(normalizeSettings({ manualCachingAtDepth: 0 }).manualCachingAtDepth, 0);
    assert.equal(normalizeSettings({ manualCachingAtDepth: null }).manualCachingAtDepth, null);
    assert.equal(normalizeSettings({ manualCachingAtDepth: '' }).manualCachingAtDepth, null);
    assert.equal(normalizeSettings({ manualCachingAtDepth: '2' }).manualCachingAtDepth, null);
    assert.equal(normalizeSettings({ manualCachingAtDepth: -1 }).manualCachingAtDepth, null);
    assert.equal(normalizeSettings({ manualCachingAtDepth: 1.5 }).manualCachingAtDepth, null);
    assert.equal(normalizeSettings({ manualCachingAtDepth: 'deep' }).manualCachingAtDepth, null);
});

test('normalizing settings is idempotent across storage round-trips', () => {
    const inputs = [
        {},
        { manualCachingAtDepth: null },
        { manualCachingAtDepth: 0 },
        { manualCachingAtDepth: 4 },
        { manualCachingAtDepth: '4' },
    ];
    for (const input of inputs) {
        const once = normalizeSettings(input);
        assert.deepEqual(normalizeSettings(once), once);
    }
});

test('normalizeSettings rejects an unknown tab and non-true dismissals', () => {
    assert.equal(normalizeSettings({ lastTab: 'nope' }).lastTab, TAB.CASES);
    assert.equal(normalizeSettings({ lastTab: TAB.DIFF }).lastTab, TAB.DIFF);
    assert.deepEqual(
        normalizeSettings({ dismissedWarnings: { a: true, b: false, c: 'yes' } }).dismissedWarnings,
        { a: true },
    );
});

test('migrateSettings normalizes an unversioned blob', () => {
    const settings = migrateSettings({ runRetention: 5 });
    assert.equal(settings.schemaVersion, 1);
    assert.equal(settings.runRetention, 5);
});

test('getSettings writes the repaired object back into the host settings', () => {
    const ctx = freshContext();
    ctx.extensionSettings[SETTINGS_KEY] = { runRetention: 'bad' };
    const settings = getSettings();
    assert.equal(settings.runRetention, 20);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].runRetention, 20);
});

test('updateSettings merges a patch and asks the host to save', () => {
    const ctx = freshContext();
    let saves = 0;
    ctx.saveSettingsDebounced = () => { saves++; };
    const next = updateSettings({ runRetention: 50 });
    assert.equal(next.runRetention, 50);
    assert.equal(ctx.extensionSettings[SETTINGS_KEY].runRetention, 50);
    assert.equal(saves, 1);
});

test('warnings can be dismissed and stay dismissed', () => {
    freshContext();
    assert.equal(isWarningDismissed('chat-file'), false);
    dismissWarning('chat-file');
    assert.equal(isWarningDismissed('chat-file'), true);
    updateSettings({ runRetention: 30 });
    assert.equal(isWarningDismissed('chat-file'), true);
});

test('clearSettings removes the extension key entirely', () => {
    const ctx = freshContext();
    updateSettings({ runRetention: 33 });
    assert.ok(ctx.extensionSettings[SETTINGS_KEY]);
    clearSettings();
    assert.equal(SETTINGS_KEY in ctx.extensionSettings, false);
});
