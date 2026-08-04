import { CAVEAT_TEXT, STATUS, STATUS_LABEL } from '../constants.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { loadHost } from '../host.js';
import * as lab from '../lab.js';
import { willCreateChatFile } from '../apply-state.js';
import { dismissWarning, isWarningDismissed } from '../settings.js';
import * as storage from '../storage.js';

const CHAT_FILE_WARNING = 'chat-file-creation';

/** Status chips carry a word as well as a colour, never colour alone. */
function statusChip(status) {
    return element('span', {
        className: `sbpl-chip sbpl-chip-${status}`,
        text: STATUS_LABEL[status] ?? status,
    });
}

export function describeRun(run) {
    if (run.status === STATUS.ERROR) {
        return run.error?.message ?? 'Something went wrong.';
    }
    if (run.status === STATUS.SKIPPED) {
        return 'Skipped because the run was stopped.';
    }
    const failed = (run.assertionResults ?? []).filter(result => result.pass === false);
    const unchecked = (run.assertionResults ?? []).filter(result => result.pass === null);
    const details = [];
    if (failed.length) {
        details.push(failed.map(result => result.message).join(' '));
    }

    const diff = run.diffVsBaseline;
    const changed = Boolean(diff && (
        diff.changedSections?.length
        || diff.addedSections?.length
        || diff.removedSections?.length
    ));
    if (diff && (changed || run.status === STATUS.CHANGED)) {
        details.push(diff.summary ?? 'This prompt differs from the baseline.');
    } else if (diff) {
        details.push('Matches the baseline.');
    } else if (!diff) {
        details.push('No baseline yet. Set this run as the baseline to compare against later.');
    }

    if (unchecked.length) {
        const label = `${unchecked.length} check${unchecked.length === 1 ? ' was' : 's were'} unchecked:`;
        details.push(`${label} ${unchecked.map(result => result.message).join(' ')}`);
    }
    return details.filter(Boolean).join(' ') || 'Matches the baseline.';
}

export function createRunTab({ onRunFinished = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let warningsHost = null;
    let statusLine = null;
    let progressBar = null;
    let progressLabel = null;
    let resultsHost = null;
    let runButton = null;
    let cancelButton = null;
    let baselineButton = null;

    let suites = [];
    let activeSuite = null;
    let controller = null;
    let lastResult = null;
    let running = false;
    const chatFileChecks = new Map();

    function cachedChatFileCheck(context, avatar) {
        if (!chatFileChecks.has(avatar)) {
            chatFileChecks.set(avatar, willCreateChatFile(context, avatar));
        }
        return chatFileChecks.get(avatar);
    }

    async function refreshSuites() {
        suites = await storage.listSuites();
        if (!suiteSelect) {
            return;
        }
        const previous = activeSuite?.id ?? suiteSelect.value;
        replace(suiteSelect, ...suites.map(suite => element('option', {
            text: `${suite.name} (${suite.caseIds.length})`,
            attributes: { value: suite.id },
        })));
        if (suites.length) {
            suiteSelect.value = suites.some(suite => suite.id === previous) ? previous : suites[0].id;
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
        } else {
            activeSuite = null;
        }
        if (!activeSuite) {
            lastResult = null;
        } else if (!lastResult) {
            const storedResult = await loadStoredResult(activeSuite);
            if (storedResult) {
                lastResult = storedResult;
                renderResults(storedResult);
            }
        }
        suiteSelect.disabled = suites.length === 0 || running;
        updateControls();
        await showPreflight();
    }

    function updateControls() {
        const hasCases = Boolean(activeSuite?.caseIds?.length);
        runButton.disabled = running || !hasCases;
        cancelButton.hidden = !running;
        baselineButton.hidden = !lastResult || running;
    }

    function summarizeRuns(runs) {
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

    /** Load one coherent stored execution when the tab opens. */
    async function loadStoredResult(suite) {
        const candidates = [];
        for (const caseId of suite?.caseIds ?? []) {
            for (const entry of await storage.listRuns(caseId)) {
                const run = await storage.getRun(entry.id);
                if (run?.suiteId === suite.id) {
                    candidates.push(run);
                }
            }
        }
        if (!candidates.length) {
            return null;
        }

        // A suite run writes one record per case. Select the newest suiteRunId
        // as a unit; independently selecting each case's newest record can
        // combine unrelated or aborted executions and make them look like one
        // baseline candidate.
        const groups = new Map();
        for (const run of candidates) {
            const key = run.suiteRunId || `legacy:${run.id}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(run);
        }
        const [, grouped] = [...groups.entries()].sort(([, left], [, right]) => {
            const latest = runs => runs.reduce((value, run) => Math.max(value, Date.parse(run.startedAt) || 0), 0);
            return latest(right) - latest(left);
        })[0] ?? [];
        if (!grouped?.length) {
            return null;
        }
        const latestByCase = new Map();
        for (const run of grouped) {
            const previous = latestByCase.get(run.caseId);
            if (!previous || String(run.startedAt ?? '') > String(previous.startedAt ?? '')) {
                latestByCase.set(run.caseId, run);
            }
        }
        const runs = [...latestByCase.values()];
        return {
            suiteRunId: runs[0].suiteRunId,
            runs,
            restoreProblems: [],
            aborted: false,
            summary: summarizeRuns(runs),
        };
    }

    async function showPreflight() {
        if (!warningsHost) {
            return;
        }
        replace(warningsHost);
        if (!activeSuite) {
            return;
        }
        let report;
        try {
            report = await lab.preflightSuite(activeSuite, { chatFileChecker: cachedChatFileCheck });
        } catch (error) {
            warningsHost.append(warning(`This suite could not be checked: ${errorMessage(error)}`));
            return;
        }

        for (const blocked of report.blocked) {
            warningsHost.append(warning(`One test case cannot run: ${blocked.reason}`));
        }
        if (report.charactersWithoutChats.length && !isWarningDismissed(CHAT_FILE_WARNING)) {
            const note = warning(
                `${report.charactersWithoutChats.length === 1 ? 'One character has' : `${report.charactersWithoutChats.length} characters have`} no chat yet. Running these tests will open them, which creates a chat for each.`,
            );
            note.append(button('Do not show this again', async () => {
                dismissWarning(CHAT_FILE_WARNING);
                await showPreflight();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
            warningsHost.append(note);
        }
        if (report.unsavedPresetEdits) {
            warningsHost.append(warning(report.unsavedPresetEditsCertain
                ? 'You have unsaved changes in the preset panel. Running tests will discard them. Save the preset first if you want to keep them.'
                : 'If you have unsaved changes in the preset panel, running tests will discard them. Save the preset first if you want to keep them.'));
        }
    }

    function warning(text) {
        const node = element('div', { className: 'sbpl-warning', attributes: { role: 'note' } });
        node.append(element('p', { className: 'sbpl-warning-text', text }));
        return node;
    }

    function renderCaveats(runs) {
        const codes = new Set(runs.flatMap(run => run?.caveats ?? []));
        if (!codes.size) {
            return null;
        }
        const wrapper = element('div', { className: 'sbpl-caveats' });
        wrapper.append(element('p', {
            className: 'sbpl-caveats-title',
            text: 'What these results cannot show',
        }));
        const list = element('ul', { className: 'sbpl-caveat-list' });
        for (const code of codes) {
            const text = CAVEAT_TEXT[code];
            if (text) {
                list.append(element('li', { text }));
            }
        }
        wrapper.append(list);
        return wrapper;
    }

    function renderResults(result) {
        replace(resultsHost);
        if (!result) {
            return;
        }
        const { runs, summary, restoreProblems } = result;

        const counts = element('p', { className: 'sbpl-summary' });
        const parts = [];
        for (const status of [STATUS.PASS, STATUS.CHANGED, STATUS.FAIL, STATUS.ERROR, STATUS.SKIPPED]) {
            if (summary[status]) {
                parts.push(`${summary[status]} ${STATUS_LABEL[status].toLowerCase()}`);
            }
        }
        counts.textContent = parts.length ? parts.join(', ') : 'Nothing ran.';
        resultsHost.append(counts);

        if (restoreProblems?.length) {
            resultsHost.append(warning(
                `Your settings and original character/group chat could not be fully put back: ${restoreProblems.join('; ')}. Check your character, group chat, persona, preset and connection profile.`,
            ));
        }

        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Test case', 'Result', 'Tokens', 'What happened']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');

        for (const run of runs) {
            const row = element('tr');
            row.append(element('td', { text: run.caseName || 'Untitled test case' }));
            const statusCell = element('td');
            statusCell.append(statusChip(run.status));
            row.append(statusCell);
            row.append(element('td', {
                className: 'sbpl-number',
                text: run.capture?.tokenTable?.total ? formatTokens(run.capture.tokenTable.total) : '—',
            }));
            row.append(element('td', { text: describeRun(run) }));
            body.append(row);
        }
        table.append(head, body);
        scroller.append(table);
        resultsHost.append(scroller);

        const caveats = renderCaveats(runs);
        if (caveats) {
            resultsHost.append(caveats);
        }
    }

    async function start() {
        if (running || !activeSuite) {
            return;
        }
        running = true;
        controller = new AbortController();
        lastResult = null;
        updateControls();
        replace(resultsHost);
        progressBar.hidden = false;
        progressBar.value = 0;
        statusLine.textContent = 'Getting ready...';

        const host = await loadHost();
        try {
            const report = await lab.preflightSuite(activeSuite, { chatFileChecker: cachedChatFileCheck });
            const result = await lab.runSuite(activeSuite, {
                signal: controller.signal,
                host,
                cases: report.runnable,
                blocked: report.blocked,
                onProgress: (event) => {
                    progressBar.max = event.total;
                    if (event.status === 'running') {
                        progressLabel.textContent = `Testing ${event.caseName} (${event.index + 1} of ${event.total})`;
                        statusLine.textContent = progressLabel.textContent;
                    } else {
                        progressBar.value = event.index + 1;
                    }
                },
            });
            lastResult = result;
            statusLine.textContent = result.aborted
                ? 'Stopped. Your settings have been put back.'
                : 'Finished. Your settings have been put back.';
            renderResults(result);
            onRunFinished?.(result);
        } catch (error) {
            statusLine.textContent = `The run could not finish: ${errorMessage(error)}`;
        } finally {
            running = false;
            controller = null;
            progressBar.hidden = true;
            progressLabel.textContent = '';
            updateControls();
            chatFileChecks.clear();
            await refreshSuites();
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-run-tab' });

        const controls = element('div', { className: 'sbpl-controls' });
        suiteSelect = element('select', {
            className: 'text_pole sbpl-select',
            id: 'sbpl-run-suite',
            attributes: { 'aria-label': 'Suite to run' },
        });
        suiteSelect.addEventListener('change', async () => {
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
            lastResult = null;
            replace(resultsHost);
            updateControls();
            await showPreflight();
        });

        runButton = button('Run these tests', () => { void start(); }, {
            className: 'menu_button sbpl-button sbpl-button-primary',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            statusLine.textContent = 'Stopping after the current test case...';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;
        baselineButton = button('Set these results as the baseline', async () => {
            if (!activeSuite || !lastResult) {
                return;
            }
            await lab.promoteAllPassing(activeSuite, lastResult.runs);
            statusLine.textContent = 'Saved as the baseline. Future runs will be compared against these results.';
            await refreshSuites();
        }, { className: 'menu_button sbpl-button' });
        baselineButton.hidden = true;

        controls.append(suiteSelect, runButton, cancelButton, baselineButton);

        warningsHost = element('div', { className: 'sbpl-warnings' });
        statusLine = statusRegion('');
        progressLabel = element('p', { className: 'sbpl-progress-label' });
        progressBar = element('progress', { className: 'sbpl-progress' });
        progressBar.hidden = true;
        resultsHost = element('div', { className: 'sbpl-results' });

        root.append(controls, warningsHost, progressLabel, progressBar, statusLine, resultsHost);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
            }
            if (!suites.length || !suiteSelect.options.length) {
                void refreshSuites();
            }
            if (!suites.length && !activeSuite) {
                const empty = emptyState(
                    'No test suites yet.',
                    'Create a test case on the Test cases tab, then come back here to run it.',
                );
                replace(resultsHost, empty);
            }
            return root;
        },
        refresh() {
            if (!running) {
                void refreshSuites();
            }
        },
        dispose() {
            controller?.abort();
            root?.remove();
            root = null;
        },
    };
}
