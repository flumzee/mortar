import { spawn } from "node:child_process";

/**
 * Wraps the CLI's own `claude auth` subcommands. Nothing here reimplements
 * OAuth: the CLI already owns the credential store, the refresh cycle, and the
 * platform keychain, so mortar drives the same binary the terminal would and
 * inherits every future change to it for free.
 *
 * `auth login` is the only interactive piece, and it stays drivable without a
 * TTY: it writes the authorize URL to stdout and then reads the pasted code
 * from stdin. `setup-token` is not usable this way (it renders a full-screen
 * TTY UI and emits nothing when piped), so long-lived tokens are pasted in.
 */

const STATUS_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const URL_PATTERN = /(https:\/\/\S*oauth\/authorize\?\S+)/;

// OSC 8 hyperlinks wrap the URL in escape sequences, and the closing sequence
// is not whitespace, so the greedy \S+ above swallows it without this.
const OSC = /\]8;;.*?/g;

let cliPath = "claude";
let storedToken = null;

export function setAuthCli(executable) {
  if (executable) cliPath = executable;
}

/** The CLI reads this from its environment on every spawn. */
export function setAuthToken(token) {
  storedToken = token || null;
}

export function getAuthToken() {
  return storedToken;
}

/** Layered onto process.env for both the SDK and the auth subcommands. */
export function authEnv() {
  return storedToken ? { CLAUDE_CODE_OAUTH_TOKEN: storedToken } : {};
}

function run(args, { timeout = STATUS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...authEnv() },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude ${args.join(" ")} timed out`));
    }, timeout);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
  });
}

/**
 * Shape comes straight from the CLI, so new fields appear without changes here.
 * A non-zero exit means "cannot tell", which is not the same as "signed out" —
 * reporting the difference keeps the UI from nagging over a transient failure.
 */
export async function AuthStatus() {
  try {
    const raw = await run(["auth", "status", "--json"]);
    const parsed = JSON.parse(raw);
    return { ...parsed, usingToken: Boolean(storedToken), reachable: true };
  } catch (err) {
    return {
      loggedIn: false,
      reachable: false,
      usingToken: Boolean(storedToken),
      error: err?.message ?? String(err),
    };
  }
}

export function Logout() {
  return run(["auth", "logout"]).then(() => true);
}

/**
 * A login in flight. The CLI prints the URL, waits on stdin for the code, and
 * exits once it has written credentials, so the caller gets the URL first and
 * submits the code whenever the user has it.
 */
class LoginFlow {
  constructor(mode) {
    this.output = "";
    this.settled = false;

    const args = ["auth", "login"];
    if (mode === "console") args.push("--console");

    // A stored long-lived token would satisfy the CLI before it ever starts the
    // browser flow, so this one spawn deliberately runs without it.
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    this.child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    this.url = new Promise((resolve, reject) => {
      this.resolveUrl = resolve;
      this.rejectUrl = reject;
    });
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });

    // Whichever of the two the caller does not await would otherwise surface as
    // an unhandled rejection when a login is cancelled.
    this.url.catch(() => {});
    this.done.catch(() => {});

    this.timer = setTimeout(() => this.Cancel("login timed out"), LOGIN_TIMEOUT_MS);

    const read = (chunk) => {
      this.output += chunk;
      const match = this.output.replace(OSC, "").match(URL_PATTERN);
      if (match) this.resolveUrl(match[1]);
    };

    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);

    this.child.on("error", (err) => this.fail(err));
    this.child.on("close", (code) => {
      clearTimeout(this.timer);
      if (this.settled) return;
      this.settled = true;

      if (code === 0) {
        this.resolveDone(true);
      } else {
        const reason = this.output.replace(OSC, "").trim().split("\n").pop();
        this.rejectDone(new Error(reason || `login exited ${code}`));
      }
      this.rejectUrl(new Error("login ended before a url appeared"));
    });
  }

  fail(err) {
    clearTimeout(this.timer);
    if (this.settled) return;
    this.settled = true;
    this.rejectUrl(err);
    this.rejectDone(err);
  }

  SubmitCode(code) {
    if (this.settled) throw new Error("that login is no longer waiting for a code");
    this.child.stdin.write(`${String(code).trim()}\n`);
    return this.done;
  }

  Cancel(reason = "login cancelled") {
    if (this.settled) return;
    this.child.kill();
    this.fail(new Error(reason));
  }
}

export function StartLogin(mode) {
  return new LoginFlow(mode);
}
