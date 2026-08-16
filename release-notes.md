First release.

Mortar lets Claude build things in your Roblox place. You describe what you
want, and it writes the scripts, edits the properties, runs playtests, and
takes screenshots so it can see what it just did.

## Download

**Mortar Setup 1.0.0.exe** installs it with a Start Menu entry.
**Mortar-1.0.0-portable.exe** just runs, no install.

Windows 10 or 11, 64 bit.

Windows will show a blue "Windows protected your PC" box the first time,
because the app is not code signed. Click **More info**, then **Run anyway**.

## Before it will work

- [Node.js](https://nodejs.org) has to be installed. Mortar uses it to launch
  the Studio connector, so nothing connects without it.
- A Claude Pro or Max subscription, or an Anthropic API account.

## Getting started

1. Type `/login` and sign in.
2. Pick your project folder, top left.
3. Open Roblox Studio with your place loaded.

Both dots in the bottom left go green when you are ready. The Studio one takes
ten or fifteen seconds.

## About the Studio plugin

You do not need to install anything. Mortar sets up the Studio plugin on first
run and keeps it up to date on its own.

If Studio never connects, restart Studio once, since plugins only load at
startup. If it still will not connect, you can install the plugin by hand:
download
[MCPPlugin.rbxmx](https://github.com/chrrxs/robloxstudio-mcp/releases/latest/download/MCPPlugin.rbxmx),
drop it in `%LOCALAPPDATA%\Roblox\Plugins\`, and restart Studio.

## Notes

Your conversations are stored by Claude Code rather than by this app, so
anything you start in the terminal shows up here, and the other way round.

Full setup guide and troubleshooting are in the
[README](https://github.com/flumzee/mortar#readme).

The Studio connector is
[robloxstudio-mcp](https://github.com/chrrxs/robloxstudio-mcp) by chrrxs.
