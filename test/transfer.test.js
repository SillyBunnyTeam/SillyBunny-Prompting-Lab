import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { EXPORT_FORMAT, EXPORT_VERSION } = await import('../src/constants.js');
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
    const runs = [{ v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' }];
    const imported = parseImport(buildExport(suite, cases, runs).text);
    const newCaseId = imported.cases[0].id;
    const newRunId = imported.baselineRuns[0].id;
    assert.deepEqual(imported.suite.baselines, { [newCaseId]: newRunId });
    assert.equal(imported.baselineRuns[0].caseId, newCaseId);
});

test('runs for cases missing from the file are dropped on import', () => {
    const { suite, cases } = sampleSuite();
    suite.baselines = { [cases[0].id]: 'run-1' };
    const runs = [
        { v: 1, id: 'run-1', caseId: cases[0].id, status: 'pass' },
        { v: 1, id: 'run-ghost', caseId: 'case-not-in-this-file', status: 'pass' },
    ];
    const payload = JSON.parse(buildExport(suite, cases, runs).text);
    const imported = parseImport(JSON.stringify(payload));
    assert.equal(imported.baselineRuns.length, 1, 'the orphan run must not be stored under a foreign case id');
    assert.equal(imported.baselineRuns[0].caseId, imported.cases[0].id);
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

test('unknown fields in an imported case are dropped', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.cases[0].somethingUnexpected = 'ignore me';
    payload.cases[0].assertions.push({ type: 'from-the-future' });
    const imported = parseImport(JSON.stringify(payload));
    assert.equal(imported.cases[0].somethingUnexpected, undefined);
    assert.equal(imported.cases[0].assertions.length, 1);
});

test('imports reject oversized regex assertions before storing them', () => {
    const { suite, cases } = sampleSuite();
    const payload = JSON.parse(buildExport(suite, cases).text);
    payload.cases[0].assertions = [{
        type: 'content-match',
        mode: 'regex',
        value: 'a'.repeat(513),
    }];
    assert.throws(() => parseImport(JSON.stringify(payload)), /longer than the 512-character limit/);
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

test('cases can be written into and read back out of a card', async () => {
    const context = {
        characters: [{ avatar: 'aqua.png', name: 'Aqua', data: { extensions: {} } }],
        writeExtensionField: async (index, key, value) => {
            context.characters[index].data.extensions[key] = value;
        },
    };
    await writeEmbeddedCases(context, 'aqua.png', [createCase({ name: 'Embedded' })]);
    const read = readEmbeddedCases(context, 'aqua.png');
    assert.equal(read.length, 1);
    assert.equal(read[0].name, 'Embedded');
});

test('writing to a character that is not installed says so', async () => {
    const context = { characters: [], writeExtensionField: async () => {} };
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

test('adopting drops oversized regex checks the way file import refuses them', () => {
    const adopted = adoptEmbeddedCases([{
        v: 2,
        id: 'embedded-1',
        name: 'From a shared card',
        assertions: [
            { type: 'content-match', mode: 'regex', value: 'a'.repeat(600) },
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
