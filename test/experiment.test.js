import assert from 'node:assert/strict';
import test from 'node:test';

import { installStubContext, removeStubContext } from './helpers/stub-context.js';

installStubContext();

const {
    buildAnalysisMessages,
    buildExperimentMessages,
    greetingChoices,
    readCharacterCard,
    requestAnalysis,
    runExperiment,
} = await import('../src/experiment.js');

test.after(() => removeStubContext());

function contextWith({ characters = [], sendRequest = async () => 'ok' } = {}) {
    return {
        characters,
        extensionSettings: { connectionManager: { profiles: [] } },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest,
        },
    };
}

const AQUA = {
    avatar: 'aqua.png',
    name: 'Aqua',
    description: 'A water spirit.',
    personality: 'Cheerful.',
    scenario: 'A quiet lake.',
    first_mes: 'The water ripples.',
};

/* ------------------------------------------------------- message building */

test('the prompt, the card, the greeting, and the scenario each take their place', () => {
    const messages = buildExperimentMessages({
        prompt: 'Stay in character.',
        role: 'system',
        character: readCharacterCard('aqua.png', contextWith({ characters: [AQUA] })),
        scenario: 'Tell me about the lake.',
    });
    assert.deepEqual(messages.map(message => message.role), ['system', 'system', 'assistant', 'user']);
    assert.equal(messages[0].content, 'Stay in character.');
    assert.match(messages[1].content, /water spirit/);
    assert.match(messages[1].content, /Cheerful/);
    assert.match(messages[1].content, /quiet lake/);
    assert.equal(messages[2].content, 'The water ripples.');
    assert.equal(messages[3].content, 'Tell me about the lake.');
});

test('an empty prompt is left out rather than sent as a blank message', () => {
    const messages = buildExperimentMessages({ prompt: '   ', scenario: 'Hi.' });
    assert.deepEqual(messages, [{ role: 'user', content: 'Hi.' }]);
});

test('an empty scenario falls back to a plain greeting', () => {
    const messages = buildExperimentMessages({ prompt: 'Be kind.' });
    assert.equal(messages.at(-1).content, 'Hello.');
});

test('an unknown role is sent as system', () => {
    const [first] = buildExperimentMessages({ prompt: 'x', role: 'wizard' });
    assert.equal(first.role, 'system');
});

/* ------------------------------------------------------- character cards */

test('a character card is read by avatar, preferring top-level fields', () => {
    const layered = {
        avatar: 'layered.png',
        name: 'Layered',
        description: 'Top level.',
        data: { description: 'Nested.', personality: 'From data.' },
    };
    const card = readCharacterCard('layered.png', contextWith({ characters: [layered] }));
    assert.equal(card.description, 'Top level.');
    assert.equal(card.personality, 'From data.');
});

test('a missing character reads as null rather than an empty card', () => {
    assert.equal(readCharacterCard('gone.png', contextWith({})), null);
});

/* ------------------------------------------------------------ experiment */

test('both variants go to the same profile and differ only in the prompt', async () => {
    const calls = [];
    const context = contextWith({
        characters: [AQUA],
        sendRequest: async (profileId, prompt) => {
            calls.push({ profileId, prompt });
            return `reply ${calls.length}`;
        },
    });
    const replies = await runExperiment({
        promptA: 'Formal tone.',
        promptB: 'Casual tone.',
        character: readCharacterCard('aqua.png', context),
        scenario: 'Describe the lake.',
        profileId: 'p1',
        hostRef: context,
    });
    assert.deepEqual(replies.map(reply => reply.key), ['A', 'B']);
    assert.deepEqual(calls.map(call => call.profileId), ['p1', 'p1']);
    assert.equal(calls[0].prompt[0].content, 'Formal tone.');
    assert.equal(calls[1].prompt[0].content, 'Casual tone.');
    assert.deepEqual(calls[0].prompt.slice(1), calls[1].prompt.slice(1),
        'everything except the prompt must be identical');
});

test('one failing variant still returns the other reply', async () => {
    let first = true;
    const context = contextWith({
        sendRequest: async () => {
            if (first) {
                first = false;
                throw new Error('backend down');
            }
            return 'good reply';
        },
    });
    const replies = await runExperiment({ promptA: 'a', promptB: 'b', profileId: 'p1', hostRef: context });
    assert.match(replies[0].error, /backend down/);
    assert.equal(replies[1].text, 'good reply');
});

/* -------------------------------------------------------------- analysis */

test('the analysis request shows both prompts and both replies', () => {
    const messages = buildAnalysisMessages({
        promptA: 'Formal tone.',
        promptB: 'Casual tone.',
        replyA: 'Good day.',
        replyB: 'Hey!',
        scenario: 'Greet me.',
        characterName: 'Aqua',
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /what changed/i);
    assert.match(messages[0].content, /say so plainly/i);
    const body = messages[1].content;
    for (const expected of ['Formal tone.', 'Casual tone.', 'Good day.', 'Hey!', 'Greet me.', 'Aqua']) {
        assert.ok(body.includes(expected), `analysis body should include "${expected}"`);
    }
});

test('missing pieces are named instead of silently left blank', () => {
    const body = buildAnalysisMessages({ promptA: 'x' })[1].content;
    assert.match(body, /\(empty\)/);
    assert.match(body, /\(no reply\)/);
});

test('requestAnalysis sends one request under the chosen profile', async () => {
    const calls = [];
    const context = contextWith({
        sendRequest: async (profileId, prompt, maxTokens) => {
            calls.push({ profileId, prompt, maxTokens });
            return 'the analysis';
        },
    });
    const result = await requestAnalysis(
        { promptA: 'a', promptB: 'b', replyA: 'ra', replyB: 'rb' },
        { profileId: 'p2', hostRef: context, maxTokens: 512 },
    );
    assert.equal(result.text, 'the analysis');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileId, 'p2');
    assert.equal(calls[0].maxTokens, 512);
});

test('a card offers its first message and every alternate greeting', () => {
    const context = {
        characters: [{
            avatar: 'seraphina.png',
            name: 'Seraphina',
            first_mes: 'She looks up from the bar.',
            data: { alternate_greetings: ['The door swings shut.', '  ', 'She is already waiting.'] },
        }],
    };
    const card = readCharacterCard('seraphina.png', context);
    const choices = greetingChoices(card);

    assert.deepEqual(choices.map(choice => choice.label), [
        'First message', 'Alternate greeting 1', 'Alternate greeting 2',
    ]);
    assert.deepEqual(choices.map(choice => choice.text), [
        'She looks up from the bar.', 'The door swings shut.', 'She is already waiting.',
    ]);
    assert.equal(choices[0].snippet, 'She looks up from the bar.');
});

test('a card with nothing to say offers no openings', () => {
    const context = { characters: [{ avatar: 'blank.png', name: 'Blank', data: {} }] };
    assert.deepEqual(greetingChoices(readCharacterCard('blank.png', context)), []);
    assert.deepEqual(greetingChoices(null), []);
});

test('a long greeting is shortened for the menu but kept whole for the request', () => {
    const long = `${'word '.repeat(40)}end`;
    const context = { characters: [{ avatar: 'a.png', name: 'A', first_mes: long, data: {} }] };
    const [choice] = greetingChoices(readCharacterCard('a.png', context));
    assert.ok(choice.snippet.length <= 60, 'the menu line stays readable');
    assert.match(choice.snippet, /…$/);
    assert.equal(choice.text, long);
});

test('the chosen greeting is what opens both requests', () => {
    const character = {
        name: 'Seraphina',
        description: 'A knight.',
        personality: '',
        scenario: '',
        firstMessage: 'She looks up from the bar.',
        greetings: ['She looks up from the bar.', 'She is already waiting.'],
    };
    const chosen = buildExperimentMessages({
        prompt: 'Be brief.',
        character,
        scenario: 'Hello.',
        greeting: 'She is already waiting.',
    });
    assert.deepEqual(
        chosen.filter(message => message.role === 'assistant').map(message => message.content),
        ['She is already waiting.'],
    );

    // Nothing chosen means the card's own first message, as it always was.
    const fallback = buildExperimentMessages({ prompt: 'Be brief.', character, scenario: 'Hello.' });
    assert.deepEqual(
        fallback.filter(message => message.role === 'assistant').map(message => message.content),
        ['She looks up from the bar.'],
    );
});
