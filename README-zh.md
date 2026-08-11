<p align="right">
  <a href="README.md">🇬🇧 English</a>
</p>

# Oh My Pi Permission Suite

> 四种审批模式 + 指令级安全限制的 Oh My Pi 扩展。

为 Oh My Pi (omp) coding agent 提供 **Act / Auto / Ask / Plan** 四种权限模式、命令和路径规则引擎、以及 subagent 自动审批。基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) 增强改造，并从 Pi 扩展移植到 omp 扩展运行时。

## 安装

```bash
omp plugin install omp-permission-suite
```

本地开发时，也可以直接加载扩展文件：

```bash
omp -e ./index.ts          # 单次会话
omp plugin link .          # 从当前目录持久链接
```

安装后重启 omp，你会获得：
- `/approval-mode` 命令切换四种模式
- `set_approval_mode` 工具（agent 可调用）
- `Alt+Shift+A` 快捷键循环切换模式
- 规则引擎自动拦截危险命令
- Subagent 自动审批复杂工具调用

> 注意：原 Pi 插件使用的 `Ctrl+Q` 在 omp 中被保留用于“排队后续消息”，因此本移植版改用 `Alt+Shift+A` 循环切换模式。

## 模式

| 模式 | 图标 | 说明 |
|------|------|------|
| Act | ⚡ | 完全权限（默认） |
| Auto | 🤖 | subagent 审批不确定的调用 |
| Ask | ❓ | 只读问答，写/执行工具禁用 |
| Plan | 📋 | 只读计划，写/执行工具禁用 |

`Alt+Shift+A` 依次循环 Act → Auto → Ask → Plan。

**Ask/Plan 可用工具：** 规则引擎的只读放行层允许 omp 的读取/调查类工具——`read`、`grep`、`glob`、`web_search`、`ask`、`task`、`todo`、`recall`、`reflect`、`set_approval_mode`，以及 `hypa_*` 只读工具（`hypa_read`、`hypa_search`、`hypa_code`、`hypa_compress`、`hypa_session`）、配置 `tools.allow` 中列出的工具，以及只读 `bash` 命令。其余工具在 Ask/Plan 中一律拦截。

## 命令

```bash
/approval-mode [ask|auto|act|plan]  # 切换模式
```

## 工具（agent 可调用）

```typescript
// agent 可以通过调用此工具自动切换模式
set_approval_mode({ mode: "plan" })  // 切换到只读计划模式
set_approval_mode({ mode: "act" })   // 切换到完全权限模式
```

## 规则引擎

### 评估优先级

```
deny 规则（硬阻断，任何模式不可覆盖）
  ↓ 未命中
allow 规则（自动放行，跳过模式检查）
  ↓ 未命中
session always rules（交互式临时规则）
  ↓ 未命中
模式层决策（ask/plan 阻断写操作，act 放行，auto 走 AI 审查）
```

### Deny 规则（所有模式生效）

**bash 命令：**
- tree-sitter 解析链式命令（`&&`、`||`、`;`、`|`）
- 检测命令替换 `$(...)` 与子 shell
- 通配符匹配：`"sudo *": "禁止 sudo"`
- 硬编码灾难命令兜底：`rm -rf /`、fork 炸弹、`curl|bash`
- 同时作用于内置 `bash` 工具与 `hypa_shell` 等扩展 shell

**文件路径（跨工具）：**
- `read`/`write`/`edit`/`grep`/`glob`/`bash` 均受路径规则约束
- 解析符号链接以防绕过
- 通配符匹配：`"*.env": "禁止访问环境变量文件"`

### Allow 规则

| 类别 | 命令 |
|------|------|
| 文件查看 | `cat`, `head`, `tail`, `less`, `more`, `wc`, `file`, `stat` |
| 目录/搜索 | `ls`, `tree`, `find`, `grep`, `rg` |
| Git | `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `describe`, `blame`, `reflog` |
| 系统状态 | `ps`, `top`, `df`, `du`, `free`, `uptime`, `uname`, `id`, `whoami` |
| 包管理 | `npm list/info/view`, `pip list/show`, `cargo tree`, `go list` |
| Docker | `docker ps/images/logs/inspect/version` |
| 归档 | `zcat`, `zgrep`, `unzip -l`, `tar -t` |
| 文本处理 | `awk`, `sed`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff` |
| 网络 | `curl`, `wget`, `ping`, `dig`, `traceroute`, `whois`, `netstat` |

## 配置

默认规则在 `config.default.json` 中。

用户自定义配置在 `~/.omp/agent/extensions/omp-permission-suite/config.json`。首次加载时自动从默认文件创建。

```jsonc
{
  // bash 命令规则
  "bash": {
    "deny": {
      "rm -rf /": "禁止删除根目录",
      "sudo *": "禁止 sudo",
      "curl * | bash": "禁止远程代码执行"
    },
    "allow": {
      "bun test": true,
      "bun run *": true,
      "git status": true,
      "git diff": true,
      "cat *": true
    }
  },
  // 跨工具文件路径规则
  "path": {
    "deny": {
      "*.env": "禁止访问环境变量文件",
      "~/.ssh/*": "禁止访问 SSH 密钥"
    },
    "allow": {
      "*.env.example": true
    }
  },
  // 按工具名（支持通配符）的整体规则
  "tools": {
    "deny": {},
    "allow": {
      "hypa_read": true,
      "hypa_search": true
    }
  }
}
```

### 配置语义

- `deny` 下的规则 → 硬阻断，任何 Mode 都不能覆盖（包括 `act`）
- `allow` 下的规则 → 自动放行，不经过 Mode 层
- 都不命中 → 交给 Mode 层决策

## Auto 模式

在 `auto` 模式下，未命中 allow/deny 规则的工具调用会交给 subagent 审批器。审批器运行一个无头 `omp` 子进程，并从 `~/.omp/agent/agents/approver.md` 读取配置（frontmatter 中的 `model:` + 系统提示词正文）。低置信度的决策会升级为交互式确认。若该 agent 文件不存在，则每次不确定的调用都会升级给用户确认。

## 项目结构

```
omp-permission-suite/
├── index.ts              # 主逻辑（ExtensionAPI）
├── types.ts              # 公共类型
├── rules.ts              # 规则引擎
├── approver.ts           # 审批器
├── subprocess-runner.ts  # 无头 omp 子进程调用
├── bash-parser.ts        # tree-sitter bash 解析
├── wildcard-matcher.ts   # 通配符匹配
├── path-utils.ts         # 路径工具
├── config-loader.ts      # 配置加载
├── config.default.json   # 默认规则
├── README.md             # 英文版
└── README-zh.md          # 本文件（中文版）
```

## 开发

```bash
bun install
bun test
```

## License

MIT — 基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system)（MIT）。
