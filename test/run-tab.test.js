import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS } from '../src/constants.js';
import { describeRun } from '../src/ui/run-tab.js';

test('describeRun keeps unchecked checks visible beside a definite failure', () => {
    const description = describeRun({
        status: STATUS.FAIL,
        assertionResults: [
            { pass: false, message: 'The section was missing.' },
            { pass: null, message: 'No lorebook activity was recorded.' },
            { pass: null, message: 'The cache depth was not known.' },
        ],
        diffVsBaseline: {
            summary: 'The prompt changed.',
            changedSections: ['story'],
            addedSections: [],
            removedSections: [],
        },
    });

    assert.match(description, /The section was missing\./);
    assert.match(description, /2 checks were unchecked:/);
    assert.match(description, /No lorebook activity was recorded\./);
    assert.match(description, /The cache depth was not known\./);
});

test('describeRun reports an unchecked-only run without calling it a pass', () => {
    const description = describeRun({
        status: STATUS.PASS,
        assertionResults: [{ pass: null, message: 'This check could not be evaluated.' }],
    });

    assert.match(description, /No baseline yet/);
    assert.match(description, /1 check was unchecked:/);
});

test('describeRun keeps baseline equality visible beside failed checks', () => {
    const description = describeRun({
        status: STATUS.FAIL,
        assertionResults: [{ pass: false, message: 'The response was wrong.' }],
        diffVsBaseline: {
            summary: 'No prompt changes.',
            changedSections: [],
            addedSections: [],
            removedSections: [],
        },
    });

    assert.match(description, /The response was wrong\./);
    assert.match(description, /Matches the baseline\./);
});
