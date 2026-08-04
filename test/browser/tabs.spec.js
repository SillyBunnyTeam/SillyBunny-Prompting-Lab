import { expect, test } from '@playwright/test';

/**
 * Opens the workbench and switches to a tab, using whichever control is on
 * screen: the tab strip on a wide screen, the select on a narrow one.
 */
async function openTab(page, tab) {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.locator('#sbpl-menu-item').click();
    const strip = page.locator(`#sbpl-tab-${tab}`);
    if (await strip.isVisible()) {
        await strip.click();
    } else {
        await page.locator('#sbpl-workbench .sbpl-tab-select').selectOption(tab);
    }
    return page.locator('#sbpl-panel');
}

test('the test cases tab starts with an explanation, not an empty box', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await expect(panel).toContainText('No test suites yet');
    await expect(panel.locator('button', { hasText: 'New suite' })).toBeVisible();
});

test('a suite and a test case can be created and saved', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.locator('button', { hasText: 'New suite' }).click();
    await expect(panel).toContainText('Created "Suite 1"');

    await panel.locator('button', { hasText: 'New test case' }).click();
    const editor = panel.locator('.sbpl-editor');
    await expect(editor).toBeVisible();

    await editor.locator('select').first().selectOption('tester.png');
    await editor.locator('textarea').fill('Tell me about the vault.');
    await panel.locator('button', { hasText: 'Save test case' }).click();

    await expect(panel).toContainText('Saved "Test case 1"');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1);
});

test('a test case without a character explains what is missing', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.locator('button', { hasText: 'New suite' }).click();
    await panel.locator('button', { hasText: 'New test case' }).click();
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await expect(panel.locator('.sbpl-problems')).toContainText('Choose a character');
});

test('checks can be added to a test case and read back', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.locator('button', { hasText: 'New suite' }).click();
    await panel.locator('button', { hasText: 'New test case' }).click();
    const adder = panel.locator('.sbpl-assertion-adder');
    await adder.locator('select').selectOption('token-ceiling');
    await adder.locator('input').fill('1500');
    await adder.locator('button', { hasText: 'Add check' }).click();
    await expect(panel.locator('.sbpl-assertion-item')).toContainText('under 1,500 tokens');
});

test('the personas and profiles offered come from the host', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.locator('button', { hasText: 'New suite' }).click();
    await panel.locator('button', { hasText: 'New test case' }).click();
    const selects = panel.locator('.sbpl-editor select');
    await expect(selects.nth(1)).toContainText('Me');
    await expect(selects.nth(2)).toContainText('Claude');
    await expect(selects.nth(3)).toContainText('Tagged');
    await expect(selects.nth(4)).toContainText('Deep');
});

test('a Prompt Tags profile can be pinned from the case editor', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.locator('button', { hasText: 'New suite' }).click();
    await panel.locator('button', { hasText: 'New test case' }).click();
    const selects = panel.locator('.sbpl-editor select');
    await selects.nth(0).selectOption('tester.png');
    await selects.nth(3).selectOption('Tagged');
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await panel.locator('button', { hasText: 'Edit' }).click();
    await expect(panel.locator('.sbpl-editor select').nth(3)).toHaveValue('Tagged');
});

test('the run tab explains itself before any suite exists', async ({ page }) => {
    const panel = await openTab(page, 'run');
    await expect(panel).toContainText('No test suites yet');
});

test('a run result row shows unchecked checks explicitly', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedUnchecked());
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-run').click();
    await expect(page.locator('#sbpl-panel')).toContainText('unchecked');
    await expect(page.locator('#sbpl-panel')).toContainText('No lorebook activity was recorded');
});

test('the comparison tab asks for two runs before it can compare', async ({ page }) => {
    const panel = await openTab(page, 'diff');
    await expect(panel).toContainText('Nothing to compare yet');
});

test('the side-by-side tab warns that it spends tokens', async ({ page }) => {
    const panel = await openTab(page, 'ab');
    await expect(panel).toContainText('uses tokens');
    await expect(panel).toContainText('does not change');
});

test('the settings tab exposes retention, caching depth and transfer', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    await expect(panel).toContainText('Results kept for each test case');
    await expect(panel).toContainText('Prompt caching depth');
    await expect(panel.locator('button', { hasText: 'Export suite' })).toBeVisible();
    await expect(panel).toContainText('saved inside the character card');
});

test('changing a setting persists it', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    const retention = panel.locator('input[type="number"]').first();
    await retention.fill('35');
    await retention.dispatchEvent('change');
    const saved = await page.evaluate(
        () => globalThis.SillyTavern.getContext().extensionSettings.SillyBunnyPromptingLab.runRetention,
    );
    expect(saved).toBe(35);
});

test('an out-of-range setting is corrected rather than accepted', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    const retention = panel.locator('input[type="number"]').first();
    await retention.fill('9999');
    await retention.dispatchEvent('change');
    await expect(retention).toHaveValue('200');
});

test('every tab keeps its content inside the panel on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const tab of ['cases', 'run', 'diff', 'ab', 'settings']) {
        await openTab(page, tab);
        const overflows = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflows, `${tab} tab caused sideways scrolling`).toBe(false);
    }
});

test('controls carry names a screen reader can read', async ({ page }) => {
    const panel = await openTab(page, 'ab');
    const unnamed = await panel.locator('select').evaluateAll(nodes => nodes.filter(
        node => !node.getAttribute('aria-label') && !node.labels?.length,
    ).length);
    expect(unnamed).toBe(0);
});

test('every tab is reachable and operable with the keyboard alone', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-cases').focus();
    for (const expected of ['run', 'diff', 'ab', 'settings']) {
        await page.keyboard.press('ArrowRight');
        await expect(page.locator(`#sbpl-tab-${expected}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(`#sbpl-tab-${expected}`)).toBeFocused();
    }
});

test('the focused control shows a visible focus ring', async ({ page }) => {
    await openTab(page, 'cases');
    await page.locator('#sbpl-tab-cases').focus();
    const outline = await page.locator('#sbpl-tab-cases').evaluate(
        node => getComputedStyle(node, ':focus-visible').outlineStyle,
    );
    expect(outline).not.toBe('none');
});
