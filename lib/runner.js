/**
 * Binary resolution and process execution for dsh-tool-ast-grep.
 *
 * Split out of index.js so the resolution/execution logic has no dependency on
 * `@deepseek-ai/dsh-tools` and can be unit-tested directly.
 *
 * ## Why this exists
 *
 * On Windows, Node >= 20 refuses to `execFile` a `.cmd`/`.bat` file (the
 * CVE-2024-27980 mitigation): the spawn fails with `EINVAL` and no friendly
 * explanation. An `npm install -g @ast-grep/cli` on Windows puts
 * `...\npm\ast-grep.cmd` on PATH, and the package's real executable lives at
 * `node_modules\@ast-grep\cli\ast-grep.exe`. The old resolver returned the
 * `.cmd` path and passed it straight to `execFile`, so every tool call failed
 * with an opaque `spawn EINVAL`.
 *
 * ## Strategy (no blanket `shell: true`)
 *
 * 1. Prefer a real native executable: `ast-grep.exe` wherever it can be found.
 * 2. If we only have a Windows npm `.cmd` shim, read the shim and execute the
 *    native executable it wraps — still no shell involved.
 * 3. Only if the shim cannot be parsed do we fall back to `cmd.exe /d /s /c
 *    <shim>`, an argv-based spawn with the shim as an ordinary argument.
 *    `shell: true` is never used, so no other command's shell-execution
 *    surface grows.
 * 4. Non-Windows platforms never enter any of this: the resolver returns
 *    `ast-grep` and the caller spawns it directly, exactly as before.
 * @module dsh-tool-ast-grep/runner
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

/** Diagnostic text appended to every Windows EINVAL failure. */
const EINVAL_HINT =
  "This usually means a shell shim (a .cmd/.bat file) was passed to execFile, which Node >= 20 refuses to execute directly. " +
  "Install a native executable so a real ast-grep.exe is used:\n" +
  "- npm:   npm install -g @ast-grep/cli   (then ensure node_modules/@ast-grep/cli/ast-grep.exe exists)\n" +
  "- cargo: cargo install ast-grep --locked\n" +
  "- or point the tool at a real binary directory on PATH.";

/**
 * Pick the path flavour to use for a simulated platform.
 *
 * Windows path rules are applied to `.cmd`/`.exe` inputs even when the tests
 * run on Linux, so shim handling is exercised identically everywhere.
 * @param platform - the platform being simulated.
 * @param override - explicit override from `deps.winPath`.
 * @returns a `path`-compatible module.
 */
function pathFor(platform, override) {
  if (override) return override;
  return platform === "win32" ? path.win32 : path;
}

/**
 * Split the npm-generated `.cmd` wrapper enough to find the file it runs.
 *
 * npm shims look like:
 *   "%_prog%"  "%dp0%\node_modules\@ast-grep\cli\ast-grep" %*
 * with `SET dp0=%~dp0` above it. The quoted paths are what we need; `%_prog%`
 * and `%*` are ignored.
 * @param text - contents of the `.cmd` file.
 * @returns the wrapper's own directory (its `%dp0%`) and the wrapped target paths.
 */
export function parseCmdShim(text) {
  const dp0 = text.match(/SET\s+dp0=([^\r\n]+)/i)?.[1]?.trim().replace(/^"|"$/g, "");
  const quoted = [...text.matchAll(/"([^"\r\n]+)"/g)]
    .map((m) => m[1])
    .filter(
      (token) => !token.includes("%_prog%") && !token.includes("%*") && !/^%~?dp0%?$/i.test(token)
    );
  return { dp0, quoted };
}

/**
 * Resolve a `.cmd` shim to a real executable, if one can be found.
 *
 * npm's Windows shim names the executable *without* an extension even when the
 * real file is `.exe`, so a bare `existsSync` on the parsed path is not enough.
 * @param shimPath - absolute path to the `.cmd` shim.
 * @param deps - injected platform/fs/env for testing.
 * @returns an absolute path to a real executable, or `null` when the shim names none.
 */
function nativeTargetFromCmdShim(shimPath, deps) {
  const platform = deps.platform ?? process.platform;
  const p = pathFor(platform, deps.winPath);
  const env = deps.env ?? {};
  let text;
  try {
    text = (deps.fs ?? fs).readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const { quoted } = parseCmdShim(text);
  // `%dp0%` is a batch variable, not a literal: cmd.exe sets it to
  // `%~dp0` — the directory holding the shim — when the script runs. The raw
  // file never contains the resolved path, so it must come from the shim's own
  // location, not from parsing the text.
  const base = p.dirname(shimPath);

  for (const token of quoted) {
    const raw = token
      .replace(/%~?dp0%?/gi, base)
      .replace(/%([^%]+)%/g, (_all, varName) => env[varName] ?? "");
    if (!raw || raw.includes("%")) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const absolute = p.isAbsolute(trimmed) ? p.normalize(trimmed) : p.resolve(base, trimmed);
    // A bare name (no directory) is not a usable wrapper target.
    const dir = p.dirname(absolute);
    if (!dir || dir === ".") continue;

    for (const candidate of p.extname(absolute) ? [absolute] : [absolute, absolute + ".exe"]) {
      let stat;
      try {
        stat = (deps.fs ?? fs).statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // Never hand back another command shim: that is the problem we are fixing.
      if (/\.(cmd|bat)$/i.test(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * Turn a resolved binary path into an executable target.
 *
 * On Windows a `.cmd`/`.bat` is redirected to the native executable it wraps,
 * or — when the shim cannot be parsed — to `cmd.exe /d /s /c <shim>`. On every
 * other platform this is the identity function.
 * @param binary - path (or bare name) the resolver chose.
 * @param deps - injected platform/fs/env for testing.
 * @returns how to launch it: a command plus any argv prefix.
 */
export function resolveExecTarget(binary, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const isShellShim = /\.(cmd|bat)$/i.test(binary);

  if (platform !== "win32" || !isShellShim) {
    return { command: binary, prefixArgs: [], viaShim: false, unwrapped: false };
  }

  const native = nativeTargetFromCmdShim(binary, deps);
  if (native) {
    return { command: native, prefixArgs: [], viaShim: true, unwrapped: true };
  }

  // Last resort: run the shim through cmd.exe rather than opening a shell for
  // arbitrary commands. cmd.exe receives the shim as an ordinary argument, and
  // `shell: true` is never set.
  const env = deps.env ?? {};
  const comSpec = env.ComSpec || env.COMSPEC || "cmd.exe";
  return { command: comSpec, prefixArgs: ["/d", "/s", "/c", binary], viaShim: true, unwrapped: false };
}

/**
 * Build the ordered candidate list for the ast-grep executable.
 * @param deps - injected platform/env for testing.
 * @returns candidate paths, most-preferred first.
 */
export function binaryCandidates(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;

  // 1. Explicit environment variable override takes absolute precedence
  const explicit = env.AST_GREP_PATH || env.AST_GREP_BIN;
  if (explicit) {
    return [explicit];
  }

  if (platform !== "win32") {
    // Unchanged from the original implementation for Linux/macOS.
    return ["ast-grep"];
  }

  const p = pathFor(platform, deps.winPath);
  const userProfile = env.USERPROFILE || "";
  const localAppData = env.LOCALAPPDATA || "";
  const appData = env.APPDATA || (userProfile ? p.join(userProfile, "AppData", "Roaming") : "");

  const pythonScripts = ["313", "312", "311"].flatMap((v) => [
    p.join(userProfile, "AppData", "Local", "Programs", "Python", `Python${v}`, "Scripts", "ast-grep.exe"),
    p.join(localAppData, "Programs", "Python", `Python${v}`, "Scripts", "ast-grep.exe"),
  ]);

  // Dynamic candidate roots from PATH and npm config prefix.
  // This automatically covers custom npm prefix (e.g. D:\nodejs\node_global)
  // as well as nvm, fnm, scoop, choco, etc.
  const pathDirs = [];
  const rawPath = env.PATH || env.Path || "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const dir of rawPath.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (trimmed && !pathDirs.includes(trimmed)) {
      pathDirs.push(trimmed);
    }
  }

  if (env.npm_config_prefix) {
    const customPrefix = env.npm_config_prefix.trim().replace(/^"|"$/g, "");
    if (customPrefix && !pathDirs.includes(customPrefix)) {
      pathDirs.push(customPrefix);
    }
  }

  // Default npm root if APPDATA is present, plus all discovered path roots
  const defaultNpmRoot = appData ? p.join(appData, "npm") : "";
  const npmRoots = [];
  if (defaultNpmRoot) npmRoots.push(defaultNpmRoot);
  for (const dir of pathDirs) {
    if (!npmRoots.includes(dir)) {
      npmRoots.push(dir);
    }
  }

  // Native executables first, ordered so:
  // 1) Cargo bin
  // 2) Python scripts
  // 3) Native exes in npm roots (both default %APPDATA%\npm and any PATH/custom prefix directories)
  const nativeFromNpm = npmRoots.flatMap((root) => [
    p.join(root, "node_modules", "@ast-grep", "cli", "ast-grep.exe"),
    p.join(
      root,
      "node_modules", "@ast-grep", "cli",
      "node_modules", "@ast-grep", "cli-win32-x64-msvc",
      "ast-grep.exe"
    ),
    p.join(root, "ast-grep.exe"),
  ]);

  const nativeCandidates = [
    p.join(userProfile, ".cargo", "bin", "ast-grep.exe"),
    ...pythonScripts,
    ...nativeFromNpm,
  ];

  // Shell shims come last and are only reached when no native binary exists anywhere
  const shimCandidates = npmRoots.map((root) => p.join(root, "ast-grep.cmd"));

  // Deduplicate while preserving precedence
  const seen = new Set();
  const ordered = [];
  for (const cand of ["ast-grep.exe", ...nativeCandidates, ...shimCandidates]) {
    if (!seen.has(cand)) {
      seen.add(cand);
      ordered.push(cand);
    }
  }

  return ordered;
}

/**
 * Probe existence through an injected fs-like object or the real fs.
 * @param fsLike - optional injected fs.
 * @param target - path to test.
 * @returns whether the path exists.
 */
function existsSyncSafe(fsLike, target) {
  const impl = fsLike ?? fs;
  try {
    return typeof impl.existsSync === "function" ? impl.existsSync(target) : false;
  } catch {
    return false;
  }
}

/** Does this candidate look like an absolute Windows path we can probe? */
function isProbeablePath(candidate, p) {
  return p.isAbsolute(candidate) || /[\\/]/.test(candidate);
}

/**
 * Resolve which ast-grep executable to use.
 *
 * Returns the first candidate that exists on disk. A Windows `.cmd` shim is
 * returned as-is only when nothing better was found: {@link resolveExecTarget}
 * then unwraps it. The result is memoized unless `deps.cache === false`.
 * @param deps - injected platform/env/fs for testing.
 * @returns the chosen binary path or bare name.
 */
export function resolveBinary(deps = {}) {
  const useCache = deps.cache !== false;
  if (useCache && resolveBinary.cached) return resolveBinary.cached;

  const platform = deps.platform ?? process.platform;
  const p = pathFor(platform, deps.winPath);
  const candidates = binaryCandidates({ platform, env: deps.env, winPath: deps.winPath });

  let chosen = candidates[0];
  let found = false;
  if (platform === "win32") {
    for (const cand of candidates) {
      if (!isProbeablePath(cand, p)) continue; // bare name: left to PATH lookup
      if (existsSyncSafe(deps.fs, cand)) {
        chosen = cand;
        found = true;
        break;
      }
    }
  } else if (isProbeablePath(chosen, p)) {
    found = existsSyncSafe(deps.fs, chosen);
  }

  // Only cache when a verified existing target was found.
  // Avoid caching a bare fallback name so subsequent attempts in the same
  // process can re-probe once the binary is installed.
  if (useCache && found) resolveBinary.cached = chosen;
  return chosen;
}

/** Clear the memoized binary so a re-resolve can observe a changed environment. */
export function resetBinaryCache() {
  resolveBinary.cached = null;
}

/**
 * Translate a spawn failure into an actionable Error.
 *
 * ENOENT and Windows EINVAL get explicit messages; everything else keeps the
 * original `ast-grep execution failed: <stderr|message>` shape.
 * @param err - the error thrown by execFile.
 * @param deps - injected platform for testing.
 * @returns the Error to throw.
 */
export function classifySpawnError(err, deps = {}) {
  const platform = deps.platform ?? process.platform;

  if (err?.name === "AbortError") return err;

  if (err?.code === "ENOENT" || err?.message?.includes("ENOENT")) {
    return new Error(
      "ast-grep binary was not found in PATH or standard directories.\n" +
        "Please install ast-grep to use this plugin:\n" +
        "- npm:  npm install -g @ast-grep/cli\n" +
        "- pip:  pip install ast-grep-cli\n" +
        "- cargo: cargo install ast-grep --locked\n" +
        "- brew: brew install ast-grep (macOS/Linux)"
    );
  }

  if (platform === "win32" && err?.code === "EINVAL") {
    const attempted = err.__attemptedBinary ? `\nBinary that failed: ${err.__attemptedBinary}` : "";
    return new Error(`ast-grep could not be executed (spawn EINVAL) on Windows.\n${EINVAL_HINT}${attempted}`);
  }

  const errText = err?.stderr?.trim() || err?.message;
  return new Error(`ast-grep execution failed: ${errText}`);
}

/**
 * Run ast-grep and return its raw stdout.
 *
 * A non-zero exit that still produced a JSON array is a "no matches" result,
 * not a failure — that behaviour is unchanged.
 * @param args - argv for ast-grep.
 * @param cwd - working directory for the child process.
 * @param signal - caller's abort signal.
 * @param timeoutMs - execution timeout.
 * @param deps - injected platform/env/fs/exec for testing.
 * @returns ast-grep's stdout, or `"[]"` when it printed nothing.
 */
export async function runAstGrep(args, cwd, signal, timeoutMs = 60000, deps = {}) {
  const binary = deps.binary ?? resolveBinary(deps);
  const target = resolveExecTarget(binary, deps);
  const argv = [...target.prefixArgs, ...args];
  const exec = deps.execFileAsync ?? execFileAsync;

  try {
    const res = await exec(target.command, argv, {
      cwd,
      signal,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return res.stdout || "[]";
  } catch (err) {
    if (err?.code === 1 && typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
      return err.stdout;
    }
    if (err && typeof err === "object" && err.__attemptedBinary === undefined) {
      err.__attemptedBinary = target.command === binary ? binary : `${binary} -> ${target.command}`;
    }
    throw classifySpawnError(err, deps);
  }
}
