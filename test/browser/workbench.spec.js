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
    await expect(tabs).toHaveCount(8);
    await expect(tabs).toHaveText([
        'Tests', 'Presets', 'Prompts', 'Run tests',
        'Compare runs', 'Compare prompts', 'Compare models', 'Settings',
    ]);
    await expect(page.locator('.sbpl-tab[aria-selected="true"]')).toHaveCount(1);
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

test('deactivate removes everything the extension added', async ({ page }) => {
    await page.locator('#sbpl-menu-item').click();
    await expect(page.locator('#sbpl-workbench')).toBeVisible();
    await page.evaluate(() => globalThis.fixtureDeactivate());
    await expect(page.locator('#sbpl-settings')).toHaveCount(0);
    await expect(page.locator('#sbpl-menu-item')).toHaveCount(0);
    await expect(page.locator('#sbpl-workbench')).toHaveCount(0);
    await expect(page.locator('#sbpl-page')).toHaveCount(0);
});
