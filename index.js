import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import path from "path";
import fs from "fs";
import { runAstGrep } from "./lib/runner.js";
import {
  buildOutlineArgs,
  buildSearchArgs,
  detectLang,
  renderOutline,
  renderSearchMatches,
} from "./lib/queries.js";

export const name = "dsh-tool-ast-grep";
export const Config = z.object({
  maxResults: z.number().default(50).description("Maximum search results to return"),
  timeoutMs: z.number().default(60000).description("Execution timeout in milliseconds"),
});

export const inject = ["tools"];

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
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        const limit = args.limit || maxResultsDefault;
        const targetPath = args.path ? path.resolve(cwd, args.path) : cwd;

        const cmdArgs = buildSearchArgs(args, targetPath);

        const rawJson = await runAstGrep(cmdArgs, cwd, exec.signal, timeoutMsDefault);
        let matches = [];
        try {
          matches = JSON.parse(rawJson);
        } catch {
          matches = [];
        }

        const query = args.pattern ? `pattern '${args.pattern}'` : `kind '${args.kind}'`;
        return { text: renderSearchMatches(matches, limit, cwd, query) };
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

        const cmdArgs = buildOutlineArgs(lang, args.depth || 1, filePath);
        const rawJson = await runAstGrep(cmdArgs, cwd, exec.signal, timeoutMsDefault);

        let items = [];
        try {
          items = JSON.parse(rawJson);
        } catch {
          items = [];
        }

        return { text: renderOutline(items, args.depth || 1, lang, filePath, cwd, args.file_path) };
      },
    })
  );
}
