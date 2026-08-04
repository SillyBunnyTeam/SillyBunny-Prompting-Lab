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

Prompt tests do not send messages or use tokens. **Compare models** is the only tab that sends a
prompt and uses tokens, and it does nothing until you choose **Get both replies**.

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

1. Open the wand menu and choose **Prompting Lab**.
2. SillyBunny opens **Extensions**, expands the Prompting Lab drawer, and shows the lab.
3. On **Tests**, create a suite, then add a test case and choose a character.
4. Open **Run tests** and run the suite.
5. Look at the sections and token counts that come back.
6. Choose **Set passing runs as baselines** so future runs have something to compare against.

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

## The five tabs

### Tests

A test case is one character and its prompt settings. A suite is a group of test cases that run
together. Every setting is chosen from what you actually have installed, so a test cannot name a
character or preset that is not there.

Each test case can carry checks:

- a prompt section is present, absent, or appears only once
- the prompt stays under a token limit
- some text does or does not appear
- a lorebook entry does or does not activate
- the cached part of the prompt stays the same between runs

A check that cannot be made, such as a lorebook check on a run with no lorebook activity, is
reported as unchecked rather than counted as a pass or a failure.

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

### Compare models

Sends a saved prompt to two connections and shows both replies next to each other. This is the only
part of Prompting Lab that uses tokens. Nothing is added to any chat, and the connection you are
using does not change.

### Settings

How many runs to keep per test case, the prompt caching depth, exporting and importing suites,
and saving test cases inside a character card.

## Sharing tests

Export a suite to a file to move it to another installation or send it to someone else. You can
export with or without baseline runs.

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
