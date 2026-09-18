# dsh-tool-ast-grep

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-tool-ast-grep.svg)](https://www.npmjs.com/package/dsh-tool-ast-grep)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-tool-ast-grep.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-ast-grep.svg)](https://github.com/Jaylor-Wang/dsh-tool-ast-grep/releases)

**AST-based structural code search and outline plugin for DeepSeek Harness (DSH)**, powered by [ast-grep](https://ast-grep.github.io/).

Provides structural code searching and outline inspection capabilities for coding agents, dramatically outperforming traditional regular expression search (`grep`) in token efficiency and semantic accuracy.

---

## Features

- **`ast_search`**: Search code structures using AST patterns and meta-variables (`$NAME`, `$$$`).
  - Finds structural patterns across multiple lines regardless of formatting or whitespace.
  - Supports node kind queries (e.g. `function_declaration`, `interface_declaration`, `class_declaration`).
  - Supports strictness modes (`smart`, `relaxed`, `ast`, `cst`).
  - Supports file path and glob filtering.
- **`ast_outline`**: Extract an ultra-compact structural outline (functions, classes, types, interfaces, exports) from a source file.
  - Saves 80%–95% tokens compared to reading the entire file.
  - Supports depth control (top-level vs. nested methods).
- **Zero Shell Quoting Issues**: Invoked safely via child processes with JSON streaming — immune to Windows shell argument escaping and quoting pitfalls.

---

## Prerequisites

This plugin requires `ast-grep` CLI installed on your machine:

- **npm**:
  ```bash
  npm install -g @ast-grep/cli
  ```
- **pip**:
  ```bash
  pip install ast-grep-cli
  ```
- **cargo**:
  ```bash
  cargo install ast-grep --locked
  ```
- **brew** (macOS/Linux):
  ```bash
  brew install ast-grep
  ```

Verify with:
```bash
ast-grep --version
```

---

## Installation in DSH

### Option 1: Via DSH Market (Recommended)

Once published and indexed, search for `dsh-tool-ast-grep` in **Settings → Plugin Market** and click **Install**.

Or run in terminal:
```bash
dsh plugin --profile web add dsh-tool-ast-grep
```

### Option 2: Mount in an Agent Preset

In your agent configuration (e.g. `~/.dsh/.agent-presets/your-agent/agent.cordis.yml`):

```yaml
id: my-agent
name: My Agent
tools:
  - id: tool-ast-grep
    name: dsh-tool-ast-grep
    config:
      maxResults: 50
      timeoutMs: 60000
```

---

## Tool API Overview

### 1. `ast_search`

| Parameter | Type | Description |
|---|---|---|
| `pattern` | `string` | AST pattern, e.g. `function $NAME($$$) { $$$ }` or `$OBJ.push($ITEM)` |
| `kind` | `string` | AST node kind, e.g. `class_declaration`, `function_declaration` |
| `path` | `string` | Directory or file path to search in (defaults to workspace root) |
| `lang` | `string` | Language override (`ts`, `tsx`, `js`, `jsx`, `python`, `rust`, `go`, etc.) |
| `globs` | `string` | File glob pattern to include/exclude (e.g. `src/**/*.ts`) |
| `limit` | `integer` | Max matches to return (default: 50) |

### 2. `ast_outline`

| Parameter | Type | Description |
|---|---|---|
| `file_path` | `string` | Path of the file to inspect |
| `lang` | `string` | Language override (auto-detected if omitted) |
| `depth` | `integer` | `1` for top-level only (default), `2` to include class methods |

---

## Supported Languages

TypeScript (`ts`, `tsx`), JavaScript (`js`, `jsx`), Python (`py`), Rust (`rs`), Go (`go`), Java (`java`), C (`c`, `h`), C++ (`cpp`, `hpp`, `cc`).

---

## License

MIT © Jaylor Wang (Jaylor-Wang)
