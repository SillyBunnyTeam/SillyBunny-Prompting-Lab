import { PRESET_API_IDS, applyCase, getPresetName, getSelectedProfileId, hasUnsavedPresetEdits, findCharacterIndex, normalizeApiId, presetRefs, resolveProfile, restoreState, snapshotState, willCreateChatFile } from './apply-state.js';
import { captureOnce } from './capture.js';
import { CAVEAT, STATUS } from './constants.js';
import { ctxOf, getContext, listInstalledPresets } from './host.js';
import { labelForApiId } from './presets.js';
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

/** Pinned presets SillyBunny does not have, described in plain language. */
function missingPresets(context, testCase) {
    return presetRefs(testCase?.pins)
        .filter(ref => !listInstalledPresets(ref.apiId, ctxOf(context)).includes(ref.name))
        .map(ref => `the ${labelForApiId(ref.apiId).toLowerCase()} preset "${ref.name}"`);
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
        const missing = missingPresets(context, testCase);
        if (missing.length) {
            blocked.push({
                caseId: testCase?.id,
                caseName: testCase?.name ?? '',
                reason: `SillyBunny does not have ${missing.join(' or ')}. Install the preset, then reload SillyBunny.`,
            });
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

/** The model actually in use, asked of the settings that belong to this mode. */
function readModel(context, apiType) {
    if (apiType === 'tc') {
        return String(context?.textCompletionSettings?.custom_model || context?.onlineStatus || '');
    }
    return String(context?.chatCompletionSettings?.openai_model ?? context?.getChatCompletionModel?.() ?? '');
}

/**
 * Records the preset behind every manager this run could have used, so a later
 * comparison can say which piece of the configuration changed.
 */
function readPresets(hostRef, testCase) {
    const pinned = new Map(presetRefs(testCase?.pins).map(ref => [ref.apiId, ref]));
    const list = [];
    for (const apiId of PRESET_API_IDS) {
        const name = getPresetName(hostRef, apiId);
        if (name) {
            list.push({ apiId, name, pinned: pinned.has(apiId) });
        }
    }
    return list;
}

function readEnvironment(hostRef, capture, integrations, testCase) {
    // Resolved after the case has been applied, so these describe what was
    // actually measured rather than what was configured beforehand.
    const context = ctxOf(hostRef);
    const characterIndex = context?.characterId;
    const apiType = capture?.apiType ?? 'cc';
    return {
        forkVersion: String(globalThis.CLIENT_VERSION ?? context?.clientVersion ?? ''),
        apiType,
        api: String(context?.mainApi ?? ''),
        model: readModel(context, apiType),
        profileName: resolveProfile(hostRef, getSelectedProfileId(hostRef))?.name ?? '',
        presetName: getPresetName(hostRef, normalizeApiId(hostRef)),
        presets: readPresets(hostRef, testCase),
        personaName: String(context?.name1 ?? ''),
        characterName: String(context?.characters?.[characterIndex]?.name ?? ''),
        // Kept so a saved run can show whose prompt it was, not only its name.
        characterAvatar: String(context?.characters?.[characterIndex]?.avatar ?? ''),
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
        // A case handed in with a setup applied says which setup it is.
        variantLabel: testCase?.variantLabel ?? '',
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
            environment: readEnvironment(context, first, integrations, testCase),
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
