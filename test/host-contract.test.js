import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { publishPreset, requestJson } from '../src/host.js';

/**
 * Tripwire for SillyBunny upgrades. Prompting Lab reads a number of host
 * internals that upstream syncs can move or rename; this test fails loudly
 * when one of them changes, instead of the extension failing silently.
 */

const hostRoot = process.env.SILLYBUNNY_ROOT || '/home/platinum/SillyBunny';
const requireHost = process.env.npm_lifecycle_event === 'test:host';

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

function bracedBlock(source, open) {
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

/** Extracts one function's body by matching braces from its declaration. */
function functionBody(source, name) {
    const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
    return start < 0 ? '' : bracedBlock(source, source.indexOf('{', start));
}

function returnedObject(source, name) {
    const body = functionBody(source, name);
    const start = body.search(/\breturn\s*\{/);
    return start < 0 ? '' : bracedBlock(body, body.indexOf('{', start));
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

test('preset publishing rejects names the host would sanitize before making a request', async () => {
    const previousFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    };
    try {
        for (const name of [
            '',
            '.',
            '..',
            '...',
            'bad/name',
            'bad?name',
            'bad<name',
            'bad>name',
            'bad\\name',
            'bad:name',
            'bad*name',
            'bad|name',
            'bad"name',
            'bad\u0000name',
            'bad\u0080name',
            'CON',
            'prn.json',
            'COM0',
            'lpt9.backup',
            'trailing.',
            'trailing ',
            '\u00e9'.repeat(128),
        ]) {
            await assert.rejects(() => publishPreset('context', name, {}), /safe as a filename/);
        }
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.equal(requests, 0, 'unsafe names must be rejected before the catalogue lookup');
});

test('preset publishing keeps the exact case-insensitive catalogue collision check', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url) => {
        requests.push(url);
        return new Response(JSON.stringify({ context: [{ name: 'Release', marker: true }] }), {
            headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        await assert.rejects(
            () => publishPreset('context', 'release', {}),
            /already has a context preset called "release"/,
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.deepEqual(requests, ['/api/settings/get']);
});

test('preset publishing forwards its signal to catalogue and save requests', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, signal: options.signal });
        const data = url === '/api/settings/get' ? {} : { name: 'Release' };
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
        assert.equal(
            await publishPreset('context', 'Release', {}, { signal: controller.signal }),
            'Release',
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.deepEqual(requests.map(request => request.url), ['/api/settings/get', '/api/presets/save']);
    assert.ok(requests.every(request => request.signal === controller.signal));
});

test('the CSRF retry path does not swallow cancellation', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    const reason = new Error('cancelled publish');
    let requestSignal = null;
    globalThis.fetch = async (_url, options) => {
        requestSignal = options.signal;
        controller.abort(reason);
        return new Response('', { status: 403 });
    };
    try {
        await assert.rejects(
            () => requestJson('/api/presets/save', {}, { signal: controller.signal }),
            error => error === reason,
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.equal(requestSignal, controller.signal);
});

test('SillyBunny exposes the host contracts used by Prompting Lab', {
    skip: !(await available()) && !requireHost,
}, async () => {
    assert.equal(await available(), true, `SillyBunny checkout not found at ${hostRoot}`);

    const [script, openai, tokenCounts, utils, context, events, lib, converters, shared, indexHtml, presetManager, charactersEndpoint] = await Promise.all([
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
        readFile(path.join(hostRoot, 'public/scripts/preset-manager.js'), 'utf8'),
        readFile(path.join(hostRoot, 'src/endpoints/characters.js'), 'utf8'),
    ]);

    await test('Generate still accepts a dry-run flag', () => {
        assert.match(script, /export\s+async\s+function\s+Generate\s*\([^)]*dryRun\s*=\s*false\s*\)/s);
        // The dry run must return before the request is sent.
        assert.match(script, /if\s*\(dryRun\)\s*\{\s*return\s+Promise\.resolve\(\)/);
    });

    await test('prompt capture events exist and carry the dry-run flag', () => {
        for (const event of [
            'GENERATION_STARTED',
            'GENERATION_AFTER_COMMANDS',
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
        assert.match(script, /event_types\.GENERATION_AFTER_COMMANDS,[^;]*dryRun/s);
        assert.match(script, /event_types\.GENERATE_AFTER_COMBINE_PROMPTS,\s*eventData/);
        assert.match(openai, /event_types\.CHAT_COMPLETION_PROMPT_READY,\s*eventData/);
    });

    await test('the event emitter still supports ordering guard and capture listeners', async () => {
        const emitter = await readFile(path.join(hostRoot, 'public/lib/eventemitter.js'), 'utf8');
        assert.match(emitter, /makeFirst/);
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
        const contextObject = returnedObject(context, 'getContext');
        assert.ok(contextObject, 'getContext returned object could not be found');
        for (const api of [
            'generate',
            'activateSendButtons',
            'deactivateSendButtons',
            'selectCharacterById',
            'unshallowCharacter',
            'getCharacterCardFields',
            'executeSlashCommandsWithOptions',
            'SlashCommandParser',
            'ConnectionManagerRequestService',
            'promptManager',
            'getTokenCountAsync',
            'extensionSettings',
            'saveSettingsDebounced',
            'getPresetManager',
            'characters',
            'groups',
            'openCharacterChat',
            'openGroupChat',
            'closeCurrentChat',
        ]) {
            assert.match(contextObject, new RegExp(`(?:^|[,{])\\s*${api}\\s*(?=[:,])`), `context.${api} is missing`);
        }
    });

    await test('character cards accept the checked merge endpoint shape', () => {
        const route = charactersEndpoint.match(/router\.post\('\/merge-attributes'[\s\S]*?(?=\nrouter\.post\()/)?.[0] ?? '';
        assert.ok(route, 'character merge-attributes route is missing');
        assert.match(route, /const update = request\.body/);
        assert.match(route, /update\.avatar/);
        assert.match(route, /mergeCharacterUpdate\(avatarPath, update\.avatar, update, request\)/);
        assert.match(route, /result\.ok[\s\S]*response\.sendStatus\(200\)/);

        // Prompting Lab sends { avatar, data: { extensions: ... } }. The route
        // must remove only the locator and merge the remaining data object.
        const merge = functionBody(charactersEndpoint, 'mergeCharacterUpdate');
        assert.match(merge, /_\.unset\(update, 'avatar'\)/);
        assert.match(merge, /deepMerge\(character, update\)/);
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

    await test('the Claude conversion blocks still match the cache model', () => {
        const body = functionBody(converters, 'convertClaudeMessages');
        assert.ok(body, 'convertClaudeMessages could not be found');
        assert.match(body, /if\s*\(\s*useSysPrompt\s*\)/, 'system prompt handling changed');
        assert.match(body, /messages\.splice\(0,\s*i\)/, 'leading system messages are no longer removed');
        assert.match(body, /message\.role\s*=\s*'user'/, 'internal system messages are no longer rewritten');
        assert.match(body, /mergedMessages/, 'same-role messages are no longer merged');
        assert.match(body, /content\.push\(\.\.\.message\.content\)/, 'merged message content order changed');
        const fingerprint = body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
        assert.equal(
            hash(fingerprint),
            'a79cf062',
            'convertClaudeMessages changed. Re-check src/cache-analyzer.js against it, then update this fingerprint.',
        );
    });

    await test('preset dirty checks expose their side-effect state', () => {
        assert.match(presetManager, /_checkDirty\(\{\s*force\s*=\s*false\s*\}\s*=\s*\{\}\)/);
        assert.match(presetManager, /this\._dirty\s*=\s*dirty/);
    });

    await test('the preset workshop can read and publish presets', async () => {
        const [presetEndpoint, settingsEndpoint] = await Promise.all([
            readFile(path.join(hostRoot, 'src/endpoints/presets.js'), 'utf8'),
            readFile(path.join(hostRoot, 'src/endpoints/settings.js'), 'utf8'),
        ]);

        // The host sanitizes names and overwrites by default. The Lab can only
        // validate and check the catalogue before this non-atomic save.
        const saveRoute = presetEndpoint.match(/router\.post\('\/save'[\s\S]*?(?=\nrouter\.post\('\/delete')/)?.[0] ?? '';
        assert.ok(saveRoute, 'preset save route is missing');
        assert.match(saveRoute, /sanitize\(request\.body\.name\)/);
        assert.match(saveRoute, /request\.body\.apiId/);
        assert.match(saveRoute, /tryWriteFileSync\(\s*fullpath,\s*JSON\.stringify\(\s*request\.body\.preset,\s*null,\s*4\s*\)\s*\)/);
        assert.doesNotMatch(saveRoute, /expectedFileAbsent\s*:\s*true|existsSync\(\s*fullpath\s*\)|['"]wx['"]/, 'preset saves gained create-only support; revisit publishPreset and this contract');
        assert.match(saveRoute, /response\.send\(\{\s*name\s*\}\)/);

        // The workshop reads the installed catalogue from this route, so the
        // six lists it splits apart have to keep their names and shapes.
        assert.match(settingsEndpoint, /router\.post\('\/get'/);
        for (const key of [
            'openai_settings',
            'openai_setting_names',
            'textgenerationwebui_presets',
            'textgenerationwebui_preset_names',
            'instruct',
            'context',
            'sysprompt',
            'reasoning',
        ]) {
            assert.match(settingsEndpoint, new RegExp(`\\b${key}\\b`), `${key} is missing from the settings payload`);
        }

        // A stale token has to be refreshable, otherwise publishing fails
        // after a long editing session.
        assert.match(script, exportPattern('refreshCsrfToken'));
        assert.match(context, /\bgetRequestHeaders\b/);

        // Reading an installed preset without touching live settings.
        assert.match(presetManager, /getCompletionPresetByName\s*\(/);
        assert.match(presetManager, /getAllPresets\s*\(/);
        assert.match(presetManager, /findPreset\s*\(/);
        assert.match(presetManager, /getSelectedPresetName\s*\(/);

        // Native chat completion imports announce themselves, so anything
        // listening for a new preset still hears the Lab's publish.
        assert.match(events, /OAI_PRESET_IMPORT_READY/);
        assert.match(openai, /event_types\.OAI_PRESET_IMPORT_READY/);
    });

    await test('prompt editors can borrow the host macro and fullscreen helpers', async () => {
        const chats = await readFile(path.join(hostRoot, 'public/scripts/chats.js'), 'utf8');
        const macros = await readFile(path.join(hostRoot, 'public/scripts/autocomplete/MacroAutoComplete.js'), 'utf8');

        // A textarea gains macro completion by carrying these attributes.
        assert.match(macros, /data-macros/);
        assert.match(macros, /data-macros-autocomplete/);

        // The large editor is delegated, so a button added later still works.
        assert.match(chats, /\.editor_maximize/);
        assert.match(chats, /data-for/);
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
