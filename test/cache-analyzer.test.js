import assert from 'node:assert/strict';
import test from 'node:test';

const {
    analyzeCache,
    cachedPrefix,
    explainSpan,
    predictCacheBreakpoints,
    prefixText,
    squashSystemMessages,
    toClaudeShape,
} = await import('../src/cache-analyzer.js');

/**
 * These are golden tests against SillyBunny's own cachingAtDepthForClaude:
 * role switches counted from the end, the assistant prefill skipped, and
 * boundaries at the depth and two switches later.
 */

function conversation() {
    return [
        { role: 'system', content: 'rules' },      // 0
        { role: 'user', content: 'turn 1' },        // 1
        { role: 'assistant', content: 'reply 1' },  // 2
        { role: 'user', content: 'turn 2' },        // 3
        { role: 'assistant', content: 'reply 2' },  // 4
        { role: 'user', content: 'turn 3' },        // 5
    ];
}

test('depth counts role switches from the end', () => {
    const messages = conversation();
    // depth 0 is the last user turn; depth 2 is two switches earlier.
    assert.deepEqual(predictCacheBreakpoints(messages, 0), [3, 5]);
    assert.deepEqual(predictCacheBreakpoints(messages, 1), [2, 4]);
});

test('an assistant message at the very end is skipped as a prefill', () => {
    const withPrefill = [...conversation(), { role: 'assistant', content: '' }];
    // The trailing assistant turn must not shift the boundary.
    assert.deepEqual(predictCacheBreakpoints(withPrefill, 0), [3, 5]);
});

test('consecutive messages with the same role count as one step', () => {
    const messages = [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'user', content: 'd' },
    ];
    // The boundary lands on the last message of a same-role run, matching
    // where SillyBunny stamps it.
    assert.deepEqual(predictCacheBreakpoints(messages, 0), [3]);
    assert.deepEqual(predictCacheBreakpoints(messages, 1), [1]);
});

test('the walk stops after the second boundary', () => {
    const long = Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `m${index}`,
    }));
    assert.equal(predictCacheBreakpoints(long, 0).length, 2);
});

test('a depth deeper than the conversation produces no boundary', () => {
    assert.deepEqual(predictCacheBreakpoints(conversation(), 99), []);
});

test('an unset or negative depth means no caching at all', () => {
    assert.deepEqual(predictCacheBreakpoints(conversation(), null), []);
    assert.deepEqual(predictCacheBreakpoints(conversation(), -1), []);
    assert.deepEqual(predictCacheBreakpoints([], 0), []);
});

test('the cached part runs from the start to the last boundary', () => {
    const messages = conversation();
    const prefix = cachedPrefix(messages, [3, 5]);
    assert.equal(prefix.length, 6);
    assert.match(prefixText(messages, [3, 5]), /^rules/);
});

test('there is no cached part without a boundary', () => {
    assert.deepEqual(cachedPrefix(conversation(), []), []);
    assert.equal(prefixText(conversation(), []), '');
});

test('prefixText reads messages whose content is split into parts', () => {
    const messages = [{ role: 'system', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }];
    assert.equal(prefixText(messages, [0]), 'one\ntwo');
});

/* ------------------------------------------------------------- squashing */

test('consecutive system messages are merged the way SillyBunny merges them', () => {
    const squashed = squashSystemMessages([
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'c' },
    ]);
    assert.equal(squashed.length, 2);
    assert.equal(squashed[0].content, 'a\nb');
});

test('named system messages are left alone when merging', () => {
    const squashed = squashSystemMessages([
        { role: 'system', content: 'a', name: 'example_user' },
        { role: 'system', content: 'b' },
    ]);
    assert.equal(squashed.length, 2);
});

test('squashing does not modify the captured messages', () => {
    const original = [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }];
    squashSystemMessages(original);
    assert.equal(original.length, 2);
    assert.equal(original[0].content, 'a');
});

test('merging system messages moves where the boundary lands', () => {
    const messages = [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'hello' },
    ];
    const before = predictCacheBreakpoints(messages, 1);
    const after = predictCacheBreakpoints(squashSystemMessages(messages), 1);
    assert.deepEqual(before, [1]);
    assert.deepEqual(after, [0], 'the merged system message is a single step');
});

/* --------------------------------------------------------------- reports */

test('a volatile span inside the cached part is flagged', () => {
    const messages = [
        { role: 'system', content: 'Today is Tuesday. Be helpful.' },
        { role: 'user', content: 'hi' },
    ];
    const report = analyzeCache({
        messages,
        volatileSpans: [{ section: 'main', text: 'Tuesday', otherText: 'Wednesday' }],
        cachingAtDepth: 0,
        useSysPrompt: false,
        hash: text => text.length,
    });
    assert.equal(report.source, 'manual');
    assert.ok(report.predictedBreakpoints.length);
    assert.equal(report.volatileSpans[0].aboveBreakpoint, true);
    assert.ok(report.prefixHash);
});

test('a volatile span below the cached part is not flagged', () => {
    const messages = [
        { role: 'system', content: 'Stable rules.' },
        { role: 'user', content: 'roll was 4' },
    ];
    const report = analyzeCache({
        messages,
        volatileSpans: [{ section: 'chatHistory', text: 'zzz-not-in-prefix', otherText: 'qqq' }],
        cachingAtDepth: 1,
        hash: text => text.length,
    });
    assert.equal(report.volatileSpans[0].aboveBreakpoint, false);
});

test('nothing is called cached when the depth is unknown', () => {
    const report = analyzeCache({
        messages: [{ role: 'system', content: 'Today is Tuesday.' }],
        volatileSpans: [{ section: 'main', text: 'Tuesday', otherText: 'Wednesday' }],
        cachingAtDepth: null,
        hash: text => text.length,
    });
    assert.equal(report.source, 'unknown');
    assert.deepEqual(report.predictedBreakpoints, []);
    assert.equal(report.volatileSpans[0].aboveBreakpoint, false);
    assert.equal(report.prefixHash, '');
});

test('Claude conversion changes cache boundaries and prefix content', () => {
    const messages = [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'hi' },
    ];
    const report = analyzeCache({ messages, cachingAtDepth: 0, hash: t => t.length });
    assert.deepEqual(report.predictedBreakpoints, [0]);
    assert.equal(report.prefixHash, '2');
});

test('toClaudeShape removes leading systems when a Claude system prompt is enabled', () => {
    const shaped = toClaudeShape([
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
    ], { useSysPrompt: true });
    assert.deepEqual(shaped, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
});

test('toClaudeShape rewrites internal systems and merges same-role content', () => {
    const shaped = toClaudeShape([
        { role: 'user', content: 'one' },
        { role: 'system', content: 'two' },
        { role: 'user', content: 'three' },
    ], { useSysPrompt: false });
    assert.deepEqual(shaped, [{
        role: 'user',
        content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two' },
            { type: 'text', text: 'three' },
        ],
    }]);
});

test('toClaudeShape keeps named message text in the Claude prefix', () => {
    assert.deepEqual(
        toClaudeShape([
            { role: 'assistant', name: 'Aqua', content: 'hello' },
            { role: 'user', name: 'Me', content: [{ type: 'text', text: 'reply' }] },
        ], { useSysPrompt: false }),
        [{
            role: 'assistant',
            content: [{ type: 'text', text: 'Aqua: hello' }],
        }, {
            role: 'user',
            content: [{ type: 'text', text: 'Me: reply' }],
        }],
    );
});

test('toClaudeShape handles an all-system prompt with the host placeholder', () => {
    assert.deepEqual(
        toClaudeShape([{ role: 'system', content: 'only rules' }], { useSysPrompt: true }),
        [{ role: 'user', content: [{ type: 'text', text: "Let's get started." }] }],
    );
});

test('toClaudeShape never mutates captured messages', () => {
    const messages = [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const before = structuredClone(messages);
    toClaudeShape(messages, { useSysPrompt: true });
    assert.deepEqual(messages, before);
});

test('toClaudeShape relocates assistant images and appends an assistant prefill', () => {
    const shaped = toClaudeShape([
        { role: 'assistant', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
        { role: 'user', content: 'what next?' },
    ], { useSysPrompt: false, prefillString: ' answer  ' });
    assert.deepEqual(shaped, [
        { role: 'assistant', content: [{ type: 'text', text: 'look' }] },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'what next?' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
            ],
        },
        { role: 'assistant', content: [{ type: 'text', text: ' answer' }] },
    ]);
});

test('toClaudeShape mirrors the host tool fallback and named examples', () => {
    assert.deepEqual(
        toClaudeShape([
            { role: 'system', name: 'example_assistant', content: 'hello' },
            { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'roll', arguments: '{"sides":6}' } }] },
            { role: 'tool', tool_call_id: 'call-1', content: '4' },
        ], {
            useSysPrompt: false,
            useTools: false,
            names: { charName: 'Aqua' },
        }),
        [
            {
                role: 'user',
                content: [{ type: 'text', text: 'Aqua: hello' }],
            },
            {
                role: 'assistant',
                content: [{ type: 'text', text: '{"sides":6}' }],
            },
            {
                role: 'user',
                content: [{ type: 'text', text: '4' }],
            },
        ],
    );
});

test('a volatile span is explained by the macro that causes it', () => {
    // A captured prompt has already had its macros resolved, so the source
    // text is where the macro name is still visible.
    const explained = explainSpan(
        { text: '4', otherText: '2' },
        { sourceText: 'You rolled {{roll:1d6}} today.' },
    );
    assert.equal(explained.class, 'random');
    assert.equal(explained.macro, 'roll');
    assert.match(explained.why, /every evaluation/);
});

test('a span still carrying macro syntax is classified directly', () => {
    const explained = explainSpan({ text: '{{time}}', otherText: '{{time}}' });
    assert.equal(explained.class, 'time');
});

test('analyzeCache explains a span using the unresolved prompt behind it', () => {
    const report = analyzeCache({
        messages: [{ role: 'system', content: 'You rolled 4 today.' }, { role: 'user', content: 'hi' }],
        sections: [{ id: 'main', content: 'You rolled 4 today.' }],
        // The captured section holds the resolved value; the macro name only
        // survives in the preset's own text.
        sourceTexts: { main: 'You rolled {{roll:1d6}} today.' },
        volatileSpans: [{ section: 'main', text: '4', otherText: '2' }],
        cachingAtDepth: 0,
        hash: text => text.length,
    });
    assert.equal(report.volatileSpans[0].macro, 'roll');
    assert.equal(report.volatileSpans[0].class, 'random');
});

test('a span with no macro still gets a plain explanation', () => {
    const explained = explainSpan({ text: '4', otherText: '2' });
    assert.match(explained.why, /different each time/);
});

test('analyzeCache survives an empty capture', () => {
    const report = analyzeCache({});
    assert.deepEqual(report.predictedBreakpoints, []);
    assert.deepEqual(report.volatileSpans, []);
    assert.equal(report.source, 'unknown');
});
