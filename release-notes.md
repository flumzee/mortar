Mortar now runs on macOS and Linux, not just Windows.

## What's new

- **macOS and Linux builds.** Every platform is built and published together
  from now on.
- **Folders in the sidebar.** Make a folder from the `+` on the recent header,
  drag chats in and out, pin the ones you use most. Deleting a folder never
  deletes the chats inside.
- **Cleaner lookups.** When Claude reads through your place it now shows one
  compact line per lookup instead of a stack of expandable panels.
- **Stays on Roblox.** Ask for a leaderboard and you get a Roblox leaderboard.
  Previously it could wander off and build you a web page.

## Download

**Windows**
Mortar-Setup-1.0.1.exe to install, or Mortar-1.0.1-portable.exe to just run it.

**macOS**
Mortar-1.0.1-arm64.dmg for Apple Silicon, Mortar-1.0.1-x64.dmg for Intel.

**Linux**
Mortar-1.0.1-portable.AppImage, or Mortar-1.0.1-amd64.deb for Debian and
Ubuntu. The AppImage needs `chmod +x` before it will run.

## The builds are not code signed

Signing certificates cost money, so expect your OS to complain the first time.

On **Windows**, click More info then Run anyway.

On **macOS**, the app is blocked on first launch. Open Terminal and run:

```
xattr -dr com.apple.quarantine /Applications/Mortar.app
```

Then open it normally.

## Before it will work

- [Node.js](https://nodejs.org) has to be installed. Mortar uses it to launch
  the Studio connector, so nothing connects without it.
- A Claude Pro or Max subscription, or an Anthropic API account.

Type `/login` to sign in, pick your project folder, and open Roblox Studio.
Both dots in the bottom left go green when you are ready.

## Studio plugin

You do not need to install anything. Mortar sets up the Studio plugin on first
run and keeps it current on its own. Plugins only load when Studio starts, so
restart Studio if it never connects.

Failing that, download
[MCPPlugin.rbxmx](https://github.com/chrrxs/robloxstudio-mcp/releases/latest/download/MCPPlugin.rbxmx)
and drop it in your Roblox Plugins folder.

## Notes

The macOS and Linux builds are new and have had far less real use than the
Windows one. If something is broken on your platform, please open an issue.

Full setup guide is in the [README](https://github.com/flumzee/mortar#readme).
The Studio connector is
[robloxstudio-mcp](https://github.com/chrrxs/robloxstudio-mcp) by chrrxs.
