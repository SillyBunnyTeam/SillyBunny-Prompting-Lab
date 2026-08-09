import { element } from '../dom.js';
import { getContext } from '../host.js';

/**
 * Choosing a character by name alone stops working at about thirty cards, so
 * this is a list of faces with a search box rather than a dropdown.
 *
 * Ported from the character filter in SillyBunny-Chats-Archive so the two
 * extensions behave the same way. The value lives on a hidden input that fires
 * a bubbling `change`, which lets every caller read `.value` and listen for
 * `change` exactly as it did with the select this replaces.
 */

let pickerCount = 0;

/** The host renders avatars from its own thumbnail service when it has one. */
export function avatarThumbnail(avatar, name = '', className = 'sbpl-picker-avatar') {
    let source = '';
    try {
        source = avatar ? (getContext()?.getThumbnailUrl?.('avatar', avatar) ?? '') : '';
    } catch {
        source = '';
    }
    if (!source) {
        const icon = element('i', {
            className: `${className} sbpl-picker-avatar-icon fa-solid fa-user`,
            attributes: { 'aria-hidden': 'true' },
        });
        return icon;
    }
    const image = element('img', {
        className,
        // Decorative: the name is written beside it in text either way.
        attributes: { src: source, alt: '', loading: 'lazy', decoding: 'async', title: name },
    });
    return image;
}

function choiceCopy(choice) {
    const copy = element('span', { className: 'sbpl-picker-copy' });
    copy.append(element('span', { className: 'sbpl-picker-name', text: choice.name }));
    if (choice.meta) {
        copy.append(element('span', { className: 'sbpl-picker-meta', text: choice.meta }));
    }
    return copy;
}

/**
 * @param {{label?: string, blankLabel?: string, includeBlank?: boolean}} options
 * @returns {{node: HTMLElement, input: HTMLInputElement, setCharacters: Function,
 *   setValue: Function, focus: Function}}
 */
export function createCharacterPicker({
    label = 'Character',
    blankLabel = 'Leave the character as it is',
    includeBlank = false,
} = {}) {
    pickerCount += 1;
    const id = `sbpl-picker-${pickerCount}`;
    let characters = [];

    const labelNode = element('span', { className: 'sbpl-field-label', text: label, id: `${id}-label` });
    const details = element('details', { className: 'sbpl-picker' });
    const summary = element('summary', {
        className: 'text_pole sbpl-picker-summary',
        attributes: { 'aria-labelledby': `${id}-label ${id}-value` },
    });
    const menu = element('div', { className: 'sbpl-picker-menu' });
    const search = element('input', {
        className: 'text_pole sbpl-picker-search',
        attributes: {
            type: 'search',
            placeholder: 'Search characters',
            'aria-label': `Search ${label.toLowerCase()}s`,
            autocomplete: 'off',
        },
    });
    const list = element('div', {
        className: 'sbpl-picker-options',
        attributes: { role: 'group', 'aria-labelledby': `${id}-label` },
    });
    const empty = element('p', { className: 'sbpl-picker-empty', text: 'No characters match.' });
    empty.hidden = true;
    const input = element('input', { attributes: { type: 'hidden' } });

    menu.append(search, list, empty);
    details.append(summary, menu);
    const node = element('div', { className: 'sbpl-picker-field' });
    node.append(labelNode, details, input);

    /** What is shown for a value, including one no longer installed. */
    function choiceFor(avatar) {
        if (!avatar) {
            return { avatar: '', name: includeBlank ? blankLabel : 'Choose a character', meta: '' };
        }
        const found = characters.find(character => character.avatar === avatar);
        return found
            ? { avatar: found.avatar, name: found.name, meta: '' }
            : { avatar: '', name: avatar, meta: 'Not installed any more' };
    }

    function showChoice() {
        const choice = choiceFor(input.value);
        const copy = choiceCopy(choice);
        copy.id = `${id}-value`;
        summary.replaceChildren(avatarThumbnail(choice.avatar, choice.name), copy);
        for (const option of list.querySelectorAll('.sbpl-picker-option')) {
            option.setAttribute('aria-pressed', String(option.dataset.avatar === input.value));
        }
    }

    function filterOptions() {
        const query = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const option of list.querySelectorAll('.sbpl-picker-option')) {
            option.hidden = Boolean(query) && !option.dataset.search.includes(query);
            visible += option.hidden ? 0 : 1;
        }
        empty.hidden = visible > 0;
    }

    /** Ends the search so the next opening starts from the whole list. */
    function clearSearch() {
        search.value = '';
        filterOptions();
    }

    function choose(avatar) {
        const changed = input.value !== avatar;
        input.value = avatar;
        showChoice();
        clearSearch();
        details.open = false;
        summary.focus({ preventScroll: true });
        if (changed) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function renderOptions() {
        const choices = includeBlank
            ? [{ avatar: '', name: blankLabel, meta: '' }, ...characters.map(toChoice)]
            : characters.map(toChoice);
        list.replaceChildren(...choices.map((choice) => {
            const option = element('button', {
                className: 'sbpl-picker-option',
                attributes: { type: 'button', 'aria-label': choice.name },
            });
            option.dataset.avatar = choice.avatar;
            option.dataset.search = `${choice.name} ${choice.avatar}`.toLocaleLowerCase();
            option.append(avatarThumbnail(choice.avatar, choice.name), choiceCopy(choice));

            const commit = () => choose(choice.avatar);
            // Mouse and pen commit on the press: a platform that does not focus
            // buttons on press can lose the click when closing hides the option
            // first. Touch waits for the click, so a scroll that starts on an
            // option is not read as a choice.
            option.addEventListener('pointerdown', (event) => {
                if (event.button === 0 && event.pointerType !== 'touch') {
                    // Stops the browser's own focus handling for this press,
                    // which otherwise runs after this handler and takes focus
                    // off the summary we just moved it to.
                    event.preventDefault();
                    commit();
                }
            });
            option.addEventListener('click', commit);
            return option;
        }));
        showChoice();
        filterOptions();
    }

    function toChoice(character) {
        return { avatar: character.avatar, name: character.name || character.avatar, meta: '' };
    }

    search.addEventListener('input', filterOptions);
    search.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            list.querySelector('.sbpl-picker-option:not([hidden])')?.focus();
        }
    });
    list.addEventListener('keydown', (event) => {
        const option = event.target.closest('.sbpl-picker-option');
        if (!option || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const options = [...list.querySelectorAll('.sbpl-picker-option:not([hidden])')];
        const index = options.indexOf(option);
        const next = event.key === 'Home'
            ? options[0]
            : event.key === 'End'
                ? options.at(-1)
                : options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
        next?.focus();
    });
    details.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && details.open) {
            event.preventDefault();
            clearSearch();
            details.open = false;
            summary.focus({ preventScroll: true });
        }
    });
    const closeOnOutside = (event) => {
        if (!details.contains(event.target)) {
            details.open = false;
        }
    };
    details.addEventListener('toggle', () => {
        if (details.open) {
            // The search is cleared when a choice is made or the menu is
            // dismissed, never on opening: a browser that reopens the menu by
            // itself, as it does when focus moves into a closed details,
            // would wipe a half-typed query and show a list ignoring it.
            //
            // The outside-press listener lives only while the menu is open. A
            // tab can be disposed and built again, and one document listener
            // per picker would pile up pointing at markup long gone.
            document.addEventListener('pointerdown', closeOnOutside);
        } else {
            document.removeEventListener('pointerdown', closeOnOutside);
        }
    });
    details.addEventListener('focusout', () => {
        // A macrotask, not a microtask: a tap's down, up and click have to
        // finish before the check, or the option closes under the finger.
        setTimeout(() => {
            // Leaving the window is not leaving the menu. A document without
            // focus reports the body as active, which would otherwise close
            // the picker, and lose a half-typed search, on every alt-tab.
            if (!document.hasFocus()) {
                return;
            }
            if (!details.contains(document.activeElement)) {
                details.open = false;
            }
        });
    });
    showChoice();

    return {
        node,
        input,
        setCharacters(list_) {
            characters = (list_ ?? []).filter(character => character?.avatar);
            renderOptions();
        },
        setValue(avatar) {
            input.value = String(avatar ?? '');
            showChoice();
        },
        get value() {
            return input.value;
        },
        focus() {
            summary.focus({ preventScroll: true });
        },
    };
}
