import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

export const name = "dsh-tool-ast-grep";
export const Config = z.object({
  maxResults: z.number().default(50).description("Maximum search results to return"),
  timeoutMs: z.number().default(60000).description("Execution timeout in milliseconds"),
});

export const inject = ["tools"];

const OUTLINE_KINDS = {
  ts: {
    topLevel:
      "function_declaration, generator_function_declaration, class_declaration, abstract_class_declaration, interface_declaration, type_alias_declaration, enum_declaration, export_statement, lexical_declaration",
    nested: "method_definition, public_field_definition",
  },
  tsx: {
    topLevel:
      "function_declaration, generator_function_declaration, class_declaration, abstract_class_declaration, interface_declaration, type_alias_declaration, enum_declaration, export_statement, lexical_declaration",
    nested: "method_definition, public_field_definition",
  },
  js: {
    topLevel:
      "function_declaration, generator_function_declaration, class_declaration, export_statement, lexical_declaration, variable_declaration",
    nested: "method_definition",
  },
  jsx: {
    topLevel:
      "function_declaration, generator_function_declaration, class_declaration, export_statement, lexical_declaration, variable_declaration",
    nested: "method_definition",
  },
  python: {
    topLevel:
      "function_definition, async_function_definition, class_definition, decorated_definition",
    nested: "function_definition, async_function_definition",
  },
  rust: {
    topLevel:
      "function_item, struct_item, enum_item, trait_item, impl_item, type_item, mod_item, macro_definition",
    nested: "function_item",
  },
  go: {
    topLevel: "function_declaration, method_declaration, type_declaration",
    nested: "method_declaration",
  },
  java: {
    topLevel: "class_declaration, interface_declaration, enum_declaration",
    nested: "method_declaration, constructor_declaration",
  },
  c: {
    topLevel: "function_definition, struct_specifier, enum_specifier, type_definition",
    nested: "field_declaration",
  },
  cpp: {
    topLevel: "function_definition, class_specifier, struct_specifier, enum_specifier, type_definition",
    nested: "function_definition, field_declaration",
  },
};

function detectLang(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".py":
    case ".pyi":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".hpp":
    case ".cc":
    case ".cxx":
      return "cpp";
    default:
      return null;
  }
}

function truncateSnippet(text, maxLines = 8) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return lines.map((l) => "    " + l).join("\n");
  }
  const head = lines.slice(0, 4).map((l) => "    " + l);
  const tail = lines.slice(-2).map((l) => "    " + l);
  const omitted = lines.length - 6;
  return [...head, `    ... (${omitted} lines omitted) ...`, ...tail].join("\n");
}

let cachedAstGrepBinary = null;

function resolveBinary() {
  if (cachedAstGrepBinary) return cachedAstGrepBinary;

  // 1. Check direct binary in PATH
  const binaryName = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
  
  // 2. Check common paths on Windows
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE || "";
    const localAppData = process.env.LOCALAPPDATA || "";
    const candidates = [
      binaryName,
      path.join(userProfile, "AppData", "Local", "Programs", "Python", "Python313", "Scripts", "ast-grep.exe"),
      path.join(userProfile, "AppData", "Local", "Programs", "Python", "Python312", "Scripts", "ast-grep.exe"),
      path.join(userProfile, "AppData", "Local", "Programs", "Python", "Python311", "Scripts", "ast-grep.exe"),
      path.join(localAppData, "Programs", "Python", "Python313", "Scripts", "ast-grep.exe"),
      path.join(userProfile, "AppData", "Roaming", "npm", "ast-grep.cmd"),
      path.join(userProfile, "AppData", "Roaming", "npm", "ast-grep.exe"),
      path.join(userProfile, ".cargo", "bin", "ast-grep.exe"),
    ];

    for (const cand of candidates) {
      if (cand === binaryName) continue;
      if (fs.existsSync(cand)) {
        cachedAstGrepBinary = cand;
        return cand;
      }
    }
  }

  cachedAstGrepBinary = binaryName;
  return binaryName;
}

async function runAstGrep(args, cwd, signal, timeoutMs = 60000) {
  const binary = resolveBinary();
  try {
    const res = await execFileAsync(binary, args, {
      cwd,
      signal,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return res.stdout || "[]";
  } catch (err) {
    if (err.code === 1 && typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
      return err.stdout;
    }
    if (err.name === "AbortError" || signal?.aborted) {
      throw err;
    }
    if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
      throw new Error(
        `ast-grep binary was not found in PATH or standard directories.\n` +
          `Please install ast-grep to use this plugin:\n` +
          `- npm:  npm install -g @ast-grep/cli\n` +
          `- pip:  pip install ast-grep-cli\n` +
          `- cargo: cargo install ast-grep --locked\n` +
          `- brew: brew install ast-grep (macOS/Linux)`
      );
    }
    const errText = err.stderr?.trim() || err.message;
    throw new Error(`ast-grep execution failed: ${errText}`);
  }
}

export function apply(ctx, config = {}) {
  const maxResultsDefault = config.maxResults || 50;
  const timeoutMsDefault = config.timeoutMs || 60000;

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt) {
    try {
      systemPrompt.section({
        name: "tool:ast-grep",
        order: systemPrompt.getSectionOrder?.("TOOLS_SDK") ?? 5000,
        text: "When searching for code structures (e.g. function/class/interface definitions, API usages) or inspecting file outline, prefer `ast_search` and `ast_outline` over plain-text grep or reading entire files. Use $VAR for single nodes and $$$ for multi-node wildcards.",
      });
    } catch {
      // safe fallback if systemPrompt not mounted
    }
  }

  // 1. ast_search
  ctx.tools.register(
    defineTool({
      name: "ast_search",
      description:
        "Perform structural AST code search across the workspace or a directory using ast-grep. Matches code by syntax tree patterns instead of regex strings. Use $VAR for single node meta-variables (e.g. $NAME) and $$$ for multiple nodes/statements/arguments. Example patterns: 'function $NAME($$$) { $$$ }', 'interface $NAME { $$$ }', 'class $NAME extends $BASE { $$$ }', '$OBJ.push($ITEM)'.",
      parameters: {
        pattern: {
          type: "string",
          description:
            "AST pattern to match. Use $VAR for single node meta-variables and $$$ for wildcard nodes. Example: 'function $NAME($$$) { $$$ }'. Either pattern or kind must be provided.",
        },
        kind: {
          type: "string",
          description:
            "AST node kind to match (e.g. 'function_declaration', 'class_declaration', 'interface_declaration', 'method_definition').",
        },
        selector: {
          type: "string",
          description:
            "Sub-syntax node kind selector for the pattern (see ast-grep --selector).",
        },
        path: {
          type: "string",
          description: "Target directory or file path. Defaults to workspace root.",
        },
        lang: {
          type: "string",
          description:
            "Programming language (ts, tsx, js, jsx, rust, python, go, c, cpp, java). Auto-detected if omitted.",
        },
        globs: {
          type: "string",
          description: 'File glob pattern to filter, e.g. "src/**/*.ts" or "!**/*.test.ts".',
        },
        strictness: {
          type: "string",
          description:
            'Strictness mode: "smart" (default), "cst", "ast", "relaxed", "signature", "template".',
        },
        limit: {
          type: "integer",
          description: "Maximum number of matches to return (default 50).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        if (!args.pattern && !args.kind) {
          throw new Error("ast_search requires either 'pattern' or 'kind' to be specified.");
        }
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        const limit = args.limit || maxResultsDefault;
        const targetPath = args.path ? path.resolve(cwd, args.path) : cwd;

        const cmdArgs = ["run", "--json=compact"];
        if (args.pattern) cmdArgs.push("--pattern", args.pattern);
        if (args.kind) cmdArgs.push("--kind", args.kind);
        if (args.selector) cmdArgs.push("--selector", args.selector);
        if (args.lang) cmdArgs.push("--lang", args.lang);
        if (args.globs) cmdArgs.push("--globs", args.globs);
        if (args.strictness) cmdArgs.push("--strictness", args.strictness);
        cmdArgs.push(targetPath);

        const rawJson = await runAstGrep(cmdArgs, cwd, exec.signal, timeoutMsDefault);
        let matches = [];
        try {
          matches = JSON.parse(rawJson);
        } catch {
          matches = [];
        }

        if (matches.length === 0) {
          const query = args.pattern ? `pattern '${args.pattern}'` : `kind '${args.kind}'`;
          return { text: `No AST matches found for ${query}` };
        }

        const total = matches.length;
        const sliced = matches.slice(0, limit);

        // Group by file
        const byFile = new Map();
        for (const m of sliced) {
          const rel = path.relative(cwd, m.file).replace(/\\/g, "/");
          const list = byFile.get(rel) || [];
          list.push(m);
          byFile.set(rel, list);
        }

        const sections = [];
        for (const [filePath, fileMatches] of byFile) {
          const lines = [`### ${filePath}`];
          for (const m of fileMatches) {
            const startLine = m.range.start.line + 1;
            const endLine = m.range.end.line + 1;
            const lineStr = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;

            // Meta variables summary
            let metaStr = "";
            if (m.metaVariables?.single) {
              const vars = Object.entries(m.metaVariables.single)
                .map(([k, v]) => `$${k} = ${JSON.stringify(v.text)}`)
                .join(", ");
              if (vars) metaStr = ` [${vars}]`;
            }

            lines.push(`- **${lineStr}**${metaStr}:\n${truncateSnippet(m.text)}`);
          }
          sections.push(lines.join("\n"));
        }

        let output = sections.join("\n\n");
        if (total > limit) {
          output += `\n\n(Showing ${limit} of ${total} matches. Narrow your search with \`path\` or \`globs\` if needed.)`;
        }
        return { text: output };
      },
    })
  );

  // 2. ast_outline
  ctx.tools.register(
    defineTool({
      name: "ast_outline",
      description:
        "Extract a concise structural outline (functions, classes, interfaces, types, exports) from a source file using AST. Much faster and saves significant tokens compared to reading the entire file.",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "Path of the source file to inspect (relative to workspace or absolute).",
        },
        lang: {
          type: "string",
          description: "Language override (ts, tsx, js, jsx, rust, python, go, java, c, cpp).",
        },
        depth: {
          type: "integer",
          description:
            "Outline depth: 1 for top-level definitions only (default), 2 to include class methods and inner declarations.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        const filePath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.resolve(cwd, args.file_path);

        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${args.file_path}`);
        }

        const lang = args.lang || detectLang(filePath);
        if (!lang) {
          throw new Error(
            `Unable to determine language for ${args.file_path}. Please provide the 'lang' parameter.`
          );
        }

        const langConfig = OUTLINE_KINDS[lang];
        if (!langConfig) {
          throw new Error(`Unsupported outline language: ${lang}`);
        }

        const depth = args.depth || 1;
        let kinds = langConfig.topLevel;
        if (depth >= 2 && langConfig.nested) {
          kinds = `${langConfig.topLevel}, ${langConfig.nested}`;
        }

        const cmdArgs = ["run", "--kind", kinds, "--lang", lang, "--json=compact", filePath];
        const rawJson = await runAstGrep(cmdArgs, cwd, exec.signal, timeoutMsDefault);

        let items = [];
        try {
          items = JSON.parse(rawJson);
        } catch {
          items = [];
        }

        if (items.length === 0) {
          return { text: `No outline symbols found in ${args.file_path}` };
        }

        items.sort(
          (a, b) =>
            a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column
        );

        const lines = [`Outline for \`${path.relative(cwd, filePath).replace(/\\/g, "/")}\` (${lang}):`];
        const seenLines = new Set();

        for (const item of items) {
          const col = item.range.start.column;
          if (depth === 1 && col > 2) {
            continue;
          }

          const startLine = item.range.start.line + 1;
          const endLine = item.range.end.line + 1;

          if (seenLines.has(startLine)) continue;
          seenLines.add(startLine);

          const rawFirstLine = item.text.split("\n")[0].trim();
          const cleanSig = rawFirstLine.replace(/\{$/, "").replace(/:$/, "").trim();

          const indent = col > 2 ? "  └─ " : "- ";
          const lineRef = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
          lines.push(`${indent}**${lineRef}**: \`${cleanSig}\``);
        }

        if (lines.length === 1) {
          return { text: `No top-level outline symbols matched in ${args.file_path}` };
        }

        return { text: lines.join("\n") };
      },
    })
  );
}
