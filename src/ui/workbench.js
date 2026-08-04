import { EXTENSION_LABEL, TAB, TAB_LABEL } from '../constants.js';
import { element, emptyState, replace } from '../dom.js';
import { getSettings, updateSettings } from '../settings.js';

const TAB_ORDER = [TAB.CASES, TAB.PRESETS, TAB.RUN, TAB.DIFF, TAB.AB, TAB.SETTINGS];

/**
 * The workbench owns the tab shell and hands each tab a panel element to fill.
 * Tabs are registered by later milestones; an unregistered tab renders a short
 * placeholder rather than an empty box.
 */
export function createWorkbench({ lifetimeSignal = null, onStateChange = null } = {}) {
    const state = {
        open: false,
        activeTab: getSettings().lastTab,
        availability: null,
    };
    const panels = new Map();
    const tabButtons = new Map();

    let root = null;
    let tabList = null;
    let panelHost = null;
    let selectMobile = null;
    let disposed = false;

    function notifyChange() {
        onStateChange?.();
    }

    function renderActivePanel() {
        if (!panelHost) {
            return;
        }
        const controller = panels.get(state.activeTab);
        if (!controller) {
            replace(panelHost, emptyState(
                `${TAB_LABEL[state.activeTab] ?? 'This tab'} is not available yet.`,
                'This part of Prompting Lab is still being built.',
            ));
            return;
        }
        const node = controller.render();
        replace(panelHost, node);
    }

    function syncTabControls() {
        for (const [id, node] of tabButtons) {
            const selected = id === state.activeTab;
            node.classList.toggle('sbpl-tab-active', selected);
            node.setAttribute('aria-selected', String(selected));
            node.tabIndex = selected ? 0 : -1;
        }
        if (selectMobile && selectMobile.value !== state.activeTab) {
            selectMobile.value = state.activeTab;
        }
    }

    function setActiveTab(id, { focus = false } = {}) {
        if (!TAB_ORDER.includes(id)) {
            return;
        }
        state.activeTab = id;
        updateSettings({ lastTab: id });
        syncTabControls();
        renderActivePanel();
        if (focus) {
            tabButtons.get(id)?.focus();
        }
        notifyChange();
    }

    function onTabKeydown(event) {
        const index = TAB_ORDER.indexOf(state.activeTab);
        let next = null;
        if (event.key === 'ArrowRight') {
            next = TAB_ORDER[(index + 1) % TAB_ORDER.length];
        } else if (event.key === 'ArrowLeft') {
            next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length];
        } else if (event.key === 'Home') {
            next = TAB_ORDER[0];
        } else if (event.key === 'End') {
            next = TAB_ORDER[TAB_ORDER.length - 1];
        }
        if (next) {
            event.preventDefault();
            setActiveTab(next, { focus: true });
        }
    }

    function build() {
        root = element('section', {
            id: 'sbpl-workbench',
            className: 'sbpl-workbench',
            attributes: { 'aria-label': EXTENSION_LABEL },
        });

        const availabilityNote = element('p', {
            className: 'sbpl-availability',
            attributes: { role: 'status', 'aria-live': 'polite' },
        });
        availabilityNote.hidden = true;

        tabList = element('div', {
            className: 'sbpl-tabs',
            attributes: { role: 'tablist', 'aria-label': `${EXTENSION_LABEL} sections` },
        });
        for (const id of TAB_ORDER) {
            const node = element('button', {
                className: 'sbpl-tab',
                id: `sbpl-tab-${id}`,
                text: TAB_LABEL[id],
                attributes: {
                    type: 'button',
                    role: 'tab',
                    'aria-controls': 'sbpl-panel',
                    'aria-selected': 'false',
                },
            });
            node.addEventListener('click', () => setActiveTab(id));
            node.addEventListener('keydown', onTabKeydown);
            tabButtons.set(id, node);
            tabList.append(node);
        }

        selectMobile = element('select', {
            className: 'text_pole sbpl-tab-select',
            attributes: { 'aria-label': `${EXTENSION_LABEL} section` },
        });
        for (const id of TAB_ORDER) {
            selectMobile.append(element('option', { text: TAB_LABEL[id], attributes: { value: id } }));
        }
        selectMobile.addEventListener('change', () => setActiveTab(selectMobile.value));

        panelHost = element('div', {
            id: 'sbpl-panel',
            className: 'sbpl-panel',
            attributes: { role: 'tabpanel', tabindex: '-1' },
        });

        root.append(availabilityNote, tabList, selectMobile, panelHost);
        root.__availabilityNote = availabilityNote;
        syncTabControls();
        renderActivePanel();
        return root;
    }

    function applyAvailability() {
        const note = root?.__availabilityNote;
        if (!note) {
            return;
        }
        if (state.availability?.ok === false) {
            note.hidden = false;
            note.className = 'sbpl-availability sbpl-availability-error';
            note.textContent = state.availability.reason
                ?? `${EXTENSION_LABEL} is not compatible with this SillyBunny build.`;
        } else if (state.availability?.warnings?.length) {
            note.hidden = false;
            note.className = 'sbpl-availability sbpl-availability-warning';
            note.textContent = state.availability.warnings.join(' ');
        } else {
            note.hidden = true;
            note.textContent = '';
        }
    }

    const controller = {
        getState() {
            return state;
        },
        registerTab(id, tabController) {
            panels.set(id, tabController);
            if (id === state.activeTab) {
                renderActivePanel();
            }
        },
        showTab(id) {
            setActiveTab(id, { focus: true });
        },
        mount(host) {
            if (disposed || !host) {
                return null;
            }
            if (!root) {
                build();
            }
            if (root.parentElement !== host) {
                host.append(root);
            }
            state.open = true;
            applyAvailability();
            notifyChange();
            return root;
        },
        setAvailability(value) {
            state.availability = value;
            applyAvailability();
            notifyChange();
        },
        refresh(reason = 'refresh') {
            if (disposed || !state.open) {
                return;
            }
            panels.get(state.activeTab)?.refresh?.(reason);
        },
        focus() {
            tabButtons.get(state.activeTab)?.focus();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const panel of panels.values()) {
                panel.dispose?.();
            }
            panels.clear();
            tabButtons.clear();
            root?.remove();
            root = null;
            tabList = null;
            panelHost = null;
            selectMobile = null;
            state.open = false;
        },
    };

    lifetimeSignal?.addEventListener?.('abort', () => controller.dispose(), { once: true });
    return controller;
}
