import { compareProfiles, listComparableProfiles } from '../ab.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { getContext } from '../host.js';
import * as lab from '../lab.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

/**
 * Sends one captured prompt to two connection profiles and shows the replies
 * next to each other. This is the only part of the extension that spends
 * tokens, so nothing happens until the button is pressed.
 */
export function createAbTab() {
    let root = null;
    let suiteSelect = null;
    let caseSelect = null;
    let runSelect = null;
    let leftSelect = null;
    let rightSelect = null;
    let tokensInput = null;
    let sendButton = null;
    let cancelButton = null;
    let status = null;
    let output = null;

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let activeCase = null;
    let runIndex = [];
    let profiles = [];
    let controller = null;

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
        loadProfiles();
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
        replace(runSelect, ...runIndex.map(entry => element('option', {
            text: describeWhen(entry.startedAt),
            attributes: { value: entry.id },
        })));
        if (runIndex.length) {
            runSelect.value = runIndex[0].id;
        }
        updateControls();
    }

    function loadProfiles() {
        profiles = listComparableProfiles(getContext());
        for (const select of [leftSelect, rightSelect]) {
            replace(select, ...profiles.map((profile) => {
                const option = element('option', {
                    text: profile.usable
                        ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                        : `${profile.name} (cannot be used here)`,
                    attributes: { value: profile.id },
                });
                option.disabled = !profile.usable;
                return option;
            }));
        }
        const usable = profiles.filter(profile => profile.usable);
        if (usable[0]) {
            leftSelect.value = usable[0].id;
        }
        if (usable[1]) {
            rightSelect.value = usable[1].id;
        }
        updateControls();
    }

    function describeWhen(value) {
        try {
            return value ? new Date(value).toLocaleString() : 'Unknown time';
        } catch {
            return String(value ?? '');
        }
    }

    function updateControls() {
        const ready = Boolean(runIndex.length && profiles.some(profile => profile.usable));
        sendButton.disabled = !ready || Boolean(controller);
        cancelButton.hidden = !controller;
    }

    async function send() {
        if (!runSelect.value) {
            return;
        }
        const run = await storage.getRun(runSelect.value);
        if (!run) {
            status.textContent = 'That run could not be loaded.';
            return;
        }
        const ids = [leftSelect.value, rightSelect.value].filter(Boolean);
        if (!ids.length) {
            status.textContent = 'Choose at least one connection profile.';
            return;
        }

        controller = new AbortController();
        updateControls();
        replace(output);
        status.textContent = 'Waiting for replies. This sends the prompt and uses tokens.';

        try {
            const maxTokens = getSettings().abMaxTokens;
            const replies = await compareProfiles(run, ids, {
                maxTokens,
                signal: controller.signal,
            });
            renderReplies(run, replies);
            status.textContent = 'Finished.';
        } catch (error) {
            status.textContent = `The replies could not be fetched: ${errorMessage(error)}`;
        } finally {
            controller = null;
            updateControls();
        }
    }

    function renderReplies(run, replies) {
        const note = element('p', { className: 'sbpl-status' });
        note.textContent = `Both replies used the same prompt of ${formatTokens(run.capture?.tokenTable?.total ?? 0)} tokens.`;
        output.append(note);

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const reply of replies) {
            const profile = profiles.find(item => item.id === reply.profileId);
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', {
                className: 'sbpl-ab-title',
                text: profile?.name ?? reply.profileId,
            }));
            if (profile?.model) {
                panel.append(element('p', { className: 'sbpl-case-meta', text: profile.model }));
            }
            panel.append(element('pre', {
                className: reply.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: reply.error ?? reply.text,
            }));
            grid.append(panel);
        }
        output.append(grid);
    }

    function build() {
        root = element('div', { className: 'sbpl-ab-tab' });

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
        runSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Run' } });

        leftSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'First connection profile' } });
        rightSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Second connection profile' } });

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '4096', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
        });

        sendButton = button('Get both replies', () => { void send(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            status.textContent = 'Stopping.';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        const pickers = element('div', { className: 'sbpl-controls' });
        pickers.append(suiteSelect, caseSelect, runSelect);
        const profilePickers = element('div', { className: 'sbpl-controls' });
        profilePickers.append(leftSelect, rightSelect, tokensInput, sendButton, cancelButton);

        status = statusRegion('');
        output = element('div', { className: 'sbpl-ab-output' });

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'This sends one saved prompt through two connections and compares their replies. Unlike prompt tests, it uses tokens. Nothing is added to any chat, and your active connection does not change.',
            }),
            pickers,
            profilePickers,
            status,
            output,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved runs could not be loaded: ${errorMessage(error)}`;
                });
            }
            if (!runIndex.length) {
                replace(output, emptyState(
                    'No saved runs yet.',
                    'Run a test case first. Its saved prompt is what gets sent here.',
                ));
            }
            return root;
        },
        refresh() {
            void reload().catch(() => {});
        },
        dispose() {
            controller?.abort();
            root?.remove();
            root = null;
        },
    };
}
