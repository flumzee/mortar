import { randomUUID } from "node:crypto";
import {
  query,
  listSessions,
  getSessionMessages,
  renameSession,
  deleteSession,
} from "@anthropic-ai/claude-agent-sdk";
import { authEnv } from "./auth.js";

export const MCP_PACKAGE = "@chrrxs/robloxstudio-mcp";

/**
 * Pinned to a resolved version rather than the `latest` tag. Both auto-update,
 * but a tag forces npx to reach the registry on every spawn, which fails
 * outright when offline; an exact version it has already cached just runs.
 */
let mcpVersion = "latest";

export function setMcpVersion(version) {
  mcpVersion = version || "latest";
}

export function getMcpVersion() {
  return mcpVersion;
}

function mcpServers() {
  return {
    robloxstudio: {
      type: "stdio",
      command: "npx",
      args: ["-y", `${MCP_PACKAGE}@${mcpVersion}`, "--auto-install-plugin"],
    },
  };
}

// CLAUDE.md and settings.json are opt-in for SDK consumers; without this the
// user's Roblox conventions in ~/.claude/CLAUDE.md never reach the model.
const SETTING_SOURCES = ["user", "project", "local"];

const SYSTEM_PROMPT = { type: "preset", preset: "claude_code" };

const DEFAULT_PERMISSION_MODE = "default";

// Roblox viewport captures are a few hundred KB; anything past this is not a
// screenshot and would only stall the IPC hop as base64.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// Replaying a long playtest session must not push tens of MB through IPC.
const MAX_HISTORY_CAPTURES = 12;

function textBlocks(text) {
  return [{ type: "text", text }];
}

/**
 * Async-iterable queue the SDK pulls user turns from. Keeping one open per chat
 * is what allows interrupt() and setPermissionMode() to work at all — both are
 * streaming-input-only control requests.
 */
function createInputQueue() {
  const pending = [];
  let waiting = null;
  let closed = false;

  return {
    push(message) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: message, done: false });
      } else {
        pending.push(message);
      }
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (pending.length > 0) {
        return Promise.resolve({ value: pending.shift(), done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return() {
      this.close();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

// Set by the main process when packaged. The SDK resolves its own binary to a
// path inside app.asar, which Node reports as existing but the OS cannot spawn.
let cliExecutable = null;

export function setCliExecutable(executable) {
  cliExecutable = executable;
}

class ChatSession {
  constructor({ chatId, cwd, sessionId, model, effort, permissionMode, emit }) {
    this.ChatId = chatId;
    this.Cwd = cwd;
    this.SessionId = sessionId ?? null;
    this.Model = model || undefined;
    this.Effort = effort || undefined;
    this.PermissionMode = permissionMode || DEFAULT_PERMISSION_MODE;
    this.Busy = false;

    this.emit = emit;
    this.query = null;
    this.input = null;
    this.pendingPermissions = new Map();
  }

  /**
   * Spawn the CLI and connect MCP without sending a turn, so the UI can show a
   * real Studio connection status and the first reply isn't behind startup.
   */
  Warm() {
    if (!this.query) this.start();
  }

  Send(text, imageBlocks = []) {
    if (!this.query) this.start();
    this.Busy = true;
    this.emit({ kind: "busy", busy: true });

    // Images before text: the model attends to them better in that order.
    const content = [...imageBlocks, ...textBlocks(text)];

    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.SessionId ?? "",
    });
  }

  async Interrupt() {
    if (!this.query) return;
    try {
      await this.query.interrupt();
    } catch (err) {
      this.emit({ kind: "error", text: `Could not interrupt: ${err.message}` });
    }
  }

  async SetPermissionMode(mode) {
    this.PermissionMode = mode;
    if (!this.query) return;
    try {
      await this.query.setPermissionMode(mode);
    } catch {
      // Session will pick the mode up on next start.
    }
  }

  /** Effort is a flag setting rather than a dedicated control request. */
  async SetEffort(level) {
    this.Effort = level || undefined;
    if (!this.query) return;
    await this.query.applyFlagSettings({ effortLevel: level || null });
  }

  async Commands() {
    this.Warm();
    return this.query.supportedCommands();
  }

  async Models() {
    this.Warm();
    return this.query.supportedModels();
  }

  async ContextUsage() {
    if (!this.query) return null;
    return this.query.getContextUsage();
  }

  /**
   * Ask the CLI directly rather than waiting on a system/init message — the
   * SDK consumes that during its own initialize handshake, so it never
   * reaches the message stream.
   */
  async McpStatus() {
    this.Warm();
    try {
      return await this.query.mcpServerStatus();
    } catch {
      return [];
    }
  }

  async SetModel(model) {
    this.Model = model || undefined;
    if (!this.query) return;
    try {
      await this.query.setModel(model || undefined);
    } catch {
      // Same as above — applied when the session next starts.
    }
  }

  ResolvePermission(requestId, decision) {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    resolve(decision);
  }

  Close() {
    for (const [, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "Chat closed." });
    }
    this.pendingPermissions.clear();
    this.input?.close();
    try {
      this.query?.close?.();
    } catch {
      // Already torn down.
    }
    this.query = null;
    this.input = null;
  }

  start() {
    this.input = createInputQueue();

    const options = {
      cwd: this.Cwd,
      mcpServers: mcpServers(),
      settingSources: SETTING_SOURCES,
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: this.PermissionMode,
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts),
      stderr: (data) => {
        if (data.trim()) this.emit({ kind: "stderr", text: data });
      },
    };

    // env replaces the subprocess environment outright rather than merging, so
    // PATH has to be carried over or npx cannot launch the MCP server.
    const auth = authEnv();
    if (Object.keys(auth).length > 0) options.env = { ...process.env, ...auth };

    if (cliExecutable) options.pathToClaudeCodeExecutable = cliExecutable;
    if (this.Model) options.model = this.Model;
    if (this.Effort) options.effort = this.Effort;
    if (this.SessionId) options.resume = this.SessionId;

    this.query = query({ prompt: this.input, options });
    this.consume();
  }

  requestPermission(toolName, input, opts) {
    const requestId = randomUUID();

    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);

      opts?.signal?.addEventListener("abort", () => {
        if (!this.pendingPermissions.has(requestId)) return;
        this.pendingPermissions.delete(requestId);
        this.emit({ kind: "permission-cancelled", requestId });
        resolve({ behavior: "deny", message: "Request aborted." });
      });

      this.emit({
        kind: "permission-request",
        requestId,
        toolName,
        input,
        title: opts?.title,
        description: opts?.description,
        suggestions: opts?.suggestions ?? [],
      });
    });
  }

  async consume() {
    try {
      for await (const message of this.query) {
        this.handle(message);
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        this.emit({ kind: "error", text: err?.message ?? String(err) });
      }
    } finally {
      this.Busy = false;
      this.emit({ kind: "busy", busy: false });
    }
  }

  handle(message) {
    if (message.session_id && message.session_id !== this.SessionId) {
      this.SessionId = message.session_id;
      this.emit({ kind: "session-id", sessionId: message.session_id });
    }

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.emit({
            kind: "init",
            sessionId: message.session_id,
            model: message.model,
            mcpServers: message.mcp_servers ?? [],
          });
        } else if (message.subtype === "local_command_output") {
          // Slash commands like /cost answer here, not as assistant text.
          this.emit({ kind: "command-output", text: message.content ?? "" });
        } else if (message.subtype === "compact_boundary") {
          this.emit({
            kind: "compacted",
            trigger: message.compact_metadata?.trigger ?? "auto",
            preTokens: message.compact_metadata?.pre_tokens,
          });
        }
        break;

      case "stream_event":
        this.handleStreamEvent(message.event);
        break;

      case "assistant":
        this.emit({
          kind: "assistant",
          uuid: message.uuid,
          blocks: message.message?.content ?? [],
        });
        break;

      case "user":
        this.handleToolResults(message.message?.content);
        break;

      case "result":
        this.Busy = false;
        this.emit({
          kind: "result",
          isError: Boolean(message.is_error),
          text: message.result ?? "",
          costUsd: message.total_cost_usd ?? 0,
          sessionId: message.session_id,
        });
        this.emit({ kind: "busy", busy: false });
        break;

      default:
        break;
    }
  }

  handleStreamEvent(event) {
    if (!event) return;

    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {};
      if (delta.type === "text_delta" && delta.text) {
        this.emit({ kind: "text-delta", text: delta.text });
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        this.emit({ kind: "thinking-delta", text: delta.thinking });
      }
      return;
    }

    if (event.type === "content_block_start") {
      const block = event.content_block ?? {};
      if (block.type === "tool_use") {
        this.emit({
          kind: "tool-start",
          id: block.id,
          name: block.name,
        });
      }
    }
  }

  handleToolResults(content) {
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      // The CLI sends a bare tool_reference block ahead of the real result; it
      // has nothing to show and would otherwise land in the chip as raw JSON.
      if (isReferenceOnly(block.content)) continue;

      this.emit({
        kind: "tool-result",
        toolUseId: block.tool_use_id,
        isError: Boolean(block.is_error),
        text: stringifyToolResult(block.content),
        images: resultImages(block.content),
      });
    }
  }
}

function stringifyToolResult(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image" || part?.type === "tool_reference") return "";
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function isReferenceOnly(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => part?.type === "tool_reference")
  );
}

function resultImages(content) {
  if (!Array.isArray(content)) return [];
  return content.map(toCapture).filter(Boolean);
}

/**
 * MCP servers emit {data, mimeType}; the same capture can arrive in the
 * Anthropic block shape depending on how the CLI normalised it, so accept both.
 */
function toCapture(part) {
  if (part?.type !== "image") return null;

  const source = part.source ?? {};
  const data = source.type === "base64" ? source.data : part.data;
  if (typeof data !== "string" || data.length === 0) return null;

  const bytes = Math.floor(data.length * 0.75);
  if (bytes > MAX_CAPTURE_BYTES) return null;

  const mimeType = source.media_type ?? part.mimeType ?? "image/png";
  return { mimeType, data, bytes };
}

export class ChatHub {
  constructor(emit) {
    this.emit = emit;
    this.sessions = new Map();
  }

  async ListChats(projectDir) {
    const sessions = await listSessions({
      dir: projectDir,
      limit: 200,
      includeProgrammatic: true,
    });

    return sessions.map((info) => ({
      sessionId: info.sessionId,
      title: info.customTitle || info.summary || info.firstPrompt || "untitled chat",
      lastModified: info.lastModified,
      gitBranch: info.gitBranch,
      cwd: info.cwd,
    }));
  }

  async LoadHistory(sessionId, projectDir) {
    const messages = await getSessionMessages(sessionId, {
      dir: projectDir,
      includeSystemMessages: false,
    });

    const rendered = [];
    let captureBudget = MAX_HISTORY_CAPTURES;

    for (const entry of messages) {
      const payload = entry.message;
      if (!payload || typeof payload !== "object") continue;
      if (entry.parent_tool_use_id) continue; // subagent chatter

      const content = payload.content;

      if (entry.type === "user") {
        if (typeof content === "string") {
          rendered.push({ role: "user", text: content });
        } else if (Array.isArray(content)) {
          const text = content
            .filter((b) => b?.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) rendered.push({ role: "user", text });

          // Screenshots live in tool_result blocks, which are otherwise skipped.
          if (captureBudget > 0) {
            const images = content
              .filter((b) => b?.type === "tool_result")
              .flatMap((b) => resultImages(b.content))
              .slice(0, captureBudget);

            if (images.length > 0) {
              captureBudget -= images.length;
              rendered.push({ role: "captures", images });
            }
          }
        }
      } else if (entry.type === "assistant" && Array.isArray(content)) {
        rendered.push({ role: "assistant", blocks: content });
      }
    }

    return rendered;
  }

  Open({ chatId, cwd, sessionId, model, effort, permissionMode }) {
    this.Close(chatId);

    const session = new ChatSession({
      chatId,
      cwd,
      sessionId,
      model,
      effort,
      permissionMode,
      emit: (event) => this.emit({ ...event, chatId }),
    });

    this.sessions.set(chatId, session);
    return session;
  }

  Get(chatId) {
    return this.sessions.get(chatId);
  }

  Close(chatId) {
    const existing = this.sessions.get(chatId);
    if (!existing) return;
    existing.Close();
    this.sessions.delete(chatId);
  }

  CloseAll() {
    for (const chatId of [...this.sessions.keys()]) this.Close(chatId);
  }

  async Rename(sessionId, title, projectDir) {
    await renameSession(sessionId, title, { dir: projectDir });
  }

  async Delete(sessionId, projectDir) {
    await deleteSession(sessionId, { dir: projectDir });
  }
}
