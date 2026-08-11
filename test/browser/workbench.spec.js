import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
});

test('the settings drawer and wand item mount on app ready', async ({ page }) => {
    await expect(page.locator('#sbpl-settings')).toBeAttached();
    await expect(page.locator('#sbpl-menu-item')).toBeAttached();
    await expect(page.locator('#sbpl-workbench')).toBeAttached();
    await expect(page.locator('.sbpl-settings-open')).toHaveCount(0);
    await expect(page.locator('#sbpl-settings .extension_name')).toHaveText('Prompting Lab');
});

test('the drawer header carries a unique name so the shell can find it', async ({ page }) => {
    const drawer = page.locator('#sbpl-settings');
    await expect(drawer).toHaveAttribute('data-extension-name', 'SillyBunny-Prompting-Lab');
    await expect(drawer).not.toHaveAttribute('data-sb-drawer-persistence', 'off');
    await expect(drawer.locator('.inline-drawer-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('opening the settings drawer shows the lab without a second open action', async ({ page }) => {
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('#sbpl-settings > .inline-drawer-toggle').click();
    await expect(page.locator('#sbpl-workbench')).toBeVisible();
});

test('the wand item opens the lab as a page of its own', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const workspace = page.locator('#sbpl-page');
    await expect(workspace).toBeVisible();
    await expect(workspace).toHaveAttribute('role', 'dialog');
    await expect(workspace.locator('#sbpl-workbench')).toBeVisible();
    await expect(workspace.locator('.sbpl-page-title')).toHaveText('Prompting Lab');
});

test('the wand item is keyboard operable and regains focus when the page closes', async ({ page }) => {
    const launcher = page.locator('#sbpl-menu-item');
    await expect(launcher).toHaveAttribute('role', 'button');
    await expect(launcher).toHaveAttribute('tabindex', '0');

    for (const key of ['Enter', 'Space']) {
        await launcher.focus();
        await page.keyboard.press(key);
        await expect(page.locator('#sbpl-page')).toBeVisible();
        await page.locator('.sbpl-page-close').click();
        await expect(launcher).toBeFocused();
    }
});

test('prompt maximize controls forward keyboard activation to host clicks', async ({ page }) => {
    await page.evaluate(async () => {
        const { promptField } = await import('/src/dom.js');
        const { wrapper } = promptField('Fixture prompt');
        wrapper.id = 'fixture-prompt';
        document.addEventListener('click', (event) => {
            if (event.target.closest?.('#fixture-prompt .editor_maximize')) {
                document.body.dataset.maximizeClicks = String(
                    Number(document.body.dataset.maximizeClicks ?? 0) + 1,
                );
            }
        });
        document.body.append(wrapper);
    });

    const maximize = page.locator('#fixture-prompt .editor_maximize');
    for (const [key, clicks] of [['Enter', '1'], ['Space', '2']]) {
        await maximize.focus();
        await page.keyboard.press(key);
        await expect(page.locator('body')).toHaveAttribute('data-maximize-clicks', clicks);
    }
    await maximize.evaluate(node => node.click());
    await expect(page.locator('body')).toHaveAttribute('data-maximize-clicks', '3');
});

test('the full-page modal inerts its background and contains keyboard and programmatic focus', async ({ page }) => {
    await page.locator('#extensions-settings-button').evaluate(node => node.setAttribute('inert', ''));
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#extensionsMenu')).toHaveAttribute('inert', '');
    await expect(page.locator('#extensions-settings-button')).toHaveAttribute('inert', '');

    await page.evaluate(() => {
        const sibling = document.createElement('div');
        sibling.id = 'fixture-late-background';
        document.body.append(sibling);
    });
    await expect(page.locator('#fixture-late-background')).toHaveAttribute('inert', '');

    const trapped = await page.evaluate(async () => {
        const background = document.getElementById('extensionsMenu');
        background.removeAttribute('inert');
        document.getElementById('sbpl-menu-item').focus();
        await new Promise(requestAnimationFrame);
        background.setAttribute('inert', '');
        return document.getElementById('sbpl-page').contains(document.activeElement);
    });
    expect(trapped).toBe(true);

    const wrapped = await page.evaluate(() => {
        const workspace = document.getElementById('sbpl-page');
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = 'Last summary';
        details.append(summary);
        const negative = document.createElement('div');
        negative.tabIndex = -2;
        negative.textContent = 'Not tabbable';
        workspace.append(details, negative);
        summary.focus();
        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        summary.dispatchEvent(event);
        return event.defaultPrevented && workspace.contains(document.activeElement)
            && document.activeElement !== summary;
    });
    expect(wrapped).toBe(true);

    await page.locator('.sbpl-page-close').click();
    await expect(page.locator('#extensionsMenu')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#extensions-settings-button')).toHaveAttribute('inert', '');
});

test('a host dialog can open above the full-page workspace without releasing the background', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'fixture-host-dialog';
        dialog.className = 'popup';
        const action = document.createElement('button');
        action.id = 'fixture-host-dialog-action';
        action.autofocus = true;
        action.textContent = 'Host action';
        dialog.append(action);
        document.body.append(dialog);
        dialog.showModal();
    });

    await expect(page.locator('#fixture-host-dialog')).not.toHaveAttribute('inert', '');
    await expect(page.locator('#fixture-host-dialog-action')).toBeFocused();
    await expect(page.locator('#extensionsMenu')).toHaveAttribute('inert', '');

    await page.evaluate(() => {
        const background = document.createElement('button');
        background.id = 'fixture-dialog-background';
        document.body.append(background);
    });
    await expect(page.locator('#fixture-dialog-background')).toHaveAttribute('inert', '');

    const trappedAgain = await page.evaluate(async () => {
        document.getElementById('fixture-host-dialog').close();
        document.getElementById('fixture-host-dialog').remove();
        const background = document.getElementById('extensionsMenu');
        background.removeAttribute('inert');
        document.getElementById('sbpl-menu-item').focus();
        await new Promise(requestAnimationFrame);
        background.setAttribute('inert', '');
        return document.getElementById('sbpl-page').contains(document.activeElement);
    });
    expect(trappedAgain).toBe(true);
});

test('closing the page puts the workbench back in the drawer', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await page.locator('.sbpl-page-close').click();
    await expect(page.locator('#sbpl-page')).toBeHidden();
    const drawerMount = page.locator('#sbpl-settings-content .sbpl-workbench-mount #sbpl-workbench');
    await expect(drawerMount).toHaveCount(1);
});

test('Escape closes the page workspace', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-page')).toBeVisible();
    // The workspace moves focus into itself on the next frame. Pressing before
    // that happens sends the key to the wand item outside the dialog, where
    // nothing listens for it.
    await expect(page.locator('#sbpl-page .sbpl-tab[aria-selected="true"]')).toBeFocused();
    await page.locator('#sbpl-page').press('Escape');
    await expect(page.locator('#sbpl-page')).toBeHidden();
});

test('the drawer offers the full page without going through the wand', async ({ page }) => {
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('#sbpl-settings > .inline-drawer-toggle').click();
    await page.locator('#sbpl-open-page').click();
    await expect(page.locator('#sbpl-page')).toBeVisible();
});

test('the workbench exposes every tab and marks one as selected', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const tabs = page.locator('#sbpl-workbench .sbpl-tab');
    await expect(tabs).toHaveCount(10);
    await expect(tabs.locator('.sbpl-tab-label')).toHaveText([
        'Tests', 'Presets', 'Prompts', 'Run tests', 'Token ledger',
        'Compare runs', 'Compare prompts', 'Compare models', 'Compare scenes', 'Settings',
    ]);
    await expect(page.locator('.sbpl-tab[aria-selected="true"]')).toHaveCount(1);
});

test('the workspace puts a rail of sections beside one wide work surface', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('#sbpl-menu-item').click();
    const nav = await page.locator('#sbpl-workbench .sbpl-nav').boundingBox();
    const main = await page.locator('#sbpl-workbench .sbpl-main').boundingBox();

    // Side by side on the same row, not stacked.
    expect(nav.x + nav.width).toBeLessThanOrEqual(main.x + 1);
    expect(Math.abs(main.y - nav.y)).toBeLessThan(5);
    // The work surface gets the space, and it reaches the edge of the window.
    expect(main.width).toBeGreaterThan(nav.width * 3);
    expect(main.x + main.width).toBeGreaterThan(1340);
});

test('the rail groups the sections under headings', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const groups = page.locator('#sbpl-workbench .sbpl-tab-group-label');
    await expect(groups).toHaveText(['Build', 'Run', 'Compare', 'Set up']);
    await expect(groups.first()).toBeVisible();
    await expect(page.locator('#sbpl-tab-cases .sbpl-tab-hint')).toHaveText('Suites, test cases and their checks');
});

test('the panel heading names the section and what it costs to use', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const head = page.locator('#sbpl-workbench .sbpl-panel-head');
    await expect(head.locator('.sbpl-panel-eyebrow')).toHaveText('Build');
    await expect(head.locator('.sbpl-panel-title')).toHaveText('Tests');
    await expect(head.locator('.sbpl-panel-cost')).toContainText('Nothing on this tab sends a message');

    await page.locator('#sbpl-tab-experiment').click();
    await expect(head.locator('.sbpl-panel-eyebrow')).toHaveText('Compare');
    await expect(head.locator('.sbpl-panel-title')).toHaveText('Compare prompts');
    await expect(head.locator('.sbpl-panel-cost')).toContainText('uses tokens');
});

test('the tabs that spend tokens say so before they are opened', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-tab-experiment .sbpl-tab-badge')).toHaveText('tokens');
    await expect(page.locator('#sbpl-tab-ab .sbpl-tab-badge')).toHaveText('tokens');
    await expect(page.locator('#sbpl-tab-cases .sbpl-tab-badge')).toHaveCount(0);
    await expect(page.locator('#sbpl-tab-ab')).toHaveAttribute('aria-label', 'Compare models, uses tokens');
});

test('the rail counts what the workspace holds and keeps the count current', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const readout = page.locator('#sbpl-workbench .sbpl-readout');
    await expect(readout).toBeVisible();
    const suites = readout.locator('.sbpl-readout-row', { hasText: 'Suites' }).locator('.sbpl-readout-value');
    await expect(suites).toHaveText('0');

    await page.locator('#sbpl-panel').getByRole('button', { name: 'Create suite' }).click();
    await expect(suites).toHaveText('1');
});

test('the workspace header reports whether the host can run the lab', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const status = page.locator('.sbpl-page-status');
    await expect(status).toContainText('Only 3 tabs use tokens');
    await expect(status.locator('.sbpl-pill-quiet')).toHaveAttribute('title', /Compare scenes/);
    await page.evaluate(() => globalThis.fixtureSetAvailability({ ok: true, warnings: [] }));
    await expect(status).toContainText('Host ready');
    await page.evaluate(() => globalThis.fixtureSetAvailability({ ok: false, reason: 'Missing tools.' }));
    await expect(status).toContainText('Host not compatible');
});

test('a global refresh dirties inactive tabs until they are activated', async ({ page }) => {
    await page.evaluate(() => globalThis.fixtureSeedSuite('suite-a', 'Suite A'));
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-run').click();
    const suites = page.locator('#sbpl-run-suite option');
    await expect(suites).toHaveText(['Suite A (0)']);

    await page.locator('#sbpl-tab-cases').click();
    await page.evaluate(() => globalThis.fixtureSeedSuite('suite-b', 'Suite B'));
    await page.evaluate(() => globalThis.fixtureEmit('chat-changed'));
    await page.locator('#sbpl-tab-run').click();
    await expect(suites).toHaveText(['Suite A (0)', 'Suite B (0)']);
});

test('a wide workspace edits beside the list instead of below it', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('#sbpl-menu-item').click();
    const panel = page.locator('#sbpl-panel');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();

    const list = await panel.locator('.sbpl-case-list-host').boundingBox();
    const editor = await panel.locator('.sbpl-editor-host').boundingBox();
    expect(editor.x).toBeGreaterThan(list.x + list.width - 1);
    expect(Math.abs(editor.y - list.y)).toBeLessThan(20);
});

test('the drawer keeps the compact strip rather than the workspace layout', async ({ page }) => {
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('#sbpl-settings > .inline-drawer-toggle').click();
    const workbench = page.locator('#sbpl-workbench');
    await expect(workbench).toHaveClass(/sbpl-workbench-drawer/);
    await expect(workbench.locator('.sbpl-panel-head')).toBeHidden();
    await expect(workbench.locator('.sbpl-readout')).toBeHidden();

    const first = await workbench.locator('#sbpl-tab-cases').boundingBox();
    const second = await workbench.locator('#sbpl-tab-presets').boundingBox();
    expect(second.x).toBeGreaterThan(first.x);
    expect(Math.abs(second.y - first.y)).toBeLessThan(2);
});

test('closing the workspace puts the workbench back into drawer layout', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-workbench')).toHaveClass(/sbpl-workbench-page/);
    await page.locator('.sbpl-page-close').click();
    await expect(page.locator('#sbpl-workbench')).toHaveClass(/sbpl-workbench-drawer/);
});

test('tabs can be changed with the keyboard', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-cases').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#sbpl-tab-presets')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.locator('#sbpl-tab-settings')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.locator('#sbpl-tab-cases')).toHaveAttribute('aria-selected', 'true');
});

test('the selected tab is the only one in the tab order', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    const tabIndexes = await page.locator('#sbpl-workbench .sbpl-tab').evaluateAll(
        nodes => nodes.map(node => node.tabIndex),
    );
    expect(tabIndexes.filter(value => value === 0)).toHaveLength(1);
});

test('the mobile layout swaps the tab strip for a select', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-workbench .sbpl-tabs')).toBeHidden();
    await expect(page.locator('#sbpl-workbench .sbpl-tab-select')).toBeVisible();
});

test('the page never scrolls sideways on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.locator('#sbpl-menu-item').click();
    const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
});

test('a ready host is reported as ready', async ({ page }) => {
    await page.evaluate(() => globalThis.fixtureSetAvailability({ ok: true, warnings: [] }));
    await expect(page.locator('#sbpl-settings .sbpl-settings-status')).toBeHidden();
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-workbench .sbpl-availability')).toBeHidden();
});

test('an incompatible host is reported in the drawer and the workbench', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await page.evaluate(() => globalThis.fixtureSetAvailability({
        ok: false,
        reason: 'Missing tools: ChatCompletion.',
    }));
    const status = page.locator('#sbpl-settings .sbpl-settings-status');
    await expect(status).toHaveClass(/sbpl-settings-error/);
    await expect(status).toContainText('Prompting Lab cannot run with this SillyBunny version.');
    await expect(status).toHaveAttribute('title', /Missing tools: ChatCompletion\./);
    const banner = page.locator('#sbpl-workbench .sbpl-availability');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('Missing tools: ChatCompletion.');
    await expect(page.locator('#sbpl-panel')).toHaveAttribute('inert', '');
    await expect(page.locator('#sbpl-panel')).toHaveAttribute('aria-disabled', 'true');
});

test('host warnings are surfaced without blocking use', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await page.evaluate(() => globalThis.fixtureSetAvailability({
        ok: true,
        warnings: ['Per-section token counts use a simpler calculation on this SillyBunny build.'],
    }));
    const banner = page.locator('#sbpl-workbench .sbpl-availability');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/sbpl-availability-warning/);
    await expect(page.locator('#sbpl-settings .sbpl-settings-status')).toBeHidden();
});

test('a workbench control regains focus after its host subtree is replaced', async ({ page }) => {
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('#sbpl-settings > .inline-drawer-toggle').click();
    const createSuite = page.getByRole('button', { name: 'Create suite' });
    await createSuite.focus();

    await page.evaluate(async () => {
        const oldHost = document.getElementById('extensions_settings2');
        const newHost = document.createElement('main');
        newHost.id = oldHost.id;
        oldHost.replaceWith(newHost);
        await globalThis.fixtureEmit('chat-changed');
    });

    await expect(page.getByRole('button', { name: 'Create suite' })).toBeFocused();
});

test('confirm buttons stay disabled for async work and surface rejection', async ({ page }) => {
    await page.evaluate(async () => {
        const { confirmButton } = await import('/src/dom.js');
        let resolve;
        globalThis.fixtureFinishConfirm = () => resolve();
        const pending = new Promise(done => { resolve = done; });
        const success = confirmButton('Delete', () => pending);
        success.id = 'fixture-confirm-success';
        const failure = confirmButton('Remove', async () => { throw new Error('Storage unavailable'); });
        failure.id = 'fixture-confirm-failure';
        document.body.append(success, failure);
    });

    const success = page.locator('#fixture-confirm-success');
    await success.click();
    await success.click();
    await expect(success).toBeDisabled();
    await page.evaluate(() => globalThis.fixtureFinishConfirm());
    await expect(success).toBeEnabled();
    await expect(success).toHaveText('Delete');

    const failure = page.locator('#fixture-confirm-failure');
    await failure.click();
    await failure.click();
    await expect(failure).toBeEnabled();
    await expect(failure).toHaveText('Remove failed: Storage unavailable');
});

test('deactivate removes everything the extension added', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-workbench')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureDeactivate());
    await expect(page.locator('#sbpl-settings')).toHaveCount(0);
    await expect(page.locator('#sbpl-menu-item')).toHaveCount(0);
    await expect(page.locator('#sbpl-workbench')).toHaveCount(0);
    await expect(page.locator('#sbpl-page')).toHaveCount(0);
});
