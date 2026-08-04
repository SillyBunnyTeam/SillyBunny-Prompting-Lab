import assert from 'node:assert/strict';
import test from 'node:test';

const {
    compareRuns,
    describeComparison,
    differingSpan,
    findVolatileSpans,
    normalizeVolatile,
} = await import('../src/compare.js');

function runWith(sections, total = null) {
    return {
        capture: {
            sections,
            tokenTable: {
                total: total ?? sections.reduce((sum, section) => sum + section.tokens, 0),
                perSection: {},
            },
        },
    };
}

test('an unchanged prompt compares as identical', () => {
    const sections = [{ id: 'main', content: 'You are Aqua.', tokens: 5 }];
    const result = compareRuns(runWith(sections), runWith(sections));
    assert.equal(result.identical, true);
    assert.deepEqual(result.changedSections, []);
    assert.equal(result.totalDelta, 0);
    assert.match(result.summary, /same as the baseline/);
});

test('an edited section is reported with its token change', () => {
    const before = runWith([{ id: 'main', content: 'You are Aqua.', tokens: 5 }]);
    const after = runWith([{ id: 'main', content: 'You are Aqua, a goddess.', tokens: 9 }]);
    const result = compareRuns(after, before);
    assert.equal(result.identical, false);
    assert.deepEqual(result.changedSections, ['main']);
    assert.equal(result.totalDelta, 4);
    const delta = result.tokenDeltas.find(item => item.id === 'main');
    assert.deepEqual(
        { baseline: delta.baseline, current: delta.current, delta: delta.delta },
        { baseline: 5, current: 9, delta: 4 },
    );
});

test('an added section is reported separately from a changed one', () => {
    const before = runWith([{ id: 'main', content: 'a', tokens: 1 }]);
    const after = runWith([
        { id: 'main', content: 'a', tokens: 1 },
        { id: 'jailbreak', content: 'new', tokens: 3 },
    ]);
    const result = compareRuns(after, before);
    assert.deepEqual(result.addedSections, ['jailbreak']);
    assert.deepEqual(result.changedSections, []);
    assert.equal(result.identical, false);
    assert.equal(result.tokenDeltas.find(item => item.id === 'jailbreak').status, 'added');
});

test('a removed section is reported with a negative delta', () => {
    const before = runWith([
        { id: 'main', content: 'a', tokens: 1 },
        { id: 'worldInfoBefore', content: 'lore', tokens: 40 },
    ]);
    const after = runWith([{ id: 'main', content: 'a', tokens: 1 }]);
    const result = compareRuns(after, before);
    assert.deepEqual(result.removedSections, ['worldInfoBefore']);
    const delta = result.tokenDeltas.find(item => item.id === 'worldInfoBefore');
    assert.equal(delta.delta, -40);
    assert.equal(delta.status, 'removed');
});

test('normalizeVolatile masks the parts that change every run', () => {
    const masked = normalizeVolatile('Rolled a 4 today', [{
        text: '4',
        anchorBefore: 'Rolled a ',
        anchorAfter: ' today',
        macro: 'roll',
    }]);
    assert.equal(masked, 'Rolled a ⟨macro:roll⟩ today');
});

test('normalizeVolatile treats an unanchored span as the whole section', () => {
    const masked = normalizeVolatile('abcabc', [{ text: 'a' }, { text: 'abc' }]);
    assert.equal(masked, '⟨changes each time⟩');
});

test('normalizeVolatile leaves a malformed empty span alone', () => {
    assert.equal(normalizeVolatile('roll a', [{ text: '' }]), 'roll a');
});

test('normalizeVolatile treats span text literally, not as a search pattern', () => {
    const masked = normalizeVolatile('cost (3.50) today', [{
        text: '(3.50)',
        anchorBefore: 'cost ',
        anchorAfter: ' today',
        macro: 'price',
    }]);
    assert.equal(masked, 'cost ⟨macro:price⟩ today');
});

test('normalizeVolatile leaves text alone when there is nothing to mask', () => {
    assert.equal(normalizeVolatile('unchanged', []), 'unchanged');
    assert.equal(normalizeVolatile('unchanged', [{ text: '' }]), 'unchanged');
});

test('a random value does not report itself as a regression', () => {
    const before = runWith([{ id: 'main', content: 'Today you rolled 3.', tokens: 6 }]);
    const after = runWith([{ id: 'main', content: 'Today you rolled 7.', tokens: 6 }]);
    const spans = [{ text: '3' }, { text: '7' }];

    const normalized = compareRuns(after, before, { volatileSpans: spans, normalize: true });
    assert.equal(normalized.identical, true, 'a value that always changes must not count as a change');

    const raw = compareRuns(after, before, { volatileSpans: spans, normalize: false });
    assert.deepEqual(raw.changedSections, ['main'], 'the raw comparison should still show it');
});

test('a genuine edit is still caught when normalization is on', () => {
    const before = runWith([{ id: 'main', content: 'You rolled 3. Be kind.', tokens: 8 }]);
    const after = runWith([{ id: 'main', content: 'You rolled 7. Be cruel.', tokens: 8 }]);
    const result = compareRuns(after, before, {
        volatileSpans: [
            { text: '3', anchorBefore: 'You rolled ', anchorAfter: '. Be ' },
            { text: '7', anchorBefore: 'You rolled ', anchorAfter: '. Be ' },
        ],
        normalize: true,
    });
    assert.deepEqual(result.changedSections, ['main']);
});

test('differingSpan narrows two strings to the part that differs', () => {
    assert.deepEqual(differingSpan('roll: 3 done', 'roll: 7 done'), { a: '3', b: '7', start: 6 });
    assert.equal(differingSpan('same', 'same'), null);
});

test('differingSpan copes with one string being longer', () => {
    const span = differingSpan('abc', 'abcdef');
    assert.equal(span.a, '');
    assert.equal(span.b, 'def');
});

test('findVolatileSpans reports what moved between two builds', () => {
    const first = { sections: [{ id: 'main', content: 'The time is 10:00.', tokens: 6 }] };
    const second = { sections: [{ id: 'main', content: 'The time is 10:01.', tokens: 6 }] };
    const spans = findVolatileSpans({ capture: first }, { capture: second });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].section, 'main');
    assert.equal(spans[0].text, '0');
    assert.equal(spans[0].otherText, '1');
});

test('findVolatileSpans reports nothing for a stable prompt', () => {
    const capture = { sections: [{ id: 'main', content: 'Steady.', tokens: 2 }] };
    assert.deepEqual(findVolatileSpans({ capture }, { capture }), []);
});

test('findVolatileSpans needs both builds', () => {
    const capture = { sections: [{ id: 'main', content: 'x', tokens: 1 }] };
    assert.deepEqual(findVolatileSpans({ capture }, null), []);
    assert.deepEqual(findVolatileSpans(null, { capture }), []);
});

test('describeComparison reads as a sentence', () => {
    assert.match(
        describeComparison({ changedSections: ['main'], addedSections: [], removedSections: [], totalDelta: 12 }),
        /1 section changed, using 12 more tokens\./,
    );
    assert.match(
        describeComparison({ changedSections: [], addedSections: ['a', 'b'], removedSections: [], totalDelta: -5 }),
        /2 sections added, using 5 fewer tokens\./,
    );
    assert.match(
        describeComparison({ changedSections: [], addedSections: [], removedSections: [], totalDelta: 0 }),
        /same as the baseline/,
    );
});

test('comparing against nothing does not throw', () => {
    const result = compareRuns(runWith([{ id: 'main', content: 'a', tokens: 1 }]), null);
    assert.deepEqual(result.addedSections, ['main']);
    assert.equal(result.identical, false);
});

test('a volatile value is masked by the unchanged text around it', () => {
    // The value differs on every build, so a later run holds a number that no
    // earlier run ever produced. Only the surrounding text can locate it.
    const spans = [{
        text: '215',
        otherText: '487',
        anchorBefore: 'Lucky number: ',
        anchorAfter: '.\nBe kind.',
    }];
    const a = normalizeVolatile('Lucky number: 903.\nBe kind.', spans);
    const b = normalizeVolatile('Lucky number: 41.\nBe kind.', spans);
    assert.equal(a, b, 'two unseen values must normalize to the same text');
    assert.match(a, /Lucky number: ⟨changes each time⟩/);
});

test('leading and trailing anchored values normalize unseen values', () => {
    const trailing = [{ text: 'old', anchorBefore: 'Roll: ' }];
    assert.equal(
        normalizeVolatile('Roll: 903', trailing),
        normalizeVolatile('Roll: 41', trailing),
    );
    const leading = [{ text: 'old', anchorAfter: ' is the result.' }];
    assert.equal(
        normalizeVolatile('903 is the result.', leading),
        normalizeVolatile('41 is the result.', leading),
    );
});

test('volatile spans are scoped to their section during comparison', () => {
    const before = runWith([
        { id: 'main', content: 'Roll: 3', tokens: 2 },
        { id: 'chatHistory', content: 'stable', tokens: 1 },
    ]);
    const after = runWith([
        { id: 'main', content: 'Roll: 7', tokens: 2 },
        { id: 'chatHistory', content: 'edited', tokens: 1 },
    ]);
    const result = compareRuns(after, before, {
        volatileSpans: [{ section: 'main', text: '3', otherText: '7' }],
        normalize: true,
    });
    assert.deepEqual(result.changedSections, ['chatHistory']);
});

test('anchored masking still leaves a genuine edit visible', () => {
    const spans = [{
        text: '215',
        anchorBefore: 'Lucky number: ',
        anchorAfter: '.\nBe kind.',
    }];
    const a = normalizeVolatile('Lucky number: 903.\nBe kind.', spans);
    const b = normalizeVolatile('Lucky number: 41.\nBe cruel.', spans);
    assert.notEqual(a, b);
});

test('anchored masking does not hide the same value outside its boundary', () => {
    const spans = [{
        text: '215',
        anchorBefore: 'Lucky number: ',
        anchorAfter: '. End.',
    }];
    const before = normalizeVolatile('Unrelated 215. Lucky number: 215. End.', spans);
    const after = normalizeVolatile('Unrelated 487. Lucky number: 903. End.', spans);
    assert.notEqual(before, after);
});

test('findVolatileSpans records the unchanged text around the value', () => {
    const first = { sections: [{ id: 'main', content: 'Lucky number: 215. Be kind.', tokens: 8 }] };
    const second = { sections: [{ id: 'main', content: 'Lucky number: 487. Be kind.', tokens: 8 }] };
    const [span] = findVolatileSpans({ capture: first }, { capture: second });
    assert.equal(span.text, '215');
    assert.match(span.anchorBefore, /Lucky number: $/);
    assert.match(span.anchorAfter, /^\. Be kind\./);
});
