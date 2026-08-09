import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { EXPORT_FORMAT, EXPORT_VERSION, MAX_EXPORT_WITH_BASELINES_BYTES } = await import('../src/constants.js');
const { createCase, createDraft, createSuite } = await import('../src/schema.js');
const { KIND, buildExport, formatSize, parseImport, suggestedFileName } = await import('../src/transfer.js');
const {
    PRIVACY_NOTICE,
    adoptEmbeddedCases,
    embeddedSize,
    findCharactersWithTests,
    readEmbeddedCases,
    stripForEmbedding,
    writeEmbeddedCases,
} = await import('../src/embed.js');

test.after(() => removeStubContext());

function sampleSuite() {
    const caseA = createCase({
        name: 'Aqua greeting',
        pins: { characterAvatar: 'aqua.png', connectionProfileId: 'p1', personaKey: 'me.png' },
        userMessage: 'Hello',
        assertions: [{ type: 'section-present', section: 'main' }],
    });
    const suite = createSuite({ name: 'My suite', caseIds: [caseA.id] });
    return { suite, cases: [caseA] };
}

/* ------------------------------------------------------------- exporting */

test('an exported suite carries its cases and identifies itself', () => {
    const { suite, cases } = sampleSuite();
    const { text, kind } = buildExport(suite, cases);
    const payload = JSON.parse(text);
    assert.equal(payload.format, EXPORT_FORMAT);
    assert.equal(payload.version, EXPORT_VERSION);
    assert.equal(kind, KIND.SUITE);
    assert.equal(payload.cases.length, 1);
    assert.equal(payload.suite.name, 'My suite');
});

test('presets travel with the suite and arrive as fresh drafts', () => {
    const { suite, cases } = sampleSuite();
    const draft = createDraft({ apiId: 'openai', name: 'Deep', payload: { prompts: [] } });
    const payload = JSON.parse(buildExport(suite, cases, null, [draft]).text);
    assert.equal(payload.presets.length, 1);

    const imported = parseImport(JSON.stringify(payload));
    assert.equal(imported.presets.length, 1);
    assert.equal(imported.presets[0].name, 'Deep');
    assert.notEqual(imported.presets[0].id, draft.id);
    assert.equal(imported.presets[0].publishedAs, '');
});

test('exporting without results drops baseline pointers that would dangle', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const payload = JSON.parse(buildExport(suite, cases).text);
    assert.deepEqual(payload.suite.baselines, {});
});

test('exporting with results keeps the baselines and marks the kind', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const runs = [{ v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' }];
    const { text, kind } = buildExport(suite, cases, runs);
    const payload = JSON.parse(text);
    assert.equal(kind, KIND.SUITE_WITH_BASELINES);
    assert.equal(payload.baselineRuns.length, 1);
    assert.deepEqual(payload.suite.baselines, { [cases[0].id]: 'run-1' });
});

test('exporting baselines keeps only matching pointers and runs', () => {
    const { suite, cases } = sampleSuite();
    const second = createCase({ name: 'Second', pins: { characterAvatar: 'aqua.png' } });
    cases.push(second);
    suite.caseIds.push(second.id);
    suite.baselines = { [cases[0].id]: 'run-1', [second.id]: 'run-2' };
    const payload = JSON.parse(buildExport(suite, cases, [
        { v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' },
        { v: 1, id: 'run-2', caseId: 'wrong-case', status: 'pass' },
        { v: 1, id: 'extra', caseId: cases[0].id, status: 'pass' },
    ]).text);

    assert.deepEqual(payload.suite.baselines, { [cases[0].id]: 'run-1' });
    assert.deepEqual(payload.baselineRuns.map(run => run.id), ['run-1']);
    assert.equal(parseImport(JSON.stringify(payload)).baselineRuns.length, 1);
});

test('an oversized export is refused with advice', () => {
    const { suite } = sampleSuite();
    const huge = Array.from({ length: 400 }, (_, index) => createCase({
        name: `case ${index}`,
        notes: 'x'.repeat(4000),
    }));
    assert.throws(() => buildExport(suite, huge), /larger than the .* limit/);
});

test('file sizes are written for people, not in bytes', () => {
    assert.equal(formatSize(512), '512 bytes');
    assert.match(formatSize(2048), /2\.0 KB/);
    assert.match(formatSize(3 * 1024 * 1024), /3\.0 MB/);
});

test('the suggested file name is safe and readable', () => {
    assert.equal(suggestedFileName({ name: 'My Preset / Suite!' }), 'prompting-lab-my-preset-suite.json');
    assert.equal(suggestedFileName({ name: '' }), 'prompting-lab-suite.json');
});

/* ------------------------------------------------------------- importing */

test('an imported suite gets fresh identifiers so nothing is overwritten', () => {
    const { suite, cases } = sampleSuite();
    const imported = parseImport(buildExport(suite, cases).text);
    assert.notEqual(imported.suite.id, suite.id);
    assert.notEqual(imported.cases[0].id, cases[0].id);
    assert.deepEqual(imported.suite.caseIds, [imported.cases[0].id]);
    assert.equal(imported.cases[0].name, 'Aqua greeting');
});

test('baseline pointers are rewritten to follow the new identifiers', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const runs = [{
        v: 1,
        id: 'run-1',
        suiteId: suite.id,
        suiteRunId: 'old-suite-run',
        caseId: cases[0].id,
        status: 'pass',
    }];
    const imported = parseImport(buildExport(suite, cases, runs).text);
    const newCaseId = imported.cases[0].id;
    const newRunId = imported.baselineRuns[0].id;
    assert.deepEqual(imported.suite.baselines, { [newCaseId]: newRunId });
    assert.equal(imported.baselineRuns[0].caseId, newCaseId);
    assert.equal(imported.baselineRuns[0].suiteId, imported.suite.id);
    assert.notEqual(imported.baselineRuns[0].suiteRunId, 'old-suite-run');
});

test('strict imports reject unreferenced runs added to an export', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const payload = JSON.parse(buildExport(suite, cases, [
        { v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' },
    ]).text);
    payload.baselineRuns.push({
        v: 1,
        id: 'run-ghost',
        caseId: 'case-not-in-this-file',
        status: 'pass',
    });
    assert.throws(() => parseImport(JSON.stringify(payload)), /Every baseline run.*referenced|does not belong/);
});

test('runs from one imported suite run keep a fresh shared group identifier', () => {
    const { suite, cases } = sampleSuite();
    const second = createCase({ name: 'Second', pins: { characterAvatar: 'aqua.png' } });
    cases.push(second);
    suite.caseIds.push(second.id);
    suite.baselines = { [cases[0].id]: 'run-1', [second.id]: 'run-2' };
    const runs = cases.map((testCase, index) => ({
        v: 1,
        id: `run-${index + 1}`,
        suiteId: suite.id,
        suiteRunId: 'shared-old-id',
        caseId: testCase.id,
        status: 'pass',
    }));
    const imported = parseImport(buildExport(suite, cases, runs).text);
    assert.ok(imported.baselineRuns.every(run => run.suiteId === imported.suite.id));
    assert.equal(new Set(imported.baselineRuns.map(run => run.suiteRunId)).size, 1);
    assert.notEqual(imported.baselineRuns[0].suiteRunId, 'shared-old-id');
});

test('importing the same file twice produces two separate suites', () => {
    const { suite, cases } = sampleSuite();
    const text = buildExport(suite, cases).text;
    const first = parseImport(text);
    const second = parseImport(text);
    assert.notEqual(first.suite.id, second.suite.id);
    assert.notEqual(first.cases[0].id, second.cases[0].id);
});

test('unreadable and foreign files are refused in plain language', () => {
    assert.throws(() => parseImport('not json at all'), /not readable as JSON/);
    assert.throws(() => parseImport('[]'), /does not contain a Prompting Lab suite/);
    assert.throws(() => parseImport('{"format":"something-else"}'), /not made by Prompting Lab/);
    assert.throws(() => parseImport(`{"format":"${EXPORT_FORMAT}"}`), /does not say which version/);
});

test('a file from a newer version is refused rather than half understood', () => {
    assert.throws(
        () => parseImport(`{"format":"${EXPORT_FORMAT}","version":99,"suite":{},"cases":[]}`),
        /newer version of Prompting Lab/,
    );
});

test('imports require a supported kind and their required arrays', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    delete payload.kind;
    assert.throws(() => parseImport(JSON.stringify(payload)), /supported Prompting Lab export kind/);

    payload.kind = KIND.SUITE;
    delete payload.cases;
    assert.throws(() => parseImport(JSON.stringify(payload)), /missing its test case list/);

    payload.cases = cases;
    payload.presets = {};
    assert.throws(() => parseImport(JSON.stringify(payload)), /damaged preset draft list/);
});

test('import size is bounded by UTF-8 bytes before JSON parsing', () => {
    const oversized = 'é'.repeat(Math.floor(MAX_EXPORT_WITH_BASELINES_BYTES / 2) + 1);
    assert.throws(() => parseImport(oversized), /larger than the .* import limit/);
});

test('unknown fields in an imported case are dropped', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.cases[0].somethingUnexpected = 'ignore me';
    const imported = parseImport(JSON.stringify(payload));
    assert.equal(imported.cases[0].somethingUnexpected, undefined);
    assert.equal(imported.cases[0].assertions.length, 1);
});

test('invalid assertions are rejected instead of normalized to defaults', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.cases[0].assertions = [{
        type: 'content-match',
        scope: 'final',
        mode: 'not-a-mode',
        value: 'text',
        negate: false,
    }];
    assert.throws(() => parseImport(JSON.stringify(payload)), /invalid assertion/);
});

test('duplicate, null, and orphan test cases are rejected', () => {
    const { suite, cases } = sampleSuite();
    const duplicate = JSON.parse(buildExport(suite, cases).text);
    duplicate.cases.push({ ...duplicate.cases[0] });
    assert.throws(() => parseImport(JSON.stringify(duplicate)), /two test cases/);

    const missing = JSON.parse(buildExport(suite, cases).text);
    missing.cases = [null];
    assert.throws(() => parseImport(JSON.stringify(missing)), /test case 1.*missing or damaged/);

    const orphan = JSON.parse(buildExport(suite, cases).text);
    orphan.cases.push({ ...orphan.cases[0], id: 'orphan-case' });
    assert.throws(() => parseImport(JSON.stringify(orphan)), /Every test case.*belong/);
});

test('duplicate and null baseline runs are rejected', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const runs = [{ v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' }];
    const duplicate = JSON.parse(buildExport(suite, cases, runs).text);
    duplicate.baselineRuns.push({ ...duplicate.baselineRuns[0] });
    assert.throws(() => parseImport(JSON.stringify(duplicate)), /two baseline runs/);

    const missing = JSON.parse(buildExport(suite, cases, runs).text);
    missing.baselineRuns = [null];
    assert.throws(() => parseImport(JSON.stringify(missing)), /baseline run 1.*missing or damaged/);
});

test('invalid preset drafts are rejected', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.presets = [{ v: 1, id: 'bad-draft', apiId: 'unknown', name: 'Bad', payload: {} }];
    assert.throws(() => parseImport(JSON.stringify(payload)), /Preset draft.*invalid/);
});

test('imports reject oversized regex assertions before storing them', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.cases[0].assertions = [{
        type: 'content-match',
        mode: 'regex',
        value: 'a'.repeat(513),
    }];
    assert.throws(() => parseImport(JSON.stringify(payload)), /search pattern is too long.*512/);
});

/* ------------------------------------------------- embedding into a card */

test('embedding drops the pins that only make sense on one installation', () => {
    const stripped = stripForEmbedding(createCase({
        name: 'Travels',
        pins: { characterAvatar: 'aqua.png', connectionProfileId: 'p1', personaKey: 'me.png' },
        userMessage: 'Hello',
    }));
    assert.equal(stripped.pins.characterAvatar, '');
    assert.equal(stripped.pins.connectionProfileId, '');
    assert.equal(stripped.pins.personaKey, null);
    assert.equal(stripped.userMessage, 'Hello');
});

test('the privacy notice says what travels with the card', () => {
    assert.match(PRIVACY_NOTICE, /saved inside the character card/);
    assert.match(PRIVACY_NOTICE, /never included/);
});

test('cases use the checked merge endpoint and update local data after success', async () => {
    const raw = { name: 'Aqua', data: { extensions: { existing: true } } };
    const context = {
        characterId: 0,
        characters: [{
            avatar: 'aqua.png',
            name: 'Aqua',
            data: { extensions: {} },
            json_data: JSON.stringify(raw),
        }],
    };
    const previousFetch = globalThis.fetch;
    const previousDocument = globalThis.document;
    const hidden = { value: 'old' };
    let request = null;
    globalThis.document = {
        querySelector: selector => selector === '#character_json_data' ? hidden : null,
    };
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return new Response('OK', { status: 200 });
    };
    let payload;
    try {
        payload = await writeEmbeddedCases(context, 'aqua.png', [createCase({ name: 'Embedded' })]);
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.document = previousDocument;
    }
    assert.equal(request.url, '/api/characters/merge-attributes');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {
        avatar: 'aqua.png',
        data: { extensions: { SillyBunnyPromptingLab: payload } },
    });
    const read = readEmbeddedCases(context, 'aqua.png');
    assert.equal(read.length, 1);
    assert.equal(read[0].name, 'Embedded');
    const jsonData = JSON.parse(context.characters[0].json_data);
    assert.equal(jsonData.data.extensions.existing, true);
    assert.deepEqual(jsonData.data.extensions.SillyBunnyPromptingLab, payload);
    assert.equal(hidden.value, context.characters[0].json_data);
});

test('server success preserves malformed raw character JSON', async () => {
    const malformed = '{not valid json';
    const context = {
        characterId: 0,
        characters: [{ avatar: 'aqua.png', data: { extensions: {} }, json_data: malformed }],
    };
    const previousFetch = globalThis.fetch;
    const previousDocument = globalThis.document;
    const hidden = { value: malformed };
    globalThis.document = { querySelector: () => hidden };
    globalThis.fetch = async () => new Response('OK', { status: 200 });
    let payload;
    try {
        payload = await writeEmbeddedCases(context, 'aqua.png', [createCase({ name: 'Embedded' })]);
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.document = previousDocument;
    }
    assert.strictEqual(context.characters[0].data.extensions.SillyBunnyPromptingLab, payload);
    assert.equal(context.characters[0].json_data, malformed);
    assert.equal(hidden.value, malformed);
});

test('a failed character merge rejects without changing local card data', async () => {
    const existing = { v: 1, cases: [{ id: 'existing', name: 'Keep me' }] };
    const jsonData = JSON.stringify({
        data: { extensions: { SillyBunnyPromptingLab: existing } },
    });
    const context = {
        characterId: 0,
        characters: [{
            avatar: 'aqua.png',
            data: { extensions: { SillyBunnyPromptingLab: existing } },
            json_data: jsonData,
        }],
    };
    const before = structuredClone(context.characters[0].data);
    const previousFetch = globalThis.fetch;
    const previousDocument = globalThis.document;
    const hidden = { value: jsonData };
    globalThis.document = { querySelector: () => hidden };
    globalThis.fetch = async () => new Response('failed', { status: 500 });
    try {
        await assert.rejects(
            () => writeEmbeddedCases(context, 'aqua.png', [createCase({ name: 'Replacement' })]),
            /refused the request \(500\)/,
        );
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.document = previousDocument;
    }
    assert.deepEqual(context.characters[0].data, before);
    assert.strictEqual(context.characters[0].data.extensions.SillyBunnyPromptingLab, existing);
    assert.equal(context.characters[0].json_data, jsonData);
    assert.equal(hidden.value, jsonData);
});

test('writing to a character that is not installed says so', async () => {
    const context = { characters: [] };
    await assert.rejects(
        () => writeEmbeddedCases(context, 'missing.png', []),
        /not installed/,
    );
});

test('embedded cases from a newer version are left alone', () => {
    const context = {
        characters: [{
            avatar: 'aqua.png',
            data: { extensions: { SillyBunnyPromptingLab: { v: 99, cases: [{ name: 'future' }] } } },
        }],
    };
    assert.deepEqual(readEmbeddedCases(context, 'aqua.png'), []);
});

test('writing refuses to overwrite embedded data from a newer version', async () => {
    const future = { v: 99, cases: [{ id: 'future' }], unknown: { keep: true } };
    let requests = 0;
    const context = {
        characters: [{
            avatar: 'aqua.png',
            data: { extensions: { SillyBunnyPromptingLab: future } },
        }],
    };
    const before = JSON.stringify(future);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        requests += 1;
        return new Response('OK', { status: 200 });
    };
    try {
        await assert.rejects(
            writeEmbeddedCases(context, 'aqua.png', [createCase({ name: 'Replacement' })]),
            /newer version.*cannot be changed/,
        );
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.equal(requests, 0);
    assert.equal(JSON.stringify(context.characters[0].data.extensions.SillyBunnyPromptingLab), before);
});

test('a card with no tests reads as empty', () => {
    const context = { characters: [{ avatar: 'aqua.png', data: { extensions: {} } }] };
    assert.deepEqual(readEmbeddedCases(context, 'aqua.png'), []);
    assert.deepEqual(readEmbeddedCases(context, 'nope.png'), []);
});

test('embedding keeps a Prompt Tags profile name but not the local id', () => {
    const stripped = stripForEmbedding(createCase({
        name: 'Tagged',
        pins: {
            characterAvatar: 'aqua.png',
            promptTags: { profileId: 'local-1', profileName: 'Tagged profile' },
        },
    }));
    assert.equal(stripped.pins.promptTags.profileName, 'Tagged profile');
    assert.equal(stripped.pins.promptTags.profileId, '');
});

test('adopting drops assertions rejected by the schema validator', () => {
    const adopted = adoptEmbeddedCases([{
        v: 2,
        id: 'embedded-1',
        name: 'From a shared card',
        assertions: [
            { type: 'content-match', mode: 'regex', value: 'a'.repeat(600) },
            { type: 'content-match', mode: 'regex', value: '[' },
            { type: 'token-ceiling', scope: 'total', max: 0 },
            { type: 'content-match', mode: 'contains', value: 'safe text' },
        ],
        pins: {},
    }], 'aqua.png');
    assert.equal(adopted[0].assertions.length, 1);
    assert.equal(adopted[0].assertions[0].value, 'safe text');
});

test('adopting embedded cases pins them to the card they came from', () => {
    const adopted = adoptEmbeddedCases([stripForEmbedding(createCase({ name: 'Travels' }))], 'aqua.png');
    assert.equal(adopted[0].pins.characterAvatar, 'aqua.png');
    assert.equal(adopted[0].name, 'Travels');
});

test('adopted cases get fresh identifiers', () => {
    const source = stripForEmbedding(createCase({ name: 'Travels' }));
    const [first] = adoptEmbeddedCases([source], 'aqua.png');
    const [second] = adoptEmbeddedCases([source], 'aqua.png');
    assert.notEqual(first.id, second.id);
});

test('cards carrying tests can be listed', () => {
    const context = {
        characters: [
            { avatar: 'a.png', name: 'A', data: { extensions: { SillyBunnyPromptingLab: { v: 1, cases: [{}, {}] } } } },
            { avatar: 'b.png', name: 'B', data: { extensions: {} } },
        ],
    };
    assert.deepEqual(findCharactersWithTests(context), [{ avatar: 'a.png', name: 'A', count: 2 }]);
});

test('the size written into a card can be measured before saving', () => {
    assert.ok(embeddedSize([createCase({ name: 'Sized' })]) > 0);
    assert.equal(embeddedSize([]) > 0, true);
});
