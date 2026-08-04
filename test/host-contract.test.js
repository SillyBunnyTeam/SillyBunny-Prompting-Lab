import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

/**
 * Tripwire for SillyBunny upgrades. Prompting Lab reads a number of host
 * internals that upstream syncs can move or rename; this test fails loudly
 * when one of them changes, instead of the extension failing silently.
 */

const hostRoot = process.env.SILLYBUNNY_ROOT || '/home/platinum/SillyBunny';

async function available() {
    try {
        await access(path.join(hostRoot, 'public/script.js'));
        return true;
    } catch {
        return false;
    }
}

function exportPattern(symbol) {
    return new RegExp(`export[^;\\n]*\\b${symbol}\\b|export\\s+(?:async\\s+)?(?:function|class|const|let)\\s+${symbol}\\b`);
}

/** Extracts one function's body by matching braces from its declaration. */
function functionBody(source, name) {
    const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
    if (start < 0) {
        return '';
    }
    const open = source.indexOf('{', start);
    if (open < 0) {
        return '';
    }
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') {
            depth += 1;
        } else if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(open, index + 1);
            }
        }
    }
    return '';
}

/** Small stable hash, so a fingerprint can be written into this file. */
function hash(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, '0');
}

test('SillyBunny exposes the host contracts used by Prompting Lab', {
    skip: !(await available()) && !process.env.PROMPT_LAB_REQUIRE_HOST,
}, async () => {
    assert.equal(await available(), true, `SillyBunny checkout not found at ${hostRoot}`);

    const [script, openai, tokenCounts, utils, context, events, lib, converters, shared, indexHtml] = await Promise.all([
        readFile(path.join(hostRoot, 'public/script.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/openai.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/prompt-token-counts.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/utils.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/st-context.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/events.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/lib.js'), 'utf8'),
        readFile(path.join(hostRoot, 'src/prompt-converters.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/scripts/extensions/shared.js'), 'utf8'),
        readFile(path.join(hostRoot, 'public/index.html'), 'utf8'),
    ]);

    await test('Generate still accepts a dry-run flag', () => {
        assert.match(script, /export\s+async\s+function\s+Generate\s*\([^)]*dryRun\s*=\s*false\s*\)/s);
        // The dry run must return before the request is sent.
        assert.match(script, /if\s*\(dryRun\)\s*\{\s*return\s+Promise\.resolve\(\)/);
    });

    await test('prompt capture events exist and carry the dry-run flag', () => {
        for (const event of [
            'GENERATION_STARTED',
            'GENERATE_BEFORE_COMBINE_PROMPTS',
            'GENERATE_AFTER_COMBINE_PROMPTS',
            'GENERATE_AFTER_DATA',
            'CHAT_COMPLETION_PROMPT_READY',
            'WORLDINFO_SCAN_DONE',
            'CHAT_CHANGED',
            'CONNECTION_PROFILE_LOADED',
            'APP_READY',
            'SETTINGS_UPDATED',
            'CHARACTER_EDITED',
        ]) {
            assert.match(events, new RegExp(`\\b${event}\\b`), `event ${event} is missing`);
        }
        assert.match(script, /event_types\.GENERATE_AFTER_DATA,\s*generate_data,\s*dryRun/);
        assert.match(script, /event_types\.GENERATE_AFTER_COMBINE_PROMPTS,\s*eventData/);
        assert.match(openai, /event_types\.CHAT_COMPLETION_PROMPT_READY,\s*eventData/);
    });

    await test('the event emitter still supports ordering listeners last', async () => {
        const emitter = await readFile(path.join(hostRoot, 'public/lib/eventemitter.js'), 'utf8');
        assert.match(emitter, /makeLast/);
    });

    await test('prompt assembly internals used for section breakdowns exist', () => {
        assert.match(openai, exportPattern('ChatCompletion'));
        assert.match(openai, /async\s+squashSystemMessages\s*\(/);
        assert.match(openai, /squash_system_messages/);
        assert.match(openai, /export\s+let\s+promptManager/);
        for (const method of ['getCollection', 'getItemByIdentifier', 'flatten', 'getTokens']) {
            assert.match(openai, new RegExp(`\\b${method}\\s*\\(`), `MessageCollection.${method} is missing`);
        }
        assert.match(tokenCounts, exportPattern('getPromptDisplayTokenCounts'));
    });

    await test('context exposes the functions the test runner drives', () => {
        for (const api of [
            'generate',
            'selectCharacterById',
            'unshallowCharacter',
            'getCharacterCardFields',
            'executeSlashCommandsWithOptions',
            'ConnectionManagerRequestService',
            'promptManager',
            'writeExtensionField',
            'getTokenCountAsync',
            'extensionSettings',
            'saveSettingsDebounced',
            'getPresetManager',
            'characters',
        ]) {
            assert.match(context, new RegExp(`\\b${api}\\b`), `context.${api} is missing`);
        }
    });

    await test('utils and bundled libraries provide the helpers used here', () => {
        assert.match(utils, exportPattern('getStringHash'));
        assert.match(lib, /window\.localforage\s*=\s*localforage/);
        assert.match(lib, /window\.diff_match_patch\s*=\s*DiffMatchPatch/);
    });

    await test('side-by-side responses can still run under a chosen profile', () => {
        assert.match(shared, /static\s+async\s+sendRequest\s*\(\s*profileId/);
        assert.match(shared, /class\s+ConnectionManagerRequestService/);
    });

    await test('the prompt caching walker still works the way the analyzer mirrors it', () => {
        assert.match(converters, /export\s+function\s+cachingAtDepthForClaude/);

        const body = functionBody(converters, 'cachingAtDepthForClaude');
        assert.ok(body, 'cachingAtDepthForClaude could not be found');

        // Each rule below is reproduced in src/cache-analyzer.js. If one of
        // them changes, the Lab's predicted cache boundaries stop matching
        // where the server actually puts them.
        assert.match(body, /passedThePrefill/, 'the trailing assistant prefill is no longer skipped');
        assert.match(body, /for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1;\s*i\s*>=\s*0;\s*i--/, 'the walk no longer runs backwards');
        assert.match(body, /role\s*!==\s*previousRoleName/, 'depth is no longer counted by role switches');
        assert.match(body, /depth\s*===\s*cachingAtDepth\s*\|\|\s*depth\s*===\s*cachingAtDepth\s*\+\s*2/, 'the two boundary positions changed');
        assert.match(body, /if\s*\(\s*depth\s*===\s*cachingAtDepth\s*\+\s*2\s*\)\s*\{\s*break/, 'the walk no longer stops after the second boundary');
        assert.match(body, /cache_control\s*=\s*\{\s*type:\s*'ephemeral'/, 'the cache marker changed shape');

        // A normalized fingerprint of the whole rule. Whitespace and comments
        // are ignored, so this only trips when the logic itself moves.
        const fingerprint = body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
        assert.equal(
            hash(fingerprint),
            'b29f7070',
            'cachingAtDepthForClaude changed. Re-check src/cache-analyzer.js against it, then update this fingerprint.',
        );
    });

    await test('the extension settings host elements exist', () => {
        assert.match(indexHtml, /id="extensions_settings2"/);
        assert.match(indexHtml, /id="extensions-settings-button"/);
    });

    await test('the slash commands used to apply a configuration exist', async () => {
        const [slash, presets, personas, connectionManager] = await Promise.all([
            readFile(path.join(hostRoot, 'public/scripts/slash-commands.js'), 'utf8'),
            readFile(path.join(hostRoot, 'public/scripts/preset-manager.js'), 'utf8'),
            readFile(path.join(hostRoot, 'public/scripts/personas.js'), 'utf8'),
            readFile(path.join(hostRoot, 'public/scripts/extensions/connection-manager/index.js'), 'utf8'),
        ]);
        assert.match(presets, /name:\s*'preset'/);
        assert.match(personas, /name:\s*'persona-set'/);
        assert.match(connectionManager, /name:\s*'profile'/);
        assert.match(slash, /name:\s*'go'/);
    });
});
