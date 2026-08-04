import { EXTENSION_LABEL, EXTENSION_NAME, TAB } from '../constants.js';
import { button, element } from '../dom.js';
import { createAbTab } from './ab-tab.js';
import { createCasesTab } from './cases-tab.js';
import { createDiffTab } from './diff-tab.js';
import { createExperimentTab } from './experiment-tab.js';
import { createPresetsTab } from './presets-tab.js';
import { createPromptsTab } from './prompts-tab.js';
import { createRunTab } from './run-tab.js';
import { createSettingsTab } from './settings-tab.js';
import { createWorkbench } from './workbench.js';

let mounted = null;

function settingsHost() {
    return document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
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
    let page = null;
    let pageMount = null;
    let pageOpener = null;
    let disposed = false;
    let workbench = null;

    function updateDrawer() {
        if (!settingsDrawer?.isConnected || !drawerStatus) {
            return;
        }
        const state = workbench.getState();
        if (state.availability?.ok === true) {
            drawerStatus.hidden = true;
            drawerStatus.textContent = '';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-ready';
            drawerStatus.removeAttribute('title');
        } else if (state.availability?.ok === false) {
            drawerStatus.hidden = false;
            drawerStatus.textContent = 'Prompting Lab cannot run with this SillyBunny version. Update SillyBunny or Prompting Lab, then reload.';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-error';
            if (state.availability.reason) {
                drawerStatus.title = `Technical details: ${state.availability.reason}`;
            }
        } else {
            drawerStatus.hidden = false;
            drawerStatus.textContent = 'Checking SillyBunny compatibility...';
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
        onQuickRun: (testCase) => {
            workbench.showTab(TAB.RUN);
            runTab.runOne(testCase);
        },
    });
    const promptsTab = createPromptsTab({
        onChanged: () => {
            presetsTab.refresh();
            experimentTab.refresh();
        },
    });
    const presetsTab = createPresetsTab({
        onChanged: () => {
            casesTab.refresh();
            promptsTab.refresh();
        },
        onPromptSaved: () => {
            promptsTab.refresh();
            experimentTab.refresh();
        },
    });
    const diffTab = createDiffTab();
    const experimentTab = createExperimentTab();
    const abTab = createAbTab();
    workbench.registerTab(TAB.CASES, casesTab);
    workbench.registerTab(TAB.PRESETS, presetsTab);
    workbench.registerTab(TAB.PROMPTS, promptsTab);
    workbench.registerTab(TAB.RUN, runTab);
    workbench.registerTab(TAB.DIFF, diffTab);
    workbench.registerTab(TAB.EXPERIMENT, experimentTab);
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

    /* ---------------------------------------------------- full-page mode */

    function ensurePage() {
        if (page?.isConnected) {
            return;
        }
        page?.remove();
        document.getElementById('sbpl-page')?.remove();
        page = element('div', {
            id: 'sbpl-page',
            className: 'sbpl-page',
            attributes: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': `${EXTENSION_LABEL} workspace`,
            },
        });
        page.hidden = true;

        const header = element('header', { className: 'sbpl-page-header' });
        const heading = element('div', { className: 'sbpl-page-heading' });
        heading.append(
            element('h2', { className: 'sbpl-page-title', text: EXTENSION_LABEL }),
            element('p', {
                className: 'sbpl-page-subtitle',
                text: 'Prompt tests build prompts without sending a message or using tokens. Compare prompts and Compare models are the tabs that send requests.',
            }),
        );
        const close = button('Close workspace', () => closePage(), {
            className: 'menu_button sbpl-button sbpl-page-close',
            title: 'Close the workspace and return to SillyBunny (Escape)',
        });
        header.append(heading, close);

        const body = element('div', { className: 'sbpl-page-body' });
        pageMount = element('div', { className: 'sbpl-workbench-mount' });
        body.append(pageMount);
        page.append(header, body);
        page.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closePage();
            }
        });
        document.body.append(page);
    }

    /** Opens the lab as a page of its own rather than a drawer entry. */
    function openPage(opener = null) {
        if (disposed) {
            return;
        }
        ensurePage();
        pageOpener = opener instanceof HTMLElement ? opener : null;
        page.hidden = false;
        workbench.mount(pageMount);
        requestAnimationFrame(() => {
            if (!disposed && page && !page.hidden) {
                workbench.focus();
            }
        });
    }

    /** Puts the workbench back in the drawer so nothing is lost on close. */
    function closePage() {
        if (!page || page.hidden) {
            return;
        }
        page.hidden = true;
        ensureSettingsDrawer();
        if (workbenchMount) {
            workbench.mount(workbenchMount);
        }
        pageOpener?.focus?.();
        pageOpener = null;
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
                title: 'Open the Prompting Lab workspace to test prompts for your characters',
            },
        });
        menuItem.append(
            element('span', {
                className: 'fa-solid fa-flask extensionsMenuExtensionButton sbpl-menu-icon',
                attributes: { 'aria-hidden': 'true' },
            }),
            element('span', { text: EXTENSION_LABEL }),
        );
        menuItem.addEventListener('click', () => openPage(menuItem));
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

        const openPageButton = button('Open as full page', () => openPage(openPageButton), {
            id: 'sbpl-open-page',
            className: 'menu_button sbpl-button',
            title: 'Open the lab as a workspace covering the whole page',
        });
        settingsBody.append(
            drawerStatus,
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Prompt tests build prompts without sending a message or using tokens. Compare prompts and Compare models are the only tabs that send a prompt and use tokens.',
            }),
            element('p', {
                className: 'sbpl-settings-note',
                text: 'While a suite runs, Prompting Lab temporarily applies each test case\'s character, persona, preset, and connection profile, then restores your setup.',
            }),
            openPageButton,
        );

        workbenchMount = element('div', { className: 'sbpl-workbench-mount' });
        drawerContent.append(settingsBody, workbenchMount);
        settingsDrawer.append(drawerToggle, drawerContent);
        settingsRoot.append(settingsDrawer);
        host.append(settingsRoot);
        if (!page || page.hidden) {
            workbench.mount(workbenchMount);
        }

        drawerObserver = new MutationObserver(syncDrawerAccessibility);
        drawerObserver.observe(drawerIcon, { attributes: true, attributeFilter: ['class'] });
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
            page?.remove();
            document.getElementById('sbpl-menu-item')?.remove();
            document.getElementById('sbpl-page')?.remove();
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
            page = null;
            pageMount = null;
            pageOpener = null;
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
