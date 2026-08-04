import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, makeRunFixture, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { compareProfiles, isProfileUsable, listComparableProfiles, sendUnderProfile } = await import('../src/ab.js');

test.after(() => removeStubContext());

function contextWith({ profiles = [], sendRequest = null, supported = () => true } = {}) {
    return {
        extensionSettings: { connectionManager: { profiles } },
        ConnectionManagerRequestService: sendRequest === null && supported === null
            ? undefined
            : {
                sendRequest,
                isProfileSupported: supported,
            },
    };
}

const PROFILES = [
    { id: 'p1', name: 'Local', mode: 'tc', model: 'llama' },
    { id: 'p2', name: 'Claude', mode: 'cc', model: 'claude-sonnet' },
];

test('profiles are listed with their model and whether they can be used', () => {
    const context = contextWith({ profiles: PROFILES, supported: profile => profile.mode === 'cc' });
    const listed = listComparableProfiles(context);
    assert.deepEqual(listed.map(item => item.usable), [false, true]);
    assert.equal(listed[1].model, 'claude-sonnet');
});

test('a profile is unusable when the connection service is missing', () => {
    assert.equal(isProfileUsable({ extensionSettings: {} }, PROFILES[0]), false);
    assert.deepEqual(listComparableProfiles({ extensionSettings: {} }), []);
});

test('a profile the service rejects is reported as unusable rather than crashing', () => {
    const context = contextWith({
        profiles: PROFILES,
        supported: () => { throw new Error('unknown profile type'); },
    });
    assert.equal(listComparableProfiles(context)[0].usable, false);
});

test('the captured messages are sent under the chosen profile', async () => {
    const calls = [];
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (profileId, prompt, maxTokens, custom) => {
            calls.push({ profileId, prompt, maxTokens, custom });
            return { content: 'a reply' };
        },
    });
    const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context, maxTokens: 128 });
    assert.equal(result.text, 'a reply');
    assert.equal(result.error, null);
    assert.equal(calls[0].profileId, 'p2');
    assert.equal(calls[0].maxTokens, 128);
    assert.deepEqual(calls[0].prompt, makeRunFixture().capture.messages);
    assert.equal(calls[0].custom.stream, false, 'replies are fetched whole, not streamed');
    assert.equal(calls[0].custom.includePreset, true);
});

test('a text completion prompt is sent as a string', async () => {
    let sent = null;
    const run = makeRunFixture({ capture: { ...makeRunFixture().capture, messages: null, combinedPrompt: 'One long prompt.' } });
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (_id, prompt) => { sent = prompt; return 'ok'; },
    });
    await sendUnderProfile(run, 'p1', { hostRef: context });
    assert.equal(sent, 'One long prompt.');
});

test('a plain string reply is accepted', async () => {
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => 'plain text reply' });
    const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context });
    assert.equal(result.text, 'plain text reply');
});

test('an empty reply is reported rather than shown as a blank panel', async () => {
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => '' });
    const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context });
    assert.match(result.error, /empty reply/);
});

test('a run with no captured prompt is refused with a reason', async () => {
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => 'x' });
    const empty = makeRunFixture({ capture: { messages: null, combinedPrompt: null } });
    const result = await sendUnderProfile(empty, 'p2', { hostRef: context });
    assert.match(result.error, /did not capture a prompt/);
});

test('a missing connection manager is explained in plain language', async () => {
    const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: { extensionSettings: {} } });
    assert.match(result.error, /Connection Manager/);
});

test('backend errors are turned into plain language', async () => {
    const cases = [
        ['Connection Manager is not available', /turned off/],
        ['API type openai does not support chat completions', /cannot be used to compare model replies/],
        ['The operation was aborted', /Stopped before the model replied/],
        ['rate limited', /rate limited/],
    ];
    for (const [thrown, expected] of cases) {
        const context = contextWith({
            profiles: PROFILES,
            sendRequest: async () => { throw new Error(thrown); },
        });
        const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context });
        assert.match(result.error, expected, `for "${thrown}"`);
        assert.equal(result.text, '');
    }
});

test('two profiles are asked at the same time', async () => {
    let active = 0;
    let maxActive = 0;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (profileId) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            active -= 1;
            return `reply from ${profileId}`;
        },
    });
    const replies = await compareProfiles(makeRunFixture(), ['p1', 'p2'], { hostRef: context });
    assert.equal(replies.length, 2);
    assert.equal(maxActive, 2, 'one slow backend must not hold up the other');
    assert.deepEqual(replies.map(reply => reply.profileId), ['p1', 'p2']);
});

test('one failing profile still returns the other reply', async () => {
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (profileId) => {
            if (profileId === 'p1') {
                throw new Error('backend down');
            }
            return 'good reply';
        },
    });
    const replies = await compareProfiles(makeRunFixture(), ['p1', 'p2'], { hostRef: context });
    assert.match(replies[0].error, /backend down/);
    assert.equal(replies[1].text, 'good reply');
});

test('the same profile chosen twice is only asked once', async () => {
    let calls = 0;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async () => { calls += 1; return 'x'; },
    });
    const replies = await compareProfiles(makeRunFixture(), ['p2', 'p2'], { hostRef: context });
    assert.equal(calls, 1);
    assert.equal(replies.length, 1);
});

test('asking for no profiles does nothing', async () => {
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => 'x' });
    assert.deepEqual(await compareProfiles(makeRunFixture(), [], { hostRef: context }), []);
});
