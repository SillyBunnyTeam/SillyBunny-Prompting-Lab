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

/**
 * Chooses a character in the avatar picker that replaced the old dropdown:
 * open the menu, then press the option carrying that name.
 */
async function pickCharacter(scope, name) {
    const picker = scope.locator('.sbpl-picker').first();
    await picker.locator('summary').click();
    await picker.getByRole('button', { name, exact: true }).click();
}

/** Opens the workbench on a fresh fixture page and switches to a tab. */
async function openTab(page, tab) {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.locator('#sbpl-menu-item').click();
    return switchTab(page, tab);
}

async function seedModelRun(page) {
    await page.evaluate(async () => {
        const { saveCase, saveRun, saveSuite } = await import('/src/storage.js');
        const testCase = await saveCase({
            id: 'model-case',
            name: 'Model case',
            pins: { characterAvatar: 'tester.png' },
        });
        await saveSuite({ id: 'model-suite', name: 'Model suite', caseIds: [testCase.id] });
        await saveRun({
            id: 'model-run',
            suiteId: 'model-suite',
            caseId: testCase.id,
            caseName: testCase.name,
            startedAt: new Date().toISOString(),
            status: 'pass',
            capture: {
                messages: [{ role: 'user', content: 'Hello.' }],
                tokenTable: { total: 2 },
            },
        });
    });
}

async function makeSceneReady(panel) {
    await panel.getByLabel('Connection profile').selectOption('p2');
    await panel.locator('.sbpl-scene-preset', { hasText: 'Default' }).locator('input').check();
    await panel.locator('.sbpl-scene-preset', { hasText: 'Deep' }).locator('input').check();
    await panel.getByRole('textbox', { name: 'Turn 1' }).fill('Open the door.');
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

    await pickCharacter(editor, 'Tester');
    await editor.getByRole('textbox', { name: 'Example message' }).fill('Tell me about the vault.');
    await panel.locator('button', { hasText: 'Save test case' }).click();

    await expect(panel).toContainText('Saved "Test case 1"');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1);
});

test('case save, duplicate, and matrix creation stay registered through storage', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        globalThis.__caseBacking = storage.createMemoryStore();
        storage.__setStoreForTests(globalThis.__caseBacking);
        await globalThis.fixtureEmit('chat-changed');
    });
    await expect(panel).toContainText('No test suites yet');

    const pauseNextWrite = async () => {
        await page.evaluate(async () => {
            const storage = await import('/src/storage.js');
            const backing = globalThis.__caseBacking;
            let release;
            const paused = new Promise(resolve => { release = resolve; });
            globalThis.__caseWritePaused = false;
            globalThis.__releaseCaseWrite = release;
            storage.__setStoreForTests({
                getItem: key => backing.getItem(key),
                async setItem(key, value) {
                    if (!globalThis.__caseWritePaused && key === 'meta:transaction') {
                        globalThis.__caseWritePaused = true;
                        await paused;
                    }
                    return backing.setItem(key, value);
                },
                removeItem: key => backing.removeItem(key),
                clear: () => backing.clear(),
                keys: () => backing.keys(),
            });
        });
    };
    const expectTracked = async (name) => {
        await page.waitForFunction(() => globalThis.__caseWritePaused === true);
        expect(await page.evaluate(async () => (
            await import('/src/operations.js')
        ).activeTaskNames())).toContain(name);
        await page.evaluate(() => globalThis.__releaseCaseWrite());
    };

    await panel.getByRole('button', { name: 'Create suite' }).click();
    await expect(panel).toContainText('Created "Suite 1"');
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(panel.locator('.sbpl-editor'), 'Tester');
    await pauseNextWrite();
    await panel.getByRole('button', { name: 'Save test case' }).click();
    await expectTracked('case save');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1);

    await pauseNextWrite();
    await panel.locator('.sbpl-case-item').getByRole('button', { name: 'Duplicate' }).click();
    await expectTracked('case duplication');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(2);

    await panel.getByRole('button', { name: 'Create several' }).click();
    await panel.getByLabel('Characters').selectOption('tester.png');
    await panel.getByLabel('Presets').selectOption('Default');
    await pauseNextWrite();
    await panel.getByRole('button', { name: 'Create test cases' }).click();
    await expectTracked('case matrix creation');
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(3);
});

test('deleting a test case takes two presses, not one slip', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(panel.locator('.sbpl-editor'), 'Tester');
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1);

    const remove = panel.locator('.sbpl-case-item').getByRole('button', { name: 'Delete' });
    await remove.click();
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(1, { timeout: 1000 });
    await panel.locator('.sbpl-case-item').getByRole('button', { name: 'Press again to delete' }).click();
    await expect(panel.locator('.sbpl-case-item')).toHaveCount(0);
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
    await expect(selects.nth(0)).toContainText('Me');
    await expect(selects.nth(1)).toContainText('Claude');
    await expect(selects.nth(2)).toContainText('Tagged');
    await expect(selects.nth(3)).toContainText('Deep');
});

test('a Prompt Tags profile can be pinned from the case editor', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(panel.locator('.sbpl-editor'), 'Tester');
    await panel.locator('.sbpl-editor select').nth(2).selectOption('Tagged');
    await panel.locator('button', { hasText: 'Save test case' }).click();
    await panel.locator('button', { hasText: 'Edit' }).click();
    await expect(panel.locator('.sbpl-editor select').nth(2)).toHaveValue('Tagged');
});

test('the character picker shows faces and filters as you type', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();

    const picker = panel.locator('.sbpl-picker').first();
    await picker.locator('summary').click();
    const options = picker.locator('.sbpl-picker-option');
    await expect(options).toHaveCount(2);
    await expect(options.first().locator('img')).toHaveAttribute('src', /^data:image\/png/);

    // Read as a snapshot rather than a retrying assertion: a retry loop keeps
    // the page busy for seconds, and any focus churn in that window reopens
    // the menu, which clears the search being tested.
    const shownAfter = async (query) => {
        await picker.locator('.sbpl-picker-search').fill(query);
        return page.evaluate(() => ({
            names: [...document.querySelectorAll('.sbpl-picker-option')]
                .filter(node => !node.hidden)
                .map(node => node.getAttribute('aria-label')),
            emptyShown: !document.querySelector('.sbpl-picker-empty').hidden,
        }));
    };

    expect(await shownAfter('sera')).toEqual({ names: ['Seraphina'], emptyShown: false });
    expect(await shownAfter('nobody')).toEqual({ names: [], emptyShown: true });

    await picker.locator('.sbpl-picker-search').fill('sera');
    await picker.getByRole('button', { name: 'Seraphina', exact: true }).click();
    await expect(picker.locator('summary')).toContainText('Seraphina');
    // Choosing closes the menu and hands focus back, so the keyboard does not
    // end up inside a list that is no longer on screen.
    await expect(picker.locator('.sbpl-picker-menu')).toBeHidden();
    await expect(picker.locator('summary')).toBeFocused();
});

test('characters with the same name have distinct accessible names', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await page.evaluate(() => {
        globalThis.SillyTavern.getContext().characters.push({
            avatar: 'tester-copy.png',
            name: 'Tester',
            data: { extensions: {} },
        });
    });
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();

    const picker = panel.locator('.sbpl-picker').first();
    await picker.locator('summary').click();
    await expect(picker.getByRole('button', { name: 'Tester, tester.png', exact: true })).toHaveCount(1);
    await expect(picker.getByRole('button', { name: 'Tester, tester-copy.png', exact: true })).toHaveCount(1);
});

test('the character picker can be driven by the keyboard alone', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();

    const picker = panel.locator('.sbpl-picker').first();
    await picker.locator('summary').click();
    await picker.locator('.sbpl-picker-search').focus();
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByRole('button', { name: 'Tester', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByRole('button', { name: 'Seraphina', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker.locator('summary')).toContainText('Seraphina');

    await picker.locator('summary').click();
    await page.keyboard.press('Escape');
    await expect(picker.locator('.sbpl-picker-menu')).toBeHidden();
});

test('the character chosen in the picker is what the test case saves', async ({ page }) => {
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(panel.locator('.sbpl-editor'), 'Seraphina');
    await panel.locator('button', { hasText: 'Save test case' }).click();

    const item = panel.locator('.sbpl-case-item');
    await expect(item).toContainText('Seraphina');
    await expect(item.locator('img.sbpl-row-avatar')).toBeVisible();

    // Reopening reads the pin back rather than falling to the first character.
    await item.getByRole('button', { name: 'Edit' }).click();
    await expect(panel.locator('.sbpl-picker').first().locator('summary')).toContainText('Seraphina');
});

test('missing legacy case pins stay visible until they are removed', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedLegacyPins());
    await page.evaluate(() => globalThis.fixtureEmit('chat-changed'));
    await page.locator('#sbpl-menu-item').click();
    const panel = page.locator('#sbpl-panel');
    await panel.getByRole('button', { name: 'Edit' }).click();

    const editor = panel.locator('.sbpl-editor');
    const persona = editor.getByRole('combobox', { name: 'Persona', exact: true });
    const profile = editor.getByRole('combobox', { name: 'Connection profile', exact: true });
    const preset = editor.getByRole('combobox', { name: /^legacy-api/ });
    await expect(persona).toContainText('missing-persona.png (not installed)');
    await expect(profile).toContainText('missing-profile (not installed)');
    await expect(preset).toContainText('Missing preset (not installed)');

    await persona.selectOption('');
    await profile.selectOption('');
    await preset.selectOption('');
    await editor.getByRole('button', { name: 'Save test case' }).click();
    await expect(panel).toContainText('Saved "Legacy pins"');
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

test('built-in system prompts are editable but cannot be deleted', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedReservedPrompt());
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-presets').click();
    const panel = page.locator('#sbpl-panel');
    await panel.locator('.sbpl-preset-item', { hasText: 'Reserved draft' })
        .getByRole('button', { name: 'Edit' }).click();
    const module = panel.locator('.sbpl-editor .sbpl-module-item');
    await module.getByRole('button', { name: 'Edit' }).click();
    await module.getByRole('textbox', { name: 'Text' }).fill('Edited system prompt.');
    await expect(module.getByRole('textbox', { name: 'Text' })).toHaveValue('Edited system prompt.');
    await expect(module.getByRole('button', { name: 'Delete' })).toHaveCount(0);
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

test('publishing is single-flight and disables editor actions while pending', async ({ page }) => {
    const panel = await openTab(page, 'presets');
    await panel.locator('.sbpl-preset-item', { hasText: 'Default' }).first()
        .getByRole('button', { name: 'Copy to drafts' }).click();
    await page.evaluate(() => {
        const originalFetch = globalThis.fetch;
        globalThis.__publishCalls = 0;
        globalThis.fetch = (resource, init) => {
            if (!String(resource).endsWith('/api/presets/save')) {
                return originalFetch(resource, init);
            }
            globalThis.__publishCalls += 1;
            return new Promise((resolve) => {
                globalThis.__finishPublish = () => resolve(new Response(
                    JSON.stringify({ name: 'Default (copy)' }),
                    { headers: { 'Content-Type': 'application/json' } },
                ));
            });
        };
    });

    const editor = panel.locator('.sbpl-editor');
    const publish = editor.getByRole('button', { name: 'Publish to SillyBunny' });
    await publish.click();
    await page.waitForFunction(() => typeof globalThis.__finishPublish === 'function');
    await expect(publish).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).toContain('preset publish');

    await page.evaluate(() => {
        const publishButton = [...document.querySelectorAll('.sbpl-editor-actions button')]
            .find(node => node.textContent === 'Publish to SillyBunny');
        publishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(await page.evaluate(() => globalThis.__publishCalls)).toBe(1);

    await page.evaluate(() => globalThis.__finishPublish());
    await expect(panel).toContainText('Published "Default (copy)"');
    expect(await page.evaluate(() => globalThis.__publishCalls)).toBe(1);
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).not.toContain('preset publish');
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

test('sending a prompt registers before its read and a closed registry blocks another write', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const { createDraft, createPromptDraft } = await import('/src/schema.js');
        globalThis.__promptBacking = storage.createMemoryStore();
        storage.__setStoreForTests(globalThis.__promptBacking);
        await storage.saveDraft(createDraft({
            id: 'tracked-target',
            apiId: 'openai',
            name: 'Tracked target',
            payload: { prompts: [], prompt_order: [] },
        }));
        await storage.savePromptDraft(createPromptDraft({ id: 'tracked-prompt', title: 'Tracked prompt' }));
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'prompts');
    await panel.locator('.sbpl-preset-item').getByRole('button', { name: 'Edit' }).click();

    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const backing = globalThis.__promptBacking;
        let release;
        const paused = new Promise(resolve => { release = resolve; });
        globalThis.__releasePromptRead = release;
        globalThis.__promptReadPaused = false;
        storage.__setStoreForTests({
            async getItem(key) {
                if (!globalThis.__promptReadPaused && key === 'draft:tracked-target') {
                    globalThis.__promptReadPaused = true;
                    await paused;
                }
                return backing.getItem(key);
            },
            setItem: (key, value) => backing.setItem(key, value),
            removeItem: key => backing.removeItem(key),
            clear: () => backing.clear(),
            keys: () => backing.keys(),
        });
    });
    await panel.getByRole('button', { name: 'Send selected draft' }).click();
    await page.waitForFunction(() => globalThis.__promptReadPaused === true);
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).toContain('prompt send to preset');
    await page.evaluate(() => globalThis.__releasePromptRead());
    await expect(panel).toContainText('Sent "Tracked prompt" to "Tracked target"');

    await page.evaluate(async () => (await import('/src/operations.js')).closeOperationRegistry());
    await panel.getByRole('button', { name: 'Send selected draft' }).click();
    await expect(panel.locator('[role="status"]')).toContainText('Prompting Lab is not active');
    expect(await page.evaluate(async () => (
        await (await import('/src/storage.js')).getDraft('tracked-target')
    ).payload.prompts)).toHaveLength(1);
    await page.evaluate(async () => (await import('/src/operations.js')).openOperationRegistry());
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

test('prompt experiment refresh keeps the selected draft version', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { savePromptDraft } = await import('/src/storage.js');
        await savePromptDraft({
            id: 'experiment-prompt',
            title: 'Experiment prompt',
            versions: [
                { id: 'experiment-v1', label: 'Draft 1', content: 'First version.' },
                { id: 'experiment-v2', label: 'Draft 2', content: 'Second version.' },
            ],
            selectedVersionId: 'experiment-v1',
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'experiment');
    const prompt = panel.getByLabel('Prompt to load');
    const version = panel.getByLabel('Draft version to load');
    await expect(prompt).toHaveValue('experiment-prompt');
    await version.selectOption('experiment-v2');

    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const draft = await storage.getPromptDraft('experiment-prompt');
        await storage.savePromptDraft({ ...draft, title: 'Experiment prompt refreshed' });
        await globalThis.fixtureEmit('chat-changed');
    });
    await expect(prompt.locator('option')).toHaveText(['Experiment prompt refreshed']);
    await expect(version).toHaveValue('experiment-v2');
});

test('the prompt comparison tab sends both variants and offers an analysis', async ({ page }) => {
    const panel = await openTab(page, 'experiment');
    await expect(panel).toContainText('uses tokens');
    await expect(panel).toContainText('independent stochastic samples');
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

test('prompt experiment sends the normalized visible reply length and resyncs only while idle', async ({ page }) => {
    const panel = await openTab(page, 'experiment');
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        globalThis.__experimentTokenRequests = [];
        context.ConnectionManagerRequestService.sendRequest = (_profileId, _prompt, maxTokens) => new Promise((resolve) => {
            globalThis.__experimentTokenRequests.push({ maxTokens, resolve });
        });
    });
    await panel.getByRole('textbox', { name: 'Prompt A' }).fill('Formal tone.');
    await panel.getByRole('textbox', { name: 'Prompt B' }).fill('Casual tone.');
    const tokens = panel.getByLabel('Reply length');
    await panel.getByRole('button', { name: 'Get both replies' }).evaluate((node) => {
        document.querySelector('[aria-label="Reply length"]').value = '7';
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(() => globalThis.__experimentTokenRequests.length === 2);
    expect(await page.evaluate(() => globalThis.__experimentTokenRequests.map(request => request.maxTokens)))
        .toEqual([16, 16]);
    await expect(tokens).toHaveValue('16');

    await page.evaluate(async () => {
        (await import('/src/settings.js')).updateSettings({ abMaxTokens: 640 });
        await globalThis.fixtureEmit('chat-changed');
    });
    await expect(tokens).toHaveValue('16');
    await page.evaluate(() => {
        for (const request of globalThis.__experimentTokenRequests) request.resolve('reply');
    });
    await expect(panel.locator('[role="status"]')).toHaveText('Finished.');
    await page.evaluate(() => globalThis.fixtureEmit('chat-changed'));
    await expect(tokens).toHaveValue('640');
});

test('starting a new prompt comparison aborts and ignores an old analysis', async ({ page }) => {
    const panel = await openTab(page, 'experiment');
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        globalThis.__experimentPhase = 'first';
        context.ConnectionManagerRequestService.sendRequest = async (_profileId, prompt, _maxTokens, options) => {
            if (prompt?.[0]?.content?.includes('helping a prompt author')) {
                return new Promise((resolve) => {
                    globalThis.__finishAnalysis = resolve;
                    globalThis.__analysisSignal = options.signal;
                });
            }
            return `${globalThis.__experimentPhase} reply`;
        };
    });
    await panel.getByRole('textbox', { name: 'Prompt A' }).fill('Formal tone.');
    await panel.getByRole('textbox', { name: 'Prompt B' }).fill('Casual tone.');
    await panel.getByRole('button', { name: 'Get both replies' }).click();
    await expect(panel.locator('.sbpl-ab-panel')).toHaveCount(2);

    await panel.getByRole('button', { name: 'Get the analysis' }).click();
    await page.waitForFunction(() => typeof globalThis.__finishAnalysis === 'function');
    await page.evaluate(() => { globalThis.__experimentPhase = 'new'; });
    await panel.getByRole('button', { name: 'Get both replies' }).click();
    await expect(panel.locator('.sbpl-ab-panel').first()).toContainText('new reply');
    expect(await page.evaluate(() => globalThis.__analysisSignal.aborted)).toBe(true);

    await page.evaluate(() => globalThis.__finishAnalysis('stale analysis'));
    await expect(panel).not.toContainText('stale analysis');
    await expect(panel.locator('[role="status"]')).toHaveText('Finished.');
});

test('the run tab explains itself before any suite exists', async ({ page }) => {
    const panel = await openTab(page, 'run');
    await expect(panel).toContainText('No test suites yet');
});

test('the run tab lists what a run would do before it is started', async ({ page }) => {
    const cases = await openTab(page, 'cases');
    await cases.getByRole('button', { name: 'Create suite' }).click();
    await cases.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(cases.locator('.sbpl-editor'), 'Tester');
    await cases.locator('button', { hasText: 'Save test case' }).click();
    await expect(cases.locator('.sbpl-case-item')).toHaveCount(1);

    const panel = await switchTab(page, 'run');
    const queue = panel.locator('.sbpl-queue');
    await expect(queue).toContainText('Ready to run: 1 test case.');
    await expect(queue.locator('tbody tr')).toHaveCount(1);
    await expect(queue).toContainText('Tester');
    await expect(queue).toContainText('None yet');
});

test('definite unsaved preset edits block Quick Run and suite Run before the runner starts', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveCase, saveSuite } = await import('/src/storage.js');
        const testCase = await saveCase({
            id: 'dirty-run-case',
            name: 'Dirty preset case',
            pins: { characterAvatar: 'tester.png' },
        });
        await saveSuite({ id: 'dirty-run-suite', name: 'Dirty preset suite', caseIds: [testCase.id] });
        const context = globalThis.SillyTavern.getContext();
        const getPresetManager = context.getPresetManager.bind(context);
        context.getPresetManager = apiId => ({
            ...getPresetManager(apiId),
            _dirty: true,
            _checkDirty() {},
        });
        globalThis.__dirtyRunProbe = (await import('/src/operations.js')).acquireHostOperation('dirty run probe');
        await globalThis.fixtureEmit('chat-changed');
    });
    await page.locator('#sbpl-menu-item').click();
    const cases = await switchTab(page, 'cases');
    await cases.getByRole('button', { name: 'Run this one' }).click();

    const panel = page.locator('#sbpl-panel');
    const status = panel.locator('[role="status"]');
    await expect(status).toContainText('Save or discard your unsaved preset changes');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeOperation()?.name)).toBe('dirty run probe');
    expect(await page.evaluate(async () => (
        await (await import('/src/storage.js')).listRuns('dirty-run-case')
    ).length)).toBe(0);

    const runSuite = panel.getByRole('button', { name: 'Run suite' });
    await expect(runSuite).toBeEnabled();
    await status.evaluate(node => { node.textContent = ''; });
    await runSuite.click();
    await expect(status).toContainText('Save or discard your unsaved preset changes');
    expect(await page.evaluate(async () => (
        await (await import('/src/storage.js')).listRuns('dirty-run-case')
    ).length)).toBe(0);
    await page.evaluate(() => globalThis.__dirtyRunProbe.release());
});

test('Quick Run focuses the visible mobile section control', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    const panel = await openTab(page, 'cases');
    await panel.getByRole('button', { name: 'Create suite' }).click();
    await panel.getByRole('button', { name: 'Add test case' }).click();
    await pickCharacter(panel.locator('.sbpl-editor'), 'Tester');
    await panel.getByRole('button', { name: 'Save test case' }).click();
    await panel.getByRole('button', { name: 'Run this one' }).click();

    const section = page.locator('#sbpl-workbench .sbpl-tab-select');
    await expect(section).toHaveValue('run');
    await expect(section).toBeVisible();
    await expect(section).toBeFocused();
});

test('Quick Run keeps the suite that initiated it when a case is shared', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveCase, saveSuite } = await import('/src/storage.js');
        const testCase = await saveCase({
            id: 'shared-quick-case',
            name: 'Shared quick case',
            pins: { characterAvatar: 'tester.png' },
        });
        await saveSuite({ id: 'quick-a', name: 'Quick A', caseIds: [testCase.id] });
        await saveSuite({ id: 'quick-b', name: 'Quick B', caseIds: [testCase.id] });
        await globalThis.fixtureEmit('chat-changed');
    });
    await page.locator('#sbpl-menu-item').click();
    const cases = page.locator('#sbpl-panel');
    await cases.getByLabel('Suite').selectOption('quick-b');
    await cases.getByRole('button', { name: 'Run this one' }).click();
    await expect(page.locator('#sbpl-run-suite')).toHaveValue('quick-b');
});

test('a delayed Quick Run cannot start after its tab is disposed', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    const result = await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const { waitForQuiescence } = await import('/src/operations.js');
        const { createRunTab } = await import('/src/ui/run-tab.js');
        const backing = storage.createMemoryStore();
        storage.__setStoreForTests(backing);
        const testCase = await storage.saveCase({
            id: 'disposed-quick-case',
            name: 'Disposed Quick Run',
            pins: { characterAvatar: 'tester.png' },
        });
        const suite = await storage.saveSuite({
            id: 'disposed-quick-suite',
            name: 'Disposed Quick Suite',
            caseIds: [testCase.id],
        });

        let releaseReads;
        let blocked = true;
        const readsReleased = new Promise(resolve => { releaseReads = resolve; });
        storage.__setStoreForTests({
            async getItem(key) {
                if (blocked) await readsReleased;
                return backing.getItem(key);
            },
            setItem: (key, value) => backing.setItem(key, value),
            removeItem: key => backing.removeItem(key),
            clear: () => backing.clear(),
            keys: () => backing.keys(),
        });

        const tab = createRunTab();
        document.body.append(tab.render());
        tab.runOne({ id: testCase.id, suiteId: suite.id });
        tab.dispose();
        blocked = false;
        releaseReads();
        await new Promise(resolve => setTimeout(resolve, 20));
        await waitForQuiescence();
        return { runs: await storage.listRuns(testCase.id) };
    });

    expect(result.runs).toHaveLength(0);
});

test('a run result row shows unchecked checks explicitly', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedUnchecked());
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-run').click();
    await expect(page.locator('#sbpl-panel')).toContainText('1 needs review');
    await expect(page.locator('#sbpl-panel')).toContainText('unchecked');
    await expect(page.locator('#sbpl-panel')).toContainText('No lorebook activity was recorded');
});

test('refresh removes a run result that was deleted elsewhere', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedUnchecked());
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-run').click();
    const panel = page.locator('#sbpl-panel');
    await expect(panel).toContainText('1 needs review');

    await page.evaluate(async () => {
        const { deleteRun } = await import('/src/storage.js');
        await deleteRun('fixture-unchecked-case', 'fixture-unchecked-run');
        await globalThis.fixtureEmit('chat-changed');
    });
    await expect(panel).not.toContainText('1 needs review');
    await expect(panel.getByRole('button', { name: 'Set passing runs as baselines' })).toBeHidden();
});

test('the comparison tab asks for two runs before it can compare', async ({ page }) => {
    const panel = await openTab(page, 'diff');
    await expect(panel).toContainText('Nothing to compare yet');
});

test('the comparison tab preserves duplicate sections and reports outbound-only changes', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveCase, saveRun, saveSuite } = await import('/src/storage.js');
        const testCase = await saveCase({ id: 'diff-case', name: 'Diff case' });
        await saveSuite({
            id: 'diff-suite',
            name: 'Diff suite',
            caseIds: [testCase.id],
            baselines: { [testCase.id]: 'diff-base' },
        });
        const capture = (second, callId) => ({
            sections: [
                { id: 'main', content: 'first occurrence', tokens: 2 },
                { id: 'main', content: second, tokens: 3 },
            ],
            messages: [{ role: 'assistant', content: '', tool_calls: [{ id: callId }] }],
            tokenTable: { total: 5 },
        });
        await saveRun({
            id: 'diff-base',
            suiteId: 'diff-suite',
            caseId: testCase.id,
            caseName: testCase.name,
            startedAt: '2026-08-09T10:00:00.000Z',
            status: 'pass',
            capture: capture('old second occurrence', 'call-1'),
        });
        await saveRun({
            id: 'diff-text',
            suiteId: 'diff-suite',
            caseId: testCase.id,
            caseName: testCase.name,
            startedAt: '2026-08-09T10:01:00.000Z',
            status: 'pass',
            capture: capture('new second occurrence', 'call-1'),
        });
        await saveRun({
            id: 'diff-protocol',
            suiteId: 'diff-suite',
            caseId: testCase.id,
            caseName: testCase.name,
            startedAt: '2026-08-09T10:02:00.000Z',
            status: 'pass',
            capture: capture('old second occurrence', 'call-2'),
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'diff');
    await panel.getByLabel('Compare from').selectOption('diff-base');
    await panel.getByLabel('Compare to').selectOption('diff-text');

    await expect(panel.locator('.sbpl-diff-output tbody tr td:first-child')).toHaveText([
        'Main prompt (occurrence 1 of 2)',
        'Main prompt (occurrence 2 of 2)',
    ]);
    await expect(panel.locator('.sbpl-diff-section')).toHaveCount(1);
    await expect(panel.locator('.sbpl-diff-section')).toContainText('old second occurrence');
    await expect(panel.locator('.sbpl-diff-section')).toContainText('new second occurrence');

    await panel.getByLabel('Compare to').selectOption('diff-protocol');
    const summary = panel.locator('.sbpl-diff-output > .sbpl-summary');
    await expect(summary).toContainText("final outbound prompt's structure, message order, or protocol fields changed");
    await expect(summary).not.toContainText('same prompt');
    await expect(summary).not.toContainText('exactly the same prompt');
});

test('definite unsaved preset edits block setup comparison before the runner starts', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveCase, saveSuite } = await import('/src/storage.js');
        const testCase = await saveCase({
            id: 'dirty-setup-case',
            name: 'Dirty setup case',
            pins: { characterAvatar: 'tester.png' },
        });
        await saveSuite({ id: 'dirty-setup-suite', name: 'Dirty setup suite', caseIds: [testCase.id] });
        const context = globalThis.SillyTavern.getContext();
        const getPresetManager = context.getPresetManager.bind(context);
        context.getPresetManager = apiId => ({
            ...getPresetManager(apiId),
            _dirty: true,
            _checkDirty() {},
        });
        globalThis.__dirtySetupProbe = (await import('/src/operations.js')).acquireHostOperation('dirty setup probe');
        await globalThis.fixtureEmit('chat-changed');
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'diff');
    const build = panel.getByRole('button', { name: 'Build this test case under 2 setups' });
    await expect(build).toBeEnabled();
    await build.click();

    await expect(panel.locator('[role="status"]')).toContainText('Save or discard your unsaved preset changes');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeOperation()?.name)).toBe('dirty setup probe');
    expect(await page.evaluate(async () => (
        await (await import('/src/storage.js')).listRuns('dirty-setup-case')
    ).length)).toBe(0);
    await page.evaluate(() => globalThis.__dirtySetupProbe.release());
});

test('diff refresh keeps setup choices for the same case and resets them for another case', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveCase, saveSuite } = await import('/src/storage.js');
        const first = await saveCase({
            id: 'setup-a',
            name: 'Setup A',
            pins: {
                characterAvatar: 'tester.png',
                presets: [{ apiId: 'openai', name: 'Default' }],
            },
        });
        const second = await saveCase({
            id: 'setup-b',
            name: 'Setup B',
            pins: {
                characterAvatar: 'tester.png',
                presets: [{ apiId: 'openai', name: 'Default' }],
            },
        });
        await saveSuite({ id: 'setup-suite', name: 'Setup suite', caseIds: [first.id, second.id] });
        await globalThis.fixtureEmit('chat-changed');
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'diff');
    const rows = panel.locator('.sbpl-setup-rows > .sbpl-controls');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).getByLabel('Preset for this setup').selectOption('Deep');
    await rows.nth(0).getByLabel('Connection for this setup').selectOption('p2');
    await rows.nth(1).getByLabel('Preset kind to swap').selectOption('instruct');
    await rows.nth(1).getByLabel('Preset for this setup').selectOption('ChatML');
    await rows.nth(1).getByLabel('Connection for this setup').selectOption('p1');
    await panel.getByRole('button', { name: 'Add a setup' }).click();
    await rows.nth(2).getByLabel('Preset kind to swap').selectOption('textgenerationwebui');
    await rows.nth(2).getByLabel('Preset for this setup').selectOption('Simple');
    await rows.nth(2).getByLabel('Connection for this setup').selectOption('p2');

    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const testCase = await storage.getCase('setup-a');
        await storage.saveCase({ ...testCase, name: 'Setup A refreshed' });
        await globalThis.fixtureEmit('chat-changed');
    });
    const caseSelect = panel.getByLabel('Test case');
    await expect(caseSelect.locator('option[value="setup-a"]')).toHaveText('Setup A refreshed');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByLabel('Preset for this setup')).toHaveValue('Deep');
    await expect(rows.nth(0).getByLabel('Connection for this setup')).toHaveValue('p2');
    await expect(rows.nth(1).getByLabel('Preset kind to swap')).toHaveValue('instruct');
    await expect(rows.nth(1).getByLabel('Preset for this setup')).toHaveValue('ChatML');
    await expect(rows.nth(1).getByLabel('Connection for this setup')).toHaveValue('p1');
    await expect(rows.nth(2).getByLabel('Preset kind to swap')).toHaveValue('textgenerationwebui');
    await expect(rows.nth(2).getByLabel('Preset for this setup')).toHaveValue('Simple');
    await expect(rows.nth(2).getByLabel('Connection for this setup')).toHaveValue('p2');

    await caseSelect.selectOption('setup-b');
    await expect(rows).toHaveCount(2);
});

test('diff baseline promotion stays registered through its reload', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        globalThis.__baselineBacking = storage.createMemoryStore();
        storage.__setStoreForTests(globalThis.__baselineBacking);
        const testCase = await storage.saveCase({ id: 'tracked-baseline-case', name: 'Tracked baseline case' });
        await storage.saveSuite({
            id: 'tracked-baseline-suite',
            name: 'Tracked baseline suite',
            caseIds: [testCase.id],
        });
        await storage.saveRun({
            id: 'tracked-baseline-run',
            suiteId: 'tracked-baseline-suite',
            caseId: testCase.id,
            caseName: testCase.name,
            status: 'pass',
            capture: {
                messages: [{ role: 'user', content: 'Tracked prompt.' }],
                tokenTable: { total: 3 },
            },
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'diff');
    await expect(panel.getByLabel('Compare to')).toHaveValue('tracked-baseline-run');

    await page.evaluate(async () => {
        const storage = await import('/src/storage.js');
        const backing = globalThis.__baselineBacking;
        let release;
        const paused = new Promise(resolve => { release = resolve; });
        globalThis.__releaseBaselineReload = release;
        globalThis.__baselinePromoted = false;
        globalThis.__baselineIndexReads = 0;
        storage.__setStoreForTests({
            async getItem(key) {
                if (globalThis.__baselinePromoted && key === 'index:suites') {
                    globalThis.__baselineIndexReads += 1;
                    if (globalThis.__baselineIndexReads === 2) {
                        globalThis.__baselineReloadPaused = true;
                        await paused;
                    }
                }
                return backing.getItem(key);
            },
            async setItem(key, value) {
                const result = await backing.setItem(key, value);
                if (key === 'suite:tracked-baseline-suite'
                    && value?.baselines?.['tracked-baseline-case'] === 'tracked-baseline-run') {
                    globalThis.__baselinePromoted = true;
                }
                return result;
            },
            removeItem: key => backing.removeItem(key),
            clear: () => backing.clear(),
            keys: () => backing.keys(),
        });
    });
    await panel.getByRole('button', { name: 'Set the "To" run as the baseline' }).click();
    await page.waitForFunction(() => globalThis.__baselineReloadPaused === true);
    await expect(panel.locator('[role="status"]')).toContainText('Saved the');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).toContain('baseline promotion');

    await page.evaluate(() => globalThis.__releaseBaselineReload());
    await expect.poll(async () => page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).not.toContain('baseline promotion');
    expect(await page.evaluate(async () => (
        await (await import('/src/storage.js')).getSuite('tracked-baseline-suite')
    ).baselines['tracked-baseline-case'])).toBe('tracked-baseline-run');
});

test('the model comparison tab warns that it spends tokens', async ({ page }) => {
    const panel = await openTab(page, 'ab');
    await expect(panel).toContainText('uses tokens');
    await expect(panel).toContainText('does not change');
});

test('model comparison requires two distinct profiles and freezes its request inputs', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await seedModelRun(page);
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        globalThis.__modelRequests = [];
        context.ConnectionManagerRequestService.sendRequest = (profileId) => new Promise((resolve) => {
            globalThis.__modelRequests.push({ profileId, resolve });
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'ab');
    const first = panel.getByLabel('First connection profile');
    const second = panel.getByLabel('Second connection profile');
    const send = panel.getByRole('button', { name: 'Get both replies' });
    await expect(send).toBeEnabled();

    await second.selectOption('p1');
    await expect(send).toBeDisabled();
    await second.selectOption('p2');
    await send.click();
    await page.waitForFunction(() => globalThis.__modelRequests.length === 2);
    for (const control of [
        panel.getByLabel('Suite'),
        panel.getByLabel('Test case'),
        panel.getByLabel('Run'),
        first,
        second,
        panel.getByLabel('Reply length'),
    ]) {
        await expect(control).toBeDisabled();
    }

    await page.evaluate(() => {
        document.querySelector('[aria-label="Second connection profile"]').value = 'p1';
        for (const request of globalThis.__modelRequests) {
            request.resolve(`reply from ${request.profileId}`);
        }
    });
    await expect(panel.locator('.sbpl-ab-title')).toHaveText(['Local', 'Claude']);
});

test('model comparison sends the normalized visible reply length and resyncs only while idle', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await seedModelRun(page);
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        globalThis.__modelTokenRequests = [];
        context.ConnectionManagerRequestService.sendRequest = (profileId, _prompt, maxTokens) => new Promise((resolve) => {
            globalThis.__modelTokenRequests.push({ profileId, maxTokens, resolve });
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'ab');
    const tokens = panel.getByLabel('Reply length');
    await panel.getByRole('button', { name: 'Get both replies' }).evaluate((node) => {
        document.querySelector('[aria-label="Reply length"]').value = '99999';
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(() => globalThis.__modelTokenRequests.length === 2);
    expect(await page.evaluate(() => globalThis.__modelTokenRequests.map(request => request.maxTokens)))
        .toEqual([32000, 32000]);
    await expect(tokens).toHaveValue('32000');

    await page.evaluate(async () => {
        (await import('/src/settings.js')).updateSettings({ abMaxTokens: 512 });
        await globalThis.fixtureEmit('chat-changed');
    });
    await expect(tokens).toHaveValue('32000');
    await page.evaluate(() => {
        for (const request of globalThis.__modelTokenRequests) request.resolve(`reply from ${request.profileId}`);
    });
    await expect(panel.locator('[role="status"]')).toHaveText('Finished.');
    await switchTab(page, 'cases');
    const activePanel = await switchTab(page, 'ab');
    await expect(activePanel.getByLabel('Reply length')).toHaveValue('512');
});

test('the scene comparison tab states its cost and refuses to send until it can', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await expect(panel).toContainText('uses tokens');
    await expect(panel).toContainText('Nothing is added to any chat');
    // Nothing is chosen yet, so the estimate asks for the missing pieces and
    // the button that spends money stays disabled.
    await expect(panel).toContainText('Choose at least two presets');
    await expect(panel.locator('button', { hasText: 'Play the scene' })).toBeDisabled();
});

test('the browser scene sanitizer keeps only inert formatting', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    const clean = await page.evaluate(async () => {
        const { sanitizeReplyHtml } = await import('/src/scenes.js');
        return sanitizeReplyHtml(
            '</div></section><div class="card" style="color:red">'
            + '<strong onclick="alert(1)">Safe</strong>'
            + '<style>.card{position:fixed}</style>'
            + '<form action="https://example.test"><input name="secret">'
            + '<button formaction="https://example.test">Send <em>now</em></button></form>'
            + '<a href="https://example.test" target="_blank">external <u>link</u></a>'
            + '</div><script>document.body.remove()</script>',
        );
    });

    expect(clean).toBe('<div><strong>Safe</strong>Send <em>now</em>external <u>link</u></div>');
});

test('the scene tab offers every greeting a card carries and previews the chosen one', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await pickCharacter(panel, 'Seraphina');

    const opening = panel.getByLabel('Which greeting opens the scene');
    // No opening, the first message, and both alternates.
    await expect(opening.locator('option')).toHaveCount(4);
    await expect(opening.locator('option').first()).toContainText('No opening');
    await expect(opening.locator('option').nth(1)).toContainText('First message');
    await expect(opening.locator('option').nth(2)).toContainText('Alternate greeting 1');

    const preview = panel.locator('.sbpl-preview');
    await expect(preview).toContainText('She looks up from the bar.');
    await opening.selectOption('1');
    await expect(preview).toContainText('The door swings shut behind you.');
    await expect(preview).not.toContainText('She looks up from the bar.');

    // Turning the opening off leaves the scene starting at your own first turn.
    await opening.selectOption('');
    await expect(preview).not.toContainText('The door swings shut behind you.');

    await opening.selectOption('1');
    await pickCharacter(panel, 'Tester');
    await pickCharacter(panel, 'Seraphina');
    await expect(opening).toHaveValue('0');
    await expect(preview).toContainText('She looks up from the bar.');
    await expect(preview).not.toContainText('The door swings shut behind you.');
});

test('the scene preview shows both faces and follows what is typed', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await pickCharacter(panel, 'Seraphina');
    const preview = panel.locator('.sbpl-preview');

    // The character opens, the persona answers: one picture each.
    await expect(preview.locator('img.sbpl-preview-avatar')).toHaveCount(1);
    await panel.getByRole('textbox', { name: 'Turn 1' }).fill('I push open the door.');
    await expect(preview).toContainText('I push open the door.');
    await expect(preview.locator('img.sbpl-preview-avatar')).toHaveCount(2);
    await expect(preview).toContainText('Me');
});

test('the scene tab can be run as a different persona', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await pickCharacter(panel, 'Seraphina');
    await panel.getByRole('textbox', { name: 'Turn 1' }).fill('I push open the door.');

    const persona = panel.locator('.sbpl-picker').nth(1);
    await persona.locator('summary').click();
    await persona.getByRole('button', { name: 'Kris', exact: true }).click();
    await expect(persona.locator('summary')).toContainText('Kris');
    await expect(panel.locator('.sbpl-preview')).toContainText('Kris');
});

test('only the current avatar chat-file check can restore scene readiness', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (resource, init) => {
            if (String(resource).endsWith('/api/characters/chats')) {
                const avatar = JSON.parse(String(init?.body ?? '{}')).avatar_url;
                if (avatar === 'tester.png') {
                    return new Promise((resolve) => {
                        globalThis.__finishTesterChatCheck = () => resolve(new Response('[]'));
                    });
                }
                if (avatar === 'seraphina.png') {
                    return new Promise((resolve) => {
                        globalThis.__finishSeraphinaChatCheck = () => resolve(new Response('[{}]'));
                    });
                }
            }
            return originalFetch(resource, init);
        };
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'scenes');
    await page.waitForFunction(() => typeof globalThis.__finishTesterChatCheck === 'function');
    await makeSceneReady(panel);
    const warning = panel.locator('.sbpl-warning-text');
    const send = panel.getByRole('button', { name: 'Play the scene under each preset' });
    await expect(warning).toHaveAttribute('role', 'status');
    await expect(warning).toContainText('Checking whether playing this character will create a chat');
    await expect(send).toBeDisabled();

    await pickCharacter(panel, 'Seraphina');
    await page.waitForFunction(() => typeof globalThis.__finishSeraphinaChatCheck === 'function');
    await page.evaluate(() => globalThis.__finishTesterChatCheck());
    await expect(warning).toContainText('Checking whether playing this character will create a chat');
    await expect(send).toBeDisabled();

    await page.evaluate(() => globalThis.__finishSeraphinaChatCheck());
    await expect(panel.locator('.sbpl-warning-text')).toBeHidden();
    await expect(send).toBeEnabled();
});

test('scene send awaits the avatar check before acquiring the host lease', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (resource, init) => {
            if (String(resource).endsWith('/api/characters/chats')) {
                return new Promise((resolve) => {
                    globalThis.__finishSceneChatCheck = () => resolve(new Response('[{}]'));
                });
            }
            return originalFetch(resource, init);
        };
        const context = globalThis.SillyTavern.getContext();
        globalThis.__scenePaidRequests = 0;
        context.ConnectionManagerRequestService.sendRequest = async () => {
            globalThis.__scenePaidRequests += 1;
            return 'unexpected';
        };
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'scenes');
    await page.waitForFunction(() => typeof globalThis.__finishSceneChatCheck === 'function');
    await makeSceneReady(panel);
    const send = panel.getByRole('button', { name: 'Play the scene under each preset' });
    await expect(send).toBeDisabled();

    await send.evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await page.evaluate(async () => (await import('/src/operations.js')).activeOperation())).toBe(null);
    expect(await page.evaluate(() => globalThis.__scenePaidRequests)).toBe(0);

    await page.evaluate(async () => {
        globalThis.__sceneProbeLease = (await import('/src/operations.js')).acquireHostOperation('chat check probe');
    });
    await page.evaluate(() => globalThis.__finishSceneChatCheck());
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('busy with chat check probe');
    expect(await page.evaluate(() => globalThis.__scenePaidRequests)).toBe(0);
    await page.evaluate(() => globalThis.__sceneProbeLease.release());
    expect(await page.evaluate(async () => (await import('/src/operations.js')).activeOperation())).toBe(null);
});

test('scene comparison validates profile mode, dirty presets, and the shared host lease', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await panel.locator('.sbpl-scene-preset', { hasText: 'Default' }).locator('input').check();
    await panel.locator('.sbpl-scene-preset', { hasText: 'Deep' }).locator('input').check();
    await panel.getByRole('textbox', { name: 'Turn 1' }).fill('Open the door.');
    const send = panel.getByRole('button', { name: 'Play the scene under each preset' });
    await expect(panel).toContainText('Choose a Chat Completion connection profile');
    await expect(send).toBeDisabled();

    await panel.getByLabel('Connection profile').selectOption('p2');
    await expect(send).toBeEnabled();
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        globalThis.__basePresetManager = context.getPresetManager.bind(context);
        globalThis.__scenePaidRequests = 0;
        context.ConnectionManagerRequestService.sendRequest = async () => {
            globalThis.__scenePaidRequests += 1;
            return 'unexpected';
        };
        context.getPresetManager = (apiId) => ({
            ...globalThis.__basePresetManager(apiId),
            _dirty: true,
            _checkDirty() {},
        });
    });
    await send.click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('unsaved changes');
    expect(await page.evaluate(() => globalThis.__scenePaidRequests)).toBe(0);

    await page.evaluate(async () => {
        const context = globalThis.SillyTavern.getContext();
        context.getPresetManager = (apiId) => ({
            ...globalThis.__basePresetManager(apiId),
            _dirty: false,
            _checkDirty() {},
        });
        const { acquireHostOperation } = await import('/src/operations.js');
        globalThis.__otherLease = acquireHostOperation('another workflow');
    });
    await send.click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('busy with another workflow');
    await page.evaluate(() => globalThis.__otherLease.release());
});

test('a scene snapshots its persona and exports retry completion accurately', async ({ page }) => {
    const panel = await openTab(page, 'scenes');
    await page.evaluate(() => {
        const context = globalThis.SillyTavern.getContext();
        const originalManager = context.getPresetManager.bind(context);
        const managers = new Map();
        context.getPresetManager = (apiId = 'openai') => {
            if (!managers.has(apiId)) {
                const base = originalManager(apiId);
                let selected = base.getSelectedPresetName();
                managers.set(apiId, {
                    ...base,
                    getSelectedPresetName: () => selected,
                    getSelectedPreset: () => base.findPreset(selected),
                    async selectPreset(value) {
                        selected = String(value).replace(/^value:/, '');
                    },
                    _dirty: false,
                    _checkDirty() {
                        this._dirty = false;
                        if (globalThis.__switchPersonaOnPreflight) {
                            globalThis.__switchPersonaOnPreflight = false;
                            context.userAvatar = 'kris.png';
                            context.name1 = 'Kris';
                        }
                    },
                });
            }
            return managers.get(apiId);
        };

        Object.assign(context.eventTypes, {
            GENERATION_STARTED: 'generation-started',
            GENERATION_AFTER_COMMANDS: 'generation-after-commands',
            GENERATE_AFTER_DATA: 'generate-after-data',
            CHAT_COMPLETION_PROMPT_READY: 'chat-completion-ready',
            GENERATE_BEFORE_COMBINE_PROMPTS: 'before-combine',
            GENERATE_AFTER_COMBINE_PROMPTS: 'after-combine',
            WORLDINFO_SCAN_DONE: 'world-info-done',
        });
        context.generate = async (_type, _options, dryRun) => {
            await context.eventSource.emit(context.eventTypes.GENERATE_AFTER_DATA, {
                prompt: [{ role: 'user', content: 'assembled prompt' }],
            }, dryRun);
        };
        context.extensionSettings.connectionManager.selectedProfile = 'p2';
        context.mainApi = 'openai';
        const connectionValues = { model: 'claude', proxy: 'None' };
        const connectionCommand = field => ({
            callback: async (args, value) => {
                if (args?._hasUnnamedArgument) connectionValues[field] = String(value);
                return connectionValues[field];
            },
        });
        context.SlashCommandParser = {
            commands: {
                model: connectionCommand('model'),
                proxy: connectionCommand('proxy'),
            },
        };
        globalThis.__sceneCommands = [];
        context.executeSlashCommandsWithOptions = async (command) => {
            globalThis.__sceneCommands.push(command);
            if (command.startsWith('/persona-set')) {
                const quoted = command.match(/"(?:\\.|[^"\\])*"/)?.[0];
                context.userAvatar = quoted ? JSON.parse(quoted) : '';
                context.name1 = context.userAvatar === 'me.png' ? 'Me' : 'Kris';
            }
            return {};
        };

        globalThis.__sceneSendMode = 'clock';
        globalThis.__sceneSendCalls = 0;
        globalThis.__sceneModeCalls = 0;
        context.ConnectionManagerRequestService.sendRequest = (_profileId, _prompt, _maxTokens, options) => {
            globalThis.__sceneSendCalls += 1;
            globalThis.__sceneModeCalls += 1;
            if (globalThis.__sceneSendMode === 'clock' && globalThis.__sceneModeCalls === 1) {
                return new Promise((resolve, reject) => {
                    globalThis.__finishFirstSceneReply = resolve;
                    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
            }
            if ((globalThis.__sceneSendMode === 'abort' && globalThis.__sceneModeCalls === 3)
                || (globalThis.__sceneSendMode === 'retry-abort' && globalThis.__sceneModeCalls === 2)) {
                globalThis.__sceneRetrySignal = options.signal;
                return new Promise((_resolve, reject) => {
                    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
                    if (options.signal.aborted) abort();
                    else options.signal.addEventListener('abort', abort, { once: true });
                });
            }
            return `scene reply ${globalThis.__sceneSendCalls}`;
        };
        globalThis.__switchPersonaOnPreflight = true;
    });

    const persona = panel.locator('.sbpl-picker').nth(1);
    await persona.locator('summary').click();
    await persona.getByRole('button', { name: 'Stay on the persona you are using', exact: true }).click();
    await makeSceneReady(panel);
    await panel.getByRole('button', { name: 'Play the scene under each preset' }).click();

    const liveLabel = panel.locator('.sbpl-scene-turn-label').first();
    await expect(liveLabel).toContainText(/waiting [1-9]\.[0-9] seconds/, { timeout: 3000 });
    await expect(panel.getByLabel('Connection profile')).toBeDisabled();
    expect(await page.evaluate(async () => (await import('/src/operations.js')).activeOperation()?.name))
        .toBe('a scene comparison');
    await page.evaluate(() => globalThis.__finishFirstSceneReply('first scene reply'));
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('Finished.');
    expect((await page.evaluate(() => globalThis.__sceneCommands.filter(command => command.startsWith('/persona-set'))))[0])
        .toContain('"me.png"');
    expect(await page.evaluate(async () => (await import('/src/operations.js')).activeOperation())).toBe(null);

    await panel.getByRole('textbox', { name: 'Turn 2' }).fill('Keep going.');
    await page.evaluate(() => {
        globalThis.__sceneSendMode = 'abort';
        globalThis.__sceneModeCalls = 0;
        globalThis.__sceneRetrySignal = null;
    });
    await panel.getByRole('button', { name: 'Play the scene under each preset' }).click();
    await page.waitForFunction(() => Boolean(globalThis.__sceneRetrySignal));
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('Stopped.');

    await page.evaluate(() => {
        globalThis.__sceneSendMode = 'reply';
        globalThis.__sceneModeCalls = 0;
        const createObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            globalThis.__sceneExport = blob;
            return createObjectURL(blob);
        };
    });
    await panel.locator('.sbpl-ab-panel').first().getByRole('button', { name: 'Play turn 2 again' }).click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('Played Default again from turn 2.');
    await panel.getByRole('button', { name: 'Save as Markdown' }).click();
    const partial = await page.evaluate(() => globalThis.__sceneExport.text());
    expect(partial).toContain('**Status:** Incomplete');
    expect(partial).toContain('**Requests:** 3 of 4 completed');
    expect(partial).not.toContain('Aborted (incomplete)');

    await page.evaluate(() => {
        globalThis.__sceneSendMode = 'retry-abort';
        globalThis.__sceneModeCalls = 0;
        globalThis.__sceneRetrySignal = null;
    });
    await panel.locator('.sbpl-ab-panel').nth(1).getByRole('button', { name: 'Play turn 1 again' }).click();
    await page.waitForFunction(() => Boolean(globalThis.__sceneRetrySignal));
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('Stopped.');
    await panel.getByRole('button', { name: 'Save as Markdown' }).click();
    const stoppedRetry = await page.evaluate(() => globalThis.__sceneExport.text());
    expect(stoppedRetry).toContain('**Status:** Aborted (incomplete)');
    expect(stoppedRetry).toContain('**Requests:** 4 of 4 completed');

    await page.evaluate(() => {
        globalThis.__sceneSendMode = 'reply';
        globalThis.__sceneModeCalls = 0;
    });
    await panel.locator('.sbpl-ab-panel').nth(1).getByRole('button', { name: 'Play turn 2 again' }).click();
    await expect(panel.locator('.sbpl-status:not(.sbpl-warning-text)')).toContainText('Played Deep again from turn 2.');
    await panel.getByRole('button', { name: 'Save as Markdown' }).click();
    const complete = await page.evaluate(() => globalThis.__sceneExport.text());
    expect(complete).toContain('**Status:** Complete');
    expect(complete).toContain('**Requests:** 4 of 4 completed');
});

test('the settings tab exposes retention, caching depth and transfer', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    await expect(panel).toContainText('Runs kept for each test case');
    await expect(panel).toContainText('Prompt caching depth');
    await expect(panel.locator('button', { hasText: 'Export suite' })).toBeVisible();
    await expect(panel).toContainText('saved inside the character card');
});

test('saving a multi-character suite requires an explicit card choice', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(() => globalThis.fixtureSeedMultiCharacterSuite());
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-settings').click();
    const panel = page.locator('#sbpl-panel');
    const character = panel.getByLabel('Character card');
    await expect(character).toHaveValue('');
    await expect(character).toContainText('Tester');
    await expect(character).toContainText('Seraphina');

    await panel.getByRole('button', { name: 'Save this suite into a character card' }).click();
    await expect(panel).toContainText('Choose which character card to save into');
    await character.selectOption('seraphina.png');
    page.once('dialog', async (dialog) => {
        expect(dialog.message()).toContain('will be replaced');
        await dialog.dismiss();
    });
    await panel.getByRole('button', { name: 'Save this suite into a character card' }).click();
    await expect(panel).toContainText('Nothing was saved into the card');
});

test('cleanup waits for an import paused at its first await', async ({ page }) => {
    const panel = await openTab(page, 'settings');
    await page.evaluate(() => {
        File.prototype.text = function text() {
            return new Promise((resolve) => {
                globalThis.__finishSuiteRead = () => resolve('{}');
            });
        };
    });
    await panel.getByLabel('Suite file to import').setInputFiles({
        name: 'paused-suite.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{}'),
    });
    await page.waitForFunction(() => typeof globalThis.__finishSuiteRead === 'function');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).toContain('suite import');

    await page.evaluate(async () => {
        const { clean } = await import('/index.js');
        globalThis.__cleanSettled = false;
        globalThis.__cleaning = clean().then(() => { globalThis.__cleanSettled = true; });
    });
    expect(await page.evaluate(() => globalThis.__cleanSettled)).toBe(false);
    await page.evaluate(() => globalThis.__finishSuiteRead());
    await page.evaluate(() => globalThis.__cleaning);
    expect(await page.evaluate(() => globalThis.__cleanSettled)).toBe(true);
});

test('card embedding remains tracked until the host write settles', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        await globalThis.fixtureSeedMultiCharacterSuite();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (resource, init) => {
            if (!String(resource).endsWith('/api/characters/merge-attributes')) {
                return originalFetch(resource, init);
            }
            return new Promise((resolve) => {
                globalThis.__finishCardWrite = () => resolve(new Response('OK'));
            });
        };
    });
    await page.locator('#sbpl-menu-item').click();
    await page.locator('#sbpl-tab-settings').click();
    const panel = page.locator('#sbpl-panel');
    await panel.getByLabel('Character card').selectOption('tester.png');
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Save this suite into a character card' }).click();
    await page.waitForFunction(() => typeof globalThis.__finishCardWrite === 'function');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).toContain('character card embedding');

    await page.evaluate(() => globalThis.__finishCardWrite());
    await expect(panel).toContainText('Saved 1 test case into the card.');
    expect(await page.evaluate(async () => (
        await import('/src/operations.js')
    ).activeTaskNames())).not.toContain('character card embedding');
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
    for (const tab of ['cases', 'presets', 'prompts', 'run', 'ledger', 'diff', 'experiment', 'ab', 'scenes', 'settings']) {
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
    for (const expected of ['presets', 'prompts', 'run', 'ledger', 'diff', 'experiment', 'ab', 'scenes', 'settings']) {
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

test('the token ledger lists recorded prompts and persists its switch', async ({ page }) => {
    await page.goto('/test/browser/fixture.html');
    await page.waitForFunction(() => globalThis.__ready === true);
    await page.evaluate(async () => {
        const { saveLedgerEntry } = await import('/src/storage.js');
        await saveLedgerEntry({
            id: 'led-1',
            at: '2026-08-11T10:00:00.000Z',
            kind: 'normal',
            apiType: 'cc',
            api: 'openai',
            characterName: 'Seraphina',
            total: 420,
            sections: [
                { id: 'chatHistory', label: 'Chat history', tokens: 300 },
                { id: 'main', label: 'Main prompt', tokens: 120 },
            ],
            wiEntryCount: 1,
        });
    });
    await page.locator('#sbpl-menu-item').click();
    const panel = await switchTab(page, 'ledger');
    await expect(panel).toContainText('Record where the tokens of real replies go');
    await expect(panel).toContainText('never the prompt text itself');
    await expect(panel).toContainText('Seraphina');
    await expect(panel).toContainText('420 tokens');
    await expect(panel).toContainText('Average prompt size');

    const entry = panel.locator('.sbpl-ledger-entry').first();
    await entry.locator('summary').click();
    await expect(entry).toContainText('Chat history: 300 tokens');
    await expect(entry).toContainText('1 lorebook entry activated');

    await panel.locator('.sbpl-checkbox').first().check();
    const enabled = await page.evaluate(
        () => globalThis.SillyTavern.getContext().accountStorage.getItem('SBPromptingLab_ledgerEnabled'),
    );
    expect(enabled).toBe('true');
});
