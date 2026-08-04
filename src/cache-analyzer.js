import { classifySource, CLASS_STABLE, CLASS_WHY, SEVERITY } from './vendor/volatility.js';

/**
 * Works out which part of a prompt gets cached, and whether anything in that
 * part changes between runs.
 *
 * Prompt caching is applied by the server after the browser hands the prompt
 * over, so no event can report where the cache boundary landed. The walk below
 * mirrors SillyBunny's own (src/prompt-converters.js, cachingAtDepthForClaude)
 * so the boundary can be predicted from the captured messages. The host
 * contract test hashes that function and fails if its rules change.
 *
 * Pure: no host imports, so every rule is testable.
 */

/**
 * Finds the messages the server would mark as cache boundaries.
 *
 * Depth counts role *switches* from the end of the conversation, not messages,
 * and the assistant prefill at the very end is skipped. Boundaries are placed
 * at the requested depth and again two switches later.
 *
 * @param {object[]} messages the outgoing messages
 * @param {number} cachingAtDepth depth configured on the server
 * @returns {number[]} indices of the messages that carry a cache boundary
 */
export function predictCacheBreakpoints(messages, cachingAtDepth) {
    if (!Array.isArray(messages) || !Number.isInteger(cachingAtDepth) || cachingAtDepth < 0) {
        return [];
    }
    const breakpoints = [];
    let passedThePrefill = false;
    let depth = 0;
    let previousRoleName = '';

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!passedThePrefill && message?.role === 'assistant') {
            continue;
        }
        passedThePrefill = true;

        if (message?.role !== previousRoleName) {
            if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
                breakpoints.push(index);
            }
            if (depth === cachingAtDepth + 2) {
                break;
            }
            depth += 1;
            previousRoleName = message?.role;
        }
    }
    return breakpoints.sort((a, b) => a - b);
}

/**
 * The part of the prompt that caching is supposed to reuse: everything from the
 * start up to and including the last boundary.
 */
export function cachedPrefix(messages, breakpoints) {
    if (!Array.isArray(messages) || !breakpoints?.length) {
        return [];
    }
    const last = Math.max(...breakpoints);
    return messages.slice(0, last + 1);
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
    }
    return '';
}

export function prefixText(messages, breakpoints) {
    return cachedPrefix(messages, breakpoints).map(messageText).join('\n');
}

/**
 * SillyBunny merges consecutive system messages before sending, but skips that
 * step during a dry run. Because depth counts role switches, leaving them
 * unmerged would put the predicted boundary in the wrong place, so the merge is
 * reproduced here on a copy.
 */
export function squashSystemMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const result = [];
    for (const message of messages) {
        const previous = result[result.length - 1];
        if (
            previous
            && previous.role === 'system'
            && message?.role === 'system'
            && typeof previous.content === 'string'
            && typeof message.content === 'string'
            && !previous.name
            && !message.name
        ) {
            previous.content = `${previous.content}\n${message.content}`;
            continue;
        }
        result.push({ ...message });
    }
    return result;
}

/**
 * Explains why a piece of text is not the same on every run, using the macro
 * names it contains.
 */
export function explainSpan(span, { deps = {}, sourceText = '' } = {}) {
    // The classifier reads macro syntax, but a captured prompt has already had
    // its macros resolved, so the span itself usually holds only the result.
    // Any source text the caller can supply (a preset's own prompt, a card
    // field) is where a macro name will actually still be found.
    const haystack = [sourceText, span?.text, span?.otherText]
        .filter(part => typeof part === 'string' && part)
        .join('\n');
    const findings = classifySource(haystack, deps);
    const worst = (Array.isArray(findings) ? findings : [])
        .filter(finding => finding?.cls && finding.cls !== CLASS_STABLE)
        .sort((a, b) => (SEVERITY[b.cls] ?? 0) - (SEVERITY[a.cls] ?? 0))[0] ?? null;
    return {
        macro: worst?.name ?? '',
        class: worst?.cls ?? '',
        why: worst
            ? `${worst.name}: ${CLASS_WHY[worst.cls] ?? 'changes between runs'}`
            : 'this text is different each time the prompt is built',
    };
}

/**
 * Full cache report for one run.
 *
 * @param {object} options
 * @param {object[]} options.messages captured outgoing messages
 * @param {object[]} options.volatileSpans pieces that differed between two builds
 * @param {number|null} options.cachingAtDepth configured depth, or null if unknown
 * @param {boolean} options.squashSystem whether SillyBunny merges system messages
 * @param {function} options.hash stable hash for the cached prefix
 */
export function analyzeCache({
    messages = [],
    volatileSpans = [],
    cachingAtDepth = null,
    squashSystem = false,
    hash = null,
    sections = [],
    sourceTexts = {},
    deps = {},
} = {}) {
    const effective = squashSystem ? squashSystemMessages(messages) : messages;
    const known = Number.isInteger(cachingAtDepth) && cachingAtDepth >= 0;
    const breakpoints = known ? predictCacheBreakpoints(effective, cachingAtDepth) : [];
    const prefix = prefixText(effective, breakpoints);

    const sectionOrder = new Map(sections.map((section, index) => [section.id, index]));
    const spans = volatileSpans.map((span) => {
        const explained = explainSpan(span, {
            deps,
            // The unresolved prompt text is where a macro name still exists.
            sourceText: sourceTexts?.[span?.section] ?? '',
        });
        return {
            ...span,
            ...explained,
            // Without a boundary there is no cached region, so nothing can sit
            // above one. Saying "above" here would invent a problem.
            aboveBreakpoint: breakpoints.length ? isSpanInPrefix(span, prefix, sectionOrder) : false,
        };
    });

    return {
        predictedBreakpoints: breakpoints,
        prefixHash: prefix && typeof hash === 'function' ? String(hash(prefix)) : '',
        volatileSpans: spans,
        source: known ? 'manual' : 'unknown',
        squashApplied: Boolean(squashSystem),
    };
}

function isSpanInPrefix(span, prefix, sectionOrder) {
    if (!prefix) {
        return false;
    }
    const text = String(span?.text ?? '');
    if (text && prefix.includes(text)) {
        return true;
    }
    // A span that is empty on one side (text was added, not changed) cannot be
    // located by its own content, so fall back to where its section sits.
    if (!text && span?.section && sectionOrder.has(span.section)) {
        return true;
    }
    return false;
}
