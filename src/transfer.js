import {
    EXPORT_FORMAT,
    EXPORT_VERSION,
    MAX_EXPORT_BYTES,
    MAX_EXPORT_WITH_BASELINES_BYTES,
    MAX_REGEX_LENGTH,
} from './constants.js';
import { migrateCase, migrateDraft, migrateRun, migrateSuite, newId, normalizeCase, normalizeSuite } from './schema.js';

/**
 * Moves suites between installations as a plain JSON file.
 *
 * A suite is meant to be shared, so an imported file is treated as untrusted:
 * every object is rebuilt through the schema, unknown fields are dropped, and a
 * file written by a newer version is refused rather than half-understood.
 */

export const KIND = Object.freeze({
    SUITE: 'suite',
    SUITE_WITH_BASELINES: 'suite-with-baselines',
});

function byteLength(text) {
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(text).length;
    }
    return Buffer.byteLength(text, 'utf8');
}

/**
 * Builds the file contents for a suite.
 *
 * @param {object} suite the suite to export
 * @param {object[]} cases its test cases
 * @param {object[]} baselineRuns baseline runs, when they are being included
 */
export function buildExport(suite, cases, baselineRuns = null, presets = null) {
    const includeBaselines = Array.isArray(baselineRuns) && baselineRuns.length > 0;
    const includePresets = Array.isArray(presets) && presets.length > 0;
    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        kind: includeBaselines ? KIND.SUITE_WITH_BASELINES : KIND.SUITE,
        exportedAt: new Date().toISOString(),
        suite: normalizeSuite({ ...suite, baselines: includeBaselines ? suite.baselines : {} }),
        cases: cases.map(item => normalizeCase(item)),
        ...(includeBaselines ? { baselineRuns } : {}),
        ...(includePresets ? { presets } : {}),
    };
    const text = JSON.stringify(payload, null, 2);
    const limit = includeBaselines ? MAX_EXPORT_WITH_BASELINES_BYTES : MAX_EXPORT_BYTES;
    const size = byteLength(text);
    if (size > limit) {
        throw new Error(
            `This export is ${formatSize(size)}, which is larger than the ${formatSize(limit)} limit. `
            + (includeBaselines
                ? 'Export without baseline runs, or split the suite into smaller ones.'
                : 'Split the suite into smaller ones.'),
        );
    }
    return { text, size, kind: payload.kind };
}

export function formatSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reads an export file.
 *
 * Identifiers are always regenerated so importing a suite twice, or importing
 * one that came from a copy of your own, cannot overwrite what is already
 * saved. Baseline pointers are rewritten to follow the new identifiers.
 *
 * Presets travelling with a suite arrive as drafts. They are never installed
 * on their own, so a shared file cannot change the settings you already have.
 *
 * @returns {{suite: object, cases: object[], baselineRuns: object[], presets: object[]}}
 */
export function parseImport(text) {
    let payload;
    try {
        payload = JSON.parse(String(text ?? ''));
    } catch (error) {
        throw new Error(`That file is not readable as JSON: ${error?.message ?? error}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('That file does not contain a Prompting Lab suite.');
    }
    if (payload.format !== EXPORT_FORMAT) {
        throw new Error('That file was not made by Prompting Lab.');
    }
    const version = Number(payload.version);
    if (!Number.isFinite(version)) {
        throw new Error('That file does not say which version of Prompting Lab made it.');
    }
    if (version > EXPORT_VERSION) {
        throw new Error('That file was made by a newer version of Prompting Lab. Update the extension, then import it again.');
    }

    const hasOversizedRegex = (Array.isArray(payload.cases) ? payload.cases : [])
        .some(item => (Array.isArray(item?.assertions) ? item.assertions : [])
            .some(assertion => assertion?.type === 'content-match'
                && assertion?.mode === 'regex'
                && typeof assertion?.value === 'string'
                && assertion.value.length > MAX_REGEX_LENGTH));
    if (hasOversizedRegex) {
        throw new Error(`That file contains a search pattern longer than the ${MAX_REGEX_LENGTH}-character limit.`);
    }

    const suite = migrateSuite(payload.suite);
    if (!suite) {
        throw new Error('The suite in that file could not be read.');
    }
    const cases = (Array.isArray(payload.cases) ? payload.cases : [])
        .map(item => migrateCase(item))
        .filter(Boolean);

    // Fresh identifiers, with old ones mapped across so the suite still points
    // at its own cases and baselines.
    const caseIdMap = new Map();
    const importedCases = cases.map((item) => {
        const id = newId();
        caseIdMap.set(item.id, id);
        return { ...item, id };
    });

    const runIdMap = new Map();
    const baselineRuns = (Array.isArray(payload.baselineRuns) ? payload.baselineRuns : [])
        .map(run => migrateRun(run))
        .filter(Boolean)
        // A run whose case is not in the file would be stored under a case id
        // this installation has never seen (or worse, someone else's), so it
        // is dropped the same way dangling baseline pointers are below.
        .filter(run => caseIdMap.has(run.caseId))
        .map((run) => {
            const id = newId();
            runIdMap.set(run.id, id);
            return { ...run, id, caseId: caseIdMap.get(run.caseId) };
        });

    const baselines = {};
    for (const [oldCaseId, oldRunId] of Object.entries(suite.baselines ?? {})) {
        const caseId = caseIdMap.get(oldCaseId);
        const runId = runIdMap.get(oldRunId);
        if (caseId && runId) {
            baselines[caseId] = runId;
        }
    }

    return {
        suite: normalizeSuite({
            ...suite,
            id: newId(),
            caseIds: suite.caseIds.map(id => caseIdMap.get(id)).filter(Boolean),
            baselines,
        }),
        cases: importedCases,
        baselineRuns,
        presets: (Array.isArray(payload.presets) ? payload.presets : [])
            .map(draft => migrateDraft({ ...draft, id: newId(), publishedAs: '' }))
            .filter(Boolean),
    };
}

/** Offers a file to the browser for download. */
export function downloadExport(fileName, text, mimeType = 'application/json') {
    if (typeof globalThis.Blob !== 'function' || typeof document === 'undefined') {
        throw new Error('This browser cannot download files.');
    }
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function suggestedFileName(suite) {
    const safe = String(suite?.name ?? 'suite')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'suite';
    return `prompting-lab-${safe}.json`;
}
