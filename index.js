import { getContext, loadHost } from './src/host.js';
import { clearSettings, getSettings } from './src/settings.js';
import { clearAll } from './src/storage.js';
import { mountRuntimeUi, unmountRuntimeUi } from './src/ui/runtime.js';

let initialized = false;
let activationEpoch = 0;
let activationController = null;
let runtimeUi = null;
const subscriptions = [];

function subscribe(source, eventType, handler) {
    if (!source?.on || !eventType) {
        return;
    }
    source.on(eventType, handler);
    subscriptions.push({ source, eventType, handler });
}

async function mountOnReady(epoch, signal) {
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi = mountRuntimeUi({ signal });
    runtimeUi.refresh('app-ready');

    const host = await loadHost();
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi?.setAvailability(host);
}

export function init() {
    if (initialized) {
        runtimeUi?.refresh('init');
        return;
    }

    initialized = true;
    const epoch = ++activationEpoch;
    activationController = new AbortController();
    const { signal } = activationController;
    getSettings();

    const context = getContext();
    const source = context?.eventSource;
    const events = context?.eventTypes;
    if (!source || !events) {
        initialized = false;
        activationController.abort();
        activationController = null;
        return;
    }

    subscribe(source, events.APP_READY, () => {
        void mountOnReady(epoch, signal).catch((error) => {
            if (!signal.aborted && epoch === activationEpoch) {
                console.error('Prompting Lab could not mount.', error);
            }
        });
    });

    const refresh = reason => () => {
        if (!signal.aborted && epoch === activationEpoch) {
            runtimeUi?.refresh(reason);
        }
    };
    subscribe(source, events.CHAT_CHANGED, refresh('chat-changed'));
    subscribe(source, events.CHARACTER_EDITED, refresh('character-edited'));
    subscribe(source, events.SETTINGS_UPDATED, refresh('settings-updated'));
}

export function deactivate() {
    initialized = false;
    activationEpoch++;
    activationController?.abort();
    activationController = null;

    while (subscriptions.length) {
        const { source, eventType, handler } = subscriptions.pop();
        source?.removeListener?.(eventType, handler);
    }

    runtimeUi = null;
    unmountRuntimeUi();
}

export async function clean() {
    deactivate();
    try {
        await clearAll();
    } catch (error) {
        console.error('Prompting Lab could not clear its stored tests.', error);
    }
    clearSettings();
}
