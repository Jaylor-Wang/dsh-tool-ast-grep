/**
 * Regression tests for ast-grep binary resolution and execution.
 *
 * The headline case: on Windows, `npm i -g @ast-grep/cli` puts a `.cmd` shim on
 * PATH, and Node >= 20 refuses to `execFile` a `.cmd`/`.bat` (the CVE-2024-27980
 * mitigation) and raises EINVAL. The resolver must prefer a real executable and,
 * failing that, unwrap the shim rather than handing it to `execFile`.
 *
 * Every case is exercised through an injected `platform`/`env`/`fs`, so the
 * Windows behaviour is asserted on any host. The search/outline cases skip
 * themselves when no real ast-grep binary is available.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  binaryCandidates,
  classifySpawnError,
  parseCmdShim,
  resetBinaryCache,
  resolveBinary,
  resolveExecTarget,
  runAstGrep,
} from "../lib/runner.js";
import {
  buildOutlineArgs,
  buildSearchArgs,
  detectLang,
  OUTLINE_KINDS,
  renderOutline,
  renderSearchMatches,
} from "../lib/queries.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Locate a real ast-grep executable, or null when none is installed. */
function findRealAstGrep() {
  const candidates = [
    process.platform === "win32" ? "ast-grep.exe" : "ast-grep",
    ...(process.env.APPDATA
      ? [path.win32.join(process.env.APPDATA, "npm", "node_modules", "@ast-grep", "cli", "ast-grep.exe")]
      : []),
    ...(process.env.USERPROFILE ? [path.win32.join(process.env.USERPROFILE, ".cargo", "bin", "ast-grep.exe")] : []),
  ];
  for (const c of candidates) {
    if (!/[\\/]/.test(c)) {
      try {
        execFileSync(c, ["--version"], { stdio: "ignore" });
        return c;
      } catch {
        continue;
      }
    }
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const REAL = findRealAstGrep();
const skipWithoutBinary = REAL ? false : "no ast-grep binary available on this host";

/** Build a temp fixture directory with the given files. */
function makeFixtures(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "ast-grep-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const WIN_ENV = {
  USERPROFILE: "C:\\Users\\Tester",
  LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local",
  APPDATA: "C:\\Users\\Tester\\AppData\\Roaming",
};
const NPM_ROOT = "C:\\Users\\Tester\\AppData\\Roaming\\npm";
const NPM_EXE = `${NPM_ROOT}\\node_modules\\@ast-grep\\cli\\ast-grep.exe`;
const NPM_MSVC_EXE = `${NPM_ROOT}\\node_modules\\@ast-grep\\cli\\node_modules\\@ast-grep\\cli-win32-x64-msvc\\ast-grep.exe`;
const NPM_CMD = `${NPM_ROOT}\\ast-grep.cmd`;

/** A real npm-generated shim, in shape. */
const SHIM_TEXT = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@ast-grep\\cli\\ast-grep" %*',
].join("\r\n");

/** An injected fs over a fixed set of existing paths. */
function fakeFs(existingPaths, extraFiles = {}) {
  const set = new Set(existingPaths);
  return {
    existsSync: (p) => set.has(p),
    statSync: (p) => {
      if (set.has(p)) return { isFile: () => true };
      throw new Error("ENOENT");
    },
    readFileSync: (p) => {
      if (Object.prototype.hasOwnProperty.call(extraFiles, p)) return extraFiles[p];
      throw new Error("ENOENT");
    },
  };
}

const winDeps = (rows, extraFiles = {}) => ({
  platform: "win32",
  env: WIN_ENV,
  fs: fakeFs(rows, extraFiles),
  cache: false,
});

// ─── native executable preferred ────────────────────────────────────────────

test("win32: the native .exe is chosen over the npm .cmd shim", () => {
  const chosen = resolveBinary(winDeps([NPM_CMD, NPM_EXE]));
  assert.equal(chosen, NPM_EXE);
  assert.ok(!/\.(cmd|bat)$/i.test(chosen), "must not resolve to a shell shim");
});

test("win32: every native candidate is ordered before any shim", () => {
  const candidates = binaryCandidates({ platform: "win32", env: WIN_ENV });
  const shimIndex = candidates.findIndex((c) => /\.(cmd|bat)$/i.test(c));
  assert.ok(shimIndex > 0, "the shim must still be a last-resort candidate");
  for (let i = 0; i < shimIndex; i += 1) {
    assert.ok(!/\.(cmd|bat)$/i.test(candidates[i]), `candidate #${i} must not be a shim`);
  }
  assert.ok(candidates.includes(NPM_EXE), "the npm package's real exe must be a candidate");
  assert.ok(candidates.includes(NPM_MSVC_EXE), "the platform sub-package exe must be a candidate");
});

test("win32: a bare name is left to PATH when nothing is found", () => {
  const chosen = resolveBinary(winDeps([]));
  assert.equal(chosen, "ast-grep.exe");
  const target = resolveExecTarget(chosen, { platform: "win32", env: WIN_ENV, fs: fakeFs([]) });
  assert.equal(target.command, "ast-grep.exe");
  assert.deepEqual(target.prefixArgs, []);
});

// ─── the .cmd shim path ─────────────────────────────────────────────────────

test("win32: a .cmd shim is unwrapped to the executable it wraps", () => {
  const fsImpl = fakeFs([NPM_CMD, NPM_EXE], { [NPM_CMD]: SHIM_TEXT });
  const target = resolveExecTarget(NPM_CMD, { platform: "win32", env: WIN_ENV, fs: fsImpl });
  assert.equal(target.unwrapped, true, "the shim must be unwrapped, not shelled out");
  assert.equal(target.command, NPM_EXE);
  assert.deepEqual(target.prefixArgs, [], "unwrapping must not add argv");
  assert.ok(!/\.(cmd|bat)$/i.test(target.command), "the launched command must be a real executable");
});

test("win32: an unparseable shim falls back to cmd.exe with the shim as argv", () => {
  const target = resolveExecTarget(NPM_CMD, {
    platform: "win32",
    env: { ...WIN_ENV, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    fs: fakeFs([NPM_CMD], { [NPM_CMD]: "@ECHO off\r\nrem nothing useful\r\n" }),
  });
  assert.equal(target.unwrapped, false);
  assert.equal(target.viaShim, true);
  assert.equal(target.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(target.prefixArgs, ["/d", "/s", "/c", NPM_CMD]);
});

test("win32: shell:true is never passed to execFile", async () => {
  const calls = [];
  const fsImpl = fakeFs([NPM_CMD, NPM_EXE], { [NPM_CMD]: SHIM_TEXT });
  await runAstGrep(["run", "--json=compact", "--kind", "x", "."], process.cwd(), undefined, 1000, {
    platform: "win32",
    env: WIN_ENV,
    fs: fsImpl,
    execFileAsync: async (cmd, argv, opts) => {
      calls.push({ cmd, argv, opts });
      return { stdout: "[]" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, NPM_EXE, "the unwrapped executable must be spawned");
  assert.ok(!("shell" in calls[0].opts), "no shell option may be passed");
});

test("win32: shim parsing finds the wrapped target and ignores npm internals", () => {
  const parsed = parseCmdShim(SHIM_TEXT);
  assert.ok(parsed.quoted.includes("%dp0%\\node_modules\\@ast-grep\\cli\\ast-grep"));
  assert.ok(
    !parsed.quoted.some((t) => t.includes("%_prog%")),
    "the launcher variable must not be treated as a target"
  );
});

// ─── error surfacing ────────────────────────────────────────────────────────

test("ENOENT keeps the actionable install hint", () => {
  const err = classifySpawnError({ code: "ENOENT", message: "spawn ast-grep ENOENT" }, { platform: "win32" });
  assert.match(err.message, /was not found in PATH or standard directories/);
  assert.match(err.message, /npm install -g @ast-grep\/cli/);
});

test("Windows EINVAL explains the shim cause instead of reporting it opaquely", () => {
  const raw = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL", syscall: "spawn" });
  raw.__attemptedBinary = NPM_CMD;
  const err = classifySpawnError(raw, { platform: "win32" });
  assert.match(err.message, /shell shim \(a \.cmd\/\.bat file\)/);
  assert.match(err.message, /npm install -g @ast-grep\/cli/);
  assert.notEqual(err.message, "ast-grep execution failed: spawn EINVAL");
});

test("non-Windows EINVAL is not mislabelled as a Windows shim problem", () => {
  const err = classifySpawnError(Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }), {
    platform: "linux",
  });
  assert.equal(err.message, "ast-grep execution failed: spawn EINVAL");
});

test("abort errors propagate untouched", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(classifySpawnError(abort, { platform: "win32" }), abort);
});

test("a non-zero exit that still printed JSON is a no-match, not a failure", async () => {
  const out = await runAstGrep(["run", "--json=compact", "--kind", "x", "."], process.cwd(), undefined, 1000, {
    platform: "win32",
    env: WIN_ENV,
    fs: fakeFs([NPM_EXE]),
    execFileAsync: async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stdout: "[]" });
    },
  });
  assert.equal(out, "[]");
});

// ─── non-Windows behaviour is unchanged ─────────────────────────────────────

test("non-win32 resolution is untouched", () => {
  assert.deepEqual(binaryCandidates({ platform: "linux", env: WIN_ENV }), ["ast-grep"]);
  assert.deepEqual(binaryCandidates({ platform: "darwin", env: WIN_ENV }), ["ast-grep"]);
  assert.equal(resolveBinary({ platform: "linux", env: WIN_ENV, cache: false }), "ast-grep");
  const target = resolveExecTarget("ast-grep", { platform: "linux" });
  assert.equal(target.command, "ast-grep");
  assert.deepEqual(target.prefixArgs, []);
  assert.equal(target.viaShim, false);
});

test("memoization can be bypassed and reset", () => {
  const a = resolveBinary({ platform: "win32", env: WIN_ENV, fs: fakeFs([NPM_EXE]), cache: true });
  assert.equal(a, NPM_EXE);
  assert.equal(resolveBinary({ platform: "win32", env: WIN_ENV, fs: fakeFs([]), cache: true }), NPM_EXE);
  resetBinaryCache();
  assert.equal(resolveBinary.cached, null);
});

// ─── environment variable override (Issue #1) ────────────────────────────────

test("AST_GREP_PATH takes absolute precedence across platforms", () => {
  const customBin = "D:\\custom\\bin\\ast-grep.exe";
  const candsWin = binaryCandidates({ platform: "win32", env: { ...WIN_ENV, AST_GREP_PATH: customBin } });
  assert.deepEqual(candsWin, [customBin]);

  const candsLinux = binaryCandidates({ platform: "linux", env: { AST_GREP_PATH: "/opt/bin/ast-grep" } });
  assert.deepEqual(candsLinux, ["/opt/bin/ast-grep"]);

  const chosen = resolveBinary({
    platform: "win32",
    env: { ...WIN_ENV, AST_GREP_PATH: customBin },
    fs: fakeFs([customBin]),
    cache: false,
  });
  assert.equal(chosen, customBin);
});

test("AST_GREP_BIN is supported as an alias for AST_GREP_PATH", () => {
  const customBin = "/usr/local/bin/my-ast-grep";
  const cands = binaryCandidates({ platform: "linux", env: { AST_GREP_BIN: customBin } });
  assert.deepEqual(cands, [customBin]);
});

// ─── custom npm prefix in PATH (Issue #1) ────────────────────────────────────

test("win32: discovers native exe under custom npm prefix in PATH", () => {
  const customPrefix = "D:\\nodejs\\node_global";
  const customCmd = `${customPrefix}\\ast-grep.cmd`;
  const customNativeExe = `${customPrefix}\\node_modules\\@ast-grep\\cli\\ast-grep.exe`;
  const envWithPath = {
    ...WIN_ENV,
    PATH: `C:\\Windows\\system32;${customPrefix};C:\\Tools`,
  };

  const candidates = binaryCandidates({ platform: "win32", env: envWithPath });
  assert.ok(candidates.includes(customNativeExe), "must include native exe under custom prefix");
  assert.ok(candidates.includes(customCmd), "must include shim under custom prefix");

  const chosen = resolveBinary({
    platform: "win32",
    env: envWithPath,
    fs: fakeFs([customCmd, customNativeExe]),
    cache: false,
  });
  assert.equal(chosen, customNativeExe, "native exe must be chosen over shim in custom prefix");
});

test("win32: unwraps .cmd shim under custom npm prefix when native exe not directly found", () => {
  const customPrefix = "D:\\nodejs\\node_global";
  const customCmd = `${customPrefix}\\ast-grep.cmd`;
  const customNativeExe = `${customPrefix}\\node_modules\\@ast-grep\\cli\\ast-grep.exe`;
  const customShimText = SHIM_TEXT;

  const envWithPath = {
    ...WIN_ENV,
    PATH: `${customPrefix};C:\\Windows\\system32`,
  };

  const fsImpl = fakeFs([customCmd, customNativeExe], { [customCmd]: customShimText });
  const target = resolveExecTarget(customCmd, { platform: "win32", env: envWithPath, fs: fsImpl });
  assert.equal(target.unwrapped, true);
  assert.equal(target.command, customNativeExe);
  assert.deepEqual(target.prefixArgs, []);
});

test("win32: resolution does not cache bare fallback name when binary is missing", () => {
  resetBinaryCache();
  const fallback = resolveBinary({ platform: "win32", env: WIN_ENV, fs: fakeFs([]), cache: true });
  assert.equal(fallback, "ast-grep.exe");
  assert.equal(resolveBinary.cached, null, "must not cache bare fallback name");

  const installed = resolveBinary({ platform: "win32", env: WIN_ENV, fs: fakeFs([NPM_EXE]), cache: true });
  assert.equal(installed, NPM_EXE);
  assert.equal(resolveBinary.cached, NPM_EXE, "must cache discovered existing binary");
  resetBinaryCache();
});

// ─── outline kind table ─────────────────────────────────────────────────────

test("no language table requests a kind ast-grep rejects", () => {
  // ast-grep rejects the whole invocation on an unknown kind, so one bad entry
  // breaks the entire outline. `async_function_definition` is not a valid kind.
  const kindsOf = (argv) => argv[argv.indexOf("--kind") + 1].split(",").map((s) => s.trim());
  for (const lang of Object.keys(OUTLINE_KINDS)) {
    for (const depth of [1, 2]) {
      for (const kind of kindsOf(buildOutlineArgs(lang, depth, "/x/y"))) {
        assert.notEqual(kind, "async_function_definition", `${lang} depth ${depth} must not request it`);
        assert.match(kind, /^[a-z_]+$/, `${lang} kind looks malformed: ${kind}`);
      }
    }
  }
});

test("Python outline kinds cover async def without the invalid kind", () => {
  assert.ok(!OUTLINE_KINDS.python.topLevel.includes("async_function_definition"));
  assert.ok(!OUTLINE_KINDS.python.nested.includes("async_function_definition"));
  assert.ok(OUTLINE_KINDS.python.topLevel.includes("function_definition"));
  assert.throws(() => buildOutlineArgs("cobol", 1, "/x/y"), /Unsupported outline language/);
});

test("language detection maps the supported extensions", () => {
  assert.equal(detectLang("/x/a.py"), "python");
  assert.equal(detectLang("/x/a.ts"), "ts");
  assert.equal(detectLang("/x/a.tsx"), "tsx");
  assert.equal(detectLang("/x/a.unknownext"), null);
});

// ─── no rewrite capability ──────────────────────────────────────────────────

test("no query builder can emit a rewrite invocation", () => {
  const argvs = [
    buildSearchArgs({ pattern: "foo($$$)" }, "/x"),
    buildSearchArgs({ kind: "class_declaration", lang: "ts", globs: "**/*.ts", strictness: "smart" }, "/x"),
    buildSearchArgs({ pattern: "a", selector: "b", lang: "js" }, "/x"),
    buildOutlineArgs("python", 1, "/x/a.py"),
    buildOutlineArgs("ts", 2, "/x/a.ts"),
  ];
  for (const argv of argvs) {
    assert.equal(argv[0], "run");
    for (const banned of ["--rewrite", "-U", "--update-all", "--interactive"]) {
      assert.ok(!argv.includes(banned), `argv must not contain ${banned}`);
    }
  }
});

test("buildSearchArgs rejects a call with neither pattern nor kind", () => {
  assert.throws(() => buildSearchArgs({}, "/x"), /requires either 'pattern' or 'kind'/);
});

// ─── live runs ──────────────────────────────────────────────────────────────

const liveDeps = () => ({ binary: REAL, platform: process.platform, env: process.env, cache: false });
let fixtures = null;

test("live: Python ast_search finds functions and try/except", { skip: skipWithoutBinary }, async () => {
  fixtures = makeFixtures({
    "sample.py": [
      "import json",
      "",
      "",
      "def fetch_user(user_id):",
      "    return {'id': user_id}",
      "",
      "",
      "def load_config(p):",
      "    try:",
      "        with open(p) as f:",
      "            return json.load(f)",
      "    except FileNotFoundError:",
      "        return {}",
      "",
      "",
      "async def fetch_async(user_id):",
      "    return {'id': user_id}",
      "",
      "",
      "class Store:",
      "    def add(self, k, v):",
      "        pass",
      "",
    ].join("\n"),
  });

  const fnRaw = await runAstGrep(
    buildSearchArgs({ kind: "function_definition", lang: "python" }, fixtures),
    fixtures,
    undefined,
    60000,
    liveDeps()
  );
  const names = JSON.parse(fnRaw).map((m) => m.text.split("\n")[0].trim());
  assert.ok(names.some((n) => n.includes("def fetch_user(")));
  assert.ok(names.some((n) => n.includes("def load_config(")));
  assert.ok(names.some((n) => n.includes("async def fetch_async(")), "async def must match function_definition");

  const tryRaw = await runAstGrep(
    buildSearchArgs({ kind: "try_statement", lang: "python" }, fixtures),
    fixtures,
    undefined,
    60000,
    liveDeps()
  );
  assert.equal(JSON.parse(tryRaw).length, 1);

  // Regression: depth 2 must not fail on the kind list.
  const outlineRaw = await runAstGrep(
    buildOutlineArgs("python", 2, path.join(fixtures, "sample.py")),
    fixtures,
    undefined,
    60000,
    liveDeps()
  );
  const text = renderOutline(
    JSON.parse(outlineRaw),
    2,
    "python",
    path.join(fixtures, "sample.py"),
    fixtures,
    "sample.py"
  );
  assert.match(text, /fetch_user/);
  assert.match(text, /async def fetch_async/);
});

test("live: TypeScript ast_search finds functions and classes", { skip: skipWithoutBinary }, async () => {
  const dir = fixtures ?? makeFixtures({});
  fs.writeFileSync(
    path.join(dir, "sample.ts"),
    [
      "export interface Row { id: number }",
      "",
      "export function parseRow(raw: string): Row {",
      "  return JSON.parse(raw) as Row;",
      "}",
      "",
      "async function loadRows(p: string): Promise<Row[]> {",
      "  return [];",
      "}",
      "",
      "export class RowCache {",
      "  private rows = new Map<number, Row>();",
      "  put(r: Row): void { this.rows.set(r.id, r); }",
      "}",
      "",
    ].join("\n")
  );

  const fnRaw = await runAstGrep(
    buildSearchArgs({ kind: "function_declaration", lang: "ts" }, dir),
    dir,
    undefined,
    60000,
    liveDeps()
  );
  const names = JSON.parse(fnRaw).map((m) => m.text.split("\n")[0].trim());
  assert.ok(names.some((n) => n.includes("function parseRow(")));
  assert.ok(names.some((n) => n.includes("async function loadRows(")));

  const classRaw = await runAstGrep(
    buildSearchArgs({ kind: "class_declaration", lang: "ts" }, dir),
    dir,
    undefined,
    60000,
    liveDeps()
  );
  assert.ok(JSON.parse(classRaw).some((m) => m.text.includes("class RowCache")));
});

test("live: searching creates and removes no files", { skip: skipWithoutBinary }, async () => {
  const dir = fixtures ?? makeFixtures({ "a.py": "def a():\n    pass\n" });
  const before = fs.readdirSync(dir).sort();
  await runAstGrep(buildSearchArgs({ kind: "function_definition", lang: "python" }, dir), dir, undefined, 60000, liveDeps());
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test.after(() => {
  if (fixtures) fs.rmSync(fixtures, { recursive: true, force: true });
  fixtures = null;
});
