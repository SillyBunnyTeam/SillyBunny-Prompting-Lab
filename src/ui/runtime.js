import { EXTENSION_LABEL, EXTENSION_NAME, TAB } from '../constants.js';
import { element } from '../dom.js';
import { createAbTab } from './ab-tab.js';
import { createCasesTab } from './cases-tab.js';
import { createDiffTab } from './diff-tab.js';
import { createRunTab } from './run-tab.js';
import { createSettingsTab } from './settings-tab.js';
import { createWorkbench } from './workbench.js';

let mounted = null;

function settingsHost() {
    return document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
}

function openExtensionsSurface() {
    if (typeof globalThis.SillyBunnyShell?.openTab === 'function') {
        globalThis.SillyBunnyShell.openTab('right', 'extensions');
        return;
    }
    const toggle = document.querySelector('#extensions-settings-button > .drawer-toggle');
    const host = settingsHost();
    const hostIsVisible = host instanceof HTMLElement && host.getClientRects().length > 0;
    if (!hostIsVisible && toggle instanceof HTMLElement) {
        toggle.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
    }
}

export function mountRuntimeUi({ signal = null } = {}) {
    if (mounted) {
        mounted.refresh('remount');
        return mounted;
    }

    let menuItem = null;
    let settingsRoot = null;
    let settingsDrawer = null;
    let drawerToggle = null;
    let drawerIcon = null;
    let drawerContent = null;
    let drawerObserver = null;
    let drawerStatus = null;
    let workbenchMount = null;
    let disposed = false;
    let workbench = null;

    function updateDrawer() {
        if (!settingsDrawer?.isConnected || !drawerStatus) {
            return;
        }
        const state = workbench.getState();
        if (state.availability?.ok === true) {
            drawerStatus.textContent = 'Prompt testing is ready.';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-ready';
            drawerStatus.removeAttribute('title');
        } else if (state.availability?.ok === false) {
            drawerStatus.textContent = 'Prompt testing is unavailable. Update SillyBunny or Prompting Lab, then reload.';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-error';
            if (state.availability.reason) {
                drawerStatus.title = `Technical details: ${state.availability.reason}`;
            }
        } else {
            drawerStatus.textContent = 'Checking compatibility with SillyBunny...';
            drawerStatus.className = 'sbpl-settings-status';
            drawerStatus.removeAttribute('title');
        }
    }

    workbench = createWorkbench({
        lifetimeSignal: signal,
        onStateChange: updateDrawer,
    });

    const runTab = createRunTab({
        onRunFinished: () => {
            workbench.refresh('run-finished');
            diffTab.refresh();
            abTab.refresh();
        },
    });
    const casesTab = createCasesTab({
        onChanged: () => runTab.refresh(),
    });
    const diffTab = createDiffTab();
    const abTab = createAbTab();
    workbench.registerTab(TAB.CASES, casesTab);
    workbench.registerTab(TAB.RUN, runTab);
    workbench.registerTab(TAB.DIFF, diffTab);
    const settingsTab = createSettingsTab({
        onChanged: () => {
            casesTab.refresh();
            runTab.refresh();
            diffTab.refresh();
        },
    });
    workbench.registerTab(TAB.AB, abTab);
    workbench.registerTab(TAB.SETTINGS, settingsTab);

    function syncDrawerAccessibility() {
        const expanded = Boolean(drawerIcon && !drawerIcon.classList.contains('down'));
        drawerToggle?.setAttribute('aria-expanded', String(expanded));
        drawerContent?.setAttribute('aria-hidden', String(!expanded));
    }

    function revealWorkbench() {
        if (disposed) {
            return;
        }
        ensureSettingsDrawer();
        openExtensionsSurface();
        if (!settingsDrawer?.isConnected || !workbenchMount) {
            return;
        }
        const root = workbench.mount(workbenchMount);
        if (!root) {
            return;
        }
        if (drawerIcon?.classList.contains('down')) {
            drawerToggle?.click();
        }
        syncDrawerAccessibility();
        requestAnimationFrame(() => {
            if (!disposed && root.isConnected) {
                root.scrollIntoView({ block: 'start', inline: 'nearest' });
                workbench.focus();
            }
        });
    }

    function ensureMenuItem() {
        if (menuItem?.isConnected) {
            return;
        }
        const host = document.getElementById('prompting_lab_wand_container')
            ?? document.getElementById('extensionsMenu');
        if (!host) {
            return;
        }
        document.getElementById('sbpl-menu-item')?.remove();

        menuItem = element('button', {
            id: 'sbpl-menu-item',
            className: 'list-group-item flex-container flexGap5 interactable sbpl-menu-item',
            attributes: {
                type: 'button',
                title: 'Open Prompting Lab to test prompts for your characters',
            },
        });
        menuItem.append(
            element('span', {
                className: 'fa-solid fa-flask extensionsMenuExtensionButton sbpl-menu-icon',
                attributes: { 'aria-hidden': 'true' },
            }),
            element('span', { text: EXTENSION_LABEL }),
        );
        menuItem.addEventListener('click', revealWorkbench);
        host.append(menuItem);
    }

    function ensureSettingsDrawer() {
        if (settingsRoot?.isConnected && settingsDrawer?.isConnected && settingsRoot.contains(settingsDrawer)) {
            return;
        }
        const host = settingsHost();
        if (!host) {
            return;
        }
        drawerObserver?.disconnect();
        settingsRoot?.remove();
        const staleDrawer = document.getElementById('sbpl-settings');
        (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();

        settingsRoot = element('div', { className: 'extension_container sbpl-settings-container' });
        settingsDrawer = element('div', {
            id: 'sbpl-settings',
            className: 'inline-drawer sbpl-settings',
            attributes: {
                'data-extension-name': EXTENSION_NAME,
                'data-sb-drawer-persistence': 'off',
            },
        });
        drawerToggle = element('button', {
            className: 'inline-drawer-toggle inline-drawer-header sbpl-settings-summary',
            attributes: {
                type: 'button',
                'aria-controls': 'sbpl-settings-content',
                'aria-expanded': 'false',
            },
        });
        const summaryCopy = element('span', { className: 'sbpl-settings-summary-copy' });
        summaryCopy.append(
            element('strong', { className: 'extension_name', text: EXTENSION_LABEL }),
            element('span', {
                className: 'sbpl-settings-summary-note',
                text: 'Test prompts and spot changes',
            }),
        );
        drawerIcon = element('span', {
            className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down not_focusable',
            attributes: { 'aria-hidden': 'true' },
        });
        drawerToggle.append(summaryCopy, drawerIcon);

        drawerContent = element('div', {
            id: 'sbpl-settings-content',
            className: 'inline-drawer-content sbpl-settings-content',
            attributes: { 'aria-hidden': 'true' },
        });
        drawerContent.style.display = 'none';

        const settingsBody = element('div', { className: 'sbpl-settings-body' });
        drawerStatus = element('p', {
            className: 'sbpl-settings-status',
            attributes: { role: 'status', 'aria-live': 'polite' },
        });
        const openButton = element('button', {
            className: 'menu_button sbpl-button sbpl-button-primary sbpl-settings-open',
            text: 'Open Prompting Lab',
            attributes: { type: 'button' },
        });
        openButton.addEventListener('click', revealWorkbench);

        settingsBody.append(
            drawerStatus,
            openButton,
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Running tests does not send a message or spend tokens, unless you ask for side-by-side model responses.',
            }),
            element('p', {
                className: 'sbpl-settings-note',
                text: 'A test run briefly switches your character, persona, preset, and connection profile, then puts them back when it finishes.',
            }),
        );

        workbenchMount = element('div', { className: 'sbpl-workbench-mount' });
        drawerContent.append(settingsBody, workbenchMount);
        settingsDrawer.append(drawerToggle, drawerContent);
        settingsRoot.append(settingsDrawer);
        host.append(settingsRoot);

        drawerObserver = new MutationObserver(syncDrawerAccessibility);
        drawerObserver.observe(drawerIcon, { attributes: true, attributeFilter: ['class'] });
        if (workbench.getState().open) {
            workbench.mount(workbenchMount);
        }
        syncDrawerAccessibility();
        updateDrawer();
    }

    function ensureEntrypoints() {
        ensureMenuItem();
        ensureSettingsDrawer();
    }

    const controller = {
        refresh(reason = 'refresh') {
            if (disposed) {
                return;
            }
            ensureEntrypoints();
            workbench.refresh(reason);
            updateDrawer();
        },
        setAvailability(value) {
            if (disposed) {
                return;
            }
            workbench.setAvailability(value);
            updateDrawer();
        },
        getWorkbench() {
            return workbench;
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            drawerObserver?.disconnect();
            workbench.dispose();
            menuItem?.remove();
            settingsRoot?.remove();
            document.getElementById('sbpl-menu-item')?.remove();
            const staleDrawer = document.getElementById('sbpl-settings');
            (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();
            menuItem = null;
            settingsRoot = null;
            settingsDrawer = null;
            drawerToggle = null;
            drawerIcon = null;
            drawerContent = null;
            drawerObserver = null;
            drawerStatus = null;
            workbenchMount = null;
        },
    };

    mounted = controller;
    ensureEntrypoints();
    updateDrawer();
    return controller;
}

export function unmountRuntimeUi() {
    mounted?.dispose();
    mounted = null;
}
