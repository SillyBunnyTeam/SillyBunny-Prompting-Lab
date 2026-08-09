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

Prompt tests do not send messages or use tokens. **Compare prompts**, **Compare models** and
**Compare scenes** are the only tabs that send a prompt and use tokens, and they do nothing until
you press their buttons.

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

## The workspace

Opened as a full page, the lab lays itself out as a workbench. The sections are
listed down the left under **Build**, **Run**, **Compare** and **Set up**, each
with a line saying what it is for, and the two sections that spend tokens are
marked as such before you open them. The rest of the window is one work
surface, with a heading that repeats what the section does and what it costs to
use. At the foot of the list is a count of what this workspace holds: suites,
test cases, checks, saved runs, preset drafts and prompts.

On a wide screen the lists and the editor sit next to each other, so opening a
test case or a preset does not push the list you picked it from off the screen.
The same lab in the Extensions drawer keeps its compact row of tabs instead.

## The nine tabs

### Tests

A test case is one character and its prompt settings. A suite is a group of test cases that run
together. Every setting is chosen from what you actually have installed, so a test cannot name a
character or preset that is not there.

Characters are chosen from a list of faces with a search box, the same picker Chats Archive uses,
rather than a long dropdown of names: type a few letters to narrow it, or walk the list with the
arrow keys. A test case pinning a character you have since deleted says so instead of looking
blank. The same picker chooses the character card on Compare prompts and Compare scenes, and saved
test cases, the run queue and the results all show the face beside the name.

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
that running would discard. It also lists the suite itself, case by case, with the character each
one uses, how many checks it carries, and whether it has a baseline to be compared against yet.

While a suite runs, your character, persona, preset, and connection profile are changed to match
each test case. They are put back when the run finishes, when you stop it, and when something goes
wrong.

### Compare runs

Shows what changed between two runs of the same test case, section by section, with the token cost
of each change. Parts that change on every build, such as a dice roll or a timestamp, are hidden by
default so a real change stands out; there is a switch to show them.

If the two runs were made with different settings, such as a different model or a changed macro
pack, that is listed above the differences.

It can also make the two runs for you. Choose a test case, pick a preset and a connection for
**Setup A** and another for **Setup B**, and the same test case is built once under each. The
character, persona, example message and checks stay as the test case has them, so the setup is the
only difference between the two prompts, and the comparison opens on the pair as soon as they are
built. This is how to answer "what does this scenario look like under preset 1 against preset 2",
or under two different models, without editing the test case. Nothing is sent, so it costs no
tokens.

A test case that pins Text Completion presets swaps only the kind it pins first; the other four
templates stay as the test case has them.

### Compare prompts

Tests a prompt against a modified version of it. Both versions are sent through the same
connection, with the same character card and the same test message, so the prompt text is the only
difference between the two requests. The replies come back side by side. Prompts can be typed in
directly or loaded from the drafts kept on the Prompts tab.

When the card has more than one greeting, **Opening** chooses which one both requests carry, and a
preview shows it and your test message with the faces of the character and your persona.

After the replies arrive, an optional analysis can be requested: a model of your choosing is shown
both prompts and both replies and asked what changed between the prompts and what the replies show.
The analysis is a reading aid, not a verdict, and it is only fetched when you ask for it.

Along with Compare models, this tab uses tokens. Nothing is added to any chat, and the connection
you are using does not change.

### Compare models

Sends a saved prompt to two connections and shows both replies next to each other. Nothing is added
to any chat, and the connection you are using does not change.

### Compare scenes

Plays the same scene under several presets and shows what each one wrote, side by side. Choose a
character, a persona, a connection, and two to four presets, then write the scene: either the turns
you want sent, or one opening message and how many exchanges to let it run for.

If the card carries more than one greeting, **Opening** says which one starts the scene, so every
preset answers the same first message. Cards often have several, and the choice is listed with
enough of each to tell them apart; **No opening** starts at your own first turn instead. Above the
button, a preview shows the scene as it will be sent, with the character's and the persona's faces
beside what each of them says.

Each preset gets its own column. Within a column, the prompt is rebuilt the way SillyBunny would
with everything said so far already in the chat, sent, and the reply becomes part of the scene
before the next turn is built. Scripted turns mean every preset faces the same words; letting it run
shows how a preset carries a scene on its own, and from the second turn each column is answering its
own replies rather than the same input.

Replies arrive as they are written, so a column fills in while you watch rather than appearing at
the end, and each turn says how long it took, in seconds or minutes, next to what its prompt cost in
tokens. That matters with a reasoning model, which can spend a long time thinking before the first
word appears.

If a connection fails or a reply comes back empty, that column stops there and offers **Try this
preset again**, which replays the scene for that preset alone from the first turn. The other columns
are left as they are.

When the run finishes, **Save as Markdown**, **Save as text** and **Save as web page** write the
whole comparison to a file: every preset, every turn, what was said and what came back, how long
each reply took, and any failures, exactly as shown.

Save as web page is the one to use when replies carry markup of their own, such as a tracker or a
styled card: the saved page renders it instead of showing the tags. That markup was written by a
model, so scripts, frames and event handlers are removed, and the page itself blocks anything it
would have to fetch, including remote images. A reply that styles itself may still colour the page
around it. The file stands on its own and can be opened anywhere.

Before you press the button it says how many requests that will be and roughly how many reply tokens
they may use. Nothing is added to any chat: the turns are put into the chat in memory only for as
long as it takes to build the prompt. Your character, persona, preset and connection change while it
runs and are put back afterwards, including when you stop it or when a reply fails.

The character's open chat is part of every prompt built, underneath the opening chosen here. When
that chat already has messages in it, the results say so; start a new chat in SillyBunny for a scene
that begins where you think it does.

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
