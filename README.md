# SillyBunny Prompting Lab

**Check whether a change to your settings quietly changed the prompts your characters produce.**

Prompting Lab saves a test case for a character: which persona, preset, and connection profile it
uses, an example message, and what you expect the prompt to contain. When you run the test, it
rebuilds the whole prompt exactly as SillyBunny would before sending it, and shows you what came
out, section by section, with token counts.

Save a run as a baseline. Later, after you edit a preset, install an extension, or update
SillyBunny, run the same tests again and see what changed.

It can help when:

- You edited a preset and want to know which of your characters it affected.
- A character stopped behaving the way it used to and you cannot see why.
- You want to know which part of your prompt is using all the tokens.
- You want to know whether a macro is breaking prompt caching and costing you money.
- You maintain cards or presets for other people and want to check them before release.

Prompt tests do not send messages or use tokens. **Compare prompts** and **Compare models** are the
only tabs that send a prompt and use tokens, and they do nothing until you press their buttons.

## Install

Prompting Lab requires SillyBunny 1.7.0 or newer.

1. Open **Extensions** in SillyBunny.
2. Choose **Install Extension**.
3. Paste this URL:

```text
https://github.com/SillyBunnyTeam/SillyBunny-Prompting-Lab
```

4. Finish the installation and reload SillyBunny.

No server plugin or build step is needed.

## First test

1. Open the wand menu and choose **Prompting Lab**. The lab opens as a workspace covering the
   whole page. Close it with **Close workspace** or Escape; the same lab also lives in the
   Prompting Lab drawer under **Extensions**, with an **Open as full page** button to get back.
2. On **Tests**, create a suite, then add a test case and choose a character.
3. Open **Run tests** and run the suite.
4. Look at the sections and token counts that come back.
5. Choose **Set passing runs as baselines** so future runs have something to compare against.

## What a run tells you

- **Passed** means every check passed and nothing differs from your baseline.
- **Changed** means the checks still pass, but the prompt is not the same as your baseline. This is
  the state worth looking at after you edit a preset.
- **Failed** means one of your checks did not pass.
- **Could not run** means something went wrong before a prompt could be built, such as a missing
  character.

Each run also lists what a test cannot reproduce. A test build skips extensions that rewrite chat
history at the last moment, such as vector storage and summaries, so a real reply may contain
content a test does not show. These notes appear on the run itself rather than in the manual.

## The eight tabs

### Tests

A test case is one character and its prompt settings. A suite is a group of test cases that run
together. Every setting is chosen from what you actually have installed, so a test cannot name a
character or preset that is not there.

A test case can pin a Chat Completion preset, or any of the five Text Completion pieces: the
sampler preset, the context template, the instruct template, the system prompt, and the reasoning
template. It cannot pin both kinds at once, because only one of them builds the prompt.

The search box filters by name, note, tag, character, or preset. Cases can be duplicated, tagged or
deleted in bulk, and run one at a time. **Generate combinations** builds one case per character and
preset pairing, so a whole matrix can be made in one step.

Each test case can carry checks:

- a prompt section is present, absent, or appears only once
- the prompt stays under a token limit
- some text does or does not appear
- a lorebook entry does or does not activate
- the cached part of the prompt stays the same between runs

A check that cannot be made, such as a lorebook check on a run with no lorebook activity, is
reported as unchecked rather than counted as a pass or a failure.

### Presets

A workshop for the presets your tests use. It lists what SillyBunny has installed and the drafts
you are working on.

Installed presets are read only. Copy one into a draft, or start a draft from nothing, and edit it
without touching the preset you rely on. A Chat Completion draft shows its prompt modules: you can
turn one off, move it, change its role or text, add or duplicate one, and see what each costs in
tokens. The Text Completion kinds get the fields that matter to them. Every setting a preset holds,
including the ones without their own control, can be edited as text.

Single prompts can travel between presets. **Copy** on any module, including one browsed from an
installed preset, holds it on a clipboard inside the lab; **Paste** adds it to the draft being
edited. A pasted module always gets a fresh identity, so pasting can never overwrite what a preset
already has. **To Prompts tab** saves a module into the Prompts space instead.

When a draft is ready, **Publish to SillyBunny** saves it as a new preset. It never overwrites,
renames, or deletes an installed preset, and it never changes the preset you have selected. Renaming
and deleting installed presets stays in SillyBunny's own preset menu. SillyBunny reads its preset
lists while starting, so the workshop offers a reload when you publish.

A draft says so when the preset it was copied from has changed or been uninstalled since.

### Prompts

A space for prompts on their own, outside any preset. Each prompt has a title, a role, and as many
draft versions of its text as you like; one version is marked as selected. Keep a careful version
and an experimental version side by side, and switch which one is selected without losing either.

The selected draft is what leaves this tab: **Send to a preset** adds it as a new module at the end
of a Chat Completion draft in the workshop, and **Copy for pasting** puts it on the lab clipboard
for the Presets tab. Prompt drafts are also what **Compare prompts** offers to load, so the drafts
you keep here are the variants you can test.

### Run tests

Runs a whole suite, one test case at a time. Before it starts it tells you what will happen: which
cases cannot run, which characters have no chat yet, and whether you have unsaved preset changes
that running would discard.

While a suite runs, your character, persona, preset, and connection profile are changed to match
each test case. They are put back when the run finishes, when you stop it, and when something goes
wrong.

### Compare runs

Shows what changed between two runs of the same test case, section by section, with the token cost
of each change. Parts that change on every build, such as a dice roll or a timestamp, are hidden by
default so a real change stands out; there is a switch to show them.

If the two runs were made with different settings, such as a different model or a changed macro
pack, that is listed above the differences.

### Compare prompts

Tests a prompt against a modified version of it. Both versions are sent through the same
connection, with the same character card and the same test message, so the prompt text is the only
difference between the two requests. The replies come back side by side. Prompts can be typed in
directly or loaded from the drafts kept on the Prompts tab.

After the replies arrive, an optional analysis can be requested: a model of your choosing is shown
both prompts and both replies and asked what changed between the prompts and what the replies show.
The analysis is a reading aid, not a verdict, and it is only fetched when you ask for it.

Along with Compare models, this tab uses tokens. Nothing is added to any chat, and the connection
you are using does not change.

### Compare models

Sends a saved prompt to two connections and shows both replies next to each other. Nothing is added
to any chat, and the connection you are using does not change.

### Settings

How many runs to keep per test case, the prompt caching depth, exporting and importing suites,
and saving test cases inside a character card.

## Sharing tests

Export a suite to a file to move it to another installation or send it to someone else. You can
export with or without baseline runs, and with or without the presets the tests use.

Preset settings that describe where your requests go, such as a proxy address or a password, are
left out unless you tick them yourself. Imported presets arrive as drafts on the Presets tab, so
nothing is installed behind your back.

Test cases can also be saved inside a character card, so they travel with the card. Only the test
definitions are stored, never runs, and Prompting Lab tells you what will travel before it
saves. Settings that only mean something on your own machine, the connection profile and the
persona, are left behind.

## Prompt caching

The cache check needs to know the caching depth your server uses. Only an administrator can read
that value, so you enter it in Settings. Leave it empty and the caching checks are skipped rather
than guessed.

With it set, Prompting Lab works out which part of your prompt gets cached and warns you when
something inside that part changes on every build, which stops caching from working and costs you
money. Where it can, it names the macro responsible.

## Development

```sh
npm ci
npm test
npm run test:browser
```

Set `SILLYBUNNY_ROOT` to check the extension against a different SillyBunny checkout:

```sh
SILLYBUNNY_ROOT=/path/to/SillyBunny npm run test:host
```

`npm run test:host` verifies that this SillyBunny build still provides everything Prompting Lab
reads. Run it after a SillyBunny update.

## License

AGPL-3.0.

Includes a copy of the macro volatility classifier from
[SillyBunny-MacroEnhanced](https://github.com/SillyBunnyTeam/SillyBunny-MacroEnhanced), also
AGPL-3.0.
