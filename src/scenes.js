import { sendPrompt } from './ab.js';
import { applyCase, restoreState, snapshotState } from './apply-state.js';
import { captureOnce } from './capture.js';
import { getContext } from './host.js';

/**
 * Plays one scene under several presets and puts the replies side by side.
 *
 * Each preset gets its own column. Within a column the scene is built turn by
 * turn: the prompt is rebuilt the way SillyBunny would, with everything said so
 * far already in the chat, then sent. The reply becomes part of the scene and
 * the next turn starts from there.
 *
 * This spends tokens, so nothing here runs until the user presses the button.
 * Nothing is written to any chat: the turns live in the in-memory chat for the
 * length of one dry-run build and are taken out again.
 */

export const SCENE_MODE = Object.freeze({
    SCRIPTED: 'scripted',
    CONTINUE: 'continue',
});

/** What drives a turn when the user only wrote the opening. */
export const CONTINUE_NUDGE = 'Continue the scene.';

export const MAX_TURNS = 4;
export const MAX_PRESETS = 4;

function clampCount(value, max) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) {
        return 1;
    }
    return Math.min(Math.max(number, 1), max);
}

/**
 * The user turns a scene will send, in order.
 *
 * Scripted mode sends what the user wrote, so every preset faces the same
 * words. Continue mode sends the opening and then a fixed nudge, so the scene
 * carries on by itself; from the second turn onwards the columns are answering
 * their own replies rather than the same input.
 */
export function sceneTurns({ mode = SCENE_MODE.SCRIPTED, turns = [], exchanges = 2 } = {}) {
    const written = (turns ?? [])
        .map(text => String(text ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_TURNS);
    if (mode !== SCENE_MODE.CONTINUE) {
        return written;
    }
    if (!written.length) {
        return [];
    }
    const count = clampCount(exchanges, MAX_TURNS);
    return [written[0], ...Array.from({ length: count - 1 }, () => CONTINUE_NUDGE)];
}

/**
 * What a comparison will cost, worked out before it starts so the number can be
 * shown next to the button rather than discovered afterwards.
 */
export function estimateScene({
    presets = [],
    mode = SCENE_MODE.SCRIPTED,
    turns = [],
    exchanges = 2,
    maxTokens = 300,
} = {}) {
    const script = sceneTurns({ mode, turns, exchanges });
    const presetCount = (presets ?? []).length;
    const requests = script.length * presetCount;
    return {
        turns: script.length,
        presets: presetCount,
        requests,
        replyTokenCeiling: requests * Math.max(0, Math.floor(Number(maxTokens)) || 0),
    };
}

/** How long a reply took, in the units a reader thinks in. */
export function describeDuration(ms) {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    if (seconds < 10) {
        return `${seconds.toFixed(1)} seconds`;
    }
    if (seconds < 60) {
        return `${Math.round(seconds)} seconds`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds - (minutes * 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
}

/** Says in plain language what pressing the button will do. */
export function describeEstimate(estimate) {
    if (!estimate?.requests) {
        return 'Choose at least two presets and write the first message.';
    }
    return `${estimate.requests} request${estimate.requests === 1 ? '' : 's'}: `
        + `${estimate.turns} turn${estimate.turns === 1 ? '' : 's'} for each of ${estimate.presets} presets, `
        + `up to about ${estimate.replyTokenCeiling.toLocaleString()} reply tokens in total, plus the prompt each time.`;
}

/**
 * Writes a finished comparison out as something a person can keep, read
 * elsewhere, or send to someone else. Markdown keeps the headings; plain text
 * uses rules instead, so both stay readable on their own.
 */
export function formatScene(result, {
    format = 'md',
    characterName = '',
    connectionName = '',
    savedAt = '',
} = {}) {
    const markdown = format !== 'txt';
    const lines = [];
    const heading = (level, text) => lines.push(markdown ? `${'#'.repeat(level)} ${text}` : text.toUpperCase());
    const rule = () => lines.push(markdown ? '' : '-'.repeat(60));

    heading(1, 'Scene comparison');
    lines.push('');
    for (const [label, value] of [
        ['Character', characterName],
        ['Connection', connectionName],
        ['Saved', savedAt],
    ]) {
        if (value) {
            lines.push(markdown ? `- **${label}:** ${value}` : `${label}: ${value}`);
        }
    }
    lines.push('');

    for (const column of result?.columns ?? []) {
        rule();
        heading(2, column.label);
        lines.push('');
        if (column.error) {
            lines.push(markdown ? `> ${column.error}` : `! ${column.error}`, '');
        }
        for (const turn of column.turns ?? []) {
            heading(3, `Turn ${turn.index}`);
            lines.push('');
            lines.push(markdown ? `**You:** ${turn.userText}` : `You: ${turn.userText}`);
            lines.push('');
            const body = turn.error ? `(${turn.error})` : turn.text;
            lines.push(markdown ? `**${column.label}:** ${body}` : `${column.label}: ${body}`);
            lines.push('');
            const facts = `${describeDuration(turn.durationMs)}, prompt ${turn.promptTokens.toLocaleString()} tokens`;
            lines.push(markdown ? `*${facts}*` : `(${facts})`);
            lines.push('');
        }
    }

    return `${lines.join('\n').trimEnd()}\n`;
}

/** A file name that says what the file holds and stays safe on every system. */
export function sceneFileName({ characterName = '', format = 'md', savedAt = '' } = {}) {
    const safe = String(characterName || 'scene')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'scene';
    const stamp = String(savedAt).slice(0, 10);
    return `prompting-lab-scene-${safe}${stamp ? `-${stamp}` : ''}.${format === 'txt' ? 'txt' : 'md'}`;
}

/**
 * Runs the comparison. Apply, build and send are injectable so the sequencing
 * can be tested without a live SillyBunny or a real model.
 *
 * @returns {Promise<{columns: object[], script: string[], restoreProblems: string[], aborted: boolean}>}
 */
export async function runSceneComparison({
    presets = [],
    characterAvatar = '',
    personaKey = null,
    connectionProfileId = '',
    mode = SCENE_MODE.SCRIPTED,
    turns = [],
    exchanges = 2,
    maxTokens = 300,
    context = getContext,
    host = null,
    signal = null,
    onProgress = null,
    onUpdate = null,
    live = false,
    captureFn = captureOnce,
    applyFn = applyCase,
    sendFn = sendPrompt,
    snapshotFn = snapshotState,
    restoreFn = restoreState,
} = {}) {
    const script = sceneTurns({ mode, turns, exchanges });
    const chosen = (presets ?? []).filter(preset => preset?.name).slice(0, MAX_PRESETS);
    const columns = [];
    if (!script.length || !chosen.length) {
        return { columns, script, restoreProblems: [], aborted: false };
    }

    // Snapshotted before the first preset is applied and restored no matter how
    // this ends, so a failed send cannot leave the user on another preset.
    const snapshot = snapshotFn(context);
    let restoreProblems = [];

    try {
        for (const preset of chosen) {
            if (signal?.aborted) {
                break;
            }
            const column = {
                preset,
                label: preset.name,
                turns: [],
                caveats: [],
                error: '',
                done: false,
            };
            columns.push(column);
            onUpdate?.({ columns });

            try {
                await applyFn(context, {
                    characterAvatar,
                    personaKey,
                    connectionProfileId,
                    presets: [preset],
                }, { signal });
            } catch (error) {
                column.error = String(error?.message ?? error);
                column.done = true;
                onUpdate?.({ columns });
                continue;
            }

            const scene = [];
            for (const [index, userText] of script.entries()) {
                if (signal?.aborted) {
                    break;
                }
                onProgress?.({
                    presetName: preset.name,
                    presetIndex: columns.length,
                    presetTotal: chosen.length,
                    turn: index + 1,
                    turnTotal: script.length,
                });

                scene.push({ role: 'user', text: userText });
                let capture;
                try {
                    capture = await captureFn({ scene: [...scene], context, host });
                } catch (error) {
                    column.error = String(error?.message ?? error);
                    column.done = true;
                    onUpdate?.({ columns });
                    break;
                }
                for (const caveat of capture?.caveats ?? []) {
                    if (!column.caveats.includes(caveat)) {
                        column.caveats.push(caveat);
                    }
                }

                // The record exists before the reply does, so a watcher can
                // show the turn filling in rather than a blank wait.
                const record = {
                    index: index + 1,
                    userText,
                    text: '',
                    error: null,
                    promptTokens: Number(capture?.tokenTable?.total ?? 0),
                    durationMs: 0,
                    waiting: true,
                };
                column.turns.push(record);
                onUpdate?.({ columns });

                const startedMs = Date.now();
                const prompt = capture?.messages ?? capture?.combinedPrompt ?? '';
                const reply = await sendFn(connectionProfileId, prompt, {
                    hostRef: context,
                    maxTokens,
                    signal,
                    onDelta: live
                        ? (text) => {
                            record.text = text;
                            record.durationMs = Date.now() - startedMs;
                            onUpdate?.({ columns, streaming: record });
                        }
                        : null,
                });
                record.text = String(reply?.text ?? '');
                record.error = reply?.error ?? null;
                record.durationMs = Date.now() - startedMs;
                record.waiting = false;
                onUpdate?.({ columns });

                // A scene that stalled cannot be continued honestly: the next
                // turn would be answering a reply that never arrived.
                if (reply?.error || !reply?.text) {
                    break;
                }
                scene.push({ role: 'assistant', text: reply.text });
            }
            column.done = true;
            onUpdate?.({ columns });
        }
    } finally {
        try {
            restoreProblems = await restoreFn(context, snapshot) ?? [];
        } catch (error) {
            restoreProblems = [String(error?.message ?? error)];
        }
    }

    return { columns, script, restoreProblems, aborted: Boolean(signal?.aborted) };
}
