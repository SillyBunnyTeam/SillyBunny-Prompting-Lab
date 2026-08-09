import assert from 'node:assert/strict';
import test from 'node:test';

import { ASSERTION, CASE_VERSION, MAX_REGEX_LENGTH, RUN_VERSION, STATUS } from '../src/constants.js';
import {
    createCase,
    createSuite,
    migrateCase,
    migrateRun,
    migrateSuite,
    newId,
    normalizeAssertion,
    normalizeAssertions,
    normalizeCase,
    normalizePins,
    normalizeRun,
    normalizeSuite,
    resolveStatus,
    validateAssertion,
    validateCase,
} from '../src/schema.js';

test('newId returns distinct identifiers', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    assert.equal(ids.size, 50);
});

test('createCase produces a valid, normalized case', () => {
    const testCase = createCase({ name: 'Aqua greeting' });
    assert.equal(testCase.v, CASE_VERSION);
    assert.equal(testCase.name, 'Aqua greeting');
    assert.deepEqual(testCase.assertions, []);
    assert.equal(testCase.pins.macroEnhanced, 'record');
    assert.equal(testCase.pins.personaKey, null);
});

test('normalizePins keeps identifiers and drops empty optional pins', () => {
    const pins = normalizePins({
        characterAvatar: 'aqua.png',
        connectionProfileId: 'profile-1',
        preset: { apiId: 'openai', name: 'Deep' },
        promptTags: { profileId: '', profileName: '' },
        personaKey: '',
        macroEnhanced: 'off',
    });
    assert.equal(pins.characterAvatar, 'aqua.png');
    assert.deepEqual(pins.presets, [{ apiId: 'openai', name: 'Deep' }]);
    assert.equal(pins.promptTags, null);
    assert.equal(pins.personaKey, null);
    assert.equal(pins.macroEnhanced, 'off');
});

test('normalizePins tolerates junk input', () => {
    const pins = normalizePins(null);
    assert.equal(pins.characterAvatar, '');
    assert.deepEqual(pins.presets, []);
    assert.equal(pins.macroEnhanced, 'record');
});

test('normalizeAssertion shapes each supported type', () => {
    assert.deepEqual(
        normalizeAssertion({ type: ASSERTION.SECTION_PRESENT, section: 'main', extra: 'ignored' }),
        { type: ASSERTION.SECTION_PRESENT, section: 'main' },
    );
    assert.deepEqual(
        normalizeAssertion({ type: ASSERTION.TOKEN_CEILING, max: '1200' }),
        { type: ASSERTION.TOKEN_CEILING, scope: 'total', max: 1200 },
    );
    assert.deepEqual(
        normalizeAssertion({ type: ASSERTION.CONTENT_MATCH, value: 'Aqua', mode: 'nonsense' }),
        { type: ASSERTION.CONTENT_MATCH, scope: 'final', mode: 'contains', value: 'Aqua', negate: false },
    );
    assert.deepEqual(
        normalizeAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }),
        { type: ASSERTION.CACHE_PREFIX_STABLE },
    );
});

test('normalizeAssertions drops unknown types instead of passing them through', () => {
    const assertions = normalizeAssertions([
        { type: ASSERTION.SECTION_PRESENT, section: 'main' },
        { type: 'from-a-newer-version', section: 'main' },
        null,
    ]);
    assert.equal(assertions.length, 1);
    assert.equal(assertions[0].type, ASSERTION.SECTION_PRESENT);
});

test('validateAssertion explains problems in plain language', () => {
    assert.deepEqual(validateAssertion({ type: ASSERTION.SECTION_PRESENT, section: '' }), [
        'Choose which prompt section to check.',
    ]);
    assert.deepEqual(validateAssertion({ type: ASSERTION.TOKEN_CEILING, max: 0 }), [
        'Set a token limit above zero.',
    ]);
    assert.deepEqual(validateAssertion({ type: ASSERTION.CONTENT_MATCH, value: '' }), [
        'Enter the text to look for.',
    ]);
    assert.equal(validateAssertion({ type: 'unknown' }).length, 1);
    assert.deepEqual(validateAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }), []);
});

test('validateAssertion rejects an invalid search pattern', () => {
    const problems = validateAssertion({ type: ASSERTION.CONTENT_MATCH, mode: 'regex', value: '([' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not valid/);
});

test('regex assertions are bounded before validation or evaluation', () => {
    const pattern = 'a'.repeat(MAX_REGEX_LENGTH + 1);
    const problems = validateAssertion({ type: ASSERTION.CONTENT_MATCH, mode: 'regex', value: pattern });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /too long/);
});

test('regex assertions are rejected when deadline Worker execution is unavailable', () => {
    for (const value of [
        'a+$',
        '(a+)+$',
        '(a|aa)+$',
        '(a+)\\1',
        'a*a*b',
        '^a{50000}$',
        '^a{1,3}b{1,3}$',
        '^a{0,50000}a{0,50000}b$',
    ]) {
        assert.match(validateAssertion({ type: ASSERTION.CONTENT_MATCH, mode: 'regex', value })[0], /safe deadline/);
    }
});

test('regex validation accepts patterns when deadline Worker execution is available', () => {
    const previous = globalThis.Worker;
    globalThis.Worker = class {};
    try {
        assert.deepEqual(validateAssertion({
            type: ASSERTION.CONTENT_MATCH,
            mode: 'regex',
            value: 'a+$',
        }), []);
    } finally {
        if (previous === undefined) {
            delete globalThis.Worker;
        } else {
            globalThis.Worker = previous;
        }
    }
});

test('validateCase reports missing name, character and bad checks', () => {
    const problems = validateCase({
        name: '   ',
        pins: {},
        assertions: [{ type: ASSERTION.SECTION_PRESENT, section: '' }],
    });
    assert.ok(problems.includes('Give this test case a name.'));
    assert.ok(problems.includes('Choose a character for this test case.'));
    assert.ok(problems.some(problem => problem.startsWith('Check 1:')));
});

test('validateCase passes for a complete case', () => {
    const problems = validateCase(createCase({
        name: 'Aqua',
        pins: { characterAvatar: 'aqua.png' },
        assertions: [{ type: ASSERTION.SECTION_PRESENT, section: 'main' }],
    }));
    assert.deepEqual(problems, []);
});

test('normalizeSuite removes duplicate case ids and invalid baselines', () => {
    const suite = normalizeSuite({
        id: 'suite-1',
        caseIds: ['a', 'b', 'a', '', null],
        baselines: { a: 'run-1', b: 42, c: null },
    });
    assert.deepEqual(suite.caseIds, ['a', 'b']);
    assert.deepEqual(suite.baselines, { a: 'run-1' });
});

test('createSuite starts empty', () => {
    const suite = createSuite({ name: 'Preset check' });
    assert.equal(suite.name, 'Preset check');
    assert.deepEqual(suite.caseIds, []);
    assert.deepEqual(suite.baselines, {});
});

test('migrations refuse objects written by a newer version', () => {
    assert.equal(migrateCase({ v: 99 }), null);
    assert.equal(migrateSuite({ v: 99 }), null);
    assert.equal(migrateRun({ v: 99 }), null);
});

test('migrations accept unversioned legacy objects', () => {
    const testCase = migrateCase({ name: 'Legacy', pins: { characterAvatar: 'a.png' } });
    assert.equal(testCase.v, CASE_VERSION);
    assert.equal(testCase.name, 'Legacy');
});

test('normalizeCase assigns an id when one is missing', () => {
    const testCase = normalizeCase({ name: 'No id' });
    assert.match(testCase.id, /[0-9a-f-]{36}|[0-9a-f-]+/);
});

test('normalizeRun repairs a partial record', () => {
    const run = normalizeRun({ id: 'run-1', status: 'nonsense', capture: { sections: [{ id: 'main' }] } });
    assert.equal(run.status, STATUS.ERROR);
    assert.equal(run.capture.sections[0].tokens, 0);
    assert.equal(run.capture.tokenTable.total, 0);
    assert.deepEqual(run.cache.predictedBreakpoints, []);
    assert.equal(run.environment.apiType, 'cc');
});

test('normalizeRun keeps valid breakpoints and drops invalid ones', () => {
    const run = normalizeRun({ cache: { predictedBreakpoints: [0, 3, -2, 'x'] } });
    assert.deepEqual(run.cache.predictedBreakpoints, [0, 3]);
});

test('normalizeRun preserves unchecked results and sanitizes volatile spans', () => {
    const run = normalizeRun({
        assertionResults: [{ pass: null, message: 'not measurable' }],
        cache: {
            volatileSpans: [
                {
                    section: 'main',
                    text: 'old',
                    otherText: 'new',
                    anchorBefore: 'x'.repeat(40),
                    anchorAfter: 'y'.repeat(40),
                    aboveBreakpoint: true,
                    unexpected: 'drop me',
                },
                null,
                { section: 42, text: 'bad', otherText: 'bad' },
                { text: 'missing other side' },
            ],
        },
    });
    assert.equal(run.assertionResults[0].pass, null);
    assert.equal(run.cache.volatileSpans.length, 1);
    assert.equal(run.cache.volatileSpans[0].unexpected, undefined);
    assert.equal(run.cache.volatileSpans[0].anchorBefore.length, 24);
    assert.equal(run.cache.volatileSpans[0].anchorAfter.length, 24);
});

test('legacy pass and changed runs with missing checks migrate to unchecked', () => {
    for (const status of [STATUS.PASS, STATUS.CHANGED]) {
        const run = migrateRun({
            v: RUN_VERSION - 1,
            status,
            assertionResults: [{ pass: null }],
        });
        assert.equal(run.v, RUN_VERSION);
        assert.equal(run.status, STATUS.UNCHECKED);
    }
});

test('resolveStatus ranks failures above differences', () => {
    assert.equal(resolveStatus({ error: new Error('boom') }), STATUS.ERROR);
    assert.equal(
        resolveStatus({ assertionResults: [{ pass: false }], hasBaseline: true, diffIsEmpty: false }),
        STATUS.FAIL,
    );
    assert.equal(
        resolveStatus({ assertionResults: [{ pass: true }], hasBaseline: true, diffIsEmpty: false }),
        STATUS.CHANGED,
    );
    assert.equal(
        resolveStatus({ assertionResults: [{ pass: null }], hasBaseline: true, diffIsEmpty: false }),
        STATUS.UNCHECKED,
    );
    assert.equal(resolveStatus({ hasBaseline: true, diffIsEmpty: true }), STATUS.PASS);
    assert.equal(resolveStatus({ hasBaseline: false, diffIsEmpty: false }), STATUS.PASS);
});
