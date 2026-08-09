import { listComparableProfiles } from '../ab.js';
import { willCreateChatFile } from '../apply-state.js';
import { CAVEAT_TEXT } from '../constants.js';
import { button, element, errorMessage, field, formatTokens, promptField, replace, statusRegion } from '../dom.js';
import { getContext, loadHost } from '../host.js';
import * as lab from '../lab.js';
import { CC_API_ID, labelForApiId, PRESET_API_IDS } from '../presets.js';
import {
    describeEstimate,
    estimateScene,
    MAX_PRESETS,
    MAX_TURNS,
    runSceneComparison,
    SCENE_MODE,
} from '../scenes.js';
import { getSettings, updateSettings } from '../settings.js';

/**
 * Plays one scene under several presets and shows what each one wrote.
 *
 * Along with Compare prompts and Compare models, this tab spends tokens, and
 * only when its button is pressed.
 */
export function createScenesTab() {
    let root = null;
    let characterSelect = null;
    let profileSelect = null;
    let kindSelect = null;
    let presetHost = null;
    let modeInputs = [];
    let turnsHost = null;
    let exchangesInput = null;
    let tokensInput = null;
    let estimateLine = null;
    let chatFileNote = null;
    let sendButton = null;
    let cancelButton = null;
    let status = null;
    let output = null;

    let options = { characters: [], presets: {}, profiles: [] };
    let profiles = [];
    let presetChecks = [];
    let turnFields = [];
    let controller = null;

    function currentMode() {
        return modeInputs.find(input => input.checked)?.value ?? SCENE_MODE.SCRIPTED;
    }

    function chosenPresets() {
        return presetChecks
            .filter(entry => entry.input.checked)
            .map(entry => ({ apiId: kindSelect.value, name: entry.name }));
    }

    function writtenTurns() {
        return turnFields.map(entry => entry.textarea.value);
    }

    function reload() {
        try {
            options = lab.readAvailableOptions(getContext());
        } catch (error) {
            status.textContent = `The characters and presets could not be read: ${errorMessage(error)}`;
            return;
        }

        const previousCharacter = characterSelect.value;
        replace(characterSelect, ...options.characters.map(character => element('option', {
            text: character.name,
            attributes: { value: character.avatar },
        })));
        if (options.characters.some(character => character.avatar === previousCharacter)) {
            characterSelect.value = previousCharacter;
        }

        const previousProfile = profileSelect.value;
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
        profileSelect.value = usable.some(profile => profile.id === previousProfile)
            ? previousProfile
            : (usable[0]?.id ?? '');

        renderPresetChoices();
        void checkChatFile();
    }

    /**
     * Playing a scene opens the character, and opening a character that has
     * never been chatted to creates a chat file for it. Say so before the
     * button is pressed rather than leaving a new file behind unannounced.
     */
    async function checkChatFile() {
        chatFileNote.hidden = true;
        if (!characterSelect.value) {
            return;
        }
        try {
            const creates = await willCreateChatFile(getContext, characterSelect.value);
            chatFileNote.hidden = !creates;
            if (creates) {
                chatFileNote.textContent = 'This character has no chat yet. Playing a scene opens it, which creates one. The scene itself is still never saved to it.';
            }
        } catch {
            // A check that cannot be made is not a reason to block the tab.
            chatFileNote.hidden = true;
        }
    }

    /** The presets of the chosen kind, as a list that can be ticked. */
    function renderPresetChoices() {
        const previous = new Set(presetChecks.filter(entry => entry.input.checked).map(entry => entry.name));
        presetChecks = [];
        replace(presetHost);

        const names = options.presets[kindSelect.value] ?? [];
        if (!names.length) {
            presetHost.append(element('p', {
                className: 'sbpl-settings-note',
                text: `SillyBunny has no ${labelForApiId(kindSelect.value).toLowerCase()} presets installed.`,
            }));
            updateControls();
            return;
        }

        for (const name of names) {
            const label = element('label', { className: 'checkbox_label sbpl-scene-preset' });
            const input = element('input', { attributes: { type: 'checkbox', value: name } });
            input.checked = previous.has(name);
            input.addEventListener('change', () => {
                // More than a handful of columns cannot be read side by side,
                // and every extra one is another round of requests.
                if (input.checked && chosenPresets().length > MAX_PRESETS) {
                    input.checked = false;
                    status.textContent = `Compare at most ${MAX_PRESETS} presets at a time.`;
                }
                updateControls();
            });
            label.append(input, element('span', { text: name }));
            presetHost.append(label);
            presetChecks.push({ name, input });
        }
        updateControls();
    }

    function renderTurnFields() {
        replace(turnsHost);
        const previous = turnFields.map(entry => entry.textarea.value);
        turnFields = [];

        const scripted = currentMode() === SCENE_MODE.SCRIPTED;
        const count = scripted ? Math.max(previous.length, 2) : 1;
        for (let index = 0; index < Math.min(count, MAX_TURNS); index += 1) {
            addTurnField(previous[index] ?? '', index);
        }

        if (scripted) {
            const actions = element('div', { className: 'sbpl-controls' });
            actions.append(
                button('Add a turn', () => {
                    if (turnFields.length >= MAX_TURNS) {
                        return;
                    }
                    addTurnField('', turnFields.length);
                    turnsHost.append(actions);
                    updateControls();
                }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
                button('Remove the last turn', () => {
                    if (turnFields.length <= 1) {
                        return;
                    }
                    turnFields.pop().wrapper.remove();
                    updateControls();
                }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
            );
            turnsHost.append(actions);
        } else {
            turnsHost.append(field('How many exchanges', exchangesInput, {
                hint: `The opening is sent, then the scene is carried on with "Continue the scene." Each preset answers its own replies from the second turn onwards, so the columns stop facing the same words.`,
            }));
        }
        updateControls();
    }

    function addTurnField(value, index) {
        const scripted = currentMode() === SCENE_MODE.SCRIPTED;
        const entry = promptField(scripted ? `Turn ${index + 1}` : 'Opening message', {
            rows: 2,
            hint: index === 0 ? 'Sent as you, exactly as written, to every preset.' : '',
        });
        entry.textarea.value = value;
        entry.textarea.addEventListener('input', updateControls);
        turnsHost.append(entry.wrapper);
        turnFields.push(entry);
    }

    function updateControls() {
        const estimate = estimateScene({
            presets: chosenPresets(),
            mode: currentMode(),
            turns: writtenTurns(),
            exchanges: Number(exchangesInput.value),
            maxTokens: Number(tokensInput.value),
        });
        estimateLine.textContent = describeEstimate(estimate);
        const ready = estimate.presets >= 2 && estimate.turns >= 1
            && Boolean(characterSelect.value) && Boolean(profileSelect.value);
        sendButton.disabled = !ready || Boolean(controller);
        cancelButton.hidden = !controller;
    }

    async function send() {
        // Set before the first await: a second click would otherwise start a
        // whole second comparison and pay for it.
        if (controller) {
            return;
        }
        controller = new AbortController();
        const { signal } = controller;
        updateControls();
        replace(output);
        status.textContent = 'Building and sending the first turn. This uses tokens.';

        try {
            const host = await loadHost();
            const result = await runSceneComparison({
                presets: chosenPresets(),
                characterAvatar: characterSelect.value,
                connectionProfileId: profileSelect.value,
                mode: currentMode(),
                turns: writtenTurns(),
                exchanges: Number(exchangesInput.value),
                maxTokens: Number(tokensInput.value),
                host,
                signal,
                onProgress: (event) => {
                    status.textContent = `${event.presetName}: turn ${event.turn} of ${event.turnTotal}`
                        + ` (preset ${event.presetIndex} of ${event.presetTotal})`;
                },
            });
            renderColumns(result);
            const parts = [result.aborted ? 'Stopped.' : 'Finished.'];
            parts.push(result.restoreProblems.length
                ? `Your settings could not be fully put back: ${result.restoreProblems.join('; ')}. Check your character, preset and connection profile.`
                : 'Your character, preset and connection have been put back.');
            status.textContent = parts.join(' ');
        } catch (error) {
            status.textContent = `The scene could not be compared: ${errorMessage(error)}`;
        } finally {
            controller = null;
            updateControls();
        }
    }

    function renderColumns(result) {
        replace(output);
        if (!result.columns.length) {
            return;
        }

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const column of result.columns) {
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', { className: 'sbpl-ab-title', text: column.label }));
            if (column.error) {
                panel.append(element('pre', { className: 'sbpl-ab-body sbpl-ab-error', text: column.error }));
            }
            for (const turn of column.turns) {
                panel.append(element('p', {
                    className: 'sbpl-scene-turn-label',
                    text: `Turn ${turn.index} · prompt ${formatTokens(turn.promptTokens)} tokens`,
                }));
                panel.append(element('p', { className: 'sbpl-scene-said', text: turn.userText }));
                panel.append(element('pre', {
                    className: turn.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                    text: turn.error ?? turn.text,
                }));
            }
            grid.append(panel);
        }
        output.append(grid);

        const codes = [...new Set(result.columns.flatMap(column => column.caveats))];
        if (codes.length) {
            const wrapper = element('div', { className: 'sbpl-caveats' });
            wrapper.append(element('p', {
                className: 'sbpl-caveats-title',
                text: 'What these replies cannot show',
            }));
            const list = element('ul', { className: 'sbpl-caveat-list' });
            for (const code of codes) {
                if (CAVEAT_TEXT[code]) {
                    list.append(element('li', { text: CAVEAT_TEXT[code] }));
                }
            }
            wrapper.append(list);
            output.append(wrapper);
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-scenes-tab' });

        characterSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Character' } });
        characterSelect.addEventListener('change', () => {
            updateControls();
            void checkChatFile();
        });
        chatFileNote = element('p', { className: 'sbpl-warning-text' });
        chatFileNote.hidden = true;
        profileSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Connection profile' } });
        profileSelect.addEventListener('change', updateControls);

        kindSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Preset kind' } });
        replace(kindSelect, ...PRESET_API_IDS.map(id => element('option', {
            text: labelForApiId(id),
            attributes: { value: id },
        })));
        kindSelect.value = CC_API_ID;
        kindSelect.addEventListener('change', renderPresetChoices);
        presetHost = element('div', { className: 'sbpl-scene-presets' });

        const modeHost = element('div', { className: 'sbpl-controls' });
        modeInputs = [
            [SCENE_MODE.SCRIPTED, 'Scripted turns'],
            [SCENE_MODE.CONTINUE, 'One opening, then continue'],
        ].map(([value, text]) => {
            const label = element('label', { className: 'checkbox_label' });
            const input = element('input', { attributes: { type: 'radio', name: 'sbpl-scene-mode', value } });
            input.checked = value === SCENE_MODE.SCRIPTED;
            input.addEventListener('change', renderTurnFields);
            label.append(input, element('span', { text }));
            modeHost.append(label);
            return input;
        });

        exchangesInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '2', max: String(MAX_TURNS), step: '1', 'aria-label': 'How many exchanges' },
        });
        exchangesInput.value = '2';
        exchangesInput.addEventListener('change', updateControls);

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '32000', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
            updateControls();
        });

        turnsHost = element('div', { className: 'sbpl-scene-turns' });
        estimateLine = element('p', { className: 'sbpl-settings-note' });
        sendButton = button('Play the scene under each preset', () => { void send(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            status.textContent = 'Stopping after the turn in flight.';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        status = statusRegion('');
        output = element('div', { className: 'sbpl-ab-output' });

        const actions = element('div', { className: 'sbpl-controls' });
        actions.append(sendButton, cancelButton);

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Sends the same scene to a real model once for each preset, so you can read how each one plays it out. This uses tokens. Nothing is added to any chat; your character, preset and connection change while it runs and are put back afterwards.',
            }),
            field('Character', characterSelect),
            chatFileNote,
            field('Connection', profileSelect, { hint: 'Every preset is sent through this same connection.' }),
            field('Preset kind', kindSelect),
            element('p', { className: 'sbpl-field-label', text: `Presets to compare (2 to ${MAX_PRESETS})` }),
            presetHost,
            element('p', { className: 'sbpl-field-label', text: 'The scene' }),
            modeHost,
            turnsHost,
            field('Reply length', tokensInput, { hint: 'The most tokens each reply may use. Shared with the other comparison tabs.' }),
            estimateLine,
            actions,
            status,
            output,
        );
        renderTurnFields();
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                reload();
            }
            return root;
        },
        refresh() {
            if (!controller) {
                reload();
            }
        },
        dispose() {
            controller?.abort();
            root?.remove();
            root = null;
        },
    };
}
