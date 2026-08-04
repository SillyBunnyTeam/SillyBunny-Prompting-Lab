import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRunFixture } from './helpers/stub-context.js';

const { ASSERTION } = await import('../src/constants.js');
const {
    evaluateAssertion,
    evaluateAssertions,
    finalText,
    hasFailures,
    unevaluated,
} = await import('../src/assertions.js');

function run(patch = {}) {
    const base = makeRunFixture();
    return {
        ...base,
        ...patch,
        capture: { ...base.capture, ...(patch.capture ?? {}) },
        cache: { ...base.cache, ...(patch.cache ?? {}) },
    };
}

test('finalText joins chat completion messages', () => {
    assert.equal(finalText(run()), 'You are Aqua.\nHello there.');
});

test('finalText prefers a text completion prompt when there is one', () => {
    assert.equal(finalText(run({ capture: { combinedPrompt: 'One long prompt.' } })), 'One long prompt.');
});

test('finalText copes with an empty capture', () => {
    assert.equal(finalText({}), '');
    assert.equal(finalText(null), '');
});

/* --------------------------------------------------- section presence */

test('section-present passes when the section has content', () => {
    const result = evaluateAssertion({ type: ASSERTION.SECTION_PRESENT, section: 'main' }, run());
    assert.equal(result.pass, true);
    assert.match(result.message, /Main prompt.*is in the prompt/);
});

test('section-present fails when the section is missing', () => {
    const result = evaluateAssertion({ type: ASSERTION.SECTION_PRESENT, section: 'jailbreak' }, run());
    assert.equal(result.pass, false);
    assert.match(result.message, /is not in the prompt/);
});

test('section-present treats a whitespace-only section as missing', () => {
    const result = evaluateAssertion({ type: ASSERTION.SECTION_PRESENT, section: 'main' }, run({
        capture: { sections: [{ id: 'main', label: 'Main prompt', content: '   \n ', tokens: 1 }] },
    }));
    assert.equal(result.pass, false);
});

test('section-absent is the mirror of section-present', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.SECTION_ABSENT, section: 'jailbreak' }, run()).pass, true);
    assert.equal(evaluateAssertion({ type: ASSERTION.SECTION_ABSENT, section: 'main' }, run()).pass, false);
});

/* ----------------------------------------------------- duplicate check */

test('section-unique passes when the section appears once', () => {
    const result = evaluateAssertion({ type: ASSERTION.SECTION_UNIQUE, section: 'main' }, run());
    assert.equal(result.pass, true);
    assert.equal(result.actual, 1);
});

test('section-unique catches a section duplicated into the prompt', () => {
    const duplicated = run({
        capture: {
            messages: [
                { role: 'system', content: 'You are Aqua.' },
                { role: 'system', content: 'You are Aqua.' },
            ],
        },
    });
    const result = evaluateAssertion({ type: ASSERTION.SECTION_UNIQUE, section: 'main' }, duplicated);
    assert.equal(result.pass, false);
    assert.equal(result.actual, 2);
    assert.match(result.message, /appears 2 times/);
});

test('section-unique reports that it could not check a missing section', () => {
    const result = evaluateAssertion({ type: ASSERTION.SECTION_UNIQUE, section: 'jailbreak' }, run());
    assert.equal(result.pass, null);
});

/* ------------------------------------------------------ token ceilings */

test('token-ceiling checks the whole prompt', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'total', max: 10 }, run()).pass, true);
    const tight = evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'total', max: 5 }, run());
    assert.equal(tight.pass, false);
    assert.equal(tight.actual, 8);
    assert.match(tight.message, /over the limit/);
});

test('token-ceiling checks one section', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'main', max: 5 }, run()).pass, true);
    assert.equal(evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'main', max: 4 }, run()).pass, false);
});

test('token-ceiling reports a missing section rather than passing', () => {
    const result = evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'jailbreak', max: 10 }, run());
    assert.equal(result.pass, null);
    assert.match(result.message, /could not be checked/);
});

test('token-ceiling passes when usage exactly equals the limit', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.TOKEN_CEILING, scope: 'total', max: 8 }, run()).pass, true);
});

/* ------------------------------------------------------ content match */

test('content-match finds text anywhere in the prompt', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, value: 'Aqua' }, run()).pass, true);
    assert.equal(evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, value: 'Megumin' }, run()).pass, false);
});

test('content-match can be scoped to one section', () => {
    assert.equal(
        evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, scope: 'main', value: 'Aqua' }, run()).pass,
        true,
    );
    assert.equal(
        evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, scope: 'chatHistory', value: 'Aqua' }, run()).pass,
        false,
    );
});

test('content-match can require that text is absent', () => {
    const result = evaluateAssertion(
        { type: ASSERTION.CONTENT_MATCH, value: 'forbidden phrase', negate: true },
        run(),
    );
    assert.equal(result.pass, true);
    const failing = evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, value: 'Aqua', negate: true }, run());
    assert.equal(failing.pass, false);
    assert.match(failing.message, /should not appear/);
});

test('content-match supports a search pattern', () => {
    assert.equal(
        evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, mode: 'regex', value: 'You are \\w+' }, run()).pass,
        true,
    );
});

test('content-match explains an invalid search pattern instead of failing the run', () => {
    const result = evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, mode: 'regex', value: '([' }, run());
    assert.equal(result.pass, null);
    assert.match(result.message, /not valid/);
});

test('content-match reports a missing section rather than passing', () => {
    const result = evaluateAssertion({ type: ASSERTION.CONTENT_MATCH, scope: 'jailbreak', value: 'x' }, run());
    assert.equal(result.pass, null);
});

/* -------------------------------------------------------- world info */

const withLore = run({
    capture: {
        wiPasses: [
            [{ world: 'Book', uid: 1, comment: 'Dragon fact', keys: ['dragon'] }],
            [{ world: 'Book', uid: 2, comment: 'Map fact', keys: ['map'] }],
        ],
    },
});

test('wi-activated matches on entry id, note, or key', () => {
    for (const key of ['1', 'Dragon fact', 'dragon']) {
        assert.equal(
            evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, entryKey: key }, withLore).pass,
            true,
            `expected to match on "${key}"`,
        );
    }
});

test('wi-activated finds entries from later recursion rounds', () => {
    assert.equal(evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, entryKey: 'Map fact' }, withLore).pass, true);
});

test('wi-activated can be limited to one lorebook', () => {
    assert.equal(
        evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, worldName: 'Other', entryKey: 'dragon' }, withLore).pass,
        false,
    );
});

test('wi-activated can require that an entry stays out', () => {
    assert.equal(
        evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, entryKey: 'spoiler', negate: true }, withLore).pass,
        true,
    );
    assert.equal(
        evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, entryKey: 'dragon', negate: true }, withLore).pass,
        false,
    );
});

test('wi-activated reports no lorebook activity rather than failing', () => {
    const result = evaluateAssertion({ type: ASSERTION.WI_ACTIVATED, entryKey: 'dragon' }, run());
    assert.equal(result.pass, null);
    assert.match(result.message, /could not be checked/);
});

/* ------------------------------------------------------------- caching */

test('cache-prefix-stable passes when nothing above the breakpoint moves', () => {
    const stable = run({
        cache: { source: 'manual', predictedBreakpoints: [2], volatileSpans: [{ aboveBreakpoint: false }] },
    });
    assert.equal(evaluateAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }, stable).pass, true);
});

test('cache-prefix-stable fails when cached content changes between runs', () => {
    const unstable = run({
        cache: {
            source: 'manual',
            predictedBreakpoints: [2],
            volatileSpans: [{ aboveBreakpoint: true, macro: 'random' }],
        },
    });
    const result = evaluateAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }, unstable);
    assert.equal(result.pass, false);
    assert.match(result.message, /stops caching from working/);
});

test('cache-prefix-stable says so when the caching depth is unknown', () => {
    const result = evaluateAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }, run({ cache: { source: 'unknown' } }));
    assert.equal(result.pass, null);
    assert.match(result.message, /caching depth is not known/);
});

/* ------------------------------------------------------------ plumbing */

test('an unknown check type is reported, not silently passed', () => {
    const result = evaluateAssertion({ type: 'from-a-newer-version' }, run());
    assert.equal(result.pass, null);
    assert.match(result.message, /not supported/);
});

test('evaluateAssertions numbers every result', () => {
    const results = evaluateAssertions([
        { type: ASSERTION.SECTION_PRESENT, section: 'main' },
        { type: ASSERTION.SECTION_PRESENT, section: 'jailbreak' },
    ], run());
    assert.deepEqual(results.map(item => item.index), [0, 1]);
    assert.deepEqual(results.map(item => item.pass), [true, false]);
    assert.equal(results[0].type, ASSERTION.SECTION_PRESENT);
});

test('hasFailures only counts definite failures', () => {
    assert.equal(hasFailures([{ pass: true }, { pass: null }]), false);
    assert.equal(hasFailures([{ pass: true }, { pass: false }]), true);
});

test('unevaluated lists the checks that could not be made', () => {
    const results = [{ pass: true }, { pass: null, message: 'no data' }, { pass: false }];
    assert.equal(unevaluated(results).length, 1);
});

test('a check that throws is reported instead of breaking the run', () => {
    const broken = { capture: null, get cache() { throw new Error('boom'); } };
    const result = evaluateAssertion({ type: ASSERTION.CACHE_PREFIX_STABLE }, broken);
    assert.equal(result.pass, null);
    assert.match(result.message, /could not be made/);
});
