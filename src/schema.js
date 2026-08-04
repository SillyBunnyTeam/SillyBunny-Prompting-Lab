import {
    ASSERTION,
    CASE_VERSION,
    RUN_VERSION,
    STATUS,
    SUITE_VERSION,
} from './constants.js';

/**
 * Pure data helpers for every stored object. No host imports: everything here
 * must run under plain Node for the unit tests.
 */

const ASSERTION_TYPES = new Set(Object.values(ASSERTION));
const STATUS_VALUES = new Set(Object.values(STATUS));

export function newId() {
    const uuid = globalThis.crypto?.randomUUID;
    if (typeof uuid === 'function') {
        return globalThis.crypto.randomUUID();
    }
    let text = '';
    for (let index = 0; index < 32; index++) {
        text += Math.floor(Math.random() * 16).toString(16);
    }
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function integer(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/* ------------------------------------------------------------------ pins */

export function normalizePins(value) {
    const source = plainObject(value);
    const preset = plainObject(source.preset);
    const promptTags = plainObject(source.promptTags);
    return {
        characterAvatar: text(source.characterAvatar),
        personaKey: typeof source.personaKey === 'string' && source.personaKey ? source.personaKey : null,
        connectionProfileId: text(source.connectionProfileId),
        preset: text(preset.name)
            ? { apiId: text(preset.apiId), name: text(preset.name) }
            : null,
        promptTags: text(promptTags.profileId) || text(promptTags.profileName)
            ? { profileId: text(promptTags.profileId), profileName: text(promptTags.profileName) }
            : null,
        macroEnhanced: source.macroEnhanced === 'off' ? 'off' : 'record',
    };
}

/* ------------------------------------------------------------ assertions */

/**
 * Normalizes one assertion. Unknown types are dropped by normalizeAssertions
 * so a suite written by a newer version cannot silently pass here.
 */
export function normalizeAssertion(value) {
    const source = plainObject(value);
    const type = text(source.type);
    if (!ASSERTION_TYPES.has(type)) {
        return null;
    }
    const base = { type };
    switch (type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            return { ...base, section: text(source.section) };
        case ASSERTION.TOKEN_CEILING:
            return {
                ...base,
                scope: text(source.scope, 'total') || 'total',
                max: integer(source.max, 0, 0),
            };
        case ASSERTION.CONTENT_MATCH:
            return {
                ...base,
                scope: text(source.scope, 'final') || 'final',
                mode: source.mode === 'regex' ? 'regex' : 'contains',
                value: text(source.value),
                negate: bool(source.negate),
            };
        case ASSERTION.WI_ACTIVATED:
            return {
                ...base,
                worldName: text(source.worldName),
                entryKey: text(source.entryKey),
                negate: bool(source.negate),
            };
        case ASSERTION.CACHE_PREFIX_STABLE:
            return base;
        default:
            return null;
    }
}

export function normalizeAssertions(value) {
    return list(value).map(item => normalizeAssertion(item)).filter(Boolean);
}

/**
 * Reports why an assertion cannot be evaluated, in words a non-programmer can
 * act on. Returns an empty array when the assertion is usable.
 */
export function validateAssertion(assertion) {
    const problems = [];
    const normalized = normalizeAssertion(assertion);
    if (!normalized) {
        problems.push('This check type is not supported by this version of Prompting Lab.');
        return problems;
    }
    switch (normalized.type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            if (!normalized.section) {
                problems.push('Choose which prompt section to check.');
            }
            break;
        case ASSERTION.TOKEN_CEILING:
            if (normalized.max <= 0) {
                problems.push('Set a token limit above zero.');
            }
            break;
        case ASSERTION.CONTENT_MATCH:
            if (!normalized.value) {
                problems.push('Enter the text to look for.');
            } else if (normalized.mode === 'regex') {
                try {
                    new RegExp(normalized.value);
                } catch (error) {
                    problems.push(`That search pattern is not valid: ${error?.message ?? error}`);
                }
            }
            break;
        case ASSERTION.WI_ACTIVATED:
            if (!normalized.entryKey) {
                problems.push('Enter which lorebook entry to look for.');
            }
            break;
        default:
            break;
    }
    return problems;
}

/* ----------------------------------------------------------- test cases */

export function createCase(patch = {}) {
    return normalizeCase({
        v: CASE_VERSION,
        id: newId(),
        name: 'New test case',
        notes: '',
        tags: [],
        userMessage: '',
        assertions: [],
        ...patch,
    });
}

export function normalizeCase(value) {
    const source = plainObject(value);
    return {
        v: CASE_VERSION,
        id: text(source.id) || newId(),
        name: text(source.name, 'Untitled test case') || 'Untitled test case',
        notes: text(source.notes),
        tags: list(source.tags).map(tag => text(tag)).filter(Boolean),
        pins: normalizePins(source.pins),
        userMessage: text(source.userMessage),
        assertions: normalizeAssertions(source.assertions),
    };
}

/**
 * Forward-only migration. Objects from a newer version are refused by the
 * callers rather than silently downgraded here.
 */
export function migrateCase(value) {
    const source = plainObject(value);
    const version = integer(source.v, 0, 0);
    if (version > CASE_VERSION) {
        return null;
    }
    return normalizeCase(source);
}

export function validateCase(testCase) {
    const problems = [];
    const normalized = normalizeCase(testCase);
    if (!normalized.name.trim()) {
        problems.push('Give this test case a name.');
    }
    if (!normalized.pins.characterAvatar) {
        problems.push('Choose a character for this test case.');
    }
    normalized.assertions.forEach((assertion, index) => {
        for (const problem of validateAssertion(assertion)) {
            problems.push(`Check ${index + 1}: ${problem}`);
        }
    });
    return problems;
}

/* --------------------------------------------------------------- suites */

export function createSuite(patch = {}) {
    return normalizeSuite({
        v: SUITE_VERSION,
        id: newId(),
        name: 'New suite',
        description: '',
        caseIds: [],
        baselines: {},
        ...patch,
    });
}

export function normalizeSuite(value) {
    const source = plainObject(value);
    const baselines = {};
    for (const [caseId, runId] of Object.entries(plainObject(source.baselines))) {
        if (typeof runId === 'string' && runId) {
            baselines[caseId] = runId;
        }
    }
    const seen = new Set();
    const caseIds = list(source.caseIds).map(id => text(id)).filter((id) => {
        if (!id || seen.has(id)) {
            return false;
        }
        seen.add(id);
        return true;
    });
    return {
        v: SUITE_VERSION,
        id: text(source.id) || newId(),
        name: text(source.name, 'Untitled suite') || 'Untitled suite',
        description: text(source.description),
        caseIds,
        baselines,
        createdAt: text(source.createdAt),
        updatedAt: text(source.updatedAt),
    };
}

export function migrateSuite(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > SUITE_VERSION) {
        return null;
    }
    return normalizeSuite(source);
}

/* ------------------------------------------------------------ run record */

export function createRun(patch = {}) {
    return normalizeRun({
        v: RUN_VERSION,
        id: newId(),
        status: STATUS.ERROR,
        ...patch,
    });
}

export function normalizeRun(value) {
    const source = plainObject(value);
    const capture = plainObject(source.capture);
    const cache = plainObject(source.cache);
    const environment = plainObject(source.environment);
    const ab = plainObject(source.ab);
    return {
        v: RUN_VERSION,
        id: text(source.id) || newId(),
        suiteRunId: text(source.suiteRunId),
        suiteId: text(source.suiteId),
        caseId: text(source.caseId),
        caseName: text(source.caseName),
        startedAt: text(source.startedAt),
        durationMs: integer(source.durationMs, 0, 0),
        status: STATUS_VALUES.has(source.status) ? source.status : STATUS.ERROR,
        environment: {
            forkVersion: text(environment.forkVersion),
            apiType: environment.apiType === 'tc' ? 'tc' : 'cc',
            api: text(environment.api),
            model: text(environment.model),
            profileName: text(environment.profileName),
            presetName: text(environment.presetName),
            personaName: text(environment.personaName),
            characterName: text(environment.characterName),
            promptTagsProfile: environment.promptTagsProfile ?? null,
            macroEnhanced: environment.macroEnhanced ?? null,
        },
        capture: {
            messages: Array.isArray(capture.messages) ? capture.messages : null,
            combinedPrompt: typeof capture.combinedPrompt === 'string' ? capture.combinedPrompt : null,
            sections: list(capture.sections).map(section => ({
                id: text(section?.id),
                label: text(section?.label),
                content: text(section?.content),
                tokens: integer(section?.tokens, 0, 0),
            })),
            tokenTable: {
                total: integer(plainObject(capture.tokenTable).total, 0, 0),
                perSection: plainObject(plainObject(capture.tokenTable).perSection),
            },
            wiPasses: list(capture.wiPasses).map(pass => list(pass)),
            squashedMessages: Array.isArray(capture.squashedMessages) ? capture.squashedMessages : null,
        },
        cache: {
            predictedBreakpoints: list(cache.predictedBreakpoints)
                .map(index => integer(index, -1, -1))
                .filter(index => index >= 0),
            prefixHash: text(cache.prefixHash),
            volatileSpans: list(cache.volatileSpans),
            source: text(cache.source, 'unknown') || 'unknown',
        },
        caveats: list(source.caveats).map(item => text(item)).filter(Boolean),
        assertionResults: list(source.assertionResults).map(result => ({
            index: integer(result?.index, 0, 0),
            type: text(result?.type),
            pass: bool(result?.pass),
            actual: result?.actual ?? null,
            message: text(result?.message),
        })),
        diffVsBaseline: source.diffVsBaseline ?? null,
        ab: Array.isArray(ab.runs) ? { runs: ab.runs } : null,
        error: source.error ?? null,
    };
}

export function migrateRun(value) {
    const source = plainObject(value);
    if (integer(source.v, 0, 0) > RUN_VERSION) {
        return null;
    }
    return normalizeRun(source);
}

/**
 * A run's headline status. Assertion failures always win over a content
 * difference, because a failed check is a definite problem while a difference
 * only asks the user to look.
 */
export function resolveStatus({ assertionResults = [], hasBaseline = false, diffIsEmpty = true, error = null } = {}) {
    if (error) {
        return STATUS.ERROR;
    }
    if (assertionResults.some(result => result && result.pass === false)) {
        return STATUS.FAIL;
    }
    if (hasBaseline && !diffIsEmpty) {
        return STATUS.CHANGED;
    }
    return STATUS.PASS;
}
