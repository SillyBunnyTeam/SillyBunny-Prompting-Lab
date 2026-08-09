import { DB_NAME, INDEX_KEY, STORE_PREFIX } from './constants.js';
import {
    migrateCase,
    migrateDraft,
    migratePromptDraft,
    migrateRun,
    migrateSuite,
    normalizeCase,
    normalizeDraft,
    normalizePromptDraft,
    normalizeRun,
    normalizeSuite,
} from './schema.js';

/**
 * Test cases, suites and run records live in IndexedDB rather than in
 * SillyBunny's settings file. The settings file is written as one document
 * with a version check, so storing bulky run history there would make the
 * user's own settings saves fail or reload.
 */

let store = null;
let injected = null;

function getStore() {
    if (injected) {
        return injected;
    }
    if (!store) {
        const localforage = globalThis.localforage;
        if (!localforage?.createInstance) {
            throw new Error('Prompting Lab could not open its storage because SillyBunny\'s database library is unavailable. Reload SillyBunny and try again.');
        }
        store = localforage.createInstance({ name: DB_NAME });
    }
    return store;
}

export function __setStoreForTests(value) {
    injected = value;
    store = null;
}

/** In-memory stand-in with the small slice of the localforage API used here. */
export function createMemoryStore(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        async getItem(key) {
            return data.has(key) ? structuredClone(data.get(key)) : null;
        },
        async setItem(key, value) {
            data.set(key, structuredClone(value));
            return value;
        },
        async removeItem(key) {
            data.delete(key);
        },
        async clear() {
            data.clear();
        },
        async keys() {
            return [...data.keys()];
        },
        get size() {
            return data.size;
        },
    };
}

async function readIndex(key) {
    const value = await getStore().getItem(key);
    return Array.isArray(value) ? value : [];
}

async function writeIndex(key, value) {
    await getStore().setItem(key, value);
}

async function addToIndex(key, id) {
    const index = await readIndex(key);
    if (!index.includes(id)) {
        index.push(id);
        await writeIndex(key, index);
    }
}

async function removeFromIndex(key, id) {
    const index = await readIndex(key);
    const next = index.filter(item => item !== id);
    if (next.length !== index.length) {
        await writeIndex(key, next);
    }
}

/* -------------------------------------------------------- preset drafts */

export async function saveDraft(draft) {
    const normalized = normalizeDraft({ ...draft, updatedAt: new Date().toISOString() });
    await getStore().setItem(`${STORE_PREFIX.DRAFT}${normalized.id}`, normalized);
    await addToIndex(INDEX_KEY.DRAFTS, normalized.id);
    return normalized;
}

export async function getDraft(id) {
    const value = await getStore().getItem(`${STORE_PREFIX.DRAFT}${id}`);
    return value ? migrateDraft(value) : null;
}

export async function listDrafts() {
    const ids = await readIndex(INDEX_KEY.DRAFTS);
    const drafts = await Promise.all(ids.map(id => getDraft(id)));
    return drafts.filter(Boolean);
}

export async function deleteDraft(id) {
    await getStore().removeItem(`${STORE_PREFIX.DRAFT}${id}`);
    await removeFromIndex(INDEX_KEY.DRAFTS, id);
}

/* -------------------------------------------------------- prompt drafts */

export async function savePromptDraft(draft) {
    const normalized = normalizePromptDraft({ ...draft, updatedAt: new Date().toISOString() });
    await getStore().setItem(`${STORE_PREFIX.PROMPT}${normalized.id}`, normalized);
    await addToIndex(INDEX_KEY.PROMPTS, normalized.id);
    return normalized;
}

export async function getPromptDraft(id) {
    const value = await getStore().getItem(`${STORE_PREFIX.PROMPT}${id}`);
    return value ? migratePromptDraft(value) : null;
}

export async function listPromptDrafts() {
    const ids = await readIndex(INDEX_KEY.PROMPTS);
    const drafts = await Promise.all(ids.map(id => getPromptDraft(id)));
    return drafts.filter(Boolean);
}

export async function deletePromptDraft(id) {
    await getStore().removeItem(`${STORE_PREFIX.PROMPT}${id}`);
    await removeFromIndex(INDEX_KEY.PROMPTS, id);
}

/* ---------------------------------------------------------- test cases */

export async function saveCase(testCase) {
    const normalized = normalizeCase(testCase);
    await getStore().setItem(`${STORE_PREFIX.CASE}${normalized.id}`, normalized);
    await addToIndex(INDEX_KEY.CASES, normalized.id);
    return normalized;
}

export async function getCase(id) {
    const value = await getStore().getItem(`${STORE_PREFIX.CASE}${id}`);
    return value ? migrateCase(value) : null;
}

export async function listCases() {
    const ids = await readIndex(INDEX_KEY.CASES);
    const cases = await Promise.all(ids.map(id => getCase(id)));
    return cases.filter(Boolean);
}

export async function deleteCase(id) {
    await getStore().removeItem(`${STORE_PREFIX.CASE}${id}`);
    await removeFromIndex(INDEX_KEY.CASES, id);
    for (const run of await listRuns(id)) {
        await getStore().removeItem(`${STORE_PREFIX.RUN}${run.id}`);
    }
    await getStore().removeItem(`${INDEX_KEY.RUNS}${id}`);

    // A case can belong to more than one suite. Remove both its membership
    // and any baseline pointer everywhere so deleting it cannot leave stale
    // references that later resurrect the case or its run.
    for (const suite of await listSuites()) {
        const baselines = { ...(suite.baselines ?? {}) };
        const hadBaseline = Object.prototype.hasOwnProperty.call(baselines, id);
        delete baselines[id];
        const caseIds = (suite.caseIds ?? []).filter(caseId => caseId !== id);
        if (hadBaseline || caseIds.length !== (suite.caseIds ?? []).length) {
            await saveSuite({ ...suite, caseIds, baselines });
        }
    }
}

/* -------------------------------------------------------------- suites */

export async function saveSuite(suite) {
    const normalized = normalizeSuite(suite);
    await getStore().setItem(`${STORE_PREFIX.SUITE}${normalized.id}`, normalized);
    await addToIndex(INDEX_KEY.SUITES, normalized.id);
    return normalized;
}

export async function getSuite(id) {
    const value = await getStore().getItem(`${STORE_PREFIX.SUITE}${id}`);
    return value ? migrateSuite(value) : null;
}

export async function listSuites() {
    const ids = await readIndex(INDEX_KEY.SUITES);
    const suites = await Promise.all(ids.map(id => getSuite(id)));
    return suites.filter(Boolean);
}

export async function deleteSuite(id) {
    await getStore().removeItem(`${STORE_PREFIX.SUITE}${id}`);
    await removeFromIndex(INDEX_KEY.SUITES, id);
}

/* ---------------------------------------------------------------- runs */

export async function saveRun(run) {
    const normalized = normalizeRun(run);
    await getStore().setItem(`${STORE_PREFIX.RUN}${normalized.id}`, normalized);
    const key = `${INDEX_KEY.RUNS}${normalized.caseId}`;
    const index = await readIndex(key);
    const without = index.filter(entry => entry?.id !== normalized.id);
    without.push({
        id: normalized.id,
        startedAt: normalized.startedAt,
        status: normalized.status,
        suiteRunId: normalized.suiteRunId,
        variantLabel: normalized.variantLabel,
    });
    await writeIndex(key, without);
    return normalized;
}

export async function getRun(id) {
    const value = await getStore().getItem(`${STORE_PREFIX.RUN}${id}`);
    return value ? migrateRun(value) : null;
}

/** Newest first. */
export async function listRuns(caseId) {
    const index = await readIndex(`${INDEX_KEY.RUNS}${caseId}`);
    return [...index].sort((a, b) => String(b?.startedAt ?? '').localeCompare(String(a?.startedAt ?? '')));
}

export async function getLatestRun(caseId) {
    const [newest] = await listRuns(caseId);
    return newest ? getRun(newest.id) : null;
}

export async function deleteRun(caseId, runId) {
    await getStore().removeItem(`${STORE_PREFIX.RUN}${runId}`);
    const key = `${INDEX_KEY.RUNS}${caseId}`;
    const index = await readIndex(key);
    await writeIndex(key, index.filter(entry => entry?.id !== runId));
}

/**
 * Keeps the newest `retention` runs for a case. Runs listed in `pinned` are
 * always kept and do not count against the limit, so promoting a baseline can
 * never lose the run it points at.
 */
export async function pruneRuns(caseId, retention, pinned = []) {
    const keep = new Set(pinned.filter(Boolean));
    const index = await listRuns(caseId);
    const prunable = index.filter(entry => !keep.has(entry?.id));
    const excess = prunable.slice(Math.max(0, retention));
    for (const entry of excess) {
        await deleteRun(caseId, entry.id);
    }
    return excess.length;
}

/** Removes every object this extension owns. Used by the manifest clean hook. */
export async function clearAll() {
    const target = getStore();
    if (typeof target.clear === 'function') {
        await target.clear();
        return;
    }
    for (const key of await target.keys()) {
        await target.removeItem(key);
    }
}
