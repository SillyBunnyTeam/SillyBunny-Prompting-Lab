import { listComparableProfiles } from '../ab.js';
import { willCreateChatFile } from '../apply-state.js';
import { CAVEAT_TEXT } from '../constants.js';
import { button, element, errorMessage, field, formatTokens, promptField, replace, statusRegion } from '../dom.js';
import { getContext, loadHost } from '../host.js';
import { createCharacterPicker, createPersonaPicker } from './character-picker.js';
import { readCharacterCard, greetingChoices } from '../experiment.js';
import * as lab from '../lab.js';
import { CC_API_ID, labelForApiId, PRESET_API_IDS } from '../presets.js';
import {
    describeDuration,
    describeEstimate,
    estimateScene,
    formatScene,
    MAX_PRESETS,
    MAX_TURNS,
    runSceneComparison,
    SCENE_MODE,
    sceneFileName,
} from '../scenes.js';
import { renderScenePreview, currentPersona } from './scene-preview.js';
import { getSettings, updateSettings } from '../settings.js';
import { downloadExport } from '../transfer.js';

/**
 * Plays one scene under several presets and shows what each one wrote.
 *
 * Along with Compare prompts and Compare models, this tab spends tokens, and
 * only when its button is pressed.
 */
export function createScenesTab() {
    let root = null;
    let characterPicker = null;
    let characterSelect = null;
    let personaPicker = null;
    let personaSelect = null;
    let greetingSelect = null;
    let greetingHost = null;
    let greetingChosen = false;
    let previewHost = null;
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
    let exportHost = null;
    let output = null;

    let options = { characters: [], personas: [], presets: {}, profiles: [] };
    let card = null;
    let greetings = [];
    let profiles = [];
    let presetChecks = [];
    let turnFields = [];
    let controller = null;
    let lastResult = null;
    let lastRun = null;
    let retrying = -1;
    // The reply arriving is a text change inside one panel, not a new layout;
    // keeping the nodes lets a stream update without rebuilding the grid.
    const turnNodes = new Map();
    let tickTimer = null;

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
        characterPicker.setOptions(options.characters.map(item => ({ value: item.avatar, name: item.name })));
        characterPicker.setValue(
            options.characters.some(character => character.avatar === previousCharacter)
                ? previousCharacter
                : (options.characters[0]?.avatar ?? ''),
        );

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

        const previousPersona = personaSelect.value;
        personaPicker.setOptions(options.personas.map(item => ({ value: item.key, name: item.name })));
        const persona = currentPersona(getContext());
        personaPicker.setValue(
            options.personas.some(item => item.key === previousPersona)
                ? previousPersona
                : (options.personas.some(item => item.key === persona.key) ? persona.key : ''),
        );

        renderPresetChoices();
        renderGreetings();
        void checkChatFile();
    }

    /** The openings the chosen card offers, and the one the scene will use. */
    function renderGreetings() {
        const previous = greetingSelect.value;
        card = characterSelect.value ? readCharacterCard(characterSelect.value, getContext()) : null;
        greetings = greetingChoices(card);
        replace(
            greetingSelect,
            // Named, so that opening with the card's first message is a choice
            // on screen rather than something that quietly happens.
            element('option', { text: 'No opening', attributes: { value: '' } }),
            ...greetings.map(choice => element('option', {
                text: choice.snippet ? `${choice.label} — ${choice.snippet}` : choice.label,
                attributes: { value: String(choice.index) },
            })),
        );
        // Until someone picks, a card opens the way it says it does. After
        // that the choice is theirs and a refresh must not undo it.
        const stillOffered = previous === '' || greetings.some(choice => String(choice.index) === previous);
        greetingSelect.value = greetingChosen && stillOffered
            ? previous
            : String(greetings[0]?.index ?? '');
        // A card with one opening has nothing to choose between; a card with
        // none has nothing to show at all.
        greetingHost.hidden = greetings.length === 0;
        renderPreview();
    }

    function chosenGreeting() {
        return greetings.find(choice => String(choice.index) === greetingSelect.value)?.text ?? '';
    }

    function personaFor() {
        const chosen = options.personas.find(item => item.key === personaSelect.value);
        return chosen
            ? { key: chosen.key, name: chosen.name }
            : currentPersona(getContext());
    }

    /** The scene as it will be sent, read as a conversation. */
    function renderPreview() {
        const persona = personaFor();
        renderScenePreview(previewHost, {
            characterAvatar: card?.avatar ?? characterSelect.value,
            characterName: card?.name ?? '',
            personaKey: persona.key,
            personaName: persona.name,
            lines: [
                { from: 'character', text: chosenGreeting(), note: 'opens the scene' },
                ...writtenTurns().map((text, index) => ({
                    from: 'persona',
                    text,
                    note: currentMode() === SCENE_MODE.SCRIPTED ? `turn ${index + 1}` : 'opening message',
                })),
            ],
        });
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
        renderPreview();
    }

    function addTurnField(value, index) {
        const scripted = currentMode() === SCENE_MODE.SCRIPTED;
        const entry = promptField(scripted ? `Turn ${index + 1}` : 'Opening message', {
            rows: 2,
            hint: index === 0 ? 'Sent as you, exactly as written, to every preset.' : '',
        });
        entry.textarea.value = value;
        entry.textarea.addEventListener('input', () => {
            updateControls();
            renderPreview();
        });
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
        // Nothing may start a second run while one is in flight, retry included.
        for (const node of output.querySelectorAll('.sbpl-scene-retry')) {
            node.disabled = Boolean(controller);
        }
    }

    /** What the running comparison is doing, read back as it happens. */
    function handleUpdate({ columns, streaming = null }) {
        lastResult = { ...(lastResult ?? {}), columns };
        const nodes = streaming ? turnNodes.get(streaming) : null;
        if (nodes) {
            // Only the text and its clock changed; rebuilding the grid here
            // would throw away the reader's scroll position several times a
            // second while a long reply arrives.
            nodes.body.textContent = streaming.text;
            nodes.label.textContent = turnLabel(streaming);
            return;
        }
        renderColumns({ columns });
    }

    /** Keeps the clock on a turn that is still being waited for honest. */
    function startTicking() {
        stopTicking();
        tickTimer = setInterval(() => {
            for (const [turn, nodes] of turnNodes) {
                if (turn.waiting) {
                    nodes.label.textContent = turnLabel(turn);
                }
            }
        }, 1000);
    }

    function stopTicking() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    async function send() {
        // Set before the first await: a second click would otherwise start a
        // whole second comparison and pay for it.
        if (controller) {
            return;
        }
        controller = new AbortController();
        const { signal } = controller;
        lastResult = null;
        replace(exportHost);
        // Kept as they were when the run started, so a retry repeats this run
        // rather than whatever the form says by then.
        lastRun = {
            presets: chosenPresets(),
            characterAvatar: characterSelect.value,
            characterName: options.characters.find(item => item.avatar === characterSelect.value)?.name ?? '',
            personaKey: personaSelect.value || null,
            connectionProfileId: profileSelect.value,
            connectionName: profiles.find(profile => profile.id === profileSelect.value)?.name ?? '',
            greeting: chosenGreeting(),
            mode: currentMode(),
            turns: writtenTurns(),
            exchanges: Number(exchangesInput.value),
            maxTokens: Number(tokensInput.value),
        };
        updateControls();
        replace(output);
        status.textContent = 'Building and sending the first turn. This uses tokens.';
        startTicking();

        try {
            const host = await loadHost();
            const result = await runSceneComparison({
                ...lastRun,
                live: true,
                host,
                signal,
                onUpdate: handleUpdate,
                onProgress: (event) => {
                    status.textContent = `${event.presetName}: turn ${event.turn} of ${event.turnTotal}`
                        + ` (preset ${event.presetIndex} of ${event.presetTotal})`;
                },
            });
            lastResult = result;
            renderColumns(result);
            const parts = [result.aborted ? 'Stopped.' : 'Finished.'];
            parts.push(result.restoreProblems.length
                ? `Your settings could not be fully put back: ${result.restoreProblems.join('; ')}. Check your character, preset and connection profile.`
                : 'Your character, preset and connection have been put back.');
            status.textContent = parts.join(' ');
        } catch (error) {
            status.textContent = `The scene could not be compared: ${errorMessage(error)}`;
        } finally {
            stopTicking();
            controller = null;
            updateControls();
            renderExportBar();
        }
    }

    /**
     * Plays the scene again for one preset whose connection let it down. The
     * column starts over from the first turn: a scene half told cannot be
     * picked up in the middle without pretending the missing reply happened.
     */
    async function retryColumn(index) {
        if (controller || !lastRun) {
            return;
        }
        const target = lastResult?.columns?.[index];
        if (!target) {
            return;
        }
        controller = new AbortController();
        retrying = index;
        updateControls();
        status.textContent = `Trying ${target.label} again. This uses tokens.`;
        startTicking();

        try {
            const host = await loadHost();
            const result = await runSceneComparison({
                ...lastRun,
                presets: [target.preset],
                live: true,
                host,
                signal: controller.signal,
                onUpdate: ({ columns, streaming }) => {
                    const merged = lastResult.columns.slice();
                    merged[index] = columns[0] ?? merged[index];
                    handleUpdate({ columns: merged, streaming });
                },
            });
            lastResult.columns[index] = result.columns[0] ?? target;
            renderColumns(lastResult);
            status.textContent = result.restoreProblems.length
                ? `Tried again, but your settings could not be fully put back: ${result.restoreProblems.join('; ')}.`
                : `Tried ${target.label} again. Your settings have been put back.`;
        } catch (error) {
            status.textContent = `That preset could not be tried again: ${errorMessage(error)}`;
        } finally {
            stopTicking();
            controller = null;
            retrying = -1;
            updateControls();
            renderExportBar();
        }
    }

    function turnLabel(turn) {
        const timing = turn.waiting
            ? `waiting ${describeDuration(turn.durationMs)}`
            : describeDuration(turn.durationMs);
        return `Turn ${turn.index} · ${timing} · prompt ${formatTokens(turn.promptTokens)} tokens`;
    }

    /** True when a column stopped early and is worth another attempt. */
    function columnFailed(column) {
        return Boolean(column.error) || (column.turns ?? []).some(turn => turn.error);
    }

    function renderColumns(result) {
        replace(output);
        turnNodes.clear();
        if (!result.columns.length) {
            return;
        }

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const [index, column] of result.columns.entries()) {
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', { className: 'sbpl-ab-title', text: column.label }));
            if (column.error) {
                panel.append(element('pre', { className: 'sbpl-ab-body sbpl-ab-error', text: column.error }));
            }
            for (const turn of column.turns) {
                const label = element('p', { className: 'sbpl-scene-turn-label', text: turnLabel(turn) });
                const body = element('pre', {
                    className: turn.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                    text: turn.error ?? turn.text,
                });
                panel.append(label);
                panel.append(element('p', { className: 'sbpl-scene-said', text: turn.userText }));
                panel.append(body);
                turnNodes.set(turn, { label, body });
            }
            if (columnFailed(column) && column.done) {
                panel.append(button(`Try ${column.label} again`, () => { void retryColumn(index); }, {
                    className: 'menu_button sbpl-button sbpl-scene-retry',
                    title: 'Plays this scene again for this preset, from the first turn. This uses tokens.',
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
        updateControls();
    }

    /** Saving is offered once there is something worth keeping. */
    function renderExportBar() {
        replace(exportHost);
        if (!lastResult?.columns?.length || controller) {
            return;
        }
        const FORMATS = {
            md: { label: 'Markdown', mime: 'text/markdown' },
            txt: { label: 'text', mime: 'text/plain' },
            html: { label: 'web page', mime: 'text/html' },
        };
        const save = (format) => {
            const savedAt = new Date().toISOString();
            try {
                downloadExport(
                    sceneFileName({ characterName: lastRun?.characterName ?? '', format, savedAt }),
                    formatScene(lastResult, {
                        format,
                        characterName: lastRun?.characterName ?? '',
                        connectionName: lastRun?.connectionName ?? '',
                        savedAt: new Date(savedAt).toLocaleString(),
                    }),
                    FORMATS[format].mime,
                );
                status.textContent = `Saved the scene as a ${FORMATS[format].label} file.`;
            } catch (error) {
                status.textContent = `The scene could not be saved: ${errorMessage(error)}`;
            }
        };
        exportHost.append(
            button('Save as Markdown', () => save('md'), { className: 'menu_button sbpl-button' }),
            button('Save as text', () => save('txt'), { className: 'menu_button sbpl-button' }),
            button('Save as web page', () => save('html'), {
                className: 'menu_button sbpl-button',
                title: 'Keeps any markup a reply carried, such as a tracker or a styled card',
            }),
        );
    }

    function build() {
        root = element('div', { className: 'sbpl-scenes-tab' });

        characterPicker = createCharacterPicker({ label: 'Character' });
        characterSelect = characterPicker.input;
        characterSelect.addEventListener('change', () => {
            renderGreetings();
            updateControls();
            void checkChatFile();
        });

        personaPicker = createPersonaPicker({
            includeBlank: true,
            blankLabel: 'Stay on the persona you are using',
        });
        personaSelect = personaPicker.input;
        personaSelect.addEventListener('change', () => {
            renderPreview();
            updateControls();
        });

        greetingSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Which greeting opens the scene' },
        });
        greetingSelect.addEventListener('change', () => {
            greetingChosen = true;
            renderPreview();
        });
        greetingHost = field('Opening', greetingSelect, {
            hint: 'The greeting every preset answers. Cards can carry more than one.',
        });
        previewHost = element('div', { className: 'sbpl-preview' });
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
        exportHost = element('div', { className: 'sbpl-controls sbpl-scene-export' });
        output = element('div', { className: 'sbpl-ab-output' });

        const actions = element('div', { className: 'sbpl-controls' });
        actions.append(sendButton, cancelButton);

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Sends the same scene to a real model once for each preset, so you can read how each one plays it out. This uses tokens. Nothing is added to any chat; your character, preset and connection change while it runs and are put back afterwards.',
            }),
            characterPicker.node,
            chatFileNote,
            personaPicker.node,
            greetingHost,
            field('Connection', profileSelect, { hint: 'Every preset is sent through this same connection.' }),
            field('Preset kind', kindSelect),
            element('p', { className: 'sbpl-field-label', text: `Presets to compare (2 to ${MAX_PRESETS})` }),
            presetHost,
            element('p', { className: 'sbpl-field-label', text: 'The scene' }),
            modeHost,
            turnsHost,
            previewHost,
            field('Reply length', tokensInput, { hint: 'The most tokens each reply may use. Shared with the other comparison tabs.' }),
            estimateLine,
            actions,
            status,
            exportHost,
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
            stopTicking();
            turnNodes.clear();
            root?.remove();
            root = null;
        },
    };
}
