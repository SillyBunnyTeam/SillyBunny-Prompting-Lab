import { CAVEAT, SECTION_LABEL } from './constants.js';
import { countTokens, ctxOf, displayTokenCounts, getContext } from './host.js';

/**
 * Captures the prompt SillyBunny would send, without sending it.
 *
 * Everything here observes and copies. Listeners never write back to a payload:
 * assigning to data.chat, data.prompt or data.chatChanged would make the Lab a
 * participant in the prompt it is supposed to be measuring.
 */

/** Text-completion pieces worth reporting, in the order they are assembled. */
const TC_SECTION_KEYS = [
    'worldInfoBefore',
    'description',
    'personality',
    'scenario',
    'persona',
    'storyString',
    'worldInfoAfter',
    'beforeScenarioAnchor',
    'afterScenarioAnchor',
    'mesExmString',
    'mesSendString',
    'main',
    'jailbreak',
    'naiPreamble',
];

function sectionLabel(id) {
    return SECTION_LABEL[id] ?? id;
}

/** structuredClone refuses class instances and functions; fall back to JSON. */
function safeClone(value) {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return null;
        }
    }
}

function cloneMessages(messages) {
    if (!Array.isArray(messages)) {
        return null;
    }
    return messages
        .filter(message => message && typeof message === 'object')
        .map(message => ({
            role: String(message.role ?? ''),
            content: typeof message.content === 'string'
                ? message.content
                : safeClone(message.content),
            ...(message.name ? { name: String(message.name) } : {}),
            ...(message.tool_calls ? { tool_calls: safeClone(message.tool_calls) } : {}),
        }));
}

/**
 * Pulls the activated lorebook entries out of one WORLDINFO_SCAN_DONE pass.
 * The payload holds live entry objects and a timed-effects instance, so only
 * the identifying fields are copied out.
 */
function extractWorldInfoPass(payload) {
    const activated = payload?.activated?.entries;
    const entries = activated instanceof Set ? [...activated] : (Array.isArray(activated) ? activated : []);
    return entries
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => ({
            world: String(entry.world ?? ''),
            uid: entry.uid ?? null,
            comment: String(entry.comment ?? ''),
            keys: Array.isArray(entry.key) ? entry.key.map(key => String(key)) : [],
            position: entry.position ?? null,
            depth: entry.depth ?? null,
            order: entry.order ?? null,
        }));
}

/**
 * Collects the unresolved text behind each prompt section.
 *
 * A captured prompt holds the result of a macro, not the macro itself, so the
 * assembled text cannot say why a value moves. The preset's own prompts and the
 * character card still carry the macro syntax, which is what makes it possible
 * to name the macro responsible for a prompt that will not cache.
 */
export function collectSourceTexts(context) {
    const sources = {};
    for (const prompt of context?.chatCompletionSettings?.prompts ?? []) {
        if (prompt?.identifier && typeof prompt.content === 'string') {
            sources[prompt.identifier] = prompt.content;
        }
    }
    try {
        const fields = context?.getCharacterCardFields?.() ?? {};
        const map = {
            charDescription: fields.description,
            charPersonality: fields.personality,
            scenario: fields.scenario,
            personaDescription: fields.persona,
            dialogueExamples: fields.mesExamples,
            jailbreak: fields.jailbreak,
        };
        for (const [id, value] of Object.entries(map)) {
            if (typeof value === 'string' && value) {
                sources[id] = `${sources[id] ?? ''}\n${value}`.trim();
            }
        }
    } catch {
        // Card fields are a bonus; a failure here must not stop a capture.
    }
    return sources;
}

/** Joins a MessageCollection (or single Message) down to plain text. */
function nodeText(node) {
    if (!node) {
        return '';
    }
    if (typeof node.flatten === 'function' && Array.isArray(node.collection)) {
        return node.flatten()
            .map(message => (typeof message?.content === 'string' ? message.content : ''))
            .filter(Boolean)
            .join('\n');
    }
    return typeof node.content === 'string' ? node.content : '';
}

/**
 * Reads the assembled chat-completion prompt back out of the prompt manager,
 * which holds the collection tree from the most recent assembly.
 */
export function readChatCompletionSections(host, promptManager) {
    const root = promptManager?.messages;
    if (!root || typeof root.getCollection !== 'function') {
        return { sections: [], tokenTable: { total: 0, perSection: {} } };
    }

    const displayCounts = displayTokenCounts(host, root);
    const handlerCounts = promptManager?.tokenHandler?.counts ?? {};
    const sections = [];
    let total = 0;

    for (const node of root.getCollection()) {
        const id = String(node?.identifier ?? '');
        if (!id) {
            continue;
        }
        const tokens = Number(
            displayCounts[id]
            ?? handlerCounts[id]
            ?? (typeof node.getTokens === 'function' ? node.getTokens() : 0),
        ) || 0;
        const content = nodeText(node);
        if (!content && !tokens) {
            continue;
        }
        sections.push({ id, label: sectionLabel(id), content, tokens });
        total += tokens;
    }

    const perSection = {};
    for (const section of sections) {
        perSection[section.id] = section.tokens;
    }
    return { sections, tokenTable: { total, perSection } };
}

/**
 * Builds the text-completion section list. The pieces arrive already separated
 * on GENERATE_BEFORE_COMBINE_PROMPTS, so each one is counted individually.
 */
export async function readTextCompletionSections(beforeCombine, finalPrompt = null) {
    if (!beforeCombine) {
        if (typeof finalPrompt === 'string') {
            const total = await countTokens(finalPrompt);
            return {
                sections: [],
                tokenTable: { total: total ?? 0, perSection: {} },
                estimated: total === null,
            };
        }
        return { sections: [], tokenTable: { total: 0, perSection: {} }, estimated: false };
    }
    const sections = [];
    let total = 0;
    let estimated = false;

    for (const key of TC_SECTION_KEYS) {
        const content = beforeCombine[key];
        if (typeof content !== 'string' || !content) {
            continue;
        }
        const counted = await countTokens(content);
        if (counted === null) {
            estimated = true;
        }
        const tokens = counted ?? Math.ceil(content.length / 4);
        sections.push({ id: key, label: sectionLabel(key), content, tokens });
        total += tokens;
    }

    const perSection = {};
    for (const section of sections) {
        perSection[section.id] = section.tokens;
    }
    let totalCounted = null;
    if (typeof finalPrompt === 'string') {
        totalCounted = await countTokens(finalPrompt);
    }
    if (totalCounted !== null) {
        total = totalCounted;
    } else {
        // Section token counts do not include the tokenizer's join/separator
        // behavior, so a summed total is explicitly an estimate.
        estimated = true;
    }
    return { sections, tokenTable: { total, perSection }, estimated };
}

/**
 * Listens for one prompt assembly. Listeners are attached only for the length
 * of a capture, so a user's own generations are never observed.
 */
export function createCaptureSession(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const source = context?.eventSource;
    const events = context?.eventTypes;
    const attached = [];

    const state = {
        started: false,
        dryRun: null,
        generateData: null,
        ccMessages: null,
        beforeCombine: null,
        combinedPrompt: null,
        useSysPrompt: null,
        useTools: null,
        prefillString: '',
        promptNames: null,
        wiPasses: [],
        cacheScope: null,
    };

    function listen(eventType, handler) {
        if (!eventType || !source) {
            return;
        }
        // makeLast so anything that rewrites the prompt has already run and the
        // Lab records what SillyBunny would really send.
        const add = typeof source.makeLast === 'function' ? source.makeLast.bind(source) : source.on.bind(source);
        add(eventType, handler);
        attached.push({ eventType, handler });
    }

    const onGenerationStarted = (_type, _options, dryRun) => {
        state.started = true;
        state.dryRun = Boolean(dryRun);
    };

    const onAfterData = (generateData, dryRun) => {
        if (dryRun !== undefined) {
            state.dryRun = Boolean(dryRun);
        }
        state.cacheScope = generateData?.cacheScope ?? null;
        if (typeof generateData?.use_sysprompt === 'boolean') {
            state.useSysPrompt = generateData.use_sysprompt;
        }
        if (typeof generateData?.use_tools === 'boolean') {
            state.useTools = generateData.use_tools;
        } else if (Array.isArray(generateData?.tools)) {
            state.useTools = generateData.tools.length > 0;
        }
        if (typeof generateData?.assistant_prefill === 'string') {
            state.prefillString = generateData.assistant_prefill;
        }
        if (generateData?.char_name || generateData?.user_name || Array.isArray(generateData?.group_names)) {
            state.promptNames = {
                charName: String(generateData.char_name ?? ''),
                userName: String(generateData.user_name ?? ''),
                groupNames: Array.isArray(generateData.group_names)
                    ? generateData.group_names.map(String)
                    : [],
            };
        }
        if (Array.isArray(generateData?.prompt)) {
            state.generateData = { messages: cloneMessages(generateData.prompt) };
        } else if (typeof generateData?.prompt === 'string') {
            state.generateData = { prompt: generateData.prompt };
        }
    };

    const onChatCompletionReady = (data) => {
        state.ccMessages = cloneMessages(data?.chat);
    };

    const onBeforeCombine = (data) => {
        // The negative-prompt pass for CFG re-emits this event with no dry-run
        // flag of its own. Only the first pass is the prompt being measured.
        if (state.beforeCombine) {
            return;
        }
        const copy = {};
        for (const [key, value] of Object.entries(data ?? {})) {
            if (typeof value === 'string') {
                copy[key] = value;
            }
        }
        state.beforeCombine = copy;
    };

    const onAfterCombine = (data) => {
        if (typeof data?.prompt === 'string' && state.combinedPrompt === null) {
            state.combinedPrompt = data.prompt;
        }
    };

    const onWorldInfoScanDone = (payload) => {
        const pass = extractWorldInfoPass(payload);
        if (pass.length) {
            state.wiPasses.push(pass);
        }
    };

    return {
        attach() {
            listen(events?.GENERATION_STARTED, onGenerationStarted);
            listen(events?.GENERATE_AFTER_DATA, onAfterData);
            listen(events?.CHAT_COMPLETION_PROMPT_READY, onChatCompletionReady);
            listen(events?.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforeCombine);
            listen(events?.GENERATE_AFTER_COMBINE_PROMPTS, onAfterCombine);
            listen(events?.WORLDINFO_SCAN_DONE, onWorldInfoScanDone);
        },
        detach() {
            while (attached.length) {
                const { eventType, handler } = attached.pop();
                source?.removeListener?.(eventType, handler);
            }
        },
        getState() {
            return state;
        },
    };
}

/**
 * Adds the test case's example message to the chat for the length of one
 * assembly, then takes it out again.
 *
 * A real send pushes the user's message into the chat before the prompt is
 * built, so lorebook scanning and history both see it. Doing the same here is
 * what makes a test faithful. A dry run never reaches the code that saves a
 * chat, so nothing is written to disk; the message is removed by identity in a
 * finally block so an error cannot leave it behind.
 */
export async function withTransientUserMessage(hostRef, messageText, run) {
    const context = ctxOf(hostRef);
    const text = String(messageText ?? '');
    if (!text || !Array.isArray(context?.chat)) {
        return run();
    }
    const entry = {
        name: context.name1 ?? 'You',
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: text,
        extra: {},
    };
    context.chat.push(entry);
    try {
        return await run();
    } finally {
        const index = context.chat.indexOf(entry);
        if (index !== -1) {
            context.chat.splice(index, 1);
        }
    }
}

/**
 * Runs one dry-run assembly and returns everything observed.
 * @returns {Promise<object>} capture result with sections, tokens and caveats.
 */
export async function captureOnce({ userMessage = '', context = getContext, host = null } = {}) {
    const hostRef = context;
    if (typeof ctxOf(hostRef)?.generate !== 'function') {
        throw new Error('Prompting Lab cannot build a prompt because SillyBunny\'s generate function is unavailable. Reload SillyBunny and try again.');
    }

    const session = createCaptureSession(hostRef);
    session.attach();
    try {
        await withTransientUserMessage(
            hostRef,
            userMessage,
            () => ctxOf(hostRef).generate('normal', {}, true),
        );
    } finally {
        session.detach();
    }

    const state = session.getState();
    const caveats = [CAVEAT.NO_INTERCEPTORS];
    // Read after assembly: a connection profile may have changed the API, and
    // the context copies mainApi by value.
    const live = ctxOf(hostRef);
    const apiType = live.mainApi === 'openai' ? 'cc' : 'tc';

    const messages = state.ccMessages ?? state.generateData?.messages ?? null;
    const combinedPrompt = state.combinedPrompt ?? state.generateData?.prompt ?? null;

    let sections = [];
    let tokenTable = { total: 0, perSection: {} };

    if (apiType === 'cc') {
        const read = readChatCompletionSections(host, live.promptManager);
        sections = read.sections;
        tokenTable = read.tokenTable;
    } else {
        const read = await readTextCompletionSections(state.beforeCombine, combinedPrompt);
        sections = read.sections;
        tokenTable = read.tokenTable;
        if (read.estimated) {
            caveats.push(CAVEAT.TOKENIZER_FALLBACK);
        }
    }

    if (!messages && !combinedPrompt) {
        throw new Error('Prompting Lab did not receive a prompt from SillyBunny. Check that a character is selected and that the connection settings are complete.');
    }

    return {
        apiType,
        messages,
        combinedPrompt,
        sections,
        tokenTable,
        wiPasses: state.wiPasses,
        cacheScope: state.cacheScope,
        useSysPrompt: state.useSysPrompt,
        useTools: state.useTools,
        prefillString: state.prefillString,
        promptNames: state.promptNames,
        sourceTexts: collectSourceTexts(live),
        caveats,
    };
}
