import assert from 'node:assert/strict';
import test from 'node:test';

const { PART, collapseUnchanged, diffSection, diffText, isUnchanged } = await import('../src/diff.js');

/** Stand-in for the diff library SillyBunny bundles. */
class StubDiff {
    diff_main(a, b) {
        if (a === b) {
            return [[0, a]];
        }
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) {
            start += 1;
        }
        const parts = [];
        if (start) {
            parts.push([0, a.slice(0, start)]);
        }
        if (a.slice(start)) {
            parts.push([-1, a.slice(start)]);
        }
        if (b.slice(start)) {
            parts.push([1, b.slice(start)]);
        }
        return parts;
    }

    diff_cleanupSemantic() {}
}

function withEngine(run) {
    globalThis.diff_match_patch = StubDiff;
    try {
        return run();
    } finally {
        delete globalThis.diff_match_patch;
    }
}

test('identical text produces a single unchanged part', () => {
    const parts = diffText('same text', 'same text');
    assert.deepEqual(parts, [{ type: PART.SAME, text: 'same text' }]);
    assert.equal(isUnchanged(parts), true);
});

test('two empty strings produce no parts at all', () => {
    assert.deepEqual(diffText('', ''), []);
});

test('an edit is split into unchanged, removed and added parts', () => {
    withEngine(() => {
        const parts = diffText('Be kind.', 'Be cruel.');
        assert.equal(parts[0].type, PART.SAME);
        assert.ok(parts.some(part => part.type === PART.REMOVED));
        assert.ok(parts.some(part => part.type === PART.ADDED));
        assert.equal(isUnchanged(parts), false);
    });
});

test('without the diff library the whole text is reported as replaced', () => {
    const parts = diffText('before', 'after');
    assert.deepEqual(parts, [
        { type: PART.REMOVED, text: 'before' },
        { type: PART.ADDED, text: 'after' },
    ]);
});

test('added text alone is reported as added', () => {
    const parts = diffText('', 'brand new');
    assert.deepEqual(parts, [{ type: PART.ADDED, text: 'brand new' }]);
});

test('removed text alone is reported as removed', () => {
    const parts = diffText('was here', '');
    assert.deepEqual(parts, [{ type: PART.REMOVED, text: 'was here' }]);
});

test('normalizing hides a value that changes every run', () => {
    const spans = [{ text: '3' }, { text: '7' }];
    const normalized = diffText('rolled 3', 'rolled 7', { volatileSpans: spans, normalize: true });
    assert.equal(isUnchanged(normalized), true);
    const raw = diffText('rolled 3', 'rolled 7', { volatileSpans: spans, normalize: false });
    assert.equal(isUnchanged(raw), false);
});

test('long unchanged runs are shortened but the ends are kept', () => {
    const long = 'x'.repeat(500);
    const [part] = collapseUnchanged([{ type: PART.SAME, text: long }], { context: 20 });
    assert.equal(part.collapsed, true);
    assert.match(part.text, /unchanged characters/);
    assert.ok(part.text.length < long.length);
});

test('a short unchanged run is left alone', () => {
    const parts = collapseUnchanged([{ type: PART.SAME, text: 'short' }], { context: 20 });
    assert.equal(parts[0].text, 'short');
    assert.equal(parts[0].collapsed, undefined);
});

test('changed parts are never shortened', () => {
    const long = 'y'.repeat(500);
    const [part] = collapseUnchanged([{ type: PART.ADDED, text: long }], { context: 20 });
    assert.equal(part.text, long);
});

test('the leading unchanged run keeps only its tail', () => {
    const parts = collapseUnchanged([
        { type: PART.SAME, text: 'a'.repeat(300) },
        { type: PART.ADDED, text: 'new' },
    ], { context: 10 });
    assert.ok(!parts[0].text.startsWith('aaaaaaaaaaa'));
    assert.ok(parts[0].text.endsWith('a'.repeat(10)));
});

test('diffSection compares one section of two runs', () => {
    const baseline = { capture: { sections: [{ id: 'main', content: 'old', tokens: 3 }] } };
    const current = { capture: { sections: [{ id: 'main', content: 'new', tokens: 5 }] } };
    const row = diffSection(baseline, current, 'main');
    assert.equal(row.baselineTokens, 3);
    assert.equal(row.currentTokens, 5);
    assert.equal(isUnchanged(row.parts), false);
    assert.equal(row.onlyInBaseline, false);
    assert.equal(row.onlyInCurrent, false);
});

test('diffSection marks a section that only one run has', () => {
    const baseline = { capture: { sections: [{ id: 'main', content: 'a', tokens: 1 }] } };
    const current = { capture: { sections: [] } };
    assert.equal(diffSection(baseline, current, 'main').onlyInBaseline, true);
    assert.equal(diffSection(current, baseline, 'main').onlyInCurrent, true);
});

test('diffSection copes with runs that captured nothing', () => {
    const row = diffSection(null, null, 'main');
    assert.equal(row.baselineTokens, 0);
    assert.deepEqual(row.parts, []);
});

test('diffSection applies volatile spans only to the requested section', () => {
    const baseline = {
        capture: {
            sections: [
                { id: 'main', content: 'Roll: 3', tokens: 2 },
                { id: 'chatHistory', content: 'stable', tokens: 1 },
            ],
        },
    };
    const current = {
        capture: {
            sections: [
                { id: 'main', content: 'Roll: 7', tokens: 2 },
                { id: 'chatHistory', content: 'edited', tokens: 1 },
            ],
        },
    };
    const spans = [{ section: 'main', text: '3', otherText: '7' }];
    assert.equal(isUnchanged(diffSection(baseline, current, 'main', {
        volatileSpans: spans,
        normalize: true,
    }).parts), true);
    assert.equal(isUnchanged(diffSection(baseline, current, 'chatHistory', {
        volatileSpans: spans,
        normalize: true,
    }).parts), false);
});
