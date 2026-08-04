# SillyBunny Prompting Lab

**Check whether a change to your settings quietly changed the prompts your characters produce.**

Prompting Lab saves a test case for a character: which persona, preset, and connection profile it
uses, an example message, and what you expect the prompt to contain. When you run the test, it
rebuilds the whole prompt exactly as SillyBunny would before sending it, and shows you what came
out, section by section, with token counts.

Save a result as a baseline. Later, after you edit a preset, install an extension, or update
SillyBunny, run the same tests again and see what changed.

It can help when:

- You edited a preset and want to know which of your characters it affected.
- A character stopped behaving the way it used to and you cannot see why.
- You want to know which part of your prompt is using all the tokens.
- You want to know whether a macro is breaking prompt caching and costing you money.
- You maintain cards or presets for other people and want to check them before release.

Running a test does not send a message and does not spend tokens. The only exception is the
side-by-side comparison, which you have to ask for explicitly.

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
2. SillyBunny opens **Extensions** and expands the Prompting Lab drawer.
3. On **Test cases**, create a case and choose a character.
4. Open **Run** and run it.
5. Look at the sections and token counts that come back.
6. Choose **Set as baseline** so future runs have something to compare against.

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
