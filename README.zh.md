# dsh-tool-ast-grep

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-tool-ast-grep.svg)](https://www.npmjs.com/package/dsh-tool-ast-grep)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-tool-ast-grep.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-tool-ast-grep.svg)](https://github.com/Jaylor-Wang/dsh-tool-ast-grep/releases)

**专为 DeepSeek Harness (DSH) 打造的语法级 AST 代码检索与大纲提取插件**，基于 Rust 高性能语法解析工具 [ast-grep](https://ast-grep.github.io/) 驱动。

为 Coding Agent 提供精准的代码语法树（AST）检索能力与文件架构提取能力，在语义精度和 Token 消耗控制上彻底超越传统的纯文本正则搜索（`grep`）。

---

## 核心特性

- **`ast_search`（AST 结构化检索）**：
  - 使用 AST 模式语法与元变量（如 `$NAME` 匹配单节点，`$$$` 匹配任意多节点/参数）精准定位目标代码。
  - 语法无关排版：不论是单行书写、换行还是空格格式差异，均能准确匹配。
  - 支持节点类型（Kind）检索（如 `class_declaration`, `interface_declaration`, `method_definition`）。
  - 支持严格度模式（`smart`, `relaxed`, `ast`, `cst`）及文件 Glob 过滤。
- **`ast_outline`（极速代码大纲提取）**：
  - 一键提取源码文件的结构化大纲（顶层函数、类、接口、类型别名、导出语句）。
  - 相比把整个长文件塞进大模型上下文，**可节省 80%–95% 的 Token 消耗**。
  - 支持深度控制：默认只看顶层接口，可展开类内部方法与构造函数。
- **消灭 Shell 引号与转义地狱**：
  - 采用 Node.js 原生参数列表调用，彻底规避 Windows Shell 下特殊字符（如 `$VAR` 被吞、引号被截断）引发的运行报错。

---

## 前置要求

使用本插件需要在系统中安装 `ast-grep` 命令行工具（二选一即可）：

- **通过 npm 全局安装**：
  ```bash
  npm install -g @ast-grep/cli
  ```
- **通过 Python pip 安装**：
  ```bash
  pip install ast-grep-cli
  ```
- **通过 Cargo 安装 (Rust)**：
  ```bash
  cargo install ast-grep --locked
  ```
- **macOS / Homebrew**：
  ```bash
  brew install ast-grep
  ```

验证安装：
```bash
ast-grep --version
```

---

## 在 DeepSeek Harness 中安装

### 方式 1：通过插件市场一键安装（推荐）

在 Web UI 导航至 **设置 → 插件市场**，搜索 `dsh-tool-ast-grep`，点击安装即可。

或在终端中运行：
```bash
dsh plugin --profile web add dsh-tool-ast-grep
```

### 方式 2：在智能体预设（Preset）中引入

在你的预设文件（如 `~/.dsh/.agent-presets/my-agent/agent.cordis.yml`）中挂载：

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

## 工具参数说明

### 1. `ast_search`

| 参数 | 类型 | 说明 |
|---|---|---|
| `pattern` | `string` | AST 匹配模式，如 `function $NAME($$$) { $$$ }` 或 `$OBJ.push($ITEM)` |
| `kind` | `string` | AST 语法节点类型，如 `class_declaration`, `function_declaration` |
| `path` | `string` | 搜索的目标目录或文件路径（默认为工作区根目录） |
| `lang` | `string` | 指定语言（`ts`, `tsx`, `js`, `jsx`, `python`, `rust`, `go` 等） |
| `globs` | `string` | 文件过滤规则（如 `src/**/*.ts` 或 `!**/*.test.ts`） |
| `limit` | `integer` | 最大返回条数（默认 50） |

### 2. `ast_outline`

| 参数 | 类型 | 说明 |
|---|---|---|
| `file_path` | `string` | 目标源码文件路径（相对路径或绝对路径） |
| `lang` | `string` | 指定语言（如省略则根据文件后缀自动推断） |
| `depth` | `integer` | 大纲深度：`1` 仅展示顶层定义（默认），`2` 展开类方法与构造器 |

---

## 支持的语言

TypeScript (`ts`, `tsx`), JavaScript (`js`, `jsx`), Python (`py`), Rust (`rs`), Go (`go`), Java (`java`), C (`c`, `h`), C++ (`cpp`, `hpp`, `cc`)。

---

## 许可证

MIT © Jaylor Wang (Jaylor-Wang)
