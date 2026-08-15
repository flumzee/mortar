import { app, BrowserWindow, ipcMain, dialog, screen, shell } from "electron";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { ChatHub, MCP_PACKAGE, getMcpVersion, setCliExecutable, setMcpVersion } from "./agent.js";
import { AuthStatus, Logout, StartLogin, setAuthCli, setAuthToken } from "./auth.js";
import { ResolveClipboardFiles } from "./clipboard.js";
import {
  MAX_ATTACHMENT_BYTES,
  describeAttachments,
  formatBytes,
  guessMimeType,
  prepareAttachments,
} from "./attachments.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 580;
const TITLEBAR_HEIGHT = 40;
const DEFAULT_WINDOW = { width: 1180, height: 780 };
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const REGISTRY_TIMEOUT_MS = 5000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Credentials are refreshed by the CLI whenever it runs, so a session left open
// for days is exactly the one that goes stale. Touching auth on this cadence
// keeps the refresh cycle turning without waiting for a turn to fail.
const AUTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Two copies would fight over settings.json and each spawn their own CLI and
// MCP server against the same transcripts.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let saveWindowTimer = null;
let settings = { projectDir: app.getPath("home"), pinned: [], window: null };

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const attachmentsDir = () => path.join(app.getPath("userData"), "attachments");
const logPath = () => path.join(app.getPath("userData"), "logs", "main.log");

let logChain = Promise.resolve();

/**
 * A packaged app has no terminal to print to, so anything worth diagnosing has
 * to survive on disk. Kept to one rotated file so it cannot grow forever.
 */
function log(level, ...parts) {
  const message = parts
    .map((part) => (typeof part === "string" ? part : formatForLog(part)))
    .join(" ");
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;

  if (process.env.HUB_DEBUG) process.stdout.write(line);
  logChain = logChain.then(() => writeLogLine(line)).catch(() => {});
}

function formatForLog(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function writeLogLine(line) {
  const file = logPath();
  await mkdir(path.dirname(file), { recursive: true });

  try {
    const info = await stat(file);
    if (info.size > LOG_MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    // No log yet, or the rotation target is locked. Either way, just append.
  }

  await appendFile(file, line, "utf8");
}

/**
 * The async chain above does not survive process exit, so anything logged on
 * the way out has to go straight to disk or it is simply lost.
 */
function logSync(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  if (process.env.HUB_DEBUG) process.stdout.write(line);

  try {
    mkdirSync(path.dirname(logPath()), { recursive: true });
    appendFileSync(logPath(), line, "utf8");
  } catch {
    // Nothing useful left to do if the log itself cannot be written.
  }
}

process.on("uncaughtException", (err) => log("fatal", "uncaught exception", err));
process.on("unhandledRejection", (reason) => log("fatal", "unhandled rejection", reason));

async function loadSettings() {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    // First run — defaults stand.
  }
}

async function saveSettings() {
  try {
    await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    console.error("Could not persist settings:", err.message);
  }
}

/**
 * The CLI ships as a sibling package holding a real .exe. Inside an asar the
 * SDK's own resolution yields a virtual path that passes existsSync and then
 * fails to launch, so point it at the unpacked copy instead.
 */
function resolveCliExecutable() {
  const binaryPackage = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "claude.exe" : "claude";

  // Built from resourcesPath rather than require.resolve: the SDK's exports map
  // does not expose ./package.json, so resolving through Node throws.
  const roots = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
        path.join(process.resourcesPath, "app", "node_modules"),
      ]
    : [path.join(DIR, "..", "node_modules")];

  for (const root of roots) {
    const candidate = path.join(root, "@anthropic-ai", binaryPackage, executable);
    if (existsSync(candidate)) return candidate;
  }

  log("warn", `no ${binaryPackage} binary found under ${roots.join(", ")}`);
  return null;
}

/**
 * Resolves the newest published MCP server. The /latest endpoint returns a
 * single manifest (~2KB) and rejects the abbreviated packument media type with
 * a 406, so this asks for plain JSON.
 */
async function fetchLatestMcpVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);

  try {
    const response = await fetch(`https://registry.npmjs.org/${MCP_PACKAGE}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`registry responded ${response.status}`);

    const body = await response.json();
    return typeof body?.version === "string" ? body.version : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chats already running keep the server they spawned with; the new version
 * takes effect for the next one, which avoids yanking a live Studio connection.
 */
async function refreshMcpVersion() {
  let latest = null;

  try {
    latest = await fetchLatestMcpVersion();
  } catch (err) {
    log("warn", `could not check ${MCP_PACKAGE} for updates, staying on ${getMcpVersion()}`, err);
    return;
  }

  if (!latest || latest === getMcpVersion()) return;

  log("info", `${MCP_PACKAGE} ${getMcpVersion()} -> ${latest}`);
  setMcpVersion(latest);
  settings.mcpVersion = latest;
  await saveSettings();

  mainWindow?.webContents.send("agent:event", {
    chatId: "active",
    kind: "mcp-updated",
    version: latest,
  });
}

const hub = new ChatHub((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:event", event);
  }
});

/**
 * A remembered position is only safe to reuse if it still lands on a screen
 * that exists; unplugging a second monitor would otherwise strand the window.
 */
function restorableBounds(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;

  const visible = screen.getAllDisplays().some(({ workArea }) => {
    return (
      saved.x < workArea.x + workArea.width &&
      saved.x + saved.width > workArea.x &&
      saved.y < workArea.y + workArea.height &&
      saved.y + saved.height > workArea.y
    );
  });

  return visible ? saved : null;
}

function rememberWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;

  const maximized = mainWindow.isMaximized();
  settings.window = {
    ...(maximized ? (settings.window ?? {}) : mainWindow.getNormalBounds()),
    maximized,
  };
  saveSettings();
}

function scheduleWindowSave() {
  clearTimeout(saveWindowTimer);
  saveWindowTimer = setTimeout(rememberWindow, 400);
}

function createWindow() {
  const saved = restorableBounds(settings.window);

  mainWindow = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WINDOW.width,
    height: saved?.height ?? DEFAULT_WINDOW.height,
    x: saved?.x,
    y: saved?.y,
    show: false,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: "#0e0e10",
    title: "mortar",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0e0e10",
      symbolColor: "#a1a1aa",
      height: TITLEBAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(DIR, "..", "renderer", "index.html"));

  // Painting only once the transcript is ready avoids a flash of empty chrome.
  mainWindow.once("ready-to-show", () => {
    if (settings.window?.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // Electron 36+ passes a single event object; older builds pass positionals.
  mainWindow.webContents.on("console-message", (...args) => {
    const detail = typeof args[0] === "object" && args[0]?.message ? args[0] : null;
    const level = detail ? detail.level : args[0];
    const message = detail ? detail.message : args[1];
    const source = detail ? detail.sourceId : args[3];
    const line = detail ? detail.lineNumber : args[2];

    if (level === "error" || level === 3) {
      log("error", `renderer: ${message} (${source}:${line})`);
    } else if (process.env.HUB_DEBUG) {
      log("debug", `renderer: ${message} (${source}:${line})`);
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log("fatal", "renderer gone", details);
    if (details.reason === "clean-exit" || !mainWindow || mainWindow.isDestroyed()) return;

    // A blank window is worse than a reload; the transcripts are all on disk.
    hub.CloseAll();
    mainWindow.webContents.reload();
  });

  mainWindow.webContents.on("child-process-gone", (_event, details) => {
    log("error", "child process gone", details);
  });

  mainWindow.webContents.on("unresponsive", () => log("warn", "renderer unresponsive"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  // Nothing in this app should ever navigate the shell away from index.html.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    openExternal(url);
  });

  mainWindow.on("resize", scheduleWindowSave);
  mainWindow.on("move", scheduleWindowSave);
  mainWindow.on("maximize", scheduleWindowSave);
  mainWindow.on("unmaximize", scheduleWindowSave);
  mainWindow.on("close", rememberWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Only ever hand the OS a protocol we meant to support. */
function openExternal(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return;
  }

  if (!SAFE_PROTOCOLS.has(url.protocol)) {
    log("warn", `blocked external open for ${url.protocol}`);
    return;
  }

  shell.openExternal(url.href);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log("error", `${channel} failed:`, err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

handle("app:log", (level, message) => {
  log(level === "error" ? "error" : "info", `renderer: ${message}`);
  return true;
});

handle("app:openLogFolder", async () => {
  const file = logPath();
  await mkdir(path.dirname(file), { recursive: true });
  shell.showItemInFolder(file);
  return file;
});

handle("app:info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  mcpPackage: MCP_PACKAGE,
  mcpVersion: getMcpVersion(),
  logFile: logPath(),
  userData: app.getPath("userData"),
}));

handle("clipboard:resolve", (files) => ResolveClipboardFiles(files));

/* ---------- authentication ---------- */

let loginFlow = null;
let lastAuthState = null;

/**
 * Broadcast only on a real change, since this runs on a timer and the renderer
 * repaints the account row every time it hears one.
 */
async function refreshAuth() {
  const status = await AuthStatus();
  const key = `${status.loggedIn}:${status.email ?? ""}:${status.usingToken}`;

  if (key !== lastAuthState) {
    lastAuthState = key;
    log("info", `auth: ${status.loggedIn ? `signed in as ${status.email}` : "signed out"}`);
    mainWindow?.webContents.send("agent:event", {
      chatId: "active",
      kind: "auth-changed",
      status,
    });
  }

  return status;
}

handle("auth:status", () => refreshAuth());

handle("auth:login", async (mode) => {
  loginFlow?.Cancel();
  loginFlow = StartLogin(mode);

  const url = await loginFlow.url;
  openExternal(url);
  return url;
});

handle("auth:submitCode", async (code) => {
  if (!loginFlow) throw new Error("no login is waiting for a code");

  try {
    await loginFlow.SubmitCode(code);
  } finally {
    loginFlow = null;
  }

  return refreshAuth();
});

handle("auth:cancelLogin", () => {
  loginFlow?.Cancel();
  loginFlow = null;
  return true;
});

handle("auth:logout", async () => {
  await Logout();
  return refreshAuth();
});

/**
 * A token from `claude setup-token` does not expire, so storing one is the only
 * way to make this app survive indefinitely without a browser round trip.
 * Chats already open keep the environment they spawned with.
 */
handle("auth:setToken", async (token) => {
  const trimmed = token?.trim() || null;
  settings.authToken = trimmed;
  setAuthToken(trimmed);
  await saveSettings();

  lastAuthState = null;
  return refreshAuth();
});

handle("project:get", () => settings.projectDir);

handle("project:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose your Roblox project folder",
    defaultPath: settings.projectDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return settings.projectDir;

  settings.projectDir = result.filePaths[0];
  await saveSettings();
  return settings.projectDir;
});

handle("chats:list", async (projectDir) => {
  const chats = await hub.ListChats(projectDir ?? settings.projectDir);
  const pinned = new Set(settings.pinned ?? []);

  return chats
    .map((chat) => ({ ...chat, pinned: pinned.has(chat.sessionId) }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastModified - a.lastModified;
    });
});

handle("chats:setPinned", async (sessionId, pinned) => {
  const current = new Set(settings.pinned ?? []);
  if (pinned) current.add(sessionId);
  else current.delete(sessionId);

  settings.pinned = [...current];
  await saveSettings();
  return settings.pinned;
});

handle("chat:history", (sessionId, projectDir) =>
  hub.LoadHistory(sessionId, projectDir ?? settings.projectDir),
);

let openSeq = 0;
handle("chat:open", (config) => {
  if (process.env.HUB_DEBUG) {
    console.log(`[chat:open #${++openSeq}]`, JSON.stringify(config));
  }
  const session = hub.Open({ ...config, cwd: config.cwd ?? settings.projectDir });
  session.Warm();
  return true;
});

handle("chat:send", async (chatId, text, attachments) => {
  const session = hub.Get(chatId);
  if (!session) throw new Error("That chat is not open.");

  const { blocks, files } = await prepareAttachments(attachments, attachmentsDir());
  const body = `${text}${describeAttachments(files)}`.trim();

  session.Send(body || "(see attached files)", blocks);
  return { inlined: blocks.length, files: files.length };
});

handle("capture:save", async ({ data, mimeType, suggestedName }) => {
  const extension = mimeType === "image/jpeg" ? "jpg" : (mimeType?.split("/")[1] ?? "png");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save capture",
    defaultPath: path.join(app.getPath("pictures"), `${suggestedName}.${extension}`),
    filters: [{ name: "Image", extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return null;

  await writeFile(result.filePath, Buffer.from(data, "base64"));
  return result.filePath;
});

handle("attachments:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach files",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];

  return Promise.all(
    result.filePaths.map(async (filePath) => {
      const info = await stat(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        size: info.size,
        mime: guessMimeType(filePath),
        overLimit: info.size > MAX_ATTACHMENT_BYTES,
      };
    }),
  );
});

handle("attachments:describe", async (filePath) => {
  const info = await stat(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: info.size,
    mime: guessMimeType(filePath),
    overLimit: info.size > MAX_ATTACHMENT_BYTES,
  };
});

const THUMBNAIL_LIMIT_BYTES = 3 * 1024 * 1024;

handle("attachments:thumbnail", async (filePath) => {
  const mime = guessMimeType(filePath);
  if (!mime.startsWith("image/")) return null;

  const info = await stat(filePath);
  if (info.size > THUMBNAIL_LIMIT_BYTES) return null;

  const data = await readFile(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
});

handle("attachments:limit", () => ({
  bytes: MAX_ATTACHMENT_BYTES,
  label: formatBytes(MAX_ATTACHMENT_BYTES),
}));

handle("chat:interrupt", (chatId) => hub.Get(chatId)?.Interrupt());

handle("chat:close", (chatId) => {
  hub.Close(chatId);
  return true;
});

handle("chat:setPermissionMode", (chatId, mode) =>
  hub.Get(chatId)?.SetPermissionMode(mode),
);

handle("chat:setModel", (chatId, model) => hub.Get(chatId)?.SetModel(model));

handle("chat:setEffort", (chatId, effort) => hub.Get(chatId)?.SetEffort(effort));

handle("chat:commands", (chatId) => hub.Get(chatId)?.Commands() ?? []);

handle("chat:models", (chatId) => hub.Get(chatId)?.Models() ?? []);

handle("chat:contextUsage", (chatId) => hub.Get(chatId)?.ContextUsage() ?? null);

handle("chat:mcpStatus", (chatId) => hub.Get(chatId)?.McpStatus() ?? []);

handle("chat:rename", (sessionId, title, projectDir) =>
  hub.Rename(sessionId, title, projectDir ?? settings.projectDir),
);

handle("chat:delete", async (sessionId, projectDir) => {
  await hub.Delete(sessionId, projectDir ?? settings.projectDir);

  // Don't leave a pin pointing at a session that no longer exists.
  if (settings.pinned?.includes(sessionId)) {
    settings.pinned = settings.pinned.filter((id) => id !== sessionId);
    await saveSettings();
  }
  return true;
});

handle("permission:respond", (chatId, requestId, decision) => {
  hub.Get(chatId)?.ResolvePermission(requestId, decision);
  return true;
});

// Launching again should surface the window you already have, not a second one.
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  await loadSettings();
  log("info", `started v${app.getVersion()} on electron ${process.versions.electron}`);

  const executable = resolveCliExecutable();
  if (executable) {
    setCliExecutable(executable);
    setAuthCli(executable);
    log("info", `cli binary: ${executable}`);
  }

  if (settings.authToken) {
    setAuthToken(settings.authToken);
    log("info", "using a stored long-lived token");
  }

  // Start on the last version known to work so the first chat can spawn
  // immediately, then check the registry without holding up the window.
  if (settings.mcpVersion) {
    setMcpVersion(settings.mcpVersion);
    log("info", `${MCP_PACKAGE} pinned to ${settings.mcpVersion}`);
  }

  createWindow();

  refreshMcpVersion();
  setInterval(refreshMcpVersion, UPDATE_CHECK_INTERVAL_MS);

  refreshAuth().catch((err) => log("warn", "could not read auth status", err));
  setInterval(() => refreshAuth().catch(() => {}), AUTH_CHECK_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  hub.CloseAll();
  if (process.platform !== "darwin") app.quit();
});

// Every open chat owns a CLI subprocess, which would otherwise outlive the app.
app.on("before-quit", () => {
  clearTimeout(saveWindowTimer);
  loginFlow?.Cancel();
  hub.CloseAll();
  logSync("info", "shutting down");
});
