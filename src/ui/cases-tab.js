import { ASSERTION, ASSERTION_LABEL } from '../constants.js';
import { button, element, emptyState, errorMessage, field, replace, statusRegion } from '../dom.js';
import { getContext } from '../host.js';
import * as lab from '../lab.js';
import { createCase, createSuite, validateCase } from '../schema.js';
import * as storage from '../storage.js';

/**
 * Lists suites and their test cases, and edits one case at a time.
 * Every pin is chosen from what is actually installed, so a case cannot be
 * written that names a character or preset that does not exist.
 */
export function createCasesTab({ onChanged = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let listHost = null;
    let editorHost = null;
    let status = null;

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let editing = null;

    async function reload() {
        suites = await storage.listSuites();
        if (!activeSuite || !suites.some(suite => suite.id === activeSuite.id)) {
            activeSuite = suites[0] ?? null;
        } else {
            activeSuite = suites.find(suite => suite.id === activeSuite.id) ?? null;
        }
        cases = activeSuite ? await lab.getSuiteCases(activeSuite) : [];
        renderAll();
        onChanged?.();
    }

    function renderSuiteSelect() {
        replace(suiteSelect, ...suites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        suiteSelect.disabled = suites.length === 0;
    }

    function renderList() {
        replace(listHost);
        if (!activeSuite) {
            listHost.append(emptyState(
                'No test suites yet.',
                'A suite is a group of test cases you run together, such as every character that uses one preset.',
            ));
            return;
        }
        if (!cases.length) {
            listHost.append(emptyState(
                'This suite has no test cases yet.',
                'A test case pins a character and the settings it uses, then checks the prompt they produce.',
            ));
            return;
        }
        const list = element('ul', { className: 'sbpl-case-list' });
        for (const testCase of cases) {
            const item = element('li', { className: 'sbpl-case-item' });
            const label = element('div', { className: 'sbpl-case-label' });
            label.append(
                element('span', { className: 'sbpl-case-name', text: testCase.name }),
                element('span', {
                    className: 'sbpl-case-meta',
                    text: `${testCase.pins.characterAvatar || 'no character'} · ${testCase.assertions.length} check${testCase.assertions.length === 1 ? '' : 's'}`,
                }),
            );
            const actions = element('div', { className: 'sbpl-case-actions' });
            actions.append(
                button('Edit', () => {
                    editing = { ...testCase };
                    renderEditor();
                }, { className: 'menu_button sbpl-button' }),
                button('Delete', async () => {
                    await storage.deleteCase(testCase.id);
                    await storage.saveSuite({
                        ...activeSuite,
                        caseIds: activeSuite.caseIds.filter(id => id !== testCase.id),
                    });
                    if (editing?.id === testCase.id) {
                        editing = null;
                    }
                    status.textContent = `Deleted "${testCase.name}".`;
                    await reload();
                }, { className: 'menu_button sbpl-button' }),
            );
            item.append(label, actions);
            list.append(item);
        }
        listHost.append(list);
    }

    function optionList(select, items, { valueKey, labelKey, includeBlank = '' }) {
        const options = [];
        if (includeBlank) {
            options.push(element('option', { text: includeBlank, attributes: { value: '' } }));
        }
        for (const item of items) {
            options.push(element('option', {
                text: String(item[labelKey]),
                attributes: { value: String(item[valueKey]) },
            }));
        }
        replace(select, ...options);
    }

    function renderEditor() {
        replace(editorHost);
        if (!editing) {
            return;
        }
        const options = lab.readAvailableOptions(getContext());
        const form = element('div', { className: 'sbpl-editor' });

        const nameInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        nameInput.value = editing.name;
        nameInput.addEventListener('input', () => { editing.name = nameInput.value; });

        const characterSelect = element('select', { className: 'text_pole sbpl-select' });
        optionList(characterSelect, options.characters, {
            valueKey: 'avatar',
            labelKey: 'name',
            includeBlank: 'Choose a character',
        });
        characterSelect.value = editing.pins.characterAvatar;
        characterSelect.addEventListener('change', () => {
            editing.pins.characterAvatar = characterSelect.value;
        });

        const personaSelect = element('select', { className: 'text_pole sbpl-select' });
        optionList(personaSelect, options.personas, {
            valueKey: 'key',
            labelKey: 'name',
            includeBlank: 'Leave the persona as it is',
        });
        personaSelect.value = editing.pins.personaKey ?? '';
        personaSelect.addEventListener('change', () => {
            editing.pins.personaKey = personaSelect.value || null;
        });

        const profileSelect = element('select', { className: 'text_pole sbpl-select' });
        optionList(profileSelect, options.profiles, {
            valueKey: 'id',
            labelKey: 'name',
            includeBlank: 'Leave the connection as it is',
        });
        profileSelect.value = editing.pins.connectionProfileId;
        profileSelect.addEventListener('change', () => {
            editing.pins.connectionProfileId = profileSelect.value;
        });

        const presetSelect = element('select', { className: 'text_pole sbpl-select' });
        optionList(presetSelect, options.presets.map(name => ({ name })), {
            valueKey: 'name',
            labelKey: 'name',
            includeBlank: 'Leave the preset as it is',
        });
        presetSelect.value = editing.pins.preset?.name ?? '';
        presetSelect.addEventListener('change', () => {
            editing.pins.preset = presetSelect.value
                ? { apiId: '', name: presetSelect.value }
                : null;
        });

        const messageInput = element('textarea', {
            className: 'text_pole sbpl-textarea',
            attributes: { rows: '3' },
        });
        messageInput.value = editing.userMessage;
        messageInput.addEventListener('input', () => { editing.userMessage = messageInput.value; });

        form.append(
            field('Name', nameInput),
            field('Character', characterSelect),
            field('Persona', personaSelect),
            field('Connection profile', profileSelect),
            field('Preset', presetSelect),
            field('Example message', messageInput, {
                hint: 'Added to the chat while the prompt is built, then removed. Nothing is sent and nothing is saved to the chat.',
            }),
            renderAssertionEditor(),
        );

        const problems = element('ul', { className: 'sbpl-problems' });
        const save = button('Save test case', async () => {
            const found = validateCase(editing);
            replace(problems, ...found.map(text => element('li', { text })));
            if (found.length) {
                return;
            }
            const saved = await storage.saveCase(editing);
            if (!activeSuite.caseIds.includes(saved.id)) {
                await storage.saveSuite({
                    ...activeSuite,
                    caseIds: [...activeSuite.caseIds, saved.id],
                });
            }
            editing = null;
            status.textContent = `Saved "${saved.name}".`;
            await reload();
        }, { className: 'menu_button sbpl-button sbpl-button-primary' });

        const cancel = button('Cancel', () => {
            editing = null;
            renderEditor();
        }, { className: 'menu_button sbpl-button' });

        form.append(problems, element('div', { className: 'sbpl-editor-actions' }));
        form.lastChild.append(save, cancel);
        editorHost.append(form);
    }

    function renderAssertionEditor() {
        const wrapper = element('div', { className: 'sbpl-assertions' });
        wrapper.append(element('p', { className: 'sbpl-field-label', text: 'Checks' }));

        const list = element('ul', { className: 'sbpl-assertion-list' });
        const redraw = () => {
            replace(list, ...editing.assertions.map((assertion, index) => {
                const item = element('li', { className: 'sbpl-assertion-item' });
                item.append(element('span', {
                    text: describeAssertion(assertion),
                }));
                item.append(button('Remove', () => {
                    editing.assertions.splice(index, 1);
                    redraw();
                }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
                return item;
            }));
            if (!editing.assertions.length) {
                list.append(element('li', {
                    className: 'sbpl-assertion-empty',
                    text: 'No checks yet. A test case without checks still records the prompt and compares it against the baseline.',
                }));
            }
        };
        redraw();

        const typeSelect = element('select', { className: 'text_pole sbpl-select' });
        for (const [type, label] of Object.entries(ASSERTION_LABEL)) {
            typeSelect.append(element('option', { text: label, attributes: { value: type } }));
        }
        const valueInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'text', placeholder: 'Section name, text, or number' },
        });
        const add = button('Add check', () => {
            const assertion = buildAssertion(typeSelect.value, valueInput.value);
            if (assertion) {
                editing.assertions.push(assertion);
                valueInput.value = '';
                redraw();
            }
        }, { className: 'menu_button sbpl-button' });

        const adder = element('div', { className: 'sbpl-assertion-adder' });
        adder.append(typeSelect, valueInput, add);
        wrapper.append(list, adder);
        return wrapper;
    }

    function renderAll() {
        renderSuiteSelect();
        renderList();
        renderEditor();
    }

    function build() {
        root = element('div', { className: 'sbpl-cases-tab' });
        const controls = element('div', { className: 'sbpl-controls' });
        suiteSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Suite' },
        });
        suiteSelect.addEventListener('change', async () => {
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
            editing = null;
            cases = activeSuite ? await lab.getSuiteCases(activeSuite) : [];
            renderAll();
        });

        const newSuite = button('New suite', async () => {
            const suite = await storage.saveSuite(createSuite({ name: `Suite ${suites.length + 1}` }));
            activeSuite = suite;
            status.textContent = `Created "${suite.name}".`;
            await reload();
        }, { className: 'menu_button sbpl-button' });

        const newCase = button('New test case', () => {
            if (!activeSuite) {
                status.textContent = 'Create a suite first.';
                return;
            }
            editing = createCase({ name: `Test case ${cases.length + 1}` });
            renderEditor();
        }, { className: 'menu_button sbpl-button sbpl-button-primary' });

        controls.append(suiteSelect, newSuite, newCase);
        status = statusRegion('');
        listHost = element('div', { className: 'sbpl-case-list-host' });
        editorHost = element('div', { className: 'sbpl-editor-host' });
        root.append(controls, status, listHost, editorHost);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved test cases could not be loaded: ${errorMessage(error)}`;
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

function buildAssertion(type, rawValue) {
    const value = String(rawValue ?? '').trim();
    switch (type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            return value ? { type, section: value } : null;
        case ASSERTION.TOKEN_CEILING: {
            const max = Number(value);
            return Number.isFinite(max) && max > 0 ? { type, scope: 'total', max: Math.trunc(max) } : null;
        }
        case ASSERTION.CONTENT_MATCH:
            return value ? { type, scope: 'final', mode: 'contains', value, negate: false } : null;
        case ASSERTION.WI_ACTIVATED:
            return value ? { type, worldName: '', entryKey: value, negate: false } : null;
        case ASSERTION.CACHE_PREFIX_STABLE:
            return { type };
        default:
            return null;
    }
}

export function describeAssertion(assertion) {
    const label = ASSERTION_LABEL[assertion?.type] ?? assertion?.type ?? 'Unknown check';
    switch (assertion?.type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            return `${label}: ${assertion.section}`;
        case ASSERTION.TOKEN_CEILING:
            return `${label}: ${assertion.scope === 'total' ? 'whole prompt' : assertion.scope} under ${assertion.max.toLocaleString()} tokens`;
        case ASSERTION.CONTENT_MATCH:
            return `${label}: "${assertion.value}"${assertion.negate ? ' (must not appear)' : ''}`;
        case ASSERTION.WI_ACTIVATED:
            return `${label}: ${assertion.entryKey}${assertion.negate ? ' (must not activate)' : ''}`;
        default:
            return label;
    }
}
