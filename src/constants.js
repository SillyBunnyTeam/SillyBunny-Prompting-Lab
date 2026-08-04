export const EXTENSION_NAME = 'SillyBunny-Prompting-Lab';
export const EXTENSION_LABEL = 'Prompting Lab';
export const SETTINGS_KEY = 'SillyBunnyPromptingLab';
export const EMBED_KEY = 'SillyBunnyPromptingLab';
export const DB_NAME = 'SillyBunnyPromptingLab';

export const EXPORT_FORMAT = 'sillybunny-prompting-lab';
export const EXPORT_VERSION = 2;

export const SETTINGS_VERSION = 1;
export const CASE_VERSION = 2;
export const DRAFT_VERSION = 1;
export const PROMPT_DRAFT_VERSION = 1;
export const SUITE_VERSION = 1;
export const RUN_VERSION = 1;
export const EMBED_VERSION = 1;

export const STORE_PREFIX = Object.freeze({
    SUITE: 'suite:',
    CASE: 'case:',
    RUN: 'run:',
    DRAFT: 'draft:',
    PROMPT: 'prompt:',
});

export const INDEX_KEY = Object.freeze({
    SUITES: 'index:suites',
    CASES: 'index:cases',
    RUNS: 'index:runs:',
    DRAFTS: 'index:drafts',
    PROMPTS: 'index:prompts',
});

/** Status of a single case within a run. */
export const STATUS = Object.freeze({
    PASS: 'pass',
    CHANGED: 'changed',
    FAIL: 'fail',
    ERROR: 'error',
    SKIPPED: 'skipped',
});

export const STATUS_LABEL = Object.freeze({
    [STATUS.PASS]: 'Passed',
    [STATUS.CHANGED]: 'Changed',
    [STATUS.FAIL]: 'Failed',
    [STATUS.ERROR]: 'Could not run',
    [STATUS.SKIPPED]: 'Skipped',
});

export const SECTION_LABEL = Object.freeze({
    worldInfoBefore: 'World Info (before character)',
    main: 'Main prompt',
    worldInfoAfter: 'World Info (after character)',
    charDescription: 'Character description',
    charPersonality: 'Character personality',
    scenario: 'Scenario',
    personaDescription: 'Persona description',
    controlPrompts: 'Control prompts',
    nsfw: 'Auxiliary prompt',
    jailbreak: 'Post-history instructions',
    enhanceDefinitions: 'Enhance definitions',
    bias: 'Bias',
    dialogueExamples: 'Example messages',
    chatHistory: 'Chat history',
    continueNudge: 'Continue nudge',
    sillybunnyRuntimeAgents: 'In-chat agents',
    storyString: 'Story string',
    mesExmString: 'Example messages',
    mesSendString: 'Chat history',
    finalMesSend: 'Chat history (final)',
    worldInfoString: 'World Info',
    description: 'Character description',
    personality: 'Character personality',
    persona: 'Persona description',
    naiPreamble: 'NovelAI preamble',
});

/** Assertion type identifiers. */
export const ASSERTION = Object.freeze({
    SECTION_PRESENT: 'section-present',
    SECTION_ABSENT: 'section-absent',
    SECTION_UNIQUE: 'section-unique',
    TOKEN_CEILING: 'token-ceiling',
    CONTENT_MATCH: 'content-match',
    WI_ACTIVATED: 'wi-activated',
    CACHE_PREFIX_STABLE: 'cache-prefix-stable',
});

export const ASSERTION_LABEL = Object.freeze({
    [ASSERTION.SECTION_PRESENT]: 'Section is present',
    [ASSERTION.SECTION_ABSENT]: 'Section is absent',
    [ASSERTION.SECTION_UNIQUE]: 'Section appears only once',
    [ASSERTION.TOKEN_CEILING]: 'Stays under a token limit',
    [ASSERTION.CONTENT_MATCH]: 'Text appears in the prompt',
    [ASSERTION.WI_ACTIVATED]: 'Lorebook entry activates',
    [ASSERTION.CACHE_PREFIX_STABLE]: 'Cached part of the prompt is stable',
});

/**
 * Caveats recorded on every run. A dry run cannot reproduce every step of a
 * real send, and the differences are surfaced rather than hidden.
 */
export const CAVEAT = Object.freeze({
    NO_INTERCEPTORS: 'no-interceptors',
    NO_SQUASH_LIVE: 'no-squash-live',
    PROMPT_TAGS_MISSING: 'prompt-tags-missing',
    CACHE_DEPTH_UNKNOWN: 'cache-depth-unknown',
    CACHE_BOUNDARY_PREDICTED: 'cache-boundary-predicted',
    TOKENIZER_FALLBACK: 'tokenizer-fallback',
});

export const CAVEAT_TEXT = Object.freeze({
    [CAVEAT.NO_INTERCEPTORS]: 'Extensions that rewrite chat history before sending, such as vector storage and summaries, do not run during a test. A real reply may include content this test does not show.',
    [CAVEAT.NO_SQUASH_LIVE]: 'Your setup merges consecutive system messages when sending. This analysis models that grouping itself rather than observing a real send, so message grouping may differ slightly.',
    [CAVEAT.PROMPT_TAGS_MISSING]: 'This test pins a Prompt Tags profile, but the Prompt Tags extension is not installed or enabled.',
    [CAVEAT.CACHE_DEPTH_UNKNOWN]: 'The prompt caching depth is unknown, so cache checks were skipped. Set it in Prompting Lab settings.',
    [CAVEAT.CACHE_BOUNDARY_PREDICTED]: 'Cache boundaries are predictions inferred from the captured prompt. The server does not report the actual boundary; this analysis follows Claude-style caching.',
    [CAVEAT.TOKENIZER_FALLBACK]: 'Token counts are estimates because the tokenizer was unavailable.',
});

export const TAB = Object.freeze({
    CASES: 'cases',
    PRESETS: 'presets',
    PROMPTS: 'prompts',
    RUN: 'run',
    DIFF: 'diff',
    EXPERIMENT: 'experiment',
    AB: 'ab',
    SETTINGS: 'settings',
});

export const TAB_LABEL = Object.freeze({
    [TAB.CASES]: 'Tests',
    [TAB.PRESETS]: 'Presets',
    [TAB.PROMPTS]: 'Prompts',
    [TAB.RUN]: 'Run tests',
    [TAB.DIFF]: 'Compare runs',
    [TAB.EXPERIMENT]: 'Compare prompts',
    [TAB.AB]: 'Compare models',
    [TAB.SETTINGS]: 'Settings',
});

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_VERSION,
    lastTab: TAB.CASES,
    manualCachingAtDepth: null,
    runRetention: 20,
    abMaxTokens: 300,
    normalizeVolatile: true,
    dismissedWarnings: Object.freeze({}),
});

/** Regex input is untrusted; short catastrophic patterns can still backtrack. */
export const MAX_REGEX_LENGTH = 512;

export const MAX_EXPORT_BYTES = 1024 * 1024;
export const MAX_EXPORT_WITH_BASELINES_BYTES = 10 * 1024 * 1024;
