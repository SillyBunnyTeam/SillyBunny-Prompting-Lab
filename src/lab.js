import { evaluateAssertions } from './assertions.js';
import { analyzeCache } from './cache-analyzer.js';
import { compareRuns, findVolatileSpans } from './compare.js';
import { CAVEAT, STATUS } from './constants.js';
import { ctxOf, getContext, listInstalledPresets, stringHash } from './host.js';
import { collectIntegrations } from './integrations/index.js';
import { listPromptTagsProfiles } from './integrations/prompttags.js';
import { PRESET_API_IDS } from './presets.js';
import { runSuite as runnerRunSuite, preflight, summarize } from './runner.js';
import { createRun, resolveStatus } from './schema.js';
import { getSettings } from './settings.js';
import * as storage from './storage.js';

/**
 * Ties the runner, the checks, the comparison and storage together.
 * The tabs call into here rather than orchestrating for themselves.
 */

/**
 * Builds the analyze step handed to the runner: evaluate the case's checks,
 * work out what changes between two builds of the same prompt, and compare the
 * result against the baseline.
 */
function makeAnalyzer({ baselines, normalize, cachingAtDepth, host }) {
    return async ({ run, testCase, first, second, context }) => {
        const volatileSpans = findVolatileSpans(
            { capture: first },
            second ? { capture: second } : null,
        );

        const live = ctxOf(context);
        run.cache = analyzeCache({
            messages: first.messages ?? [],
            sections: first.sections,
            sourceTexts: first.sourceTexts,
            volatileSpans,
            cachingAtDepth,
            squashSystem: Boolean(live?.chatCompletionSettings?.squash_system_messages),
            useSysPrompt: first.useSysPrompt
                ?? live?.chatCompletionSettings?.use_sysprompt
                ?? true,
            useTools: first.useTools ?? true,
            prefillString: first.prefillString ?? '',
            names: first.promptNames ?? {},
            hash: text => stringHash(host, text),
        });
        if (run.cache.source === 'unknown' && !run.caveats.includes(CAVEAT.CACHE_DEPTH_UNKNOWN)) {
            run.caveats.push(CAVEAT.CACHE_DEPTH_UNKNOWN);
        }
        if (run.cache.source === 'manual' && !run.caveats.includes(CAVEAT.CACHE_BOUNDARY_PREDICTED)) {
            run.caveats.push(CAVEAT.CACHE_BOUNDARY_PREDICTED);
        }
        if (run.cache.squashApplied && !run.caveats.includes(CAVEAT.NO_SQUASH_LIVE)) {
            run.caveats.push(CAVEAT.NO_SQUASH_LIVE);
        }

        run.assertionResults = evaluateAssertions(testCase?.assertions, run);

        const baseline = baselines?.get(testCase?.id) ?? null;
        if (baseline) {
            const comparison = compareRuns(run, baseline, { volatileSpans, normalize });
            run.diffVsBaseline = {
                baselineRunId: baseline.id,
                changedSections: comparison.changedSections,
                addedSections: comparison.addedSections,
                removedSections: comparison.removedSections,
                tokenDeltas: comparison.tokenDeltas,
                totalDelta: comparison.totalDelta,
                summary: comparison.summary,
            };
            run.status = resolveStatus({
                assertionResults: run.assertionResults,
                hasBaseline: true,
                diffIsEmpty: comparison.identical,
            });
        } else {
            run.status = resolveStatus({
                assertionResults: run.assertionResults,
                hasBaseline: false,
                diffIsEmpty: true,
            });
        }
        return run;
    };
}

/** Loads the baseline run for each case in a suite. */
async function loadBaselines(suite) {
    const baselines = new Map();
    for (const [caseId, runId] of Object.entries(suite?.baselines ?? {})) {
        const run = await storage.getRun(runId);
        if (run) {
            baselines.set(caseId, run);
        }
    }
    return baselines;
}

export async function getSuiteCases(suite) {
    const cases = [];
    for (const caseId of suite?.caseIds ?? []) {
        const testCase = await storage.getCase(caseId);
        if (testCase) {
            cases.push(testCase);
        }
    }
    return cases;
}

/** Checks a suite before anything is changed. */
export async function preflightSuite(suite, {
    context = getContext,
    chatFileChecker = undefined,
} = {}) {
    const cases = await getSuiteCases(suite);
    return {
        ...await preflight(cases, {
            context,
            ...(chatFileChecker ? { chatFileChecker } : {}),
        }),
        cases,
    };
}

/**
 * Runs a suite end to end and stores the results.
 * @returns {Promise<object>} the runner result, with runs already saved.
 */
export async function runSuite(suite, {
    signal = null,
    onProgress = null,
    onStateChange = null,
    host = null,
    cases = null,
    blocked = [],
} = {}) {
    const settings = getSettings();
    const toRun = cases ?? await getSuiteCases(suite);
    const baselines = await loadBaselines(suite);

    // A case can belong to several suites, so pruning must protect every
    // suite's baselines, not only this one's. Otherwise repeatedly running
    // one suite would quietly delete the runs another suite compares against.
    const pinnedRuns = new Set(Object.values(suite?.baselines ?? {}));
    for (const other of await storage.listSuites()) {
        for (const runId of Object.values(other?.baselines ?? {})) {
            pinnedRuns.add(runId);
        }
    }

    const persist = async (run) => {
        if (run.status === STATUS.SKIPPED) {
            return;
        }
        await storage.saveRun(run);
        await storage.pruneRuns(
            run.caseId,
            settings.runRetention,
            [...pinnedRuns],
        );
    };

    const result = await runnerRunSuite(toRun, {
        host,
        suiteId: suite?.id ?? '',
        signal,
        onProgress,
        onStateChange,
        collectIntegrations,
        analyze: makeAnalyzer({
            baselines,
            normalize: settings.normalizeVolatile,
            cachingAtDepth: settings.manualCachingAtDepth,
            host,
        }),
        persistRun: persist,
    });

    for (const item of blocked ?? []) {
        const blockedRun = createRun({
            suiteRunId: result.suiteRunId,
            suiteId: suite?.id ?? '',
            caseId: item?.caseId ?? '',
            caseName: item?.caseName ?? '',
            status: STATUS.ERROR,
            startedAt: new Date().toISOString(),
            error: { message: String(item?.reason ?? 'This test case could not run.'), stack: '' },
        });
        await persist(blockedRun);
        result.runs.push(blockedRun);
    }
    result.summary = summarize(result.runs);

    return result;
}

/** Marks a run as the baseline for its case. */
export async function promoteBaseline(suite, caseId, runId) {
    const next = {
        ...suite,
        baselines: { ...suite.baselines, [caseId]: runId },
        updatedAt: new Date().toISOString(),
    };
    return storage.saveSuite(next);
}

/** Marks every passing run from a suite run as the baseline for its case. */
export async function promoteAllPassing(suite, runs) {
    const baselines = { ...suite.baselines };
    for (const run of runs) {
        if (run?.status === STATUS.PASS || run?.status === STATUS.CHANGED) {
            baselines[run.caseId] = run.id;
        }
    }
    return storage.saveSuite({ ...suite, baselines, updatedAt: new Date().toISOString() });
}

export async function clearBaseline(suite, caseId) {
    const baselines = { ...suite.baselines };
    delete baselines[caseId];
    return storage.saveSuite({ ...suite, baselines, updatedAt: new Date().toISOString() });
}

/** Everything the case editor needs to offer real choices. */
export function readAvailableOptions(context = getContext()) {
    const characters = (context?.characters ?? [])
        .filter(character => character?.avatar)
        .map(character => ({ avatar: character.avatar, name: character.name ?? character.avatar }));

    const personas = Object.entries(context?.powerUserSettings?.personas ?? {})
        .map(([key, name]) => ({ key, name: String(name || key) }));

    const profiles = (context?.extensionSettings?.connectionManager?.profiles ?? [])
        .filter(profile => profile?.id)
        .map(profile => ({ id: profile.id, name: profile.name ?? profile.id, mode: profile.mode ?? '' }));

    const presets = {};
    for (const apiId of PRESET_API_IDS) {
        presets[apiId] = listInstalledPresets(apiId, context);
    }

    const promptTagsProfiles = listPromptTagsProfiles(context);

    return { characters, personas, profiles, presets, promptTagsProfiles };
}

export { storage };
