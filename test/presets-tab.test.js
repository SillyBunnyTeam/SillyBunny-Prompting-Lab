import assert from 'node:assert/strict';
import test from 'node:test';

import { abortActiveOperations, openOperationRegistry, waitForQuiescence } from '../src/operations.js';
import { createDraft } from '../src/schema.js';
import * as storage from '../src/storage.js';
import { createPresetsTab } from '../src/ui/presets-tab.js';

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.attributes = {};
        this.className = '';
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.isConnected = true;
    }

    append(...children) {
        for (const child of children) {
            this.children.push(child);
            child.parentNode = this;
        }
    }

    replaceChildren(...children) {
        for (const child of this.children) {
            child.parentNode = null;
        }
        this.children = [];
        this.append(...children);
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    addEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
    }

    click() {
        for (const listener of this.listeners.get('click') ?? []) {
            listener({ currentTarget: this, target: this });
        }
    }

    hasChildNodes() {
        return this.children.length > 0;
    }

    querySelectorAll(selector) {
        if (selector !== '.sbpl-editor-actions button') {
            return [];
        }
        const matches = [];
        const visit = (node, insideActions = false) => {
            const inside = insideActions || node.className.split(/\s+/).includes('sbpl-editor-actions');
            if (inside && node.tagName === 'BUTTON') {
                matches.push(node);
            }
            for (const child of node.children) {
                visit(child, inside);
            }
        };
        visit(this);
        return matches;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        }
        this.parentNode = null;
        this.isConnected = false;
    }
}

function findButton(node, label) {
    if (node.tagName === 'BUTTON' && node.textContent === label) {
        return node;
    }
    for (const child of node.children) {
        const found = findButton(child, label);
        if (found) {
            return found;
        }
    }
    return null;
}

async function waitFor(getValue) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = getValue();
        if (value) {
            return value;
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for preset tab state.');
}

test('an aborted preset publish does not save the published draft', async () => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    const store = storage.createMemoryStore();
    const originalSetItem = store.setItem.bind(store);
    let writes = 0;
    store.setItem = async (...args) => {
        writes += 1;
        return originalSetItem(...args);
    };
    storage.__setStoreForTests(store);
    openOperationRegistry();

    const draft = createDraft({
        apiId: 'context',
        name: 'Release',
        payload: { story_string: 'Hello' },
    });
    await storage.saveDraft(draft);
    writes = 0;

    let releaseCatalog;
    const catalogResponse = new Promise(resolve => { releaseCatalog = resolve; });
    const requests = [];
    globalThis.document = { createElement: tagName => new FakeElement(tagName) };
    globalThis.fetch = async (url, options) => {
        requests.push({ url, signal: options.signal });
        if (url === '/api/settings/get') {
            return catalogResponse;
        }
        return new Response('{"name":"Release"}', { headers: { 'Content-Type': 'application/json' } });
    };

    let tab = null;
    try {
        tab = createPresetsTab();
        const root = tab.render();
        const edit = await waitFor(() => findButton(root, 'Edit'));
        edit.click();
        findButton(root, 'Publish to SillyBunny').click();
        await waitFor(() => requests.length === 1);

        abortActiveOperations();
        releaseCatalog(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        await waitForQuiescence();

        assert.deepEqual(requests.map(request => request.url), ['/api/settings/get', '/api/presets/save']);
        assert.ok(requests.every(request => request.signal.aborted));
        assert.equal(writes, 0);
        assert.equal((await storage.getDraft(draft.id)).publishedAs, '');
    } finally {
        tab?.dispose();
        storage.__setStoreForTests(null);
        openOperationRegistry();
        globalThis.fetch = previousFetch;
        if (previousDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = previousDocument;
        }
    }
});
