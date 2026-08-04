import { button, element, errorMessage, field, replace, statusRegion } from '../dom.js';
import { adoptEmbeddedCases, findCharactersWithTests, PRIVACY_NOTICE, readEmbeddedCases, writeEmbeddedCases, embeddedSize } from '../embed.js';
import { getContext, readInstalledPreset } from '../host.js';
import * as lab from '../lab.js';
import { reviewConnectionFields, withoutFields } from '../presets.js';
import { createDraft } from '../schema.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';
import { buildExport, downloadExport, formatSize, parseImport, suggestedFileName } from '../transfer.js';

/**
 * Preferences, moving suites between installations, and storing tests inside a
 * character card.
 */
export function createSettingsTab({ onChanged = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let status = null;
    let embedHost = null;
    let fileInput = null;
    let includePresetsInput = null;
    let includeConnectionInput = null;
    let suites = [];
    let activeSuite = null;

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
        renderEmbedSection();
    }

    async function exportSuite(includeBaselines) {
        if (!activeSuite) {
            status.textContent = 'Choose a suite to export.';
            return;
        }
        try {
            const cases = await lab.getSuiteCases(activeSuite);
            let baselineRuns = null;
            if (includeBaselines) {
                baselineRuns = [];
                for (const runId of Object.values(activeSuite.baselines ?? {})) {
                    const run = await storage.getRun(runId);
                    if (run) {
                        baselineRuns.push(run);
                    }
                }
            }
            const presets = await collectPresets(cases);
            const { text, size, kind } = buildExport(activeSuite, cases, baselineRuns, presets);
            downloadExport(suggestedFileName(activeSuite), text);
            status.textContent = `Exported ${cases.length} test case${cases.length === 1 ? '' : 's'} (${formatSize(size)})${kind === 'suite-with-baselines' ? ', including baseline runs' : ''}${presets.length ? `, with ${presets.length} preset${presets.length === 1 ? '' : 's'}` : ''}.`;
        } catch (error) {
            status.textContent = `The suite could not be exported: ${errorMessage(error)}`;
        }
    }

    /**
     * Copies the presets a suite depends on, so it still works elsewhere.
     * Settings that say where requests go are left out unless the user asks
     * for them, because they point at someone's private setup.
     */
    async function collectPresets(cases) {
        if (!includePresetsInput?.checked) {
            return [];
        }
        const wanted = new Map();
        for (const testCase of cases) {
            for (const ref of testCase.pins.presets) {
                wanted.set(`${ref.apiId}:${ref.name}`, ref);
            }
        }
        const presets = [];
        for (const ref of wanted.values()) {
            const payload = readInstalledPreset(ref.apiId, ref.name);
            if (!payload) {
                continue;
            }
            const fields = reviewConnectionFields(ref.apiId, payload);
            presets.push(createDraft({
                apiId: ref.apiId,
                name: ref.name,
                payload: includeConnectionInput?.checked
                    ? payload
                    : withoutFields(payload, fields.map(entry => entry.field)),
            }));
        }
        return presets;
    }

    async function importFile(file) {
        try {
            const text = await file.text();
            const { suite, cases, baselineRuns, presets } = parseImport(text);
            for (const testCase of cases) {
                await storage.saveCase(testCase);
            }
            for (const run of baselineRuns) {
                await storage.saveRun(run);
            }
            for (const draft of presets) {
                await storage.saveDraft(draft);
            }
            await storage.saveSuite(suite);
            activeSuite = suite;
            status.textContent = `Imported "${suite.name}" with ${cases.length} test case${cases.length === 1 ? '' : 's'}${baselineRuns.length ? ' and its baseline runs' : ''}${presets.length ? `. Its ${presets.length} preset${presets.length === 1 ? ' is' : 's are'} waiting on the Presets tab, ready to publish` : ''}.`;
            await reload();
            onChanged?.();
        } catch (error) {
            status.textContent = `That file could not be imported: ${errorMessage(error)}`;
        }
    }

    function renderEmbedSection() {
        replace(embedHost);
        embedHost.append(element('p', { className: 'sbpl-field-label', text: 'Tests stored inside character cards' }));
        embedHost.append(element('p', { className: 'sbpl-settings-note', text: PRIVACY_NOTICE }));

        const context = getContext();
        const carriers = findCharactersWithTests(context);
        if (carriers.length) {
            const list = element('ul', { className: 'sbpl-case-list' });
            for (const carrier of carriers) {
                const item = element('li', { className: 'sbpl-case-item' });
                item.append(element('span', {
                    text: `${carrier.name} — ${carrier.count} test case${carrier.count === 1 ? '' : 's'}`,
                }));
                item.append(button('Copy into this suite', async () => {
                    if (!activeSuite) {
                        status.textContent = 'Create a suite first.';
                        return;
                    }
                    const adopted = adoptEmbeddedCases(readEmbeddedCases(context, carrier.avatar), carrier.avatar);
                    for (const testCase of adopted) {
                        await storage.saveCase(testCase);
                    }
                    await storage.saveSuite({
                        ...activeSuite,
                        caseIds: [...activeSuite.caseIds, ...adopted.map(item2 => item2.id)],
                    });
                    status.textContent = `Copied ${adopted.length} test case${adopted.length === 1 ? '' : 's'} from ${carrier.name}.`;
                    await reload();
                    onChanged?.();
                }, { className: 'menu_button sbpl-button' }));
                list.append(item);
            }
            embedHost.append(list);
        } else {
            embedHost.append(element('p', {
                className: 'sbpl-case-meta',
                text: 'No installed character card carries test cases.',
            }));
        }

        const saveInto = button('Save this suite into a character card', async () => {
            if (!activeSuite) {
                status.textContent = 'Choose a suite first.';
                return;
            }
            const cases = await lab.getSuiteCases(activeSuite);
            const avatar = cases.find(item => item.pins.characterAvatar)?.pins.characterAvatar;
            if (!avatar) {
                status.textContent = 'None of these test cases has a character, so there is no card to save them into.';
                return;
            }
            const forCharacter = cases.filter(item => item.pins.characterAvatar === avatar);
            const size = embeddedSize(forCharacter);
            const confirmed = globalThis.confirm?.(
                `${PRIVACY_NOTICE}\n\n${forCharacter.length} test case${forCharacter.length === 1 ? '' : 's'} (${formatSize(size)}) will be saved into this card.\n\nSave them?`,
            );
            if (!confirmed) {
                status.textContent = 'Nothing was saved into the card.';
                return;
            }
            try {
                await writeEmbeddedCases(getContext(), avatar, forCharacter);
                status.textContent = `Saved ${forCharacter.length} test case${forCharacter.length === 1 ? '' : 's'} into the card.`;
                renderEmbedSection();
            } catch (error) {
                status.textContent = `They could not be saved into the card: ${errorMessage(error)}`;
            }
        }, { className: 'menu_button sbpl-button' });
        embedHost.append(saveInto);
    }

    function build() {
        root = element('div', { className: 'sbpl-settings-tab' });
        const settings = getSettings();

        const retention = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '1', max: '200', step: '1' },
        });
        retention.value = String(settings.runRetention);
        retention.addEventListener('change', () => {
            const next = updateSettings({ runRetention: Number(retention.value) });
            retention.value = String(next.runRetention);
            status.textContent = `Keeping the newest ${next.runRetention} runs for each test case.`;
        });

        const depth = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '0', max: '20', step: '1', placeholder: 'Not set' },
        });
        depth.value = settings.manualCachingAtDepth === null ? '' : String(settings.manualCachingAtDepth);
        depth.addEventListener('change', () => {
            const raw = depth.value.trim();
            const next = updateSettings({ manualCachingAtDepth: raw === '' ? null : Number(raw) });
            depth.value = next.manualCachingAtDepth === null ? '' : String(next.manualCachingAtDepth);
            status.textContent = next.manualCachingAtDepth === null
                ? 'Prompt caching checks are turned off.'
                : `Prompt caching checks will assume a depth of ${next.manualCachingAtDepth}.`;
        });

        suiteSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Suite' } });
        suiteSelect.addEventListener('change', () => {
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
            renderEmbedSection();
        });

        fileInput = element('input', {
            className: 'sbpl-file-input',
            attributes: { type: 'file', accept: 'application/json,.json', 'aria-label': 'Suite file to import' },
        });
        fileInput.addEventListener('change', async () => {
            const [file] = fileInput.files ?? [];
            if (file) {
                await importFile(file);
            }
            fileInput.value = '';
        });

        includePresetsInput = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        includeConnectionInput = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        includeConnectionInput.disabled = true;
        includePresetsInput.addEventListener('change', () => {
            includeConnectionInput.disabled = !includePresetsInput.checked;
            if (!includePresetsInput.checked) {
                includeConnectionInput.checked = false;
            }
        });
        const presetChoice = element('label', { className: 'sbpl-field sbpl-field-inline' });
        presetChoice.append(includePresetsInput, element('span', {
            className: 'sbpl-field-label',
            text: 'Include the presets these tests use',
        }));
        const connectionChoice = element('label', { className: 'sbpl-field sbpl-field-inline' });
        connectionChoice.append(includeConnectionInput, element('span', {
            className: 'sbpl-field-label',
            text: 'Also include proxy and endpoint settings',
        }));

        const transfer = element('div', { className: 'sbpl-controls' });
        transfer.append(
            suiteSelect,
            button('Export suite', () => { void exportSuite(false); }, { className: 'menu_button sbpl-button' }),
            button('Export with baselines', () => { void exportSuite(true); }, { className: 'menu_button sbpl-button' }),
        );

        const danger = button('Delete all saved runs', async () => {
            const confirmed = globalThis.confirm?.('This deletes every saved run. Test cases and suites are kept. Continue?');
            if (!confirmed) {
                return;
            }
            for (const testCase of await storage.listCases()) {
                for (const entry of await storage.listRuns(testCase.id)) {
                    await storage.deleteRun(testCase.id, entry.id);
                }
            }
            status.textContent = 'Deleted every saved run.';
            onChanged?.();
        }, { className: 'menu_button sbpl-button' });

        status = statusRegion('');
        embedHost = element('div', { className: 'sbpl-embed-section' });

        root.append(
            field('Runs kept for each test case', retention, {
                hint: 'Older runs are removed to save space. A run set as a baseline is always kept.',
            }),
            field('Prompt caching depth', depth, {
                hint: 'Only needed for the caching check. Your server administrator sets this value; leave it empty to skip those checks.',
            }),
            element('p', { className: 'sbpl-field-label', text: 'Moving suites between installations' }),
            presetChoice,
            connectionChoice,
            transfer,
            field('Import a suite file', fileInput),
            embedHost,
            element('p', { className: 'sbpl-field-label', text: 'Clearing data' }),
            danger,
            status,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Suites could not be loaded: ${errorMessage(error)}`;
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
