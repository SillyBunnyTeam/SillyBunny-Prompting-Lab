import { listComparableProfiles } from '../ab.js';
import { button, element, emptyState, errorMessage, field, promptField, replace, statusRegion } from '../dom.js';
import { readCharacterCard, requestAnalysis, runExperiment } from '../experiment.js';
import { getContext } from '../host.js';
import { getSelectedVersion } from '../prompt-drafts.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

const ROLES = ['system', 'user', 'assistant'];
const ANALYSIS_MAX_TOKENS = 800;

/**
 * Compares a prompt with a modified version of it. Both versions are sent
 * through the same connection, against the same scenario and character card,
 * so the prompt text is the only difference between the two requests. An
 * optional follow-up asks a model what changed and what the replies show.
 *
 * Everything here spends tokens, so nothing is sent until a button is pressed.
 */
export function createExperimentTab() {
    let root = null;
    let promptATextarea = null;
    let promptBTextarea = null;
    let loaderPromptSelect = null;
    let loaderVersionSelect = null;
    let roleSelect = null;
    let characterSelect = null;
    let scenarioTextarea = null;
    let profileSelect = null;
    let tokensInput = null;
    let runButton = null;
    let cancelButton = null;
    let status = null;
    let output = null;
    let analysisHost = null;

    let prompts = [];
    let profiles = [];
    let characters = [];
    let controller = null;
    let lastResult = null;

    async function reload() {
        prompts = await storage.listPromptDrafts();
        renderLoaderOptions();
        loadProfiles();
        loadCharacters();
    }

    function renderLoaderOptions() {
        const previous = loaderPromptSelect.value;
        replace(loaderPromptSelect, ...prompts.map(prompt => element('option', {
            text: prompt.title,
            attributes: { value: prompt.id },
        })));
        if (prompts.some(prompt => prompt.id === previous)) {
            loaderPromptSelect.value = previous;
        }
        renderLoaderVersions();
    }

    function renderLoaderVersions() {
        const prompt = prompts.find(item => item.id === loaderPromptSelect.value);
        replace(loaderVersionSelect, ...(prompt?.versions ?? []).map(version => element('option', {
            text: version.label,
            attributes: { value: version.id },
        })));
        if (prompt) {
            loaderVersionSelect.value = getSelectedVersion(prompt)?.id ?? prompt.versions[0].id;
        }
    }

    function loadedVersionContent() {
        const prompt = prompts.find(item => item.id === loaderPromptSelect.value);
        const version = prompt?.versions.find(item => item.id === loaderVersionSelect.value);
        return version ? { prompt, version } : null;
    }

    function loadProfiles() {
        const previous = profileSelect.value;
        profiles = listComparableProfiles(getContext());
        replace(profileSelect, ...profiles.map((profile) => {
            const option = element('option', {
                text: profile.usable
                    ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                    : `${profile.name} (cannot be used here)`,
                attributes: { value: profile.id },
            });
            option.disabled = !profile.usable;
            return option;
        }));
        const usable = profiles.filter(profile => profile.usable);
        if (profiles.some(profile => profile.id === previous && profile.usable)) {
            profileSelect.value = previous;
        } else if (usable[0]) {
            profileSelect.value = usable[0].id;
        }
        updateControls();
    }

    function loadCharacters() {
        const previous = characterSelect.value;
        characters = (getContext()?.characters ?? [])
            .filter(character => character?.avatar)
            .map(character => ({ avatar: character.avatar, name: character.name ?? character.avatar }));
        replace(
            characterSelect,
            element('option', { text: 'No character card', attributes: { value: '' } }),
            ...characters.map(character => element('option', {
                text: character.name,
                attributes: { value: character.avatar },
            })),
        );
        if (characters.some(character => character.avatar === previous)) {
            characterSelect.value = previous;
        }
    }

    function updateControls() {
        const ready = profiles.some(profile => profile.usable);
        runButton.disabled = !ready || Boolean(controller);
        cancelButton.hidden = !controller;
    }

    /* --------------------------------------------------------------- run */

    async function run() {
        const promptA = promptATextarea.value;
        const promptB = promptBTextarea.value;
        if (!promptA.trim() && !promptB.trim()) {
            status.textContent = 'Write a prompt in at least one of the two boxes first.';
            return;
        }
        if (!profileSelect.value) {
            status.textContent = 'Choose a connection profile.';
            return;
        }

        controller = new AbortController();
        updateControls();
        lastResult = null;
        replace(output);
        replace(analysisHost);
        status.textContent = 'Waiting for both replies. This sends the prompts and uses tokens.';

        try {
            const character = characterSelect.value
                ? readCharacterCard(characterSelect.value, getContext())
                : null;
            const scenario = scenarioTextarea.value;
            const replies = await runExperiment({
                promptA,
                promptB,
                role: roleSelect.value,
                character,
                scenario,
                profileId: profileSelect.value,
                maxTokens: getSettings().abMaxTokens,
                signal: controller.signal,
            });
            lastResult = {
                replies,
                promptA,
                promptB,
                scenario,
                characterName: character?.name ?? '',
            };
            renderReplies(replies);
            renderAnalysisControls();
            status.textContent = 'Finished.';
        } catch (error) {
            status.textContent = `The replies could not be fetched: ${errorMessage(error)}`;
        } finally {
            controller = null;
            updateControls();
        }
    }

    function renderReplies(replies) {
        const profile = profiles.find(item => item.id === profileSelect.value);
        const note = element('p', { className: 'sbpl-status' });
        note.textContent = 'Both requests shared the same scenario, character, and connection'
            + `${profile ? ` (${profile.name})` : ''}; only the prompt differed.`;
        output.append(note);

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const reply of replies) {
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', { className: 'sbpl-ab-title', text: `Prompt ${reply.key}` }));
            panel.append(element('pre', {
                className: reply.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: reply.error ?? reply.text,
            }));
            grid.append(panel);
        }
        output.append(grid);
    }

    /* ---------------------------------------------------------- analysis */

    function renderAnalysisControls() {
        replace(analysisHost);
        if (!lastResult || lastResult.replies.every(reply => reply.error)) {
            return;
        }
        const wrapper = element('div', { className: 'sbpl-analysis' });
        wrapper.append(
            element('p', { className: 'sbpl-field-label', text: 'Analysis (optional)' }),
            element('p', {
                className: 'sbpl-field-hint',
                text: 'Asks a model what changed between the two prompts and what the replies show. This sends one more request and uses tokens.',
            }),
        );

        const analysisProfileSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Connection profile for the analysis' },
        });
        for (const profile of profiles) {
            const option = element('option', {
                text: profile.usable
                    ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                    : `${profile.name} (cannot be used here)`,
                attributes: { value: profile.id },
            });
            option.disabled = !profile.usable;
            analysisProfileSelect.append(option);
        }
        if (profileSelect.value) {
            analysisProfileSelect.value = profileSelect.value;
        }

        const analysisOutput = element('div', { className: 'sbpl-ab-output' });
        const analyzeButton = button('Get the analysis', () => {
            void analyze(analysisProfileSelect.value, analysisOutput, analyzeButton).catch((error) => {
                status.textContent = errorMessage(error);
            });
        }, { className: 'menu_button sbpl-button' });

        const controls = element('div', { className: 'sbpl-controls' });
        controls.append(analysisProfileSelect, analyzeButton);
        wrapper.append(controls, analysisOutput);
        analysisHost.append(wrapper);
    }

    async function analyze(profileId, analysisOutput, analyzeButton) {
        if (!lastResult || !profileId) {
            return;
        }
        analyzeButton.disabled = true;
        status.textContent = 'Waiting for the analysis. This sends a request and uses tokens.';
        try {
            const [replyA, replyB] = lastResult.replies;
            const result = await requestAnalysis({
                promptA: lastResult.promptA,
                promptB: lastResult.promptB,
                replyA: replyA?.text ?? '',
                replyB: replyB?.text ?? '',
                scenario: lastResult.scenario,
                characterName: lastResult.characterName,
            }, {
                profileId,
                maxTokens: ANALYSIS_MAX_TOKENS,
            });
            replace(analysisOutput, element('pre', {
                className: result.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: result.error ?? result.text,
            }));
            status.textContent = result.error ? 'The analysis could not be fetched.' : 'Finished.';
        } finally {
            analyzeButton.disabled = false;
        }
    }

    /* --------------------------------------------------------------- build */

    function build() {
        root = element('div', { className: 'sbpl-experiment-tab' });

        const promptA = promptField('Prompt A', {
            rows: 6,
            hint: 'The prompt as it is now.',
        });
        promptATextarea = promptA.textarea;
        const promptB = promptField('Prompt B', {
            rows: 6,
            hint: 'The modified version to test against it.',
        });
        promptBTextarea = promptB.textarea;

        const copyDown = button('Copy A into B', () => {
            promptBTextarea.value = promptATextarea.value;
        }, {
            className: 'menu_button sbpl-button',
            title: 'Start the modified version from the current prompt',
        });

        loaderPromptSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Prompt to load' },
        });
        loaderPromptSelect.addEventListener('change', renderLoaderVersions);
        loaderVersionSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Draft version to load' },
        });
        const loadA = button('Load into A', () => {
            const loaded = loadedVersionContent();
            if (loaded) {
                promptATextarea.value = loaded.version.content;
                status.textContent = `Loaded "${loaded.prompt.title}" (${loaded.version.label}) into prompt A.`;
            }
        }, { className: 'menu_button sbpl-button' });
        const loadB = button('Load into B', () => {
            const loaded = loadedVersionContent();
            if (loaded) {
                promptBTextarea.value = loaded.version.content;
                status.textContent = `Loaded "${loaded.prompt.title}" (${loaded.version.label}) into prompt B.`;
            }
        }, { className: 'menu_button sbpl-button' });
        const loader = element('div', { className: 'sbpl-field' });
        const loaderControls = element('div', { className: 'sbpl-controls' });
        loaderControls.append(loaderPromptSelect, loaderVersionSelect, loadA, loadB);
        loader.append(
            element('p', { className: 'sbpl-field-label', text: 'Load a saved prompt' }),
            loaderControls,
            element('span', {
                className: 'sbpl-field-hint',
                text: 'Prompts and their drafts come from the Prompts tab.',
            }),
        );

        roleSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Role the prompts speak as' },
        });
        for (const role of ROLES) {
            roleSelect.append(element('option', { text: role, attributes: { value: role } }));
        }

        characterSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Character card to test with' },
        });

        scenarioTextarea = element('textarea', {
            className: 'text_pole sbpl-textarea',
            attributes: { rows: '2', 'aria-label': 'Test message' },
        });

        profileSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Connection profile' },
        });

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '4096', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
        });

        runButton = button('Get both replies', () => { void run(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            status.textContent = 'Stopping.';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        const sendControls = element('div', { className: 'sbpl-controls' });
        sendControls.append(profileSelect, tokensInput, runButton, cancelButton);

        status = statusRegion('');
        output = element('div', { className: 'sbpl-ab-output' });
        analysisHost = element('div', { className: 'sbpl-analysis-host' });

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Test a prompt against a modified version of it. Both are sent through the same connection with the same character card and test message, so any difference in the replies points at your change. Like Compare models, this uses tokens when you ask for replies.',
            }),
            promptA.wrapper,
            copyDown,
            promptB.wrapper,
            loader,
            field('Speaking as', roleSelect),
            field('Character card', characterSelect, {
                hint: 'Adds the character\'s description, personality, scenario, and greeting to both requests.',
            }),
            field('Test message', scenarioTextarea, {
                hint: 'Sent as the user message in both requests. Left empty, a plain "Hello." is sent.',
            }),
            sendControls,
            status,
            output,
            analysisHost,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved prompts could not be loaded: ${errorMessage(error)}`;
                });
            }
            if (!lastResult) {
                replace(output, emptyState(
                    'No comparison yet.',
                    'Fill in the two prompts, pick a connection, and choose "Get both replies".',
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
