import assert from 'node:assert/strict';
import test from 'node:test';

import {
    canonicalOutbound,
    contentToText,
    hasCanonicalCapture,
    stableStringify,
} from '../src/message-content.js';

test('contentToText reads strings and multimodal text parts', () => {
    assert.equal(contentToText('plain'), 'plain');
    assert.equal(contentToText([
        { type: 'text', text: 'one' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: 'two' },
    ]), 'one\ntwo');
});

test('stableStringify sorts object keys but preserves array order and duplicates', () => {
    assert.equal(
        stableStringify({ z: 1, a: [{ y: 2, x: 1 }, { y: 2, x: 1 }] }),
        '{"a":[{"x":1,"y":2},{"x":1,"y":2}],"z":1}',
    );
});

test('canonicalOutbound prefers final messages and preserves every protocol field', () => {
    const capture = {
        messages: [{
            role: 'tool',
            content: '4',
            tool_call_id: 'call-1',
            reasoning: 'hidden',
            signature: 'sig',
            future_field: { b: 2, a: 1 },
        }],
        combinedPrompt: 'not used',
    };
    const canonical = canonicalOutbound(capture);
    assert.match(canonical, /^messages:/);
    assert.match(canonical, /"tool_call_id":"call-1"/);
    assert.match(canonical, /"future_field":\{"a":1,"b":2\}/);
    assert.equal(hasCanonicalCapture({ capture }), true);
    assert.equal(hasCanonicalCapture({ capture: { messages: null, combinedPrompt: null } }), false);
});
