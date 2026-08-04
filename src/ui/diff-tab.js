import { SECTION_LABEL, STATUS_LABEL } from '../constants.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { collapseUnchanged, diffSection, isUnchanged, PART } from '../diff.js';
import { macroConfigDiffers } from '../integrations/macroenhanced.js';
import * as lab from '../lab.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

/**
 * Compares two runs of the same test case and shows what changed, section by
 * section, with the token cost of each change.
 */
export function createDiffTab() {
    let root = null;
    let suiteSelect = null;
    let caseSelect = null;
    let baseSelect = null;
    let compareSelect = null;
    let rawToggle = null;
    let output = null;
    let status = null;

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let activeCase = null;
    let runIndex = [];

    async function reload() {
        suites = await storage.listSuites();
        activeSuite = suites.find(suite => suite.id === activeSuite?.id) ?? suites[0] ?? null;
        replace(suiteSelect, ...suites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        await reloadCases();
    }

    async function reloadCases() {
        cases = activeSuite ? await lab.getSuiteCases(activeSuite) : [];
        activeCase = cases.find(item => item.id === activeCase?.id) ?? cases[0] ?? null;
        replace(caseSelect, ...cases.map(item => element('option', {
            text: item.name,
            attributes: { value: item.id },
        })));
        if (activeCase) {
            caseSelect.value = activeCase.id;
        }
        await reloadRuns();
    }

    async function reloadRuns() {
        runIndex = activeCase ? await storage.listRuns(activeCase.id) : [];
        const baselineId = activeSuite?.baselines?.[activeCase?.id ?? ''] ?? '';
        const options = runIndex.map(entry => element('option', {
            text: `${describeWhen(entry.startedAt)} · ${STATUS_LABEL[entry.status] ?? entry.status}${entry.id === baselineId ? ' · baseline' : ''}`,
            attributes: { value: entry.id },
        }));
        replace(baseSelect, ...options.map(node => node.cloneNode(true)));
        replace(compareSelect, ...options);

        if (baselineId && runIndex.some(entry => entry.id === baselineId)) {
            baseSelect.value = baselineId;
        } else if (runIndex.length > 1) {
            baseSelect.value = runIndex[1].id;
        }
        if (runIndex.length) {
            compareSelect.value = runIndex[0].id;
        }
        await render();
    }

    function describeWhen(value) {
        if (!value) {
            return 'Unknown time';
        }
        try {
            return new Date(value).toLocaleString();
        } catch {
            return value;
        }
    }

    async function render() {
        replace(output);
        if (!activeCase) {
            output.append(emptyState(
                'Nothing to compare yet.',
                'Run a test case at least once, then come back to compare two of its runs.',
            ));
            return;
        }
        if (runIndex.length < 2) {
            output.append(emptyState(
                'Only one run so far.',
                'Comparing needs two runs of the same test case. Run it again after changing something.',
            ));
            return;
        }

        const [baseline, current] = await Promise.all([
            storage.getRun(baseSelect.value),
            storage.getRun(compareSelect.value),
        ]);
        if (!baseline || !current) {
            output.append(emptyState('That run could not be loaded.', 'It may have been removed to save space.'));
            return;
        }
        if (baseline.id === current.id) {
            output.append(emptyState('Those are the same run.', 'Choose two different runs to compare.'));
            return;
        }

        renderEnvironmentDelta(baseline, current);

        const normalize = !rawToggle.checked;
        const spans = current.cache?.volatileSpans ?? [];
        const ids = [...new Set([
            ...(baseline.capture?.sections ?? []).map(section => section.id),
            ...(current.capture?.sections ?? []).map(section => section.id),
        ])];

        const rows = ids.map(id => diffSection(baseline, current, id, {
            volatileSpans: spans,
            normalize,
        }));
        const changed = rows.filter(row => !isUnchanged(row.parts));

        const summary = element('p', { className: 'sbpl-summary' });
        const totalDelta = Number(current.capture?.tokenTable?.total ?? 0)
            - Number(baseline.capture?.tokenTable?.total ?? 0);
        summary.textContent = changed.length
            ? `${changed.length} section${changed.length === 1 ? '' : 's'} differ, ${describeDelta(totalDelta)}.`
            : normalize
                ? 'These two runs produce the same prompt, ignoring parts that change every time.'
                : 'These two runs produce exactly the same prompt.';
        output.append(summary);

        output.append(renderTokenTable(rows));

        if (!changed.length) {
            return;
        }
        for (const row of changed) {
            output.append(renderSectionDiff(row));
        }
    }

    function describeDelta(delta) {
        if (delta === 0) {
            return 'using the same number of tokens';
        }
        return `using ${Math.abs(delta).toLocaleString()} ${delta > 0 ? 'more' : 'fewer'} tokens`;
    }

    function renderEnvironmentDelta(baseline, current) {
        const differences = [];
        const pairs = [
            ['Model', baseline.environment?.model, current.environment?.model],
            ['Preset', baseline.environment?.presetName, current.environment?.presetName],
            ['Connection', baseline.environment?.profileName, current.environment?.profileName],
            ['SillyBunny version', baseline.environment?.forkVersion, current.environment?.forkVersion],
        ];
        for (const [label, before, after] of pairs) {
            if (before && after && before !== after) {
                differences.push(`${label}: ${before} → ${after}`);
            }
        }
        if (macroConfigDiffers(baseline.environment?.macroEnhanced ?? null, current.environment?.macroEnhanced ?? null)) {
            differences.push('The Macro Enhanced configuration changed between these runs.');
        }
        const tagsBefore = baseline.environment?.promptTagsProfile?.profileName ?? '';
        const tagsAfter = current.environment?.promptTagsProfile?.profileName ?? '';
        if (tagsBefore !== tagsAfter) {
            differences.push(`Prompt Tags profile: ${tagsBefore || 'none'} → ${tagsAfter || 'none'}`);
        }
        if (!differences.length) {
            return;
        }
        const note = element('div', { className: 'sbpl-warning', attributes: { role: 'note' } });
        note.append(element('p', {
            className: 'sbpl-warning-text',
            text: 'These runs were made with different settings, which may explain the difference:',
        }));
        const list = element('ul', { className: 'sbpl-caveat-list' });
        for (const line of differences) {
            list.append(element('li', { text: line }));
        }
        note.append(list);
        output.append(note);
    }

    function renderTokenTable(rows) {
        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Section', 'Baseline', 'This run', 'Change']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');
        for (const row of rows) {
            const delta = row.currentTokens - row.baselineTokens;
            const tr = element('tr');
            tr.append(element('td', { text: SECTION_LABEL[row.id] ?? row.id }));
            tr.append(element('td', { className: 'sbpl-number', text: formatTokens(row.baselineTokens) }));
            tr.append(element('td', { className: 'sbpl-number', text: formatTokens(row.currentTokens) }));
            tr.append(element('td', {
                className: 'sbpl-number',
                text: delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${formatTokens(Math.abs(delta))}`,
            }));
            body.append(tr);
        }
        table.append(head, body);
        scroller.append(table);
        return scroller;
    }

    function renderSectionDiff(row) {
        const wrapper = element('details', { className: 'sbpl-diff-section' });
        wrapper.open = true;
        const label = SECTION_LABEL[row.id] ?? row.id;
        const delta = row.currentTokens - row.baselineTokens;
        const suffix = row.onlyInBaseline
            ? ' (removed)'
            : (row.onlyInCurrent ? ' (added)' : '');
        wrapper.append(element('summary', {
            className: 'sbpl-diff-summary',
            text: `${label}${suffix} — ${delta === 0 ? 'same size' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()} tokens`}`,
        }));

        const pre = element('pre', { className: 'sbpl-diff-body' });
        for (const part of collapseUnchanged(row.parts)) {
            const span = element('span', {
                className: `sbpl-diff-${part.type}`,
                text: part.text,
            });
            if (part.type === PART.ADDED) {
                span.setAttribute('aria-label', `Added: ${part.text}`);
            } else if (part.type === PART.REMOVED) {
                span.setAttribute('aria-label', `Removed: ${part.text}`);
            }
            pre.append(span);
        }
        wrapper.append(pre);
        return wrapper;
    }

    function build() {
        root = element('div', { className: 'sbpl-diff-tab' });
        const controls = element('div', { className: 'sbpl-controls' });

        suiteSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Suite' } });
        suiteSelect.addEventListener('change', async () => {
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
            activeCase = null;
            await reloadCases();
        });

        caseSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Test case' } });
        caseSelect.addEventListener('change', async () => {
            activeCase = cases.find(item => item.id === caseSelect.value) ?? null;
            await reloadRuns();
        });

        baseSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Compare from' } });
        compareSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Compare to' } });
        baseSelect.addEventListener('change', () => { void render(); });
        compareSelect.addEventListener('change', () => { void render(); });

        const rawLabel = element('label', { className: 'checkbox_label sbpl-raw-toggle' });
        rawToggle = element('input', { attributes: { type: 'checkbox' } });
        rawToggle.checked = !getSettings().normalizeVolatile;
        rawToggle.addEventListener('change', () => {
            updateSettings({ normalizeVolatile: !rawToggle.checked });
            void render();
        });
        rawLabel.append(rawToggle, element('span', { text: 'Show parts that change every run' }));

        const promote = button('Set the newer run as the baseline', async () => {
            if (!activeSuite || !activeCase || !compareSelect.value) {
                return;
            }
            await lab.promoteBaseline(activeSuite, activeCase.id, compareSelect.value);
            status.textContent = 'Saved as the baseline for this test case.';
            await reload();
        }, { className: 'menu_button sbpl-button' });

        controls.append(suiteSelect, caseSelect);
        const runControls = element('div', { className: 'sbpl-controls' });
        runControls.append(
            element('span', { className: 'sbpl-field-label', text: 'From' }),
            baseSelect,
            element('span', { className: 'sbpl-field-label', text: 'To' }),
            compareSelect,
            promote,
        );

        status = statusRegion('');
        output = element('div', { className: 'sbpl-diff-output' });
        root.append(controls, runControls, rawLabel, status, output);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Runs could not be loaded: ${errorMessage(error)}`;
                });
            }
            return root;
        },
        refresh() {
            void reload().catch(() => {});
        },
        dispose() {
            root?.remove();
            root = null;
        },
    };
}
