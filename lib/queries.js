/**
 * Query construction and result rendering for dsh-tool-ast-grep.
 *
 * Kept free of `@deepseek-ai/dsh-tools` so the exact argv the plugin sends to
 * ast-grep can be asserted in tests. `index.js` is a thin registration layer
 * over these helpers.
 *
 * Every builder here produces a *read-only* argv: `run` plus matching options.
 * No builder emits `--rewrite`/`-U`, so the plugin has no edit capability.
 * @module dsh-tool-ast-grep/queries
 */

import path from "path";

/** Node kinds used to build outlines, per language. */
export const OUTLINE_KINDS = {
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
    // NOTE: `async_function_definition` is NOT a valid ast-grep kind for
    // Python — ast-grep rejects the whole invocation with "Cannot parse kind as
    // a valid selector", which made every depth>=2 outline of a Python file
    // fail. Python's `function_definition` already matches `async def`, so the
    // correct kind list is the two below.
    topLevel: "function_definition, class_definition, decorated_definition",
    nested: "function_definition",
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

/**
 * Map a file extension to an ast-grep language id.
 * @param filePath - path or bare filename.
 * @returns the language id, or `null` when the extension is unknown.
 */
export function detectLang(filePath) {
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

/**
 * Build the argv for `ast_search`.
 * @param args - tool arguments (`pattern`, `kind`, `selector`, `lang`, `globs`, `strictness`).
 * @param targetPath - absolute path to search.
 * @returns the argv to pass to ast-grep.
 * @throws when neither `pattern` nor `kind` is supplied.
 */
export function buildSearchArgs(args, targetPath) {
  if (!args.pattern && !args.kind) {
    throw new Error("ast_search requires either 'pattern' or 'kind' to be specified.");
  }
  const cmdArgs = ["run", "--json=compact"];
  if (args.pattern) cmdArgs.push("--pattern", args.pattern);
  if (args.kind) cmdArgs.push("--kind", args.kind);
  if (args.selector) cmdArgs.push("--selector", args.selector);
  if (args.lang) cmdArgs.push("--lang", args.lang);
  if (args.globs) cmdArgs.push("--globs", args.globs);
  if (args.strictness) cmdArgs.push("--strictness", args.strictness);
  cmdArgs.push(targetPath);
  return cmdArgs;
}

/**
 * Build the argv for `ast_outline`.
 * @param lang - resolved language id.
 * @param depth - 1 for top level only, >=2 to include nested declarations.
 * @param filePath - absolute path to the file.
 * @returns the argv to pass to ast-grep.
 * @throws when the language has no outline mapping.
 */
export function buildOutlineArgs(lang, depth, filePath) {
  const langConfig = OUTLINE_KINDS[lang];
  if (!langConfig) {
    throw new Error(`Unsupported outline language: ${lang}`);
  }
  let kinds = langConfig.topLevel;
  if (depth >= 2 && langConfig.nested) {
    kinds = `${langConfig.topLevel}, ${langConfig.nested}`;
  }
  return ["run", "--kind", kinds, "--lang", lang, "--json=compact", filePath];
}

/** Indent a snippet, eliding the middle when it is long. */
export function truncateSnippet(text, maxLines = 8) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return lines.map((l) => "    " + l).join("\n");
  }
  const head = lines.slice(0, 4).map((l) => "    " + l);
  const tail = lines.slice(-2).map((l) => "    " + l);
  const omitted = lines.length - 6;
  return [...head, `    ... (${omitted} lines omitted) ...`, ...tail].join("\n");
}

/**
 * Render ast-grep JSON matches as the text the model reads.
 * @param matches - parsed ast-grep JSON output.
 * @param limit - maximum matches to render.
 * @param cwd - base directory used to shorten reported paths.
 * @param query - human-readable description of what was searched.
 * @returns the rendered report.
 */
export function renderSearchMatches(matches, limit, cwd, query) {
  if (matches.length === 0) {
    return `No AST matches found for ${query}`;
  }

  const total = matches.length;
  const sliced = matches.slice(0, limit);

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
  return output;
}

/**
 * Render ast-grep JSON outline items as the text the model reads.
 * @param items - parsed ast-grep JSON output.
 * @param depth - the requested outline depth.
 * @param lang - the resolved language id.
 * @param filePath - absolute path to the file.
 * @param cwd - base directory used to shorten the reported path.
 * @param displayPath - path to name in the header.
 * @returns the rendered outline.
 */
export function renderOutline(items, depth, lang, filePath, cwd, displayPath) {
  if (items.length === 0) {
    return `No outline symbols found in ${displayPath}`;
  }

  items.sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.column - b.range.start.column
  );

  const lines = [`Outline for \`${path.relative(cwd, filePath).replace(/\\/g, "/")}\` (${lang}):`];
  const seenLines = new Set();

  for (const item of items) {
    const col = item.range.start.column;
    if (depth === 1 && col > 2) continue;

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
    return `No top-level outline symbols matched in ${displayPath}`;
  }
  return lines.join("\n");
}
