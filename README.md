# mortar

A desktop app that lets Claude build things in Roblox Studio for you.

You describe what you want in plain English, and Claude works directly against
your open place: writing scripts, editing properties, moving parts, running
playtests, and taking screenshots so it can see what it just did.

It is Claude Code, but as a real app instead of a terminal window.

Not affiliated with Anthropic or Roblox. Claude and Roblox are trademarks of
their respective owners.

## What you need

- **Windows 10 or 11** (64 bit)
- **Roblox Studio**
- **Node.js**, from [nodejs.org](https://nodejs.org). Mortar uses it to launch
  the Studio connector, so it has to be installed or nothing will connect.
- **A Claude subscription** (Pro or Max), or an Anthropic API account

## Installing

Grab the latest build from the
[releases page](https://github.com/flumzee/mortar/releases):

- **Mortar Setup 1.0.0.exe** installs it properly with a Start Menu entry
- **Mortar-1.0.0-portable.exe** just runs, no install

Windows will probably show a blue "Windows protected your PC" box the first
time, because the app is not code signed (that costs money). Click **More
info**, then **Run anyway**.

## First run

Three things to do, once.

**1. Sign in.** Type `/login` in the message box and press enter. A browser tab
opens for you to approve it, then you paste the code it gives you back into
mortar. The bottom left corner will show your email with a green dot when it
worked.

**2. Pick your project folder.** Top left, under "project". Choose the folder
where your game's code lives. This is where Claude reads and writes files, and
it decides which past chats show up in the sidebar.

**3. Open Roblox Studio.** Mortar installs its Studio plugin automatically the
first time it runs. Open Studio with your place loaded, and watch the bottom
left of mortar until it says **studio: connected**. This takes ten or fifteen
seconds. If the plugin was just installed, restart Studio once.

You are ready when both dots down there are green.

## Making your first change

Open your place in Studio, then type something like:

> add a red neon part called Beacon above the spawn, and make it pulse

Claude will look at your place, make the change, and usually take a screenshot
so you can both see the result. The part appears in Studio while you watch.

Some things worth trying:

> why does my sprint script break when the player respawns?

> read every script in ServerScriptService and tell me what this game does

> playtest it, take a screenshot, and tell me if the ui overlaps on mobile

> make the lobby music fade out when the round starts

You can talk to it like a person. If it does the wrong thing, just say so and
it will fix it.

## The three buttons up top

**Model** picks which Claude you are talking to. The default is whatever your
account normally uses, which is usually right.

**Effort** is how hard it thinks before answering.

| Setting | When to use it |
| --- | --- |
| low | small scoped edits, fastest |
| medium | routine work |
| high | the sensible default for real work |
| extra high | gnarly bugs, long jobs |
| max | correctness over everything, and slow |

Higher effort costs more and takes longer. High is a good place to live.

**Permissions** is how much Claude can do without stopping to ask you.

| Setting | What happens |
| --- | --- |
| plan only | thinks and explains, changes nothing |
| ask first | asks before edits and commands (the sane default) |
| auto-accept edits | edits go through, commands still ask |
| allow everything | no prompts at all |

Start on **ask first**. Move up to **auto-accept edits** once you trust what it
is doing and the asking gets annoying. "Allow everything" is shown in red on
purpose, so treat that as what it says on the tin.

Use **plan only** when you want advice without anything being touched.

## Chats

Every chat in the sidebar is a real conversation with its full history. Click
one to pick up exactly where you left off.

- **New chat**: the button up top, or `Ctrl+N`
- **Search**: `Ctrl+K`, then type
- **Rename, pin, or delete**: right click any chat, or use its `⋯` button

Pinned chats stay at the top in their own section.

These are the same conversations Claude Code uses in the terminal, so anything
you started there shows up here too, and the other way round.

## Sending files and screenshots

Three ways to attach something:

- **Paste it.** Copy a file in File Explorer and press `Ctrl+V`. Screenshots
  paste in too.
- **Drag it** onto the window.
- **Click the paperclip** in the message box.

Up to 400 MB per file. Small images Claude looks at directly. Bigger images and
every other kind of file it opens and reads from disk instead, so a 200 MB place
file or a folder of logs works fine.

When Claude takes a screenshot or runs a playtest, the picture appears right in
the conversation. Click it for a bigger view, arrow keys to page through
several, and there is a save button if you want to keep one.

## Slash commands

Type `/` in the message box and a list appears. Keep typing to filter it.

`/login` and `/logout` handle your account. Everything else comes from Claude
Code itself, so if you have your own commands or skills set up, they show up
here automatically.

## Keyboard shortcuts

| Key | What it does |
| --- | --- |
| `Ctrl+N` | New chat |
| `Ctrl+K` | Search your chats |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `/` | Slash commands |
| `←` `→` | Page through screenshots |
| `Esc` | Close whatever is open |

## When something goes wrong

**Stuck on "studio: connecting"?** Give it a minute the first time, it may be
downloading the connector. If it stays stuck, make sure Studio is actually open
with a place loaded, and check that Node.js is installed by running `node -v` in
a terminal. Restarting Studio once fixes most plugin problems.

**Says "signed out" or chats fail?** Type `/login` and sign in again.

If you want a login that never expires, click the account row in the bottom left
and choose **use a long-lived token**. It tells you the one command to run, and
after that mortar stops asking.

**Something else broke?** Click the account row, or check the log at
`%APPDATA%\mortar\logs\main.log`. If you report a problem, that file is the
useful thing to include.

## Where your stuff lives

| What | Where |
| --- | --- |
| Settings | `%APPDATA%\mortar\settings.json` |
| Log | `%APPDATA%\mortar\logs\main.log` |
| Conversations | `~\.claude\projects\` |

Your conversations are stored by Claude Code, not by this app, which is why they
are shared with the terminal.

## Building it yourself

```bash
npm install
npm start           # run it
npm run dist        # build the installer into dist/
```

## License

MIT. Do what you like with it.
