import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { installStubContext } from './helpers/stub-context.js';

const root = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(root, 'src');

async function jsFilesBelow(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...await jsFilesBelow(location));
        } else if (entry.name.endsWith('.js')) {
            result.push(location);
        }
    }
    return result;
}

const sources = await jsFilesBelow(srcRoot);

test('src modules import cleanly under a bare stub context', async () => {
    installStubContext();
    // UI modules touch the DOM at module scope in some browsers; they are
    // covered by the browser fixture tests instead.
    const headless = sources.filter(file => !file.includes(`${path.sep}ui${path.sep}`));
    assert.ok(headless.length > 0, 'expected src modules to exist');
    for (const file of headless) {
        await assert.doesNotReject(
            () => import(file),
            `${path.relative(root, file)} should import without a live SillyBunny`,
        );
    }
});

test('only src/host.js reaches into SillyBunny internals', async () => {
    for (const file of sources) {
        if (path.basename(file) === 'host.js') {
            continue;
        }
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(
            source,
            /\b(?:import|export)\s*(?:\(|[^;]*?from\s*)['"]\/(?:scripts|script)/,
            `${path.relative(root, file)}: deep host imports belong in src/host.js`,
        );
    }
});

test('vendored files stay dependency free', async () => {
    const vendorRoot = path.join(srcRoot, 'vendor');
    let vendored = [];
    try {
        vendored = await jsFilesBelow(vendorRoot);
    } catch {
        return; // Nothing vendored yet.
    }
    for (const file of vendored) {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(
            source,
            /^\s*import\s/m,
            `${path.relative(root, file)}: vendored code must not import anything`,
        );
        assert.match(
            source,
            /AGPL/,
            `${path.relative(root, file)}: vendored code must keep its licence attribution`,
        );
    }
});

test('modules render text with textContent rather than innerHTML', async () => {
    for (const file of sources) {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(
            source,
            /\.innerHTML\s*=/,
            `${path.relative(root, file)}: render untrusted text with textContent`,
        );
    }
});

test('the capture path never writes back to host prompt payloads', async () => {
    const capturePath = path.join(srcRoot, 'capture.js');
    let source = '';
    try {
        source = await readFile(capturePath, 'utf8');
    } catch {
        return; // Capture engine arrives in the next milestone.
    }
    for (const forbidden of [
        /\bdata\.chat\s*=/,
        /\bdata\.prompt\s*=/,
        /\bdata\.combinedPrompt\s*=/,
        /\bchatChanged\s*=\s*true/,
    ]) {
        assert.doesNotMatch(
            source,
            forbidden,
            'capture.js must observe prompts without changing them',
        );
    }
});
