import { SECTION_LABEL } from './constants.js';

/**
 * Compares a run against a baseline.
 *
 * Pure. This decides whether a prompt changed; rendering the difference for a
 * human to read is a separate job.
 */

function sectionLabel(id) {
    return SECTION_LABEL[id] ?? id;
}

function sectionMap(run) {
    const map = new Map();
    for (const section of run?.capture?.sections ?? []) {
        if (section?.id) {
            map.set(section.id, section);
        }
    }
    return map;
}

/**
 * Replaces the parts of a prompt that are expected to differ every time, so a
 * random roll or a timestamp does not report itself as a regression.
 * Spans are matched as literal text and replaced with a stable placeholder.
 */
function placeholderFor(span) {
    return `⟨${span?.macro ? `macro:${span.macro}` : 'changes each time'}⟩`;
}

export function normalizeVolatile(text, spans = []) {
    let source = String(text ?? '');

    // Anchored masking first. A value that differs on every build cannot be
    // matched by the text one run happened to produce, but the unchanged text
    // around it can be, so mask whatever sits between those anchors.
    for (const span of spans ?? []) {
        const before = String(span?.anchorBefore ?? '');
        const after = String(span?.anchorAfter ?? '');
        if (!before && !after) {
            continue;
        }
        const middle = before && after ? '[\\s\\S]*?' : '[\\s\\S]{0,200}?';
        const pattern = new RegExp(
            `${escapeRegExp(before)}(${middle})${escapeRegExp(after)}`,
            'g',
        );
        source = source.replace(pattern, `${before}${placeholderFor(span)}${after}`);
    }

    const labels = new Map();
    for (const span of spans ?? []) {
        if (span && typeof span.text === 'string' && span.text.length && !labels.has(span.text)) {
            labels.set(span.text, placeholderFor(span));
        }
    }
    if (!labels.size) {
        return source;
    }
    // One pass over the original text. Replacing spans one after another would
    // let a later span match inside a placeholder written by an earlier one and
    // shred it; a single regex never re-scans what it has already replaced.
    // Longest first, because alternation matches the first branch that fits.
    const ordered = [...labels.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(ordered.map(escapeRegExp).join('|'), 'g');
    return source.replace(pattern, match => labels.get(match) ?? match);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compares two runs section by section.
 * @returns {{changedSections: string[], addedSections: string[], removedSections: string[],
 *   tokenDeltas: object[], totalDelta: number, identical: boolean, summary: string}}
 */
export function compareRuns(run, baseline, { volatileSpans = [], normalize = true } = {}) {
    const current = sectionMap(run);
    const previous = sectionMap(baseline);
    const spans = normalize ? volatileSpans : [];

    const addedSections = [...current.keys()].filter(id => !previous.has(id));
    const removedSections = [...previous.keys()].filter(id => !current.has(id));
    const changedSections = [];
    const tokenDeltas = [];

    for (const [id, section] of current) {
        const before = previous.get(id);
        const currentTokens = Number(section.tokens ?? 0);
        const baselineTokens = Number(before?.tokens ?? 0);
        if (before) {
            const a = normalizeVolatile(before.content, spans);
            const b = normalizeVolatile(section.content, spans);
            if (a !== b) {
                changedSections.push(id);
            }
        }
        tokenDeltas.push({
            id,
            label: sectionLabel(id),
            baseline: baselineTokens,
            current: currentTokens,
            delta: currentTokens - baselineTokens,
            status: before ? 'present' : 'added',
        });
    }

    for (const id of removedSections) {
        const before = previous.get(id);
        tokenDeltas.push({
            id,
            label: sectionLabel(id),
            baseline: Number(before?.tokens ?? 0),
            current: 0,
            delta: -Number(before?.tokens ?? 0),
            status: 'removed',
        });
    }

    const totalDelta = Number(run?.capture?.tokenTable?.total ?? 0)
        - Number(baseline?.capture?.tokenTable?.total ?? 0);
    const identical = changedSections.length === 0
        && addedSections.length === 0
        && removedSections.length === 0;

    return {
        changedSections,
        addedSections,
        removedSections,
        tokenDeltas,
        totalDelta,
        identical,
        summary: describeComparison({ changedSections, addedSections, removedSections, totalDelta }),
    };
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function describeComparison({ changedSections, addedSections, removedSections, totalDelta }) {
    const parts = [];
    if (changedSections.length) {
        parts.push(`${plural(changedSections.length, 'section')} changed`);
    }
    if (addedSections.length) {
        parts.push(`${plural(addedSections.length, 'section')} added`);
    }
    if (removedSections.length) {
        parts.push(`${plural(removedSections.length, 'section')} removed`);
    }
    if (!parts.length) {
        return 'This prompt is the same as the baseline.';
    }
    const tokens = totalDelta === 0
        ? 'the same number of tokens'
        : `${Math.abs(totalDelta).toLocaleString()} ${totalDelta > 0 ? 'more' : 'fewer'} tokens`;
    return `${parts.join(', ')}, using ${tokens}.`;
}

/**
 * Finds the pieces of text that differ between two builds of the same prompt.
 * Anything that changes when nothing else did is by definition not fixed
 * content: a random roll, a timestamp, a counter.
 */
export const ANCHOR_LENGTH = 24;

export function findVolatileSpans(first, second) {
    if (!first || !second) {
        return [];
    }
    const spans = [];
    const firstSections = sectionMap(first);
    const secondSections = sectionMap(second);

    for (const [id, section] of firstSections) {
        const other = secondSections.get(id);
        if (!other || other.content === section.content) {
            continue;
        }
        const span = differingSpan(section.content, other.content);
        if (span) {
            // The value itself is different every run, so a later comparison
            // cannot find it by its text. The unchanged text on either side is
            // what stays put, so record that too and mask what sits between.
            spans.push({
                section: id,
                text: span.a,
                otherText: span.b,
                anchorBefore: section.content.slice(Math.max(0, span.start - ANCHOR_LENGTH), span.start),
                anchorAfter: section.content.slice(span.start + span.a.length, span.start + span.a.length + ANCHOR_LENGTH),
            });
        }
    }
    return spans;
}

/** Narrows two strings down to the part between their common ends. */
export function differingSpan(a, b) {
    const first = String(a ?? '');
    const second = String(b ?? '');
    if (first === second) {
        return null;
    }
    let start = 0;
    const max = Math.min(first.length, second.length);
    while (start < max && first[start] === second[start]) {
        start += 1;
    }
    let end = 0;
    while (
        end < max - start
        && first[first.length - 1 - end] === second[second.length - 1 - end]
    ) {
        end += 1;
    }
    return {
        a: first.slice(start, first.length - end),
        b: second.slice(start, second.length - end),
        start,
    };
}
