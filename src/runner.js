import { applyCase, getPresetName, getSelectedProfileId, hasUnsavedPresetEdits, findCharacterIndex, normalizeApiId, resolveProfile, restoreState, snapshotState, willCreateChatFile } from './apply-state.js';
import { captureOnce } from './capture.js';
import { CAVEAT, STATUS } from './constants.js';
import { ctxOf, getContext } from './host.js';
import { createRun, newId, resolveStatus } from './schema.js';

/**
 * Runs test cases one at a time and guarantees the user's configuration is put
 * back afterwards.
 *
 * Only one case can run at a time: prompt assembly writes to shared state in
 * SillyBunny (the prompt manager, the extension prompt registry), so two
 * overlapping runs would measure each other.
 */

export const RUNNER_STATE = Object.freeze({
    IDLE: 'idle',
    PREFLIGHT: 'preflight',
    RUNNING: 'running',
    RESTORING: 'restoring',
    DONE: 'done',
    ABORTED: 'aborted',
    ERROR: 'error',
});

/** Cases are ordered so that all cases for one character run together. */
export function orderCasesByCharacter(cases) {
    const groups = new Map();
    for (const testCase of cases) {
        const key = testCase?.pins?.characterAvatar ?? '';
        const group = groups.get(key) ?? [];
        group.push(testCase);
        groups.set(key, group);
    }
    return [...groups.values()].flat();
}

/**
 * Checks a set of cases before anything is changed, so the user can be told
 * what will happen and what cannot run.
 */
export async function preflight(cases, {
    context = getContext,
    chatFileChecker = willCreateChatFile,
} = {}) {
    const blocked = [];
    const charactersWithoutChats = [];
    const seenAvatars = new Set();

    for (const testCase of cases) {
        const avatar = testCase?.pins?.characterAvatar ?? '';
        if (!avatar) {
            blocked.push({ caseId: testCase?.id, caseName: testCase?.name ?? '', reason: 'No character is chosen for this test case.' });
            continue;
        }
        if (findCharacterIndex(context, avatar) < 0) {
            blocked.push({ caseId: testCase?.id, caseName: testCase?.name ?? '', reason: `The character "${avatar}" is not installed any more.` });
            continue;
        }
        if (!seenAvatars.has(avatar)) {
            seenAvatars.add(avatar);
            if (await chatFileChecker(context, avatar)) {
                charactersWithoutChats.push(avatar);
            }
        }
    }

    const dirty = hasUnsavedPresetEdits(context);
    return {
        blocked,
        charactersWithoutChats,
        // null means SillyBunny no longer offers the check, so warn anyway.
        unsavedPresetEdits: dirty === null ? true : dirty,
        unsavedPresetEditsCertain: dirty !== null,
        runnable: cases.filter(testCase => !blocked.some(item => item.caseId === testCase?.id)),
    };
}

function describeError(error) {
    return {
        message: String(error?.message ?? error ?? 'Unknown problem'),
        stack: typeof error?.stack === 'string' ? error.stack : '',
    };
}

function readEnvironment(hostRef, capture, integrations) {
    // Resolved after the case has been applied, so these describe what was
    // actually measured rather than what was configured beforehand.
    const context = ctxOf(hostRef);
    const characterIndex = context?.characterId;
    return {
        forkVersion: String(globalThis.CLIENT_VERSION ?? context?.clientVersion ?? ''),
        apiType: capture?.apiType ?? 'cc',
        api: String(context?.mainApi ?? ''),
        model: String(context?.chatCompletionSettings?.openai_model ?? context?.getChatCompletionModel?.() ?? ''),
        profileName: resolveProfile(hostRef, getSelectedProfileId(hostRef))?.name ?? '',
        presetName: getPresetName(hostRef, normalizeApiId(hostRef)),
        personaName: String(context?.name1 ?? ''),
        characterName: String(context?.characters?.[characterIndex]?.name ?? ''),
        promptTagsProfile: integrations?.promptTags ?? null,
        macroEnhanced: integrations?.macroEnhanced ?? null,
    };
}

/**
 * Runs one case: applies its pins, builds the prompt twice, and returns a run
 * record. The second build is what makes it possible to tell a genuinely
 * changed prompt from one that simply contains a random or time-based value.
 */
export async function runCase(testCase, {
    context = getContext,
    host = null,
    suiteId = '',
    suiteRunId = '',
    signal = null,
    doubleRun = true,
    captureFn = captureOnce,
    applyFn = applyCase,
    collectIntegrations = null,
    analyze = null,
} = {}) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const base = {
        id: newId(),
        suiteId,
        suiteRunId,
        caseId: testCase?.id ?? '',
        caseName: testCase?.name ?? '',
        startedAt,
    };

    try {
        const { caveats: applyCaveats = [] } = await applyFn(context, testCase?.pins, { signal }) ?? {};
        if (signal?.aborted) {
            return createRun({ ...base, status: STATUS.SKIPPED, durationMs: Date.now() - startedMs });
        }

        const first = await captureFn({ userMessage: testCase?.userMessage ?? '', context, host });
        const second = doubleRun && !signal?.aborted
            ? await captureFn({ userMessage: testCase?.userMessage ?? '', context, host })
            : null;

        const integrations = await collectIntegrations?.(context) ?? null;
        const caveats = [...new Set([...(first.caveats ?? []), ...applyCaveats, ...(integrations?.caveats ?? [])])];

        const run = createRun({
            ...base,
            status: STATUS.PASS,
            durationMs: Date.now() - startedMs,
            environment: readEnvironment(context, first, integrations),
            capture: {
                messages: first.messages,
                combinedPrompt: first.combinedPrompt,
                sections: first.sections,
                tokenTable: first.tokenTable,
                wiPasses: first.wiPasses,
                squashedMessages: null,
            },
            caveats,
        });

        // Assertions, volatility and diffing are supplied by the caller so this
        // module stays responsible for sequencing alone.
        const analyzed = await analyze?.({ run, testCase, first, second, context, host });
        const result = analyzed ?? run;
        result.status = analyzed?.status ?? resolveStatus({
            assertionResults: result.assertionResults,
            hasBaseline: Boolean(result.diffVsBaseline),
            diffIsEmpty: !result.diffVsBaseline || result.diffVsBaseline.changedSections?.length === 0,
        });
        return result;
    } catch (error) {
        return createRun({
            ...base,
            status: STATUS.ERROR,
            durationMs: Date.now() - startedMs,
            error: describeError(error),
        });
    }
}

/**
 * Runs a whole set of cases. The user's configuration is snapshotted before the
 * first case and restored in a finally block, so an error, an abort, or a
 * failing case cannot leave the app on someone else's character or preset.
 */
export async function runSuite(cases, {
    context = getContext,
    host = null,
    suiteId = '',
    signal = null,
    onProgress = null,
    onStateChange = null,
    doubleRun = true,
    captureFn = captureOnce,
    applyFn = applyCase,
    snapshotFn = snapshotState,
    restoreFn = restoreState,
    collectIntegrations = null,
    analyze = null,
    persistRun = null,
} = {}) {
    const suiteRunId = newId();
    const ordered = orderCasesByCharacter(cases ?? []);
    const runs = [];
    let state = RUNNER_STATE.PREFLIGHT;
    let restoreProblems = [];

    const setState = (next) => {
        state = next;
        onStateChange?.(next);
    };

    setState(RUNNER_STATE.PREFLIGHT);
    const snapshot = snapshotFn(context);

    setState(RUNNER_STATE.RUNNING);
    try {
        for (const [index, testCase] of ordered.entries()) {
            if (signal?.aborted) {
                runs.push(createRun({
                    id: newId(),
                    suiteId,
                    suiteRunId,
                    caseId: testCase?.id ?? '',
                    caseName: testCase?.name ?? '',
                    status: STATUS.SKIPPED,
                    startedAt: new Date().toISOString(),
                }));
                continue;
            }
            onProgress?.({
                index,
                total: ordered.length,
                caseName: testCase?.name ?? '',
                status: 'running',
            });
            const run = await runCase(testCase, {
                context,
                host,
                suiteId,
                suiteRunId,
                signal,
                doubleRun,
                captureFn,
                applyFn,
                collectIntegrations,
                analyze,
            });
            runs.push(run);
            await persistRun?.(run);
            onProgress?.({
                index,
                total: ordered.length,
                caseName: testCase?.name ?? '',
                status: run.status,
                run,
            });
        }
    } finally {
        setState(RUNNER_STATE.RESTORING);
        try {
            restoreProblems = await restoreFn(context, snapshot) ?? [];
        } catch (error) {
            restoreProblems = [String(error?.message ?? error)];
        }
        setState(signal?.aborted ? RUNNER_STATE.ABORTED : RUNNER_STATE.DONE);
    }

    return {
        suiteRunId,
        runs,
        restoreProblems,
        aborted: Boolean(signal?.aborted),
        state,
        summary: summarize(runs),
    };
}

export function summarize(runs) {
    const summary = {
        [STATUS.PASS]: 0,
        [STATUS.CHANGED]: 0,
        [STATUS.FAIL]: 0,
        [STATUS.ERROR]: 0,
        [STATUS.SKIPPED]: 0,
        total: runs.length,
    };
    for (const run of runs) {
        if (run?.status in summary) {
            summary[run.status] += 1;
        }
    }
    return summary;
}

export { CAVEAT };
