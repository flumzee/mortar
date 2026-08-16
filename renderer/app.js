"use strict";

const ACTIVE_CHAT_ID = "active";
const MCP_SERVER_NAME = "robloxstudio";
const TITLE_REFRESH_DELAY_MS = 1200;

// Short enough to be invisible next to the replay itself, long enough that
// clicking through the sidebar only reads the transcript you land on.
const HISTORY_SETTLE_MS = 50;

const el = {
  projectPicker: document.getElementById("project-picker"),
  projectName: document.getElementById("project-name-text"),
  newChat: document.getElementById("new-chat"),
  chatList: document.getElementById("chat-list"),
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
  contextMenu: document.getElementById("context-menu"),
  dialog: document.getElementById("dialog"),
  dialogTitle: document.getElementById("dialog-title"),
  dialogMessage: document.getElementById("dialog-message"),
  dialogInput: document.getElementById("dialog-input"),
  dialogConfirm: document.getElementById("dialog-confirm"),
  dialogCancel: document.getElementById("dialog-cancel"),
  mcpDot: document.getElementById("mcp-dot"),
  mcpStatus: document.getElementById("mcp-status"),
  accountRow: document.getElementById("account-row"),
  accountDot: document.getElementById("account-dot"),
  accountLabel: document.getElementById("account-label"),
  chatTitle: document.getElementById("chat-title"),
  palette: document.getElementById("command-palette"),
  attach: document.getElementById("attach"),
  tray: document.getElementById("attachment-tray"),
  dropOverlay: document.getElementById("drop-overlay"),
  dropLimit: document.getElementById("drop-limit"),
  contextFill: document.getElementById("context-fill"),
  contextText: document.getElementById("context-text"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("empty-state"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  interruptRow: document.getElementById("interrupt-row"),
  interrupt: document.getElementById("interrupt"),
  modal: document.getElementById("permission-modal"),
  permTitle: document.getElementById("perm-title"),
  permBody: document.getElementById("perm-body"),
  permAllow: document.getElementById("perm-allow"),
  permDeny: document.getElementById("perm-deny"),
  permAlways: document.getElementById("perm-always"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  lightboxStage: document.getElementById("lightbox-stage"),
  lightboxLabel: document.getElementById("lightbox-label"),
  lightboxCount: document.getElementById("lightbox-count"),
  lightboxPrev: document.getElementById("lightbox-prev"),
  lightboxNext: document.getElementById("lightbox-next"),
  lightboxSave: document.getElementById("lightbox-save"),
  lightboxClose: document.getElementById("lightbox-close"),
};

const state = {
  projectDir: null,
  chats: [],
  sessionId: null,
  busy: false,
  live: null,
  liveThinking: null,
  toolChips: new Map(),
  permission: null,
  refreshTimer: null,
  commands: [],
  paletteMatches: [],
  paletteIndex: 0,
  capabilitiesLoaded: false,
  mcpPollToken: 0,
  renderedThisTurn: false,
  openGeneration: 0,
  attachments: [],
  attachmentSeq: 0,
  limitBytes: 400 * 1024 * 1024,
  limitLabel: "400.0 MB",
  dragDepth: 0,
  query: "",
  menuSessionId: null,
  lightbox: null,
  effort: "",
  // null means the model never told us, so every stop stays available.
  allowedEfforts: null,
  replayToken: 0,
  mcpVersion: null,
  auth: null,
  exploreGroup: null,
  folders: [],
  draggingChat: null,
};

/* ---------- tiny markdown renderer (input is escaped first) ---------- */

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function renderMarkdown(raw) {
  const source = escapeHtml(raw ?? "");
  const out = [];
  const lines = source.split("\n");
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      const lang = line.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      const cls = lang ? ` class="lang-${lang.replace(/[^\w-]/g, "")}"` : "";
      out.push(`<pre><code${cls}>${body.join("\n")}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? "ul" : "ol";
      if (listType !== wanted) {
        flushList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${renderInline((bullet ?? numbered)[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return out.join("");
}

/* ---------- helpers ---------- */

function prettyToolName(name) {
  if (!name) return "tool";
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  return name;
}

function toolTarget(input) {
  if (!input || typeof input !== "object") return "";
  const candidate =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query;
  if (typeof candidate !== "string") return "";
  return candidate.length > 90 ? `${candidate.slice(0, 87)}…` : candidate;
}

function relativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Markup declares which icon it wants; this fills them in once at startup so
// index.html stays free of inline SVG.
for (const node of document.querySelectorAll("[data-icon]")) {
  fillIcon(node, node.dataset.icon, Number(node.dataset.size) || 16);
}

/* ---------- smooth scrolling ---------- */

// Fraction of the remaining distance covered each frame. Lower glides longer.
const SCROLL_EASE = 0.1;
const LINE_HEIGHT = 18;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

function pixelDelta(event, element) {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * element.clientHeight;
  return event.deltaY;
}

/**
 * Trackpads and hi-res wheels already carry their own inertia, and smoothing
 * that a second time feels like syrup. A notched wheel reports in steps of 120.
 */
function isPreciseDevice(event) {
  const raw = Math.abs(event.wheelDeltaY ?? 0);
  return raw !== 0 && raw % 120 !== 0 && Math.abs(event.deltaY) < 50;
}

/**
 * Wheel events bubble, so a code block inside a chip would lose its own
 * scrolling if the container swallowed every one of them.
 */
function innerScrollerHandles(target, container, delta) {
  let node = target instanceof Element ? target : null;

  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        const atTop = node.scrollTop <= 0;
        const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        if (delta < 0 ? !atTop : !atEnd) return true;
      }
    }
    node = node.parentElement;
  }

  return false;
}

function smoothScroller(element) {
  let target = 0;
  let running = false;

  const limit = () => Math.max(0, element.scrollHeight - element.clientHeight);

  function step() {
    // Streaming grows the transcript mid-glide, so re-clamp every frame.
    target = Math.min(target, limit());
    const gap = target - element.scrollTop;

    if (Math.abs(gap) < 0.5) {
      element.scrollTop = target;
      running = false;
      return;
    }

    element.scrollTop += gap * SCROLL_EASE;
    requestAnimationFrame(step);
  }

  element.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || REDUCED_MOTION.matches || isPreciseDevice(event)) return;

      const delta = pixelDelta(event, element);
      if (delta === 0) return;
      if (innerScrollerHandles(event.target, element, delta)) return;

      // Anything that moved the element behind our back leaves target stale.
      if (!running) target = element.scrollTop;

      const next = Math.min(limit(), Math.max(0, target + delta));
      // At either end, leave the event alone so scrolling still chains out.
      if (next === target) return;

      event.preventDefault();
      target = next;

      if (!running) {
        running = true;
        requestAnimationFrame(step);
      }
    },
    { passive: false },
  );

  return {
    jumpTo(position) {
      running = false;
      element.scrollTop = position;
      target = element.scrollTop;
    },
  };
}

const messagesScroller = smoothScroller(el.messages);
smoothScroller(el.chatList);

function atBottom() {
  const { scrollTop, scrollHeight, clientHeight } = el.messages;
  return scrollHeight - scrollTop - clientHeight < 120;
}

function scrollToBottom(force = false) {
  // While replaying into a fragment there is nothing on screen to scroll, and
  // atBottom() would force a layout per message for no reason.
  if (messageSink) return;

  // Snaps rather than glides: this fires per streamed token, so easing it would
  // leave the caret permanently trailing the text. It routes through the
  // scroller so an in-flight wheel glide is cancelled instead of fought.
  if (force || atBottom()) {
    messagesScroller.jumpTo(el.messages.scrollHeight);
  }
}

function clearMessages() {
  el.messages.replaceChildren();
  el.messages.classList.remove("loading");
  state.live = null;
  state.liveThinking = null;
  state.exploreGroup = null;
  state.toolChips.clear();
}

/**
 * Set to a DocumentFragment while replaying a transcript. Building offscreen
 * keeps one reflow at the end instead of one per message, which is the
 * difference between a snappy chat switch and a visible stall.
 */
let messageSink = null;

function addMessage(kind) {
  el.emptyState?.remove();
  state.exploreGroup = null;
  const wrapper = document.createElement("div");
  wrapper.className = `msg msg-${kind}`;
  (messageSink ?? el.messages).appendChild(wrapper);
  return wrapper;
}

function addUserMessage(text, attachments = []) {
  const wrapper = addMessage("user");
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (attachments.length > 0) {
    const strip = document.createElement("div");
    strip.className = "bubble-attachments";

    for (const attachment of attachments) {
      if (attachment.thumbnail) {
        const img = document.createElement("img");
        img.src = attachment.thumbnail;
        img.alt = attachment.name;
        img.title = attachment.name;
        strip.appendChild(img);
      } else {
        const tag = document.createElement("span");
        tag.className = "bubble-file";
        tag.textContent = attachment.name;
        strip.appendChild(tag);
      }
    }
    bubble.appendChild(strip);
  }

  if (text) {
    const body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent = text;
    bubble.appendChild(body);
  }

  wrapper.appendChild(bubble);
  scrollToBottom(true);
}

function addNotice(text, kind = "notice") {
  const wrapper = addMessage(kind);
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrapper.appendChild(body);
  scrollToBottom();
}

function addCommandOutput(text) {
  state.renderedThisTurn = true;
  const wrapper = addMessage("command");
  const pre = document.createElement("pre");
  pre.className = "command-output";
  pre.textContent = text.trim();
  wrapper.appendChild(pre);
  state.live = null;
  scrollToBottom();
}

function assistantBody() {
  if (state.live) return state.live;
  const wrapper = addMessage("assistant");
  const body = document.createElement("div");
  body.className = "body";
  wrapper.appendChild(body);
  state.live = { wrapper, body, text: "" };
  return state.live;
}

function makeChip({ className, label, target, status }) {
  const details = document.createElement("details");
  details.className = `chip ${className}`;

  const summary = document.createElement("summary");

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = label;
  summary.appendChild(name);

  if (target) {
    const targetEl = document.createElement("span");
    targetEl.className = "chip-target";
    targetEl.textContent = target;
    summary.appendChild(targetEl);
  }

  const statusEl = document.createElement("span");
  statusEl.className = `chip-status ${status.cls}`;
  statusEl.textContent = status.text;
  summary.appendChild(statusEl);

  details.appendChild(summary);
  return { details, statusEl, summary };
}

/* ---------- rendering incoming assistant content ---------- */

function renderAssistantBlocks(blocks) {
  const texts = [];

  for (const block of blocks) {
    if (block?.type === "text" && block.text) texts.push(block.text);
  }

  if (texts.length > 0) {
    const live = assistantBody();
    live.body.innerHTML = renderMarkdown(texts.join("\n\n"));
    live.body.classList.remove("streaming");
    state.live = null;
    state.renderedThisTurn = true;
  } else if (state.live && !state.live.text) {
    state.live.wrapper.remove();
    state.live = null;
  }

  if (state.liveThinking) {
    state.liveThinking.details.open = false;
    state.liveThinking = null;
  }

  for (const block of blocks) {
    if (block?.type !== "tool_use") continue;
    upsertToolChip(block.id, block.name, block.input);
  }

  scrollToBottom();
}

/**
 * Looking around the place is most of what Claude does, and a full disclosure
 * chip per lookup buries the actual work. These collapse to one line each and
 * stack into a single block, the way a file listing reads.
 */
const EXPLORE_TOOLS = new Set([
  "get_instance_children",
  "get_descendants",
  "get_project_structure",
  "get_file_tree",
  "get_instance_properties",
  "get_services",
  "get_selection",
]);

const SEARCH_TOOLS = new Set([
  "search_objects",
  "search_by_property",
  "search_files",
  "grep_scripts",
  "get_tagged",
]);

function bareToolName(name) {
  return name?.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/)?.[1] ?? name ?? "";
}

function exploreRowFor(name, input) {
  const bare = bareToolName(name);
  const verb = EXPLORE_TOOLS.has(bare) ? "Explored" : SEARCH_TOOLS.has(bare) ? "Searched" : null;
  if (!verb) return null;

  const raw =
    input?.path ?? input?.query ?? input?.pattern ?? input?.class_name ?? input?.tag ?? "game";
  const target = typeof raw === "string" && raw.trim() ? raw.trim() : "game";

  return { verb, target, icon: verb === "Explored" ? "folder" : "search" };
}

/** Consecutive lookups share one block; anything else in between breaks it. */
function appendExploreRow(id, { verb, target, icon }) {
  if (!state.exploreGroup || !state.exploreGroup.isConnected) {
    const group = document.createElement("div");
    group.className = "explore-group";
    (state.live?.wrapper ?? addMessage("assistant")).appendChild(group);
    state.exploreGroup = group;
  }

  const row = document.createElement("div");
  row.className = "explore-row running";
  row.appendChild(icon === "folder" ? iconNode("folder", 13) : iconNode("search", 13));

  const verbEl = document.createElement("span");
  verbEl.className = "explore-verb";
  verbEl.textContent = verb;

  const targetEl = document.createElement("span");
  targetEl.className = "explore-target";
  targetEl.textContent = target;
  targetEl.title = target;

  row.append(verbEl, targetEl);
  state.exploreGroup.appendChild(row);

  // Same shape applyToolResult expects, so the result path needs no special case.
  const chip = {
    row,
    isExplore: true,
    label: `${verb} ${target}`,
    statusEl: { set className(v) {}, set textContent(v) {} },
    details: { appendChild() {}, after() {}, set open(v) {} },
  };
  state.toolChips.set(id, chip);
  return chip;
}

/** icons.js exposes icon(); this keeps a missing name from killing the row. */
function iconNode(name, size) {
  try {
    return icon(name, size);
  } catch {
    return document.createElement("span");
  }
}

function upsertToolChip(id, name, input) {
  let chip = state.toolChips.get(id);

  if (!chip) {
    const explore = exploreRowFor(name, input);
    if (explore) return appendExploreRow(id, explore);
  }

  if (!chip) {
    const label = prettyToolName(name);
    const created = makeChip({
      className: "tool",
      label,
      target: toolTarget(input),
      status: { cls: "running", text: "running" },
    });
    const body = document.createElement("div");
    body.className = "tool-input";
    created.details.appendChild(body);

    const wrapper = state.live?.wrapper ?? addMessage("assistant");
    wrapper.appendChild(created.details);

    chip = { ...created, body, label, toolName: name };
    state.toolChips.set(id, chip);
  }

  if (input !== undefined) {
    renderToolInput(chip.body, input, chip.toolName);
    const target = toolTarget(input);
    if (target) {
      let targetEl = chip.summary.querySelector(".chip-target");
      if (!targetEl) {
        targetEl = document.createElement("span");
        targetEl.className = "chip-target";
        chip.summary.insertBefore(targetEl, chip.statusEl);
      }
      targetEl.textContent = target;
    }
  }

  return chip;
}

// A Luau body arrives as one JSON string field. Stringifying the whole input
// turns every newline into a literal \n, which is the least readable form of
// the thing you most want to read.
const CODE_MIN_LENGTH = 90;

function isCodePayload(value) {
  return typeof value === "string" && (value.includes("\n") || value.length > CODE_MIN_LENGTH);
}

function renderToolInput(container, input, toolName) {
  container.replaceChildren();

  if (!input || typeof input !== "object") {
    if (input !== undefined) container.appendChild(codeBlock(String(input)));
    return;
  }

  const luau = wantsLuau(toolName, input);

  const entries = Object.entries(input);
  const plain = entries.filter(([, value]) => !isCodePayload(value));
  const code = entries.filter(([, value]) => isCodePayload(value));

  if (plain.length > 0) {
    const list = document.createElement("dl");
    list.className = "tool-params";

    for (const [key, value] of plain) {
      const term = document.createElement("dt");
      term.textContent = key;
      const detail = document.createElement("dd");
      detail.textContent = typeof value === "string" ? value : JSON.stringify(value);
      list.append(term, detail);
    }
    container.appendChild(list);
  }

  for (const [key, value] of code) {
    const field = document.createElement("div");
    field.className = "tool-field";

    const heading = document.createElement("div");
    heading.className = "tool-field-key";
    heading.textContent = `${key} · ${countLines(value)}`;

    field.append(heading, codeBlock(value, luau));
    container.appendChild(field);
  }
}

function countLines(text) {
  const lines = text.split("\n").length;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

function codeBlock(text, luau = false) {
  const pre = document.createElement("pre");
  pre.className = "tool-code";
  const code = document.createElement("code");
  if (luau) code.appendChild(highlightLuau(text));
  else code.textContent = text;
  pre.appendChild(code);
  return pre;
}

/* ---------- luau highlighting ---------- */

const LUAU_TOOL = /luau|script/i;
const LUAU_FILE = /\.luau?$/i;

function wantsLuau(toolName, input) {
  if (LUAU_TOOL.test(toolName ?? "")) return true;
  const path = input?.file_path ?? input?.path;
  return typeof path === "string" && LUAU_FILE.test(path);
}

const LUAU_KEYWORDS = new Set([
  "and", "break", "continue", "do", "else", "elseif", "end", "export", "false",
  "for", "function", "if", "in", "local", "nil", "not", "or", "repeat",
  "return", "then", "true", "until", "while",
]);

const LUAU_GLOBALS = new Set([
  "game", "workspace", "script", "shared", "plugin", "self",
  "Instance", "Enum", "Vector2", "Vector3", "CFrame", "UDim", "UDim2",
  "Color3", "BrickColor", "Ray", "Region3", "TweenInfo", "NumberRange",
  "NumberSequence", "ColorSequence", "Random", "Rect", "Axes", "Faces",
  "assert", "error", "getmetatable", "ipairs", "next", "pairs", "pcall",
  "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select",
  "setmetatable", "tonumber", "tostring", "type", "typeof", "unpack", "warn",
  "xpcall", "bit32", "buffer", "coroutine", "debug", "math", "os", "string",
  "table", "task", "utf8",
]);

/**
 * Comments and strings come first in the alternation so a keyword inside either
 * is never picked up on its own. Long brackets backreference their own level,
 * which is why the `=*` runs are captured.
 */
const LUAU_TOKEN =
  /(--\[(=*)\[[\s\S]*?\]\2\]|--[^\n]*)|(\[(=*)\[[\s\S]*?\]\4\]|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)/g;

function tokenClass(match, source) {
  if (match[1]) return "tok-comment";
  if (match[3]) return "tok-string";
  if (match[5]) return "tok-number";

  const word = match[6];
  if (!word) return null;
  if (LUAU_KEYWORDS.has(word)) return "tok-keyword";
  // Roblox code is mostly method calls, so colouring them separates the noun
  // from the verb at a glance.
  if (source[match.index - 1] === ":") return "tok-method";
  if (LUAU_GLOBALS.has(word)) return "tok-global";
  return null;
}

function highlightLuau(code) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  let match;

  LUAU_TOKEN.lastIndex = 0;
  while ((match = LUAU_TOKEN.exec(code)) !== null) {
    if (match.index > last) {
      fragment.appendChild(document.createTextNode(code.slice(last, match.index)));
    }

    const cls = tokenClass(match, code);
    if (cls) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = match[0];
      fragment.appendChild(span);
    } else {
      fragment.appendChild(document.createTextNode(match[0]));
    }

    last = match.index + match[0].length;
  }

  if (last < code.length) fragment.appendChild(document.createTextNode(code.slice(last)));
  return fragment;
}

function applyToolResult({ toolUseId, isError, text, images = [] }) {
  const chip = state.toolChips.get(toolUseId);
  if (!chip) return;

  if (chip.isExplore) {
    chip.row.classList.remove("running");
    chip.row.classList.toggle("failed", Boolean(isError));
    if (isError) chip.row.title = text?.slice(0, 300) ?? "failed";
    return;
  }

  chip.statusEl.className = `chip-status ${isError ? "err" : "ok"}`;
  chip.statusEl.textContent = isError ? "failed" : "done";

  const body = text?.slice(0, 20000) || (images.length > 0 ? "" : "(no output)");
  if (body) {
    const result = document.createElement("pre");
    result.textContent = body;
    chip.details.appendChild(result);
  }

  // Captures sit outside the disclosure — seeing the shot is the whole point of
  // the call, so it should not be behind a click.
  if (images.length > 0) chip.details.after(renderCaptures(images, chip.label));

  if (isError) chip.details.open = true;
  scrollToBottom();
}

function renderCaptures(images, label) {
  const grid = document.createElement("div");
  grid.className = images.length > 1 ? "captures multi" : "captures";

  images.forEach((image, index) => {
    const figure = document.createElement("figure");
    figure.className = "capture";
    figure.tabIndex = 0;
    figure.title = "click to enlarge";

    const img = document.createElement("img");
    img.src = captureUrl(image);
    img.alt = `${label} capture ${index + 1}`;
    img.loading = "lazy";
    figure.appendChild(img);

    const caption = document.createElement("figcaption");
    caption.textContent =
      images.length > 1 ? `${label} · ${index + 1}/${images.length}` : label;
    figure.appendChild(caption);

    const open = () => openLightbox(images, index, label);
    figure.addEventListener("click", open);
    figure.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    grid.appendChild(figure);
  });

  return grid;
}

function captureUrl(image) {
  return `data:${image.mimeType};base64,${image.data}`;
}

/* ---------- capture lightbox ---------- */

function openLightbox(images, index, label) {
  state.lightbox = { images, index, label };
  el.lightbox.classList.remove("hidden");
  syncLightbox();
}

function syncLightbox() {
  const view = state.lightbox;
  if (!view) return;

  const image = view.images[view.index];
  el.lightboxImg.src = captureUrl(image);
  el.lightboxImg.alt = `${view.label} capture ${view.index + 1}`;
  el.lightboxLabel.textContent = `${view.label} · ${formatBytes(image.bytes)}`;

  const many = view.images.length > 1;
  el.lightboxCount.textContent = many ? `${view.index + 1} / ${view.images.length}` : "";
  el.lightboxPrev.classList.toggle("hidden", !many);
  el.lightboxNext.classList.toggle("hidden", !many);
}

function stepLightbox(delta) {
  const view = state.lightbox;
  if (!view || view.images.length < 2) return;
  view.index = (view.index + delta + view.images.length) % view.images.length;
  syncLightbox();
}

function closeLightbox() {
  if (!state.lightbox) return;
  state.lightbox = null;
  el.lightbox.classList.add("hidden");
  el.lightboxImg.removeAttribute("src");
}

async function saveCapture() {
  const view = state.lightbox;
  if (!view) return;

  const image = view.images[view.index];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  try {
    const saved = await window.hub.saveCapture({
      data: image.data,
      mimeType: image.mimeType,
      suggestedName: `studio-capture-${stamp}`,
    });
    if (saved) {
      el.lightboxSave.textContent = "saved";
      setTimeout(() => (el.lightboxSave.textContent = "save"), 1600);
    }
  } catch (err) {
    el.lightboxSave.textContent = "failed";
    console.error("saveCapture failed", err);
    setTimeout(() => (el.lightboxSave.textContent = "save"), 1600);
  }
}

function appendThinking(text) {
  if (!state.liveThinking) {
    const created = makeChip({
      className: "thinking",
      label: "thinking",
      target: "",
      status: { cls: "running", text: "" },
    });
    const pre = document.createElement("pre");
    created.details.appendChild(pre);

    const wrapper = addMessage("assistant");
    wrapper.appendChild(created.details);
    state.liveThinking = { ...created, pre };
  }
  state.liveThinking.pre.textContent += text;
  scrollToBottom();
}

/* ---------- chat list ---------- */

async function refreshChats() {
  try {
    state.chats = await window.hub.listChats(state.projectDir);
  } catch (err) {
    state.chats = [];
    console.error("listChats failed", err);
  }
  renderChatList();
}

function scheduleChatRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshChats, TITLE_REFRESH_DELAY_MS);
}

function matchesSearch(chat, query) {
  if (!query) return true;
  return chat.title.toLowerCase().includes(query);
}

/** Renders `text` into `target`, wrapping the matched span in a <mark>. */
function highlightInto(target, text, query) {
  const index = query ? text.toLowerCase().indexOf(query) : -1;

  if (index === -1) {
    target.textContent = text;
    return;
  }

  const mark = document.createElement("mark");
  mark.textContent = text.slice(index, index + query.length);

  target.replaceChildren(
    document.createTextNode(text.slice(0, index)),
    mark,
    document.createTextNode(text.slice(index + query.length)),
  );
}

function sectionHeader(label, onAdd = null) {
  const header = document.createElement("div");
  header.className = "list-section";

  const text = document.createElement("span");
  text.textContent = label;
  header.appendChild(text);

  if (onAdd) {
    const add = document.createElement("button");
    add.className = "section-add";
    add.title = "new folder";
    add.appendChild(icon("plus", 13));
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      onAdd();
    });
    header.appendChild(add);
  }

  return header;
}

// Rebuilding the list replaces every node, so without this the entry animation
// replays for the whole sidebar on every refresh. Only genuinely new chats
// should animate in.
const seenChats = new Set();

/**
 * Each click gets its own node rather than a class on the item, so rapid clicks
 * overlap instead of cancelling one another.
 */
function spawnRipple(item, event) {
  const rect = item.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  // Reach the furthest corner so the wave always covers the whole row.
  const size =
    2 * Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));

  const ripple = document.createElement("span");
  ripple.className = "chat-ripple";
  ripple.style.setProperty("--x", `${x}px`);
  ripple.style.setProperty("--y", `${y}px`);
  ripple.style.setProperty("--size", `${size}px`);
  ripple.addEventListener("animationend", () => ripple.remove());

  item.appendChild(ripple);
}

/** Selection is a class change, never a reason to rebuild the list. */
function syncChatSelection() {
  for (const item of el.chatList.querySelectorAll(".chat-item")) {
    const id = item.dataset.sessionId;
    item.classList.toggle("active", id === state.sessionId);
    item.classList.toggle("menu-open", id === state.menuSessionId);
  }
}

function buildChatItem(chat) {
  const item = document.createElement("div");
  item.className = "chat-item";
  item.dataset.sessionId = chat.sessionId;
  if (chat.sessionId === state.sessionId) item.classList.add("active");
  if (chat.sessionId === state.menuSessionId) item.classList.add("menu-open");

  if (!seenChats.has(chat.sessionId)) {
    seenChats.add(chat.sessionId);
    item.classList.add("enter");
  }

  const row = document.createElement("div");
  row.className = "chat-item-row";

  if (chat.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-badge";
    pin.title = "pinned";
    pin.appendChild(icon("pin", 12));
    row.appendChild(pin);
  }

  const title = document.createElement("div");
  title.className = "chat-item-title";
  title.title = chat.title;
  highlightInto(title, chat.title, state.query);
  row.appendChild(title);

  const menuButton = document.createElement("button");
  menuButton.className = "chat-menu-btn";
  menuButton.title = "chat options";
  menuButton.appendChild(icon("ellipsis", 15));
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = menuButton.getBoundingClientRect();
    openContextMenu(chat, rect.right, rect.bottom + 4);
  });
  row.appendChild(menuButton);

  const meta = document.createElement("div");
  meta.className = "chat-item-meta";
  meta.textContent = relativeTime(chat.lastModified);

  item.append(row, meta);

  item.addEventListener("click", (event) => {
    spawnRipple(item, event);
    openChat(chat);
  });
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(chat, event.clientX, event.clientY);
  });

  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    state.draggingChat = chat.sessionId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", chat.sessionId);
    // Applied late so the drag image is captured before the item dims.
    requestAnimationFrame(() => item.classList.add("dragging"));
    document.body.classList.add("dragging-chat");
  });
  item.addEventListener("dragend", () => {
    state.draggingChat = null;
    item.classList.remove("dragging");
    document.body.classList.remove("dragging-chat");
    for (const node of document.querySelectorAll(".drop-target")) {
      node.classList.remove("drop-target");
    }
  });

  return item;
}

/* ---------- folders ---------- */

async function loadFolders() {
  try {
    state.folders = await window.hub.listFolders();
  } catch (err) {
    console.warn("folders unavailable", err);
    state.folders = [];
  }
}

/** Saves optimistically: the sidebar already moved, so waiting would only lag. */
async function persistFolders() {
  try {
    state.folders = await window.hub.saveFolders(state.folders);
  } catch (err) {
    addNotice(`could not save folders: ${err.message}`, "error");
    await loadFolders();
    renderChatList();
  }
}

function folderOf(sessionId) {
  return state.folders.find((folder) => folder.chats.includes(sessionId)) ?? null;
}

/** Null folderId moves a chat back out to the ungrouped list. */
async function moveChatToFolder(sessionId, folderId) {
  const from = folderOf(sessionId);
  if ((from?.id ?? null) === folderId) return;

  for (const folder of state.folders) {
    folder.chats = folder.chats.filter((id) => id !== sessionId);
  }

  const target = state.folders.find((folder) => folder.id === folderId);
  if (target) {
    target.chats.unshift(sessionId);
    target.collapsed = false;
  }

  renderChatList();
  await persistFolders();
}

async function createFolder() {
  const name = await openDialog({
    title: "new folder",
    message: "group chats together in the sidebar.",
    input: "",
    confirmLabel: "create",
  });
  if (name === null) return;

  const trimmed = name.trim() || "untitled folder";
  state.folders.unshift({
    id: `f_${Math.random().toString(36).slice(2, 10)}`,
    name: trimmed,
    pinned: false,
    collapsed: false,
    chats: [],
  });

  renderChatList();
  await persistFolders();
}

async function renameFolder(folder) {
  const name = await openDialog({
    title: "rename folder",
    message: "",
    input: folder.name,
    confirmLabel: "rename",
  });
  if (name === null) return;

  folder.name = name.trim() || folder.name;
  renderChatList();
  await persistFolders();
}

async function deleteFolder(folder) {
  const ok = await openDialog({
    title: "delete folder",
    message: [
      { text: "delete " },
      { text: folder.name, bold: true },
      {
        text: folder.chats.length
          ? `? the ${folder.chats.length} chat${folder.chats.length === 1 ? "" : "s"} inside go back to recent, nothing is deleted.`
          : "?",
      },
    ],
    confirmLabel: "delete",
    danger: true,
  });
  if (!ok) return;

  state.folders = state.folders.filter((f) => f.id !== folder.id);
  renderChatList();
  await persistFolders();
}

async function toggleFolderPin(folder) {
  folder.pinned = !folder.pinned;
  renderChatList();
  await persistFolders();
}

async function toggleFolderCollapsed(folder) {
  folder.collapsed = !folder.collapsed;
  renderChatList();
  await persistFolders();
}

function openFolderMenu(folder, x, y) {
  el.contextMenu.replaceChildren(
    menuItem(
      folder.pinned ? "unpin folder" : "pin folder",
      folder.pinned ? "pin-off" : "pin",
      () => toggleFolderPin(folder),
    ),
    menuItem("rename…", "pencil", () => renameFolder(folder)),
    Object.assign(document.createElement("div"), { className: "menu-sep" }),
    menuItem("delete…", "trash-2", () => deleteFolder(folder), { danger: true }),
  );

  el.contextMenu.classList.remove("hidden");
  const left = Math.min(x, window.innerWidth - el.contextMenu.offsetWidth - 8);
  const top = Math.min(y, window.innerHeight - el.contextMenu.offsetHeight - 8);
  el.contextMenu.style.left = `${Math.max(8, left)}px`;
  el.contextMenu.style.top = `${Math.max(8, top)}px`;
}

function buildFolder(folder, chatsById) {
  const wrapper = document.createElement("div");
  wrapper.className = "folder";
  if (folder.collapsed) wrapper.classList.add("collapsed");

  const head = document.createElement("div");
  head.className = "folder-head";
  head.tabIndex = 0;

  const twisty = document.createElement("span");
  twisty.className = "folder-twisty";
  twisty.appendChild(icon("chevron-right", 13));

  const mark = document.createElement("span");
  mark.className = "folder-icon";
  mark.appendChild(icon("folder", 14));

  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = folder.name;
  name.title = folder.name;

  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = String(folder.chats.length);

  head.append(twisty, mark, name, count);

  if (folder.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-badge";
    pin.title = "pinned";
    pin.appendChild(icon("pin", 11));
    head.insertBefore(pin, count);
  }

  const menuButton = document.createElement("button");
  menuButton.className = "chat-menu-btn";
  menuButton.title = "folder options";
  menuButton.appendChild(icon("ellipsis", 15));
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = menuButton.getBoundingClientRect();
    openFolderMenu(folder, rect.right, rect.bottom + 4);
  });
  head.appendChild(menuButton);

  head.addEventListener("click", () => toggleFolderCollapsed(folder));
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleFolderCollapsed(folder);
    }
  });
  head.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openFolderMenu(folder, event.clientX, event.clientY);
  });

  attachDropTarget(head, folder.id, wrapper);
  wrapper.appendChild(head);

  const body = document.createElement("div");
  body.className = "folder-body";

  if (!folder.collapsed) {
    const chats = folder.chats.map((id) => chatsById.get(id)).filter(Boolean);
    if (chats.length === 0) {
      const hint = document.createElement("div");
      hint.className = "folder-empty";
      hint.textContent = "drop a chat here";
      body.appendChild(hint);
    }
    for (const chat of chats) body.appendChild(buildChatItem(chat));
  }

  wrapper.appendChild(body);
  return wrapper;
}

/**
 * dragover has to be cancelled for a drop to fire at all, which is the usual
 * reason a drop target silently does nothing.
 */
function attachDropTarget(element, folderId, highlight = element) {
  element.addEventListener("dragover", (event) => {
    if (!state.draggingChat) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    highlight.classList.add("drop-target");
  });

  element.addEventListener("dragleave", (event) => {
    if (element.contains(event.relatedTarget)) return;
    highlight.classList.remove("drop-target");
  });

  element.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    highlight.classList.remove("drop-target");

    const sessionId = state.draggingChat ?? event.dataTransfer.getData("text/plain");
    if (sessionId) moveChatToFolder(sessionId, folderId);
  });
}

function renderChatList() {
  el.chatList.replaceChildren();
  el.searchClear.classList.toggle("hidden", state.query === "");

  const matching = state.chats.filter((chat) => matchesSearch(chat, state.query));

  if (matching.length === 0 && state.folders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = state.query
      ? `no chats match “${state.query}”.`
      : "nothing here yet.";
    el.chatList.appendChild(empty);
    return;
  }

  // Search flattens everything: when you are looking for one chat you do not
  // care which folder it lives in.
  if (state.query) {
    el.chatList.appendChild(
      sectionHeader(`${matching.length} result${matching.length === 1 ? "" : "s"}`),
    );
    for (const chat of matching) el.chatList.appendChild(buildChatItem(chat));
    return;
  }

  const chatsById = new Map(matching.map((chat) => [chat.sessionId, chat]));
  const grouped = new Set(state.folders.flatMap((folder) => folder.chats));

  const pinned = matching.filter((chat) => chat.pinned && !grouped.has(chat.sessionId));
  const rest = matching.filter((chat) => !chat.pinned && !grouped.has(chat.sessionId));

  if (pinned.length > 0) {
    el.chatList.appendChild(sectionHeader("pinned"));
    for (const chat of pinned) el.chatList.appendChild(buildChatItem(chat));
  }

  if (state.folders.length > 0) {
    el.chatList.appendChild(sectionHeader("folders", createFolder));
    const ordered = [...state.folders].sort((a, b) => Number(b.pinned) - Number(a.pinned));
    for (const folder of ordered) el.chatList.appendChild(buildFolder(folder, chatsById));
  }

  const recent = sectionHeader("recent", state.folders.length === 0 ? createFolder : null);
  el.chatList.appendChild(recent);

  // Dropping onto the recent header is how a chat leaves a folder.
  attachDropTarget(recent, null);

  for (const chat of rest) el.chatList.appendChild(buildChatItem(chat));
}

/* ---------- context menu ---------- */

function closeContextMenu() {
  if (!state.menuSessionId) return;
  state.menuSessionId = null;
  el.contextMenu.classList.add("hidden");
  el.contextMenu.replaceChildren();
  syncChatSelection();
}

function menuItem(label, iconName, onClick, { danger = false } = {}) {
  const button = document.createElement("button");
  button.className = `menu-item${danger ? " danger" : ""}`;

  const glyph = document.createElement("span");
  glyph.className = "menu-icon";
  glyph.appendChild(icon(iconName, 14));

  const text = document.createElement("span");
  text.textContent = label;

  button.append(glyph, text);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    closeContextMenu();
    onClick();
  });

  return button;
}

/** Drag is the fast path; this is the one that works with a trackpad and a menu. */
function folderMenuItems(chat) {
  const items = [];
  const current = folderOf(chat.sessionId);

  if (current) {
    items.push(
      menuItem(`remove from ${current.name}`, "square-arrow-out-up-right", () =>
        moveChatToFolder(chat.sessionId, null),
      ),
    );
  }

  for (const folder of state.folders) {
    if (folder.id === current?.id) continue;
    items.push(
      menuItem(`move to ${folder.name}`, "folder", () =>
        moveChatToFolder(chat.sessionId, folder.id),
      ),
    );
  }

  items.push(
    menuItem("new folder…", "plus", async () => {
      const before = new Set(state.folders.map((f) => f.id));
      await createFolder();
      const created = state.folders.find((f) => !before.has(f.id));
      if (created) await moveChatToFolder(chat.sessionId, created.id);
    }),
  );

  return items;
}

function openContextMenu(chat, x, y) {
  state.menuSessionId = chat.sessionId;

  el.contextMenu.replaceChildren(
    menuItem(
      chat.pinned ? "unpin chat" : "pin chat",
      chat.pinned ? "pin-off" : "pin",
      () => togglePin(chat),
    ),
    menuItem("rename…", "pencil", () => renameChatFlow(chat)),
    ...folderMenuItems(chat),
    Object.assign(document.createElement("div"), { className: "menu-sep" }),
    menuItem("delete…", "trash-2", () => deleteChatFlow(chat), { danger: true }),
  );

  el.contextMenu.classList.remove("hidden");

  // offsetWidth/Height ignore the entry transform, so the clamp isn't thrown
  // off by the scale the open animation starts at.
  const left = Math.min(x, window.innerWidth - el.contextMenu.offsetWidth - 8);
  const top = Math.min(y, window.innerHeight - el.contextMenu.offsetHeight - 8);
  el.contextMenu.style.left = `${Math.max(8, left)}px`;
  el.contextMenu.style.top = `${Math.max(8, top)}px`;

  syncChatSelection();
}

/* ---------- dialog ---------- */

let dialogResolve = null;

function openDialog({ title, message, input, confirmLabel = "confirm", danger = false }) {
  el.dialogTitle.textContent = title;

  if (Array.isArray(message)) {
    el.dialogMessage.replaceChildren(
      ...message.map((part) => {
        if (!part.bold) return document.createTextNode(part.text);
        const strong = document.createElement("strong");
        strong.textContent = part.text;
        return strong;
      }),
    );
  } else {
    el.dialogMessage.textContent = message ?? "";
  }
  el.dialogMessage.classList.toggle("hidden", !message);

  const wantsInput = typeof input === "string";
  el.dialogInput.classList.toggle("hidden", !wantsInput);
  el.dialogInput.value = wantsInput ? input : "";

  el.dialogConfirm.textContent = confirmLabel;
  el.dialogConfirm.className = danger ? "btn-danger" : "btn-allow";

  el.dialog.classList.remove("hidden");

  if (wantsInput) {
    el.dialogInput.focus();
    el.dialogInput.select();
  } else {
    el.dialogConfirm.focus();
  }

  return new Promise((resolve) => {
    dialogResolve = resolve;
  });
}

function closeDialog(value) {
  if (!dialogResolve) return;
  const resolve = dialogResolve;
  dialogResolve = null;
  el.dialog.classList.add("hidden");
  resolve(value);
}

/* ---------- chat actions ---------- */

async function togglePin(chat) {
  try {
    await window.hub.setPinned(chat.sessionId, !chat.pinned);
    await refreshChats();
  } catch (err) {
    addNotice(`could not pin chat: ${err.message}`, "error");
  }
}

async function renameChatFlow(chat) {
  const next = await openDialog({
    title: "rename chat",
    message: "give this conversation a name you'll recognise later.",
    input: chat.title === "untitled chat" ? "" : chat.title,
    confirmLabel: "rename",
  });

  const title = next?.trim();
  if (!title || title === chat.title) return;

  try {
    await window.hub.renameChat(chat.sessionId, title, state.projectDir);
    if (chat.sessionId === state.sessionId) el.chatTitle.value = title;
    await refreshChats();
  } catch (err) {
    addNotice(`could not rename chat: ${err.message}`, "error");
  }
}

async function deleteChatFlow(chat) {
  const confirmed = await openDialog({
    title: "delete chat",
    message: [
      { text: "delete " },
      { text: chat.title, bold: true },
      {
        text: "? this wipes the transcript from disk for good.",
      },
    ],
    confirmLabel: "delete",
    danger: true,
  });

  if (!confirmed) return;

  try {
    await window.hub.deleteChat(chat.sessionId, state.projectDir);
  } catch (err) {
    addNotice(`could not delete chat: ${err.message}`, "error");
    return;
  }

  if (chat.sessionId === state.sessionId) await newChat();
  await refreshChats();
}

/* ---------- chat lifecycle ---------- */

async function openChat(chat) {
  // Clicking through the sidebar quickly should cost one replay, not one per
  // click; every superseded open bails at its next await.
  const token = ++state.replayToken;

  clearMessages();
  state.sessionId = chat.sessionId;
  el.chatTitle.value = chat.title === "untitled chat" ? "" : chat.title;
  syncChatSelection();
  setBusy(false);

  addNotice("loading conversation…");

  // Reading a transcript parses the whole JSONL on the main process, so a
  // click that is already superseded should never issue the request at all.
  await new Promise((resolve) => setTimeout(resolve, HISTORY_SETTLE_MS));
  if (token !== state.replayToken) return;

  let history = [];
  try {
    history = await window.hub.loadHistory(chat.sessionId, state.projectDir);
  } catch (err) {
    if (token !== state.replayToken) return;
    clearMessages();
    addNotice(`could not load this conversation: ${err.message}`, "error");
    return;
  }

  if (token !== state.replayToken) return;

  clearMessages();
  el.messages.classList.add("loading");

  messageSink = document.createDocumentFragment();
  try {
    for (const entry of history) {
      if (entry.role === "user") {
        addUserMessage(entry.text);
      } else if (entry.role === "captures") {
        addMessage("assistant").appendChild(renderCaptures(entry.images, "capture"));
      } else {
        renderAssistantBlocks(entry.blocks ?? []);
        state.live = null;
      }
    }

    // Tool results are not replayed into history, so leave the chips neutral.
    for (const [, chip] of state.toolChips) {
      chip.statusEl.className = "chip-status";
      chip.statusEl.textContent = "";
    }

    addNotice("resumed");
  } finally {
    const built = messageSink;
    messageSink = null;
    el.messages.appendChild(built);
  }

  scrollToBottom(true);

  // Re-enable entry animations now that the backlog is painted.
  requestAnimationFrame(() => el.messages.classList.remove("loading"));
  setConnecting();

  await activateSession({
    chatId: ACTIVE_CHAT_ID,
    cwd: state.projectDir,
    sessionId: chat.sessionId,
    model: modelSelect.value || undefined,
    effort: state.effort || undefined,
    permissionMode: permissionSelect.value,
  });
}

async function newChat() {
  // Abandons any replay still in flight, so it cannot paint over the fresh chat.
  state.replayToken += 1;

  clearMessages();
  state.sessionId = null;
  el.chatTitle.value = "";
  syncChatSelection();
  setBusy(false);

  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML =
    '<div class="empty-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
    "<h1>new chat</h1><p>claude is pointed at this project folder with the " +
    "<code>robloxstudio</code> server attached. ask for a change and it works " +
    "straight against your open place.</p>";
  el.messages.appendChild(empty);
  el.emptyState = empty;
  setConnecting();

  el.input.focus();

  await activateSession({
    chatId: ACTIVE_CHAT_ID,
    cwd: state.projectDir,
    model: modelSelect.value || undefined,
    effort: state.effort || undefined,
    permissionMode: permissionSelect.value,
  });
}

/* ---------- attachments ---------- */

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function extensionLabel(name) {
  const ext = name.split(".").pop();
  return ext && ext !== name ? ext.slice(0, 4) : "file";
}

function addAttachment(attachment) {
  const duplicate = state.attachments.some(
    (existing) =>
      existing.path && attachment.path && existing.path === attachment.path,
  );
  if (duplicate) return;

  state.attachments.push({ id: ++state.attachmentSeq, ...attachment });
  renderTray();
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((item) => item.id !== id);
  renderTray();
}

function clearAttachments() {
  state.attachments = [];
  renderTray();
}

function renderTray() {
  el.tray.replaceChildren();
  el.tray.classList.toggle("hidden", state.attachments.length === 0);

  for (const attachment of state.attachments) {
    const chip = document.createElement("div");
    chip.className = `attachment${attachment.overLimit ? " over-limit" : ""}`;

    if (attachment.thumbnail) {
      const img = document.createElement("img");
      img.className = "attachment-thumb";
      img.src = attachment.thumbnail;
      img.alt = "";
      chip.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "attachment-icon";
      icon.textContent = extensionLabel(attachment.name);
      chip.appendChild(icon);
    }

    const meta = document.createElement("div");
    meta.className = "attachment-meta";

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.name;
    name.title = attachment.path ?? attachment.name;

    const size = document.createElement("span");
    size.className = "attachment-size";
    size.textContent = attachment.overLimit
      ? `${formatBytes(attachment.size)}, over the ${state.limitLabel} limit`
      : formatBytes(attachment.size);

    meta.append(name, size);
    chip.appendChild(meta);

    const remove = document.createElement("button");
    remove.className = "attachment-remove";
    remove.title = "remove";
    remove.appendChild(icon("x", 12));
    remove.addEventListener("click", () => removeAttachment(attachment.id));
    chip.appendChild(remove);

    el.tray.appendChild(chip);
  }
}

/** Files dragged or picked already live on disk, so we only need their path. */
async function attachFromPath(filePath) {
  try {
    const info = await window.hub.describeAttachment(filePath);
    const thumbnail = info.mime.startsWith("image/")
      ? await window.hub.thumbnail(filePath).catch(() => null)
      : null;
    addAttachment({ ...info, thumbnail });
  } catch (err) {
    addNotice(`could not attach ${filePath}: ${err.message}`, "error");
  }
}

/** Pasted blobs have no path, so carry the bytes and let main persist them. */
async function attachFromBlob(file) {
  const bytes = await file.arrayBuffer();
  const name = file.name || `pasted-${Date.now()}.${(file.type.split("/")[1] ?? "bin")}`;

  let thumbnail = null;
  if (file.type.startsWith("image/") && bytes.byteLength <= 3 * 1024 ** 2) {
    thumbnail = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  addAttachment({
    name,
    size: bytes.byteLength,
    mime: file.type || "",
    bytes,
    thumbnail,
    overLimit: bytes.byteLength > state.limitBytes,
  });
}

/**
 * Files copied in Explorer paste in with no path attached, which would send the
 * whole thing through IPC as bytes and give Claude a copy to edit rather than
 * the file you actually meant. The main process can recover the real paths, so
 * try that first and only fall back to carrying bytes when it cannot.
 */
async function attachPastedFiles(files) {
  let paths = [];

  try {
    paths = await window.hub.resolveClipboardFiles(
      files.map((file) => ({ name: file.name, size: file.size })),
    );
  } catch {
    paths = [];
  }

  if (paths.length !== files.length) {
    await attachDroppedFiles(files);
    return;
  }

  for (const filePath of paths) await attachFromPath(filePath);
}

async function attachDroppedFiles(fileList) {
  for (const file of fileList) {
    const filePath = window.hub.pathForFile(file);
    if (filePath) {
      await attachFromPath(filePath);
    } else {
      await attachFromBlob(file);
    }
  }
}

/* ---------- capabilities: models, commands, context ---------- */

/**
 * Opens a session and loads its capabilities, discarding the follow-up work if
 * another chat is opened meanwhile — otherwise the newer session tears down the
 * query these requests are still waiting on.
 */
async function activateSession(config) {
  const generation = ++state.openGeneration;

  try {
    await window.hub.openChat(config);
  } catch (err) {
    addNotice(`could not open session: ${err.message}`, "error");
    return;
  }

  if (generation !== state.openGeneration) return;
  await loadCapabilities(generation);

  if (generation !== state.openGeneration) return;
  await refreshContext();
}

async function loadCapabilities(generation) {
  // Settled, not all — one unavailable control request shouldn't blank the rest.
  const [commands, models] = await Promise.allSettled([
    window.hub.listCommands(ACTIVE_CHAT_ID),
    window.hub.listModels(ACTIVE_CHAT_ID),
  ]);

  if (generation !== state.openGeneration) return;

  if (commands.status === "fulfilled") {
    state.commands = [...LOCAL_COMMANDS, ...(commands.value ?? [])];
  } else {
    console.warn("commands unavailable", commands.reason);
    state.commands = [...LOCAL_COMMANDS];
  }

  if (models.status === "fulfilled") {
    populateModels(models.value ?? []);
  } else {
    console.warn("models unavailable", models.reason);
  }

  state.capabilitiesLoaded = commands.status === "fulfilled";
  pollMcpStatus();
}

/** The status row is the only place the server version is visible. */
function syncMcpTitle(error) {
  const parts = [];
  if (state.mcpVersion) parts.push(`robloxstudio ${state.mcpVersion}`);
  if (error) parts.push(error);
  el.mcpStatus.title = parts.join("\n");
}

async function loadAppInfo() {
  try {
    const info = await window.hub.appInfo();
    state.mcpVersion = info.mcpVersion;
    syncMcpTitle();
  } catch (err) {
    console.warn("app info unavailable", err);
  }
}

function applyMcpStatus(servers) {
  const server = servers.find((s) => s.name === MCP_SERVER_NAME);
  const status = server?.status ?? "not configured";
  const toolCount = server?.tools?.length;

  const dot =
    status === "connected" ? "dot-ok" : status === "pending" ? "dot-idle" : "dot-bad";

  el.mcpDot.className = `dot ${dot}`;
  el.mcpStatus.textContent =
    status === "connected"
      ? `studio: connected${toolCount ? ` · ${toolCount} tools` : ""}`
      : `studio: ${status}`;
  syncMcpTitle(server?.error);

  return status;
}

const MCP_POLL_ATTEMPTS = 40;
const MCP_POLL_MIN_MS = 1000;
const MCP_POLL_MAX_MS = 6000;

/**
 * The MCP server reports `pending` for the first few seconds after the CLI
 * starts, so a single check almost always catches it mid-handshake.
 *
 * The window has to cover a cold start, not just a warm one: the first launch
 * after the server version changes makes npx download the new package before
 * anything can connect, which takes far longer than a handshake. Polling backs
 * off instead of giving up, so that case still resolves on its own.
 */
async function pollMcpStatus() {
  const token = ++state.mcpPollToken;

  for (let attempt = 0; attempt < MCP_POLL_ATTEMPTS; attempt += 1) {
    if (token !== state.mcpPollToken) return;

    let status = "pending";
    try {
      status = applyMcpStatus((await window.hub.mcpStatus(ACTIVE_CHAT_ID)) ?? []);
    } catch {
      return;
    }

    if (status !== "pending") return;

    const wait = Math.min(MCP_POLL_MIN_MS * 2 ** Math.floor(attempt / 4), MCP_POLL_MAX_MS);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/* ---------- account ---------- */

let authModal = null;
let authStep = "status";
let authBusy = false;
let authError = "";

function planLabel(status) {
  if (status.usingToken) return "long-lived token";
  if (status.subscriptionType) return `${status.subscriptionType} plan`;
  return status.authMethod ?? "signed in";
}

/**
 * "cannot tell" and "signed out" look the same to a user but mean very
 * different things, so an unreadable CLI never gets reported as a sign out.
 */
function applyAuthStatus(status) {
  state.auth = status;

  const dot = !status.reachable ? "dot-idle" : status.loggedIn ? "dot-ok" : "dot-bad";
  el.accountDot.className = `dot ${dot}`;

  if (!status.reachable) {
    el.accountLabel.textContent = "account: unknown";
    el.accountRow.title = status.error ?? "could not reach the claude cli";
  } else if (status.loggedIn) {
    el.accountLabel.textContent = status.email ?? "signed in";
    el.accountRow.title = [status.email, planLabel(status), status.orgName]
      .filter(Boolean)
      .join("\n");
  } else {
    el.accountLabel.textContent = "signed out";
    el.accountRow.title = "click to sign in";
  }

  if (authModal && !authModal.hidden) renderAuth();
}

async function refreshAuthStatus() {
  try {
    applyAuthStatus(await window.hub.authStatus());
  } catch (err) {
    console.warn("auth status unavailable", err);
  }
}

function authButton(label, kind, onClick) {
  const button = document.createElement("button");
  button.className = kind;
  button.textContent = label;
  button.disabled = authBusy;
  button.addEventListener("click", onClick);
  return button;
}

function authLine(text, className = "auth-line") {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  return line;
}

function buildAuthModal() {
  const { modal, card } = buildModalShell("auth-modal");
  const name = buildHead(card, "account");

  const body = document.createElement("div");
  body.className = "auth-body";
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "auth-actions";
  card.appendChild(actions);

  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) closeAuth();
  });

  authModal = { modal, card, name, body, actions, hidden: true };
}

function renderAuth() {
  const { name, body, actions } = authModal;
  const status = state.auth ?? {};

  body.replaceChildren();
  actions.replaceChildren();

  name.textContent = status.loggedIn ? (status.email ?? "signed in") : "signed out";

  if (authError) body.appendChild(authLine(authError, "auth-line auth-error"));

  if (authStep === "status") renderAuthStatusStep(status, body, actions);
  else if (authStep === "code") renderAuthCodeStep(body, actions);
  else if (authStep === "token") renderAuthTokenStep(body, actions);
}

function renderAuthStatusStep(status, body, actions) {
  if (status.loggedIn) {
    body.appendChild(authLine(`signed in with ${planLabel(status)}.`));
    if (status.orgName) body.appendChild(authLine(status.orgName, "auth-line auth-muted"));
    body.appendChild(
      authLine(
        status.usingToken
          ? "this token does not expire, so mortar will not ask you to sign in again."
          : "mortar re-checks this every half hour, which keeps the token refreshing on its own.",
        "auth-line auth-muted",
      ),
    );
  } else if (!status.reachable) {
    body.appendChild(authLine("could not read your account from the claude cli."));
    if (status.error) body.appendChild(authLine(status.error, "auth-line auth-muted"));
  } else {
    body.appendChild(authLine("you are signed out, so chats will fail until you sign back in."));
  }

  actions.appendChild(
    authButton(status.loggedIn ? "sign in again" : "sign in", "btn-allow", () => beginLogin()),
  );
  actions.appendChild(
    authButton("use a long-lived token", "btn-ghost", () => {
      authError = "";
      authStep = "token";
      renderAuth();
    }),
  );
  if (status.loggedIn && !status.usingToken) {
    actions.appendChild(authButton("sign out", "btn-danger", () => runLogout()));
  }
  if (status.usingToken) {
    actions.appendChild(authButton("forget token", "btn-danger", () => saveAuthToken("")));
  }
}

function renderAuthCodeStep(body, actions) {
  body.appendChild(authLine("a browser tab is open for you to approve the sign in."));
  body.appendChild(
    authLine("paste the code it gives you back here.", "auth-line auth-muted"),
  );

  const input = document.createElement("input");
  input.className = "auth-input";
  input.placeholder = "paste your code";
  input.spellcheck = false;
  input.disabled = authBusy;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitLoginCode(input.value);
  });
  body.appendChild(input);
  input.focus();

  actions.appendChild(authButton("finish sign in", "btn-allow", () => submitLoginCode(input.value)));
  actions.appendChild(
    authButton("cancel", "btn-ghost", async () => {
      await window.hub.cancelLogin().catch(() => {});
      authStep = "status";
      authError = "";
      renderAuth();
    }),
  );
}

function renderAuthTokenStep(body, actions) {
  body.appendChild(authLine("run this in a terminal, then paste what it prints:"));
  body.appendChild(authLine("claude setup-token", "auth-line auth-code"));
  body.appendChild(
    authLine(
      "that token has no expiry, so mortar stops depending on a login that can lapse. it needs a claude subscription.",
      "auth-line auth-muted",
    ),
  );

  const input = document.createElement("input");
  input.className = "auth-input";
  input.type = "password";
  input.placeholder = "paste your token";
  input.spellcheck = false;
  input.disabled = authBusy;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveAuthToken(input.value);
  });
  body.appendChild(input);
  input.focus();

  actions.appendChild(authButton("save token", "btn-allow", () => saveAuthToken(input.value)));
  actions.appendChild(
    authButton("back", "btn-ghost", () => {
      authError = "";
      authStep = "status";
      renderAuth();
    }),
  );
}

async function beginLogin() {
  authBusy = true;
  authError = "";
  authStep = "code";
  renderAuth();

  try {
    await window.hub.startLogin();
    authBusy = false;
    renderAuth();
  } catch (err) {
    authBusy = false;
    authStep = "status";
    authError = `could not start the sign in: ${err.message}`;
    renderAuth();
  }
}

async function submitLoginCode(code) {
  if (!code.trim() || authBusy) return;

  authBusy = true;
  authError = "";
  renderAuth();

  try {
    applyAuthStatus(await window.hub.submitLoginCode(code));
    authBusy = false;
    authStep = "status";
    renderAuth();
    addNotice("signed in");
  } catch (err) {
    authBusy = false;
    authError = `that code did not work: ${err.message}`;
    renderAuth();
  }
}

async function saveAuthToken(token) {
  authBusy = true;
  authError = "";
  renderAuth();

  try {
    applyAuthStatus(await window.hub.setAuthToken(token));
    authBusy = false;
    authStep = "status";
    renderAuth();
    addNotice(token.trim() ? "token saved, new chats will use it" : "token forgotten");
  } catch (err) {
    authBusy = false;
    authError = `could not save that token: ${err.message}`;
    renderAuth();
  }
}

async function runLogout() {
  authBusy = true;
  renderAuth();

  try {
    applyAuthStatus(await window.hub.logout());
    addNotice("signed out");
  } catch (err) {
    authError = `could not sign out: ${err.message}`;
  }

  authBusy = false;
  renderAuth();
}

function openAuth() {
  if (!authModal) buildAuthModal();
  closeActiveModal();

  authStep = "status";
  authError = "";
  authBusy = false;
  renderAuth();

  authModal.modal.classList.remove("hidden");
  authModal.hidden = false;
  activeModal = authApi;
  refreshAuthStatus();
}

function closeAuth() {
  if (!authModal) return;
  authModal.modal.classList.add("hidden");
  authModal.hidden = true;
  if (activeModal === authApi) activeModal = null;
  if (authStep === "code") window.hub.cancelLogin().catch(() => {});
}

const authApi = { close: closeAuth };

let modelsPopulated = false;

function populateModels(models) {
  if (models.length === 0 || modelsPopulated) return;

  const options = [
    { value: "", label: "default model", description: "whatever the session already uses" },
  ];

  for (const model of models) {
    options.push({
      value: model.value,
      label: model.displayName || model.value,
      description: model.description || "",
      supportsEffort: model.supportsEffort !== false,
      effortLevels: model.supportedEffortLevels ?? null,
    });
  }

  modelSelect.setOptions(options);
  modelsPopulated = true;
  syncEffortAvailability();
}

function syncEffortAvailability() {
  const selected = modelSelect.selected;
  const supports = selected?.supportsEffort !== false;

  state.allowedEfforts = selected?.effortLevels ?? null;
  effortLadder.setDisabled(!supports, "this model does not support effort levels");
}

async function refreshContext() {
  let usage = null;
  try {
    usage = await window.hub.contextUsage(ACTIVE_CHAT_ID);
  } catch {
    usage = null;
  }

  if (!usage || !usage.maxTokens) {
    el.contextFill.style.width = "0%";
    el.contextFill.className = "";
    el.contextText.textContent = "context";
    return;
  }

  const percentage = Math.min(100, Math.round(usage.percentage ?? 0));
  el.contextFill.style.width = `${percentage}%`;
  el.contextFill.className = percentage >= 85 ? "hot" : percentage >= 60 ? "warn" : "";
  el.contextText.textContent = `context ${percentage}%`;
  el.contextText.title = `${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens`;
}

/* ---------- slash command palette ---------- */

/**
 * Handled here rather than forwarded to the CLI. Its own /login draws a
 * full-screen terminal UI that has nowhere to render inside this app, so
 * mortar drives `claude auth login` itself and shows the result in a modal.
 */
const LOCAL_COMMANDS = [
  { name: "login", description: "sign in to your anthropic account", local: openAuth },
  { name: "logout", description: "sign out of your anthropic account", local: openAuth },
];

function localCommand(text) {
  const name = text.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase();
  return LOCAL_COMMANDS.find((command) => command.name === name) ?? null;
}

function currentCommandQuery() {
  const value = el.input.value;
  const match = value.match(/^\/(\S*)$/);
  return match ? match[1].toLowerCase() : null;
}

function matchesQuery(command, queryText) {
  if (command.name.toLowerCase().startsWith(queryText)) return true;
  return (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(queryText));
}

function updatePalette() {
  const queryText = currentCommandQuery();

  if (queryText === null || state.commands.length === 0) {
    hidePalette();
    return;
  }

  state.paletteMatches = state.commands.filter((c) => matchesQuery(c, queryText)).slice(0, 40);

  if (state.paletteMatches.length === 0) {
    hidePalette();
    return;
  }

  state.paletteIndex = 0;
  renderPalette();
}

function renderPalette() {
  el.palette.replaceChildren();

  state.paletteMatches.forEach((command, index) => {
    const item = document.createElement("div");
    item.className = `command-item${index === state.paletteIndex ? " selected" : ""}`;

    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = `/${command.name}`;
    item.appendChild(name);

    if (command.argumentHint) {
      const hint = document.createElement("span");
      hint.className = "command-hint";
      hint.textContent = command.argumentHint;
      item.appendChild(hint);
    }

    const desc = document.createElement("span");
    desc.className = "command-desc";
    desc.textContent = command.description || "";
    item.appendChild(desc);

    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptCommand(index);
    });

    el.palette.appendChild(item);
  });

  el.palette.classList.remove("hidden");
  el.palette.children[state.paletteIndex]?.scrollIntoView({ block: "nearest" });
}

function hidePalette() {
  state.paletteMatches = [];
  el.palette.classList.add("hidden");
  el.palette.replaceChildren();
}

function movePalette(delta) {
  if (state.paletteMatches.length === 0) return;
  const count = state.paletteMatches.length;
  state.paletteIndex = (state.paletteIndex + delta + count) % count;
  renderPalette();
}

function acceptCommand(index = state.paletteIndex) {
  const command = state.paletteMatches[index];
  if (!command) return;
  el.input.value = command.argumentHint ? `/${command.name} ` : `/${command.name}`;
  hidePalette();
  autoResize();
  el.input.focus();
}

function setConnecting() {
  el.mcpDot.className = "dot dot-idle";
  el.mcpStatus.textContent = "studio: connecting…";
}

function setBusy(busy) {
  state.busy = busy;
  el.send.disabled = busy;
  el.interruptRow.classList.toggle("hidden", !busy);
  document.body.classList.toggle("is-working", busy);
}

async function sendMessage() {
  const text = el.input.value.trim();
  const attachments = state.attachments;

  if ((!text && attachments.length === 0) || state.busy) return;

  const local = text.startsWith("/") ? localCommand(text) : null;
  if (local) {
    el.input.value = "";
    hidePalette();
    autoResize();
    local.local();
    return;
  }

  const oversized = attachments.filter((item) => item.overLimit);
  if (oversized.length > 0) {
    addNotice(
      `${oversized.map((item) => item.name).join(", ")} exceeds the ${state.limitLabel} limit. Remove it to send.`,
      "error",
    );
    return;
  }

  const payload = attachments.map((item) => ({
    name: item.name,
    mime: item.mime,
    size: item.size,
    path: item.path,
    bytes: item.bytes,
  }));

  el.input.value = "";
  hidePalette();
  autoResize();
  addUserMessage(text, attachments);
  clearAttachments();
  setBusy(true);
  state.renderedThisTurn = false;

  try {
    await window.hub.send(ACTIVE_CHAT_ID, text, payload);
  } catch (err) {
    setBusy(false);
    addNotice(`could not send: ${err.message}`, "error");
  }
}

/* ---------- permission modal ---------- */

function showPermission(event) {
  state.permission = event;

  el.permTitle.textContent = event.title || "allow this action?";

  el.permBody.replaceChildren();

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = prettyToolName(event.toolName);
  el.permBody.appendChild(name);

  if (event.description) {
    const description = document.createElement("p");
    description.textContent = event.description;
    el.permBody.appendChild(description);
  }

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(event.input ?? {}, null, 2);
  el.permBody.appendChild(pre);

  el.permAlways.classList.toggle("hidden", (event.suggestions ?? []).length === 0);
  el.modal.classList.remove("hidden");
  el.permAllow.focus();
}

function hidePermission() {
  state.permission = null;
  el.modal.classList.add("hidden");
}

async function respondToPermission(decision) {
  const pending = state.permission;
  if (!pending) return;
  hidePermission();
  await window.hub.respondToPermission(ACTIVE_CHAT_ID, pending.requestId, decision);
}

/* ---------- agent events ---------- */

function handleEvent(event) {
  if (event.chatId !== ACTIVE_CHAT_ID) return;

  switch (event.kind) {
    case "init": {
      const server = (event.mcpServers ?? []).find((s) => s.name === MCP_SERVER_NAME);
      const connected = server?.status === "connected";
      el.mcpDot.className = `dot ${connected ? "dot-ok" : "dot-bad"}`;
      el.mcpStatus.textContent = connected
        ? "studio: connected"
        : `studio: ${server?.status ?? "not loaded"}`;
      break;
    }

    case "session-id":
      state.sessionId = event.sessionId;
      scheduleChatRefresh();
      break;

    case "text-delta": {
      const live = assistantBody();
      live.text += event.text;
      live.body.textContent = live.text;
      live.body.classList.add("streaming");
      scrollToBottom();
      break;
    }

    case "thinking-delta":
      appendThinking(event.text);
      break;

    case "assistant":
      renderAssistantBlocks(event.blocks ?? []);
      break;

    case "tool-start":
      upsertToolChip(event.id, event.name, undefined);
      break;

    case "tool-result":
      applyToolResult(event);
      break;

    case "command-output":
      addCommandOutput(event.text);
      break;

    case "compacted":
      addNotice(
        `context compacted (${event.trigger}${
          event.preTokens ? `, was ${event.preTokens.toLocaleString()} tokens` : ""
        })`,
      );
      refreshContext();
      break;

    case "permission-request":
      showPermission(event);
      break;

    case "auth-changed": {
      // Lapsing mid-session and never having signed in look the same in the
      // status payload, and only one of them is worth calling out as expired.
      const lapsed = state.auth?.loggedIn === true;
      applyAuthStatus(event.status);

      if (event.status.reachable && !event.status.loggedIn) {
        addNotice(
          lapsed
            ? "your claude login expired. type /login to sign back in."
            : "you are not signed in. type /login to get started.",
          "error",
        );
      }
      break;
    }

    case "mcp-updated":
      state.mcpVersion = event.version;
      syncMcpTitle();
      addNotice(`robloxstudio updated to ${event.version}, new chats will use it`);
      break;

    case "permission-cancelled":
      if (state.permission?.requestId === event.requestId) hidePermission();
      break;

    case "busy":
      setBusy(event.busy);
      break;

    case "result":
      setBusy(false);
      state.live = null;
      if (event.isError && event.text) {
        addNotice(event.text, "error");
      } else if (!state.renderedThisTurn && event.text?.trim()) {
        // Commands like /cost answer only through the result message.
        addCommandOutput(event.text);
      }
      scheduleChatRefresh();
      refreshContext();
      break;

    case "error":
      setBusy(false);
      addNotice(event.text, "error");
      break;

    case "stderr":
      console.warn("[claude stderr]", event.text);
      break;

    default:
      break;
  }
}

/* ---------- header control modals ---------- */

// Only one of these is ever open, and Escape / backdrop clicks go to whichever
// it is.
let activeModal = null;

function closeActiveModal() {
  if (!activeModal) return;
  activeModal.close();
}

function buildModalShell(className) {
  const modal = document.createElement("div");
  modal.className = `modal ${className} hidden`;

  const card = document.createElement("div");
  card.className = "modal-card ladder-card";

  const glow = document.createElement("div");
  glow.className = "modal-glow";
  glow.setAttribute("aria-hidden", "true");
  card.appendChild(glow);

  modal.appendChild(card);
  document.body.appendChild(modal);
  return { modal, card };
}

function buildHead(card, eyebrow) {
  const head = document.createElement("div");
  head.className = "ladder-head";

  const brow = document.createElement("span");
  brow.className = "ladder-eyebrow";
  brow.textContent = eyebrow;

  const name = document.createElement("span");
  name.className = "ladder-name";

  head.append(brow, name);
  card.appendChild(head);
  return name;
}

const THUMB_WIDTH = 16;

/** Keeps a percentage aligned with the native thumb, which insets at the ends. */
function trackOffset(percent) {
  return `calc(${percent}% + ${(THUMB_WIDTH / 2 - (percent / 100) * THUMB_WIDTH).toFixed(2)}px)`;
}

/**
 * A draggable number line for settings that are genuinely a magnitude. Effort
 * and permission mode both are; the model list is not, which is why that one
 * uses createPicker instead.
 */
function createLadder(config) {
  const trigger = document.getElementById(config.triggerId);
  const pip = trigger.querySelector(".pill-pip");
  const pillLabel = trigger.querySelector(".pill-label");

  const { modal, card } = buildModalShell("ladder-modal");
  const nameEl = buildHead(card, config.eyebrow);

  const blurb = document.createElement("p");
  blurb.className = "ladder-blurb";

  const line = document.createElement("div");
  line.className = "ladder-line";

  const track = document.createElement("div");
  track.className = "ladder-track";
  const fill = document.createElement("div");
  fill.className = "ladder-fill";
  track.appendChild(fill);

  const range = document.createElement("input");
  range.type = "range";
  range.className = "ladder-range";
  range.min = "0";
  range.max = String(config.levels.length - 1);
  range.step = "1";
  range.setAttribute("aria-label", config.eyebrow);

  const ticks = document.createElement("div");
  ticks.className = "ladder-ticks";

  line.append(track, range, ticks);

  const note = document.createElement("p");
  note.className = "ladder-note hidden";

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  if (config.unsetLabel) {
    const reset = document.createElement("button");
    reset.textContent = config.unsetLabel;
    reset.addEventListener("click", () => {
      setValue("");
      config.onChange("");
      close();
    });
    actions.appendChild(reset);
  }

  const done = document.createElement("button");
  done.className = "btn-allow";
  done.textContent = "done";
  done.addEventListener("click", () => close());
  actions.appendChild(done);

  card.append(blurb, line, note, actions);

  let value = config.value ?? "";

  config.levels.forEach((level, index) => {
    const percent = (index / (config.levels.length - 1)) * 100;

    const tick = document.createElement("button");
    tick.className = "ladder-tick";
    tick.dataset.index = String(index);
    tick.style.left = trackOffset(percent);

    const mark = document.createElement("span");
    mark.className = "ladder-tick-mark";
    const text = document.createElement("span");
    text.className = "ladder-tick-label";
    text.textContent = level.label;

    tick.append(mark, text);
    tick.addEventListener("click", () => {
      range.value = String(index);
      preview(index);
      commit();
    });

    ticks.appendChild(tick);
  });

  function indexOf(target) {
    const found = config.levels.findIndex((level) => level.value === target);
    return found === -1 ? config.defaultIndex : found;
  }

  /** Visual only, so dragging does not fire a control request per pixel. */
  function preview(index) {
    const level = config.levels[index];
    const percent = (index / (config.levels.length - 1)) * 100;

    fill.style.width = trackOffset(percent);
    nameEl.textContent = level.label;
    blurb.textContent = level.blurb;
    card.className = `modal-card ladder-card tier-${level.tier}`;

    for (const tick of ticks.children) {
      const at = Number(tick.dataset.index);
      tick.classList.toggle("reached", at <= index);
      tick.classList.toggle("current", at === index);
    }

    const text = config.noteFor?.(level) ?? null;
    note.classList.toggle("hidden", !text);
    if (text) note.textContent = text;
  }

  function commit() {
    const next = config.levels[Number(range.value)].value;
    if (next === value) return;
    setValue(next);
    config.onChange(next);
  }

  function setValue(next) {
    value = next;
    const level = config.levels.find((l) => l.value === next);
    pillLabel.textContent = level ? level.label : config.unsetPillLabel;
    trigger.className = `pill-trigger${level ? ` is-set tier-${level.tier}` : ""}`;
    pip.className = "pill-pip";
  }

  function open() {
    if (trigger.disabled) return;
    closeActiveModal();

    const index = indexOf(value);
    range.value = String(index);
    preview(index);

    const blocked = config.blockedValues?.() ?? [];
    for (const tick of ticks.children) {
      const level = config.levels[Number(tick.dataset.index)];
      tick.classList.toggle("unsupported", blocked.includes(level.value));
    }

    modal.classList.remove("hidden");
    activeModal = api;
    range.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (activeModal === api) activeModal = null;
  }

  range.addEventListener("input", () => preview(Number(range.value)));
  range.addEventListener("change", commit);
  trigger.addEventListener("click", open);
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) close();
  });

  const api = {
    get value() {
      return value;
    },
    setValue,
    setDisabled(disabled, reason) {
      trigger.disabled = disabled;
      trigger.title = disabled ? reason : config.eyebrow;
      if (disabled) close();
    },
    close,
  };

  trigger.title = config.eyebrow;
  setValue(value);
  return api;
}

/**
 * For settings with no ordering. Same modal shell and open animation as the
 * ladder, but a list you pick from rather than an axis you drag along.
 */
function createPicker(config) {
  const trigger = document.getElementById(config.triggerId);
  const pillLabel = trigger.querySelector(".pill-label");

  const { modal, card } = buildModalShell("picker-modal");
  const nameEl = buildHead(card, config.eyebrow);

  const list = document.createElement("div");
  list.className = "picker-list";
  card.appendChild(list);

  let options = config.options ?? [];
  let value = config.value ?? "";
  let focusIndex = 0;

  function render() {
    list.replaceChildren();

    options.forEach((option, index) => {
      const row = document.createElement("button");
      row.className = "picker-row";
      row.classList.toggle("selected", option.value === value);
      row.classList.toggle("focused", index === focusIndex);

      const check = document.createElement("span");
      check.className = "picker-check";
      if (option.value === value) check.appendChild(icon("check", 14));

      const body = document.createElement("span");
      body.className = "picker-body";

      const label = document.createElement("span");
      label.className = "picker-label";
      label.textContent = option.label;
      body.appendChild(label);

      if (option.description) {
        const description = document.createElement("span");
        description.className = "picker-desc";
        description.textContent = option.description;
        body.appendChild(description);
      }

      row.append(check, body);
      row.addEventListener("click", () => choose(index));
      list.appendChild(row);
    });
  }

  function choose(index) {
    const option = options[index];
    close();
    if (!option || option.value === value) return;
    setValue(option.value);
    config.onChange(option.value, option);
  }

  function setValue(next) {
    value = next;
    const option = options.find((o) => o.value === next);
    pillLabel.textContent = option?.label ?? config.unsetPillLabel;
    trigger.className = `pill-trigger${next ? " is-set" : ""}`;
    nameEl.textContent = option?.label ?? config.unsetPillLabel;
  }

  function open() {
    if (trigger.disabled) return;
    closeActiveModal();

    focusIndex = Math.max(0, options.findIndex((o) => o.value === value));
    nameEl.textContent = options.find((o) => o.value === value)?.label ?? config.unsetPillLabel;
    render();

    modal.classList.remove("hidden");
    activeModal = api;
    list.children[focusIndex]?.focus();
  }

  function close() {
    modal.classList.add("hidden");
    if (activeModal === api) activeModal = null;
  }

  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusIndex = (focusIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    render();
    list.children[focusIndex]?.focus();
  });

  trigger.addEventListener("click", open);
  modal.addEventListener("mousedown", (event) => {
    if (event.target === modal) close();
  });

  const api = {
    get value() {
      return value;
    },
    get selected() {
      return options.find((option) => option.value === value) ?? null;
    },
    setOptions(next) {
      options = next;
      if (!options.some((option) => option.value === value)) {
        value = options[0]?.value ?? "";
      }
      setValue(value);
    },
    setValue,
    close,
  };

  trigger.title = config.eyebrow;
  setValue(value);
  return api;
}

/* ---------- the three header controls ---------- */

const modelSelect = createPicker({
  triggerId: "model-trigger",
  eyebrow: "model",
  unsetPillLabel: "default model",
  options: [{ value: "", label: "default model" }],
  onChange: (value) => {
    syncEffortAvailability();
    window.hub.setModel(ACTIVE_CHAT_ID, value || undefined);
  },
});

// The SDK's ladder is low..max; there is no tier above max. Anything a model
// cannot honour is silently downgraded, which is why unsupported stops are
// struck through rather than hidden.
const EFFORT_LEVELS = [
  { value: "low", tier: "low", label: "low", blurb: "minimal thinking, fastest replies. good for scoped edits." },
  { value: "medium", tier: "medium", label: "medium", blurb: "moderate thinking. fine for routine work." },
  { value: "high", tier: "high", label: "high", blurb: "deep reasoning. the sensible default for real work." },
  { value: "xhigh", tier: "xhigh", label: "extra high", blurb: "deeper than high. worth it for gnarly bugs and long runs." },
  { value: "max", tier: "max", label: "max", blurb: "everything it has. correctness over cost, and slow." },
];

// Ordered by how much Claude can do without stopping to ask.
const PERMISSION_LEVELS = [
  { value: "plan", tier: "plan", label: "plan only", blurb: "thinks it through and writes nothing. safe to leave running." },
  { value: "default", tier: "ask", label: "ask first", blurb: "prompts before edits and commands. the sane default." },
  { value: "acceptEdits", tier: "edits", label: "auto-accept edits", blurb: "file edits go through on their own. commands still ask." },
  { value: "bypassPermissions", tier: "open", label: "allow everything", blurb: "no prompts at all. it can edit and run whatever it likes." },
];

const effortLadder = createLadder({
  triggerId: "effort-trigger",
  eyebrow: "reasoning effort",
  levels: EFFORT_LEVELS,
  defaultIndex: 2,
  value: "",
  unsetPillLabel: "default effort",
  unsetLabel: "use model default",
  blockedValues: () => {
    const allowed = state.allowedEfforts;
    if (allowed === null) return [];
    return EFFORT_LEVELS.filter((l) => !allowed.includes(l.value)).map((l) => l.value);
  },
  noteFor: (level) => {
    const allowed = state.allowedEfforts;
    if (allowed === null || allowed.includes(level.value)) return null;
    const model = modelSelect.selected?.label ?? "this model";
    return `${model} does not offer ${level.label}, so it falls back to its highest.`;
  },
  onChange: async (value) => {
    state.effort = value;
    try {
      await window.hub.setEffort(ACTIVE_CHAT_ID, value || undefined);
    } catch (err) {
      addNotice(`could not change effort: ${err.message}`, "error");
    }
  },
});

const permissionSelect = createLadder({
  triggerId: "permission-trigger",
  eyebrow: "permission mode",
  levels: PERMISSION_LEVELS,
  defaultIndex: 1,
  value: "default",
  unsetPillLabel: "ask first",
  onChange: (value) => window.hub.setPermissionMode(ACTIVE_CHAT_ID, value),
});

/* ---------- wiring ---------- */

function autoResize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

el.input.addEventListener("input", () => {
  autoResize();
  updatePalette();
});

el.input.addEventListener("blur", hidePalette);

el.input.addEventListener("keydown", (event) => {
  const paletteOpen = state.paletteMatches.length > 0;

  if (paletteOpen) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePalette(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      movePalette(-1);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      acceptCommand();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hidePalette();
      return;
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

el.send.addEventListener("click", sendMessage);

el.attach.addEventListener("click", async () => {
  try {
    const picked = await window.hub.pickAttachments();
    for (const info of picked) {
      const thumbnail = info.mime.startsWith("image/")
        ? await window.hub.thumbnail(info.path).catch(() => null)
        : null;
      addAttachment({ ...info, thumbnail });
    }
  } catch (err) {
    addNotice(`could not attach files: ${err.message}`, "error");
  }
});

/**
 * Bound to the window rather than the composer: after copying something in
 * Explorer your cursor is rarely already in the text box. Other text fields
 * still get their own paste, so this only claims the event when the target is
 * not somewhere you could be typing.
 */
window.addEventListener("paste", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if (typing && target !== el.input) return;

  const items = [...(event.clipboardData?.files ?? [])];
  if (items.length === 0) return;

  event.preventDefault();
  attachPastedFiles(items);
});

// Drag events fire per-element, so count enter/leave to know when we truly left.
window.addEventListener("dragenter", (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  state.dragDepth += 1;
  el.dropOverlay.classList.remove("hidden");
});

window.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) el.dropOverlay.classList.add("hidden");
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  el.dropOverlay.classList.add("hidden");

  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) attachDroppedFiles(files);
});

el.interrupt.addEventListener("click", () => window.hub.interrupt(ACTIVE_CHAT_ID));

el.newChat.addEventListener("click", newChat);

el.search.addEventListener("input", () => {
  state.query = el.search.value.trim().toLowerCase();
  renderChatList();
});

el.search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    el.search.value = "";
    state.query = "";
    renderChatList();
    el.search.blur();
  }
});

el.searchClear.addEventListener("click", () => {
  el.search.value = "";
  state.query = "";
  renderChatList();
  el.search.focus();
});

el.dialogConfirm.addEventListener("click", () => {
  const wantsInput = !el.dialogInput.classList.contains("hidden");
  closeDialog(wantsInput ? el.dialogInput.value : true);
});

el.dialogCancel.addEventListener("click", () => closeDialog(null));

el.dialog.addEventListener("mousedown", (event) => {
  if (event.target === el.dialog) closeDialog(null);
});

el.dialogInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    closeDialog(el.dialogInput.value);
  }
});

window.addEventListener("mousedown", (event) => {
  if (state.menuSessionId && !el.contextMenu.contains(event.target)) closeContextMenu();
});

window.addEventListener("blur", closeContextMenu);
el.chatList.addEventListener("scroll", closeContextMenu);

el.projectPicker.addEventListener("click", async () => {
  const dir = await window.hub.pickProjectDir();
  if (dir === state.projectDir) return;
  state.projectDir = dir;
  el.projectName.textContent = dir.split(/[\\/]/).pop() || dir;
  el.projectPicker.title = dir;
  await refreshChats();
  await newChat();
});

el.chatTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.chatTitle.blur();
  }
});

el.chatTitle.addEventListener("blur", async () => {
  const title = el.chatTitle.value.trim();
  if (!title || !state.sessionId) return;
  try {
    await window.hub.renameChat(state.sessionId, title, state.projectDir);
    await refreshChats();
  } catch (err) {
    console.error("rename failed", err);
  }
});

el.permAllow.addEventListener("click", () => respondToPermission({ behavior: "allow" }));

el.permDeny.addEventListener("click", () =>
  respondToPermission({ behavior: "deny", message: "The user denied this action." }),
);

el.permAlways.addEventListener("click", () =>
  respondToPermission({
    behavior: "allow",
    updatedPermissions: state.permission?.suggestions ?? [],
  }),
);

el.lightboxClose.addEventListener("click", closeLightbox);
el.lightboxSave.addEventListener("click", saveCapture);
el.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
el.lightboxNext.addEventListener("click", () => stepLightbox(1));

el.lightbox.addEventListener("mousedown", (event) => {
  // Backdrop only — clicking the image itself should never dismiss it.
  if (event.target === el.lightbox || event.target === el.lightboxStage) closeLightbox();
});

/**
 * A packaged app gives the user no devtools, so a thrown error would otherwise
 * just be a UI that quietly stopped working. Surface it and write it to the log.
 */
function reportCrash(what, detail) {
  const message = detail?.stack ?? detail?.message ?? String(detail);
  window.hub.logMessage?.("error", `${what}: ${message}`).catch(() => {});
  addNotice(`something broke: ${detail?.message ?? what}. the log has details.`, "error");
}

window.addEventListener("error", (event) => reportCrash("uncaught error", event.error ?? event));
window.addEventListener("unhandledrejection", (event) =>
  reportCrash("unhandled rejection", event.reason),
);

document.addEventListener("keydown", (event) => {
  // A permission prompt renders above the lightbox, so it owns Escape first.
  if (state.lightbox && !state.permission && !dialogResolve) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLightbox();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
  }

  if (event.key === "Escape") {
    if (activeModal) {
      closeActiveModal();
      return;
    }
    if (state.menuSessionId) {
      closeContextMenu();
      return;
    }
    if (dialogResolve) {
      closeDialog(null);
      return;
    }
    if (state.permission) {
      respondToPermission({ behavior: "deny", message: "The user dismissed the prompt." });
    }
    return;
  }

  const accel = event.ctrlKey || event.metaKey;
  if (!accel) return;

  if (event.key === "k") {
    event.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (event.key === "n") {
    event.preventDefault();
    newChat();
  } else if (event.key === "f") {
    event.preventDefault();
    el.search.focus();
    el.search.select();
  }
});

window.hub.onEvent(handleEvent);

(async function init() {
  try {
    const limit = await window.hub.attachmentLimit();
    state.limitBytes = limit.bytes;
    state.limitLabel = limit.label;
    el.dropLimit.textContent = `up to ${limit.label} per file`;
  } catch {
    // Defaults already match the main-process constant.
  }

  loadAppInfo();
  el.accountRow.addEventListener("click", openAuth);
  refreshAuthStatus();

  state.projectDir = await window.hub.getProjectDir();
  el.projectName.textContent = state.projectDir.split(/[\\/]/).pop() || state.projectDir;
  el.projectPicker.title = state.projectDir;

  await loadFolders();
  await refreshChats();
  await newChat();
})();
