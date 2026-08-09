import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, makeRunFixture, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const { compareProfiles, isProfileUsable, listComparableProfiles, sendPrompt, sendUnderProfile } = await import('../src/ab.js');

test.after(() => removeStubContext());

function contextWith({ profiles = [], sendRequest = null, supported = () => true, disabled = false } = {}) {
    return {
        extensionSettings: {
            connectionManager: { profiles },
            disabledExtensions: disabled ? ['connection-manager'] : [],
        },
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

test('profiles are unusable while Connection Manager is disabled', () => {
    const context = contextWith({ profiles: PROFILES, disabled: true });
    assert.deepEqual(listComparableProfiles(context).map(profile => profile.usable), [false, false]);
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
    assert.equal(calls[0].custom.includeInstruct, true);
});

test('preset and instruct inclusion flags are passed to the host', async () => {
    let custom = null;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (_profileId, _prompt, _maxTokens, options) => {
            custom = options;
            return 'reply';
        },
    });
    await sendPrompt('p2', 'hi', {
        hostRef: context,
        includePreset: false,
        includeInstruct: false,
    });
    assert.equal(custom.includePreset, false);
    assert.equal(custom.includeInstruct, false);
});

test('a sampler override is exposed through a cloned request profile', async () => {
    const profile = { id: 'p2', mode: 'cc', preset: 'Profile preset' };
    let receiver = null;
    let requestedProfile = null;
    const context = contextWith({ profiles: [profile], sendRequest: async () => '' });
    const service = context.ConnectionManagerRequestService;
    service.getProfile = () => profile;
    service.sendRequest = async function (profileId) {
        receiver = this;
        requestedProfile = this.getProfile(profileId);
        return 'reply';
    };

    const result = await sendPrompt('p2', 'hi', { hostRef: context, presetName: 'Scene sampler' });

    assert.equal(result.text, 'reply');
    assert.notEqual(receiver, service);
    assert.equal(Object.getPrototypeOf(receiver), service);
    assert.deepEqual(requestedProfile, { ...profile, preset: 'Scene sampler' });
    assert.equal(profile.preset, 'Profile preset');
});

test('a sampler override falls back to the host service when profiles cannot be overridden', async () => {
    let receiver = null;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async function () {
            receiver = this;
            return 'reply';
        },
    });
    const service = context.ConnectionManagerRequestService;
    const result = await sendPrompt('p2', 'hi', { hostRef: context, presetName: 'Scene sampler' });
    assert.equal(result.text, 'reply');
    assert.equal(receiver, service);
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

test('whitespace-only replies are empty without changing the returned text', async () => {
    const text = '  \n ';
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => text });
    const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context });
    assert.equal(result.text, text);
    assert.match(result.error, /empty reply/);
});

test('a whitespace-only prompt is refused before a request', async () => {
    let calls = 0;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async () => { calls += 1; return 'reply'; },
    });
    const result = await sendPrompt('p2', ' \n ', { hostRef: context });
    assert.match(result.error, /nothing to send/);
    assert.equal(calls, 0);
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

test('wrapped backend and abort causes surface the useful detail', async () => {
    const errors = [
        [new Error('API request failed', { cause: new Error('quota exhausted') }), /quota exhausted/],
        [new Error('API request failed', {
            cause: Object.assign(new Error('cancelled by signal'), { name: 'AbortError' }),
        }), /Stopped before the model replied/],
    ];
    for (const [thrown, expected] of errors) {
        const context = contextWith({
            profiles: PROFILES,
            sendRequest: async () => { throw thrown; },
        });
        const result = await sendUnderProfile(makeRunFixture(), 'p2', { hostRef: context });
        assert.match(result.error, expected);
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

test('the same profile chosen twice is rejected before a request', async () => {
    let calls = 0;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async () => { calls += 1; return 'x'; },
    });
    await assert.rejects(
        compareProfiles(makeRunFixture(), ['p2', 'p2'], { hostRef: context }),
        /exactly two distinct usable/,
    );
    assert.equal(calls, 0);
});

test('anything other than two usable profiles is rejected before a request', async () => {
    let calls = 0;
    const context = contextWith({ profiles: PROFILES, sendRequest: async () => 'x' });
    context.ConnectionManagerRequestService.sendRequest = async () => { calls += 1; return 'x'; };
    await assert.rejects(compareProfiles(makeRunFixture(), [], { hostRef: context }), /exactly two/);
    context.ConnectionManagerRequestService.isProfileSupported = profile => profile.id === 'p1';
    await assert.rejects(
        compareProfiles(makeRunFixture(), ['p1', 'p2'], { hostRef: context }),
        /usable/,
    );
    assert.equal(calls, 0);
});

test('a watched reply is streamed and handed over as it grows', async () => {
    let asked = null;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (profileId, prompt, maxTokens, custom) => {
            asked = custom;
            // The host hands back a function that starts the generator, and
            // each chunk carries the whole reply so far.
            return async function* stream() {
                yield { text: 'She' };
                yield { text: 'She looks' };
                yield { text: 'She looks up.' };
            };
        },
    });

    const seen = [];
    const result = await sendPrompt('p2', [{ role: 'user', content: 'hi' }], {
        hostRef: context,
        onDelta: text => seen.push(text),
    });

    assert.equal(asked.stream, true);
    assert.deepEqual(seen, ['She', 'She looks', 'She looks up.']);
    assert.equal(result.text, 'She looks up.');
    assert.equal(result.error, null);
});

test('a stream failure returns the text already received and the error', async () => {
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async () => async function* stream() {
            yield { text: 'Still here' };
            throw new Error('API request failed', { cause: new Error('stream disconnected') });
        },
    });
    const seen = [];
    const result = await sendPrompt('p2', 'hi', {
        hostRef: context,
        onDelta: text => seen.push(text),
    });
    assert.deepEqual(seen, ['Still here']);
    assert.equal(result.text, 'Still here');
    assert.match(result.error, /stream disconnected/);
});

test('a connection that cannot stream still shows its reply once', async () => {
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async () => ({ content: 'all at once' }),
    });
    const seen = [];
    const result = await sendPrompt('p2', 'hi', { hostRef: context, onDelta: text => seen.push(text) });

    assert.deepEqual(seen, ['all at once']);
    assert.equal(result.text, 'all at once');
});

test('nothing is streamed unless someone is listening', async () => {
    let asked = null;
    const context = contextWith({
        profiles: PROFILES,
        sendRequest: async (profileId, prompt, maxTokens, custom) => {
            asked = custom;
            return { content: 'a reply' };
        },
    });
    await sendPrompt('p2', 'hi', { hostRef: context });
    assert.equal(asked.stream, false);
});
