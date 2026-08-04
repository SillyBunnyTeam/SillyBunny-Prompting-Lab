import { expect, test } from '@playwright/test';

/**
 * Switches to a tab in an already open workbench, using whichever control is
 * on screen: the tab strip on a wide screen, the select on a narrow one.
 * Navigating reloads the fixture and clears its stores, so multi-tab flows
 * must switch rather than reopen.
 */
async function switchTab(page, tab) {
    const strip = page.locator(`#sbpl-tab-${tab}`);
    if (await strip.isVisible()) {
        await strip.click();
    } else {
        await page.locator('#sbpl-workbench .sbpl-tab-select').selectOption(tab);
    }
    return page.locator('#sbpl-panel');
}

/** Opens the workbench on a fresh fixture page and switches to a tab. */
async function openTab(page, tab) {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.locator('#sbpl-menu-item').click();
    return switchTab(page, tab);
}

test('the test cases tab starts with an explanation, not an empty box', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await expect(panel).toContainText('No test suites yet');
    await expect(panel.locator('button', { hasText: 'Create suite' })).toBeVisible();
});

test('action buttons stay horizontal and use the host primary style', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    const createSuite = panel.getByRole('button', { name: 'Create suite' });
    const addCase = panel.getByRole('button', { name: 'Add test case' });
    await expect(addCase).toHaveClass(/menu_button_primary/);
    for (const action of [createSuite, addCase]) {
        await expect(action).toHaveCSS('white-space', 'nowrap');
        const box = await action.boundingBox();
        expect(box.width).toBeGreaterThan(box.height);
    }
});

test('a suite and a test case can be created and saved', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await expect(panel).toContainText('Created "Suite 1"');

    await panel.getByRole('button', { name: 'Add test case' }).click();
    const editor = panel.locator('.sbpl-editor');
    await expect(editor).toBeVisible();

    await editor.locator('select').first().selectOption('tester.png');
    await editor.getByRole('textbox', { name: 'Example message' }).fill('Tell me about the vault.');
    await panel.locator('button', { hasText: 'Save test case' }).click();

    await expect(panel).toContainText('Saved "Test case 1"');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1);
});

test('a test case without a character explains what is missing', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await expect(panel.locator('.sbpl-problems')).toContainText('Choose a character');
});

test('checks can be added to a test case and read back', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    const adder = panel.locator('.sbpl-assertion-adder');
    await adder.locator('select').selectOption('token-ceiling');
    await adder.locator('button', { hasText: 'Add check' }).click();
    const check = panel.locator('.sbpl-assertion-item');
    await expect(check).toContainText('under 1,000 tokens');
    await check.locator('button', { hasText: 'Edit' }).click();
    await check.locator('input[type="number"]').fill('1500');
    await expect(check).toContainText('under 1,500 tokens');
});

test('the personas and profiles offered come from the host', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    const selects = panel.locator('.sbpl-editor select');
    await expect(selects.nth(1)).toContainText('Me');
    await expect(selects.nth(2)).toContainText('Claude');
    await expect(selects.nth(3)).toContainText('Tagged');
    await expect(selects.nth(4)).toContainText('Deep');
});

test('a Prompt Tags profile can be pinned from the case editor', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    const selects = panel.locator('.sbpl-editor select');
    await selects.nth(0).selectOption('tester.png');
    await selects.nth(3).selectOption('Tagged');
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await panel.locator('button', { hasText: 'Edit' }).click();
    await expect(panel.locator('.sbpl-editor select').nth(3)).toHaveValue('Tagged');
});

test('the presets tab lists what the host has installed', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    await expect(panel).toContainText('Installed in SillyBunny');
    await expect(panel).toContainText('Chat Completion');
    await expect(panel).toContainText('Instruct template');
    await expect(panel).toContainText('No drafts here yet');
});

test('an installed preset can be copied into a draft and edited module by module', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    const installed = panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Copy to drafts' }).click();
    await expect(panel).toContainText('Copied "Default" into your drafts.');

    const editor = panel.locator('.sbpl-editor');
    await expect(editor).toContainText('Prompt modules');
    const module = editor.locator('.sbpl-module-item').first();
    await expect(module).toContainText('Main');
    await module.getByRole('button', { name: 'Edit' }).click();
    await module.getByRole('textbox', { name: 'Text' }).fill('Be very helpful.');
    await editor.getByRole('button', { name: 'Save draft' }).click();
    await expect(panel).toContainText('Saved "Default (copy)"');
});

test('publishing a draft sends it to the host and asks for a reload', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    const installed = panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Copy to drafts' }).click();
    await panel.locator('.sbpl-editor').getByRole('button', { name: 'Publish to SillyBunny' }).click();

    await expect(panel).toContainText('Published "Default (copy)"');
    await expect(panel.getByRole('button', { name: 'Reload SillyBunny' })).toBeVisible();
    const saved = await page.evaluate(() => globalThis.fixtureGetSavedPresets());
    expect(saved).toHaveLength(1);
    expect(saved[0].apiId).toBe('openai');
    expect(saved[0].name).toBe('Default (copy)');
});

test('the prompts tab explains itself before any prompt exists', async ({ page }) => {
    const panel = await openTab(page, 'prompts');
    await expect(panel).toContainText('No prompts here yet');
    await expect(panel.locator('button', { hasText: 'New prompt' })).toBeVisible();
});

test('a prompt can keep several draft versions and select one', async ({ page }) => {
    const panel = await openTab(page, 'prompts');
    await panel.getByRole('button', { name: 'New prompt' }).click();
    const editor = panel.locator('.sbpl-editor');
    await expect(editor).toBeVisible();

    await editor.getByRole('textbox', { name: 'Text' }).fill('Be very formal.');
    await editor.getByRole('button', { name: 'Add draft', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Text' }).fill('Be casual.');
    await expect(editor.locator('.sbpl-module-item')).toHaveCount(2);
    await expect(editor.locator('input[type="radio"]').nth(1)).toBeChecked();

    await editor.locator('input[type="radio"]').first().check();
    await editor.getByRole('button', { name: 'Save prompt' }).click();
    await expect(panel).toContainText('Saved "Prompt 1"');
    await expect(panel.locator('.sbpl-preset-item')).toContainText('2 drafts');
    await expect(panel.locator('.sbpl-preset-item')).toContainText('selected: Draft 1');
});

test('a prompt draft can be sent to a preset draft as a module', async ({ page }) => {
    const presets = await openTab(page, 'presets');
    const installed = presets.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Copy to drafts' }).click();
    await expect(presets).toContainText('Copied "Default" into your drafts.');
    await presets.locator('.sbpl-editor').getByRole('button', { name: 'Close' }).click();

    const panel = await switchTab(page, 'prompts');
    await panel.getByRole('button', { name: 'New prompt' }).click();
    const editor = panel.locator('.sbpl-editor');
    await editor.getByRole('textbox', { name: 'Text' }).fill('Always stay in character.');
    await editor.getByRole('button', { name: 'Save prompt' }).click();
    await editor.getByRole('button', { name: 'Send selected draft' }).click();
    await expect(panel).toContainText('Sent "Prompt 1" to "Default (copy)"');

    const presetsAgain = await switchTab(page, 'presets');
    await presetsAgain.locator('.sbpl-preset-item', { hasText: 'Default (copy)' })
        .getByRole('button', { name: 'Edit' }).click();
    await expect(presetsAgain.locator('.sbpl-module-item')).toHaveCount(2);
    await expect(presetsAgain.locator('.sbpl-module-item').nth(1)).toContainText('Prompt 1');
});

test('a module can be copied from one preset draft and pasted into another', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    const installed = panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Copy to drafts' }).click();
    const editor = panel.locator('.sbpl-editor');
    await expect(editor.getByRole('button', { name: 'Paste' })).toBeDisabled();
    await editor.locator('.sbpl-module-item').first().getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(panel).toContainText('Copied "Main"');

    await editor.getByRole('button', { name: 'Paste' }).click();
    await expect(panel).toContainText('Pasted "Main"');
    await expect(editor.locator('.sbpl-module-item')).toHaveCount(2);
});

test('single prompts can be browsed and copied out of an installed preset', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    const installed = panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Browse prompts' }).click();
    await expect(installed.locator('.sbpl-module-item')).toContainText('Main');
    await installed.locator('.sbpl-module-item').first().getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(panel).toContainText('Copied "Main" from "Default"');
});

test('a module can be saved into the Prompts space', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    const installed = panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first();
    await installed.getByRole('button', { name: 'Browse prompts' }).click();
    await installed.locator('.sbpl-module-item').first().getByRole('button', { name: 'To Prompts tab' }).click();
    await expect(panel).toContainText('Saved "Main" to the Prompts tab');

    const prompts = await switchTab(page, 'prompts');
    await expect(prompts.locator('.sbpl-preset-item')).toContainText('Main');
});

test('the prompt comparison tab sends both variants and offers an analysis', async ({ page }) => {
    const panel = await openTab(page, 'experiment');
    await expect(panel).toContainText('uses tokens');
    await panel.getByRole('textbox', { name: 'Prompt A' }).fill('Formal tone.');
    await panel.getByRole('textbox', { name: 'Prompt B' }).fill('Casual tone.');
    await panel.getByRole('button', { name: 'Get both replies' }).click();

    const panels = panel.locator('.sbpl-ab-panel');
    await expect(panels).toHaveCount(2);
    await expect(panels.first()).toContainText('Prompt A');
    await expect(panels.first()).toContainText('reply from');

    await expect(panel).toContainText('Analysis (optional)');
    await panel.getByRole('button', { name: 'Get the analysis' }).click();
    await expect(panel.locator('.sbpl-analysis .sbpl-ab-body')).toContainText('reply from');
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

test('the model comparison tab warns that it spends tokens', async ({ page }) => {
    const panel = await openTab(page, 'ab');
    await expect(panel).toContainText('uses tokens');
    await expect(panel).toContainText('does not change');
});

test('the settings tab exposes retention, caching depth and transfer', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    await expect(panel).toContainText('Runs kept for each test case');
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
    for (const tab of ['cases', 'presets', 'prompts', 'run', 'diff', 'experiment', 'ab', 'settings']) {
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
    for (const expected of ['presets', 'prompts', 'run', 'diff', 'experiment', 'ab', 'settings']) {
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
