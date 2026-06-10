# WeSight Agent CLI 程序化真实冒烟测试说明

## 背景

本次修复围绕 Agent Engine 在“跟随 WeSight 模型设置”时的真实运行链路，重点验证：

- Claude Code 使用 WeSight 配置时，不污染本地 `~/.claude/settings.json`。
- Codex CLI 使用 WeSight 配置时，只使用临时 `CODEX_HOME`，不污染本地 `~/.codex/config.toml` / `auth.json`。
- Codex CLI 遇到 WeSight 当前 provider 为 Anthropic-compatible 配置时，自动切换到同 provider 预置的 OpenAI-compatible endpoint，再通过 WeSight proxy 调用。
- 真实启动 Claude Code 和 Codex CLI，而不是只跑单元测试或 mock。

## 测试脚本

新增脚本：

```text
scripts/wesight-agent-cli-smoke.cjs
```

脚本运行在 Electron runtime 中，而不是普通 Node 进程中。原因是 WeSight OpenAI compatibility proxy 使用 Electron 的 `session.defaultSession.fetch`，真实测试需要处在 Electron 环境内才能复用完整链路。

脚本会：

- 只读正式 WeSight DB：`%APPDATA%\WeSight\wesight.sqlite`。
- 读取正式 `app_config` 中 provider 的 API key、baseUrl、apiFormat、models。
- 创建临时 userData 目录和临时 SQLite DB。
- 将单个 provider 配置写入临时 DB，并按测试 case 切换 `apiFormat`。
- 启动 `startCoworkOpenAICompatProxy()`。
- 使用 `ExternalCliRuntimeAdapter` 真实启动 Claude Code / Codex CLI。
- 创建临时 workspace 和 Cowork session。
- 发送带 `WESIGHT_SMOKE_OK` 标记要求的 prompt。
- 最后校验本地 CLI 配置文件 hash 是否保持不变。

正式 DB 不会写入测试会话；MiniMax 这类正式配置中 `enabled=false` 但已有 API key/model 的 provider，会只在临时 DB 中启用用于测试。

## 测试设计原则

这次程序化测试不是单元测试的替代，而是补齐“真实 CLI + 真实 provider + WeSight proxy + 临时配置隔离”的端到端验证。

核心原则：

- 使用真实 Claude Code / Codex CLI 进程，避免只验证 mock adapter。
- 读取 WeSight 正式 DB 中已经配置好的 provider，避免人工重新录入测试配置导致偏差。
- 所有会被测试流程修改的状态都放到临时 userData、临时 DB、临时 workspace 中。
- Codex 使用 WeSight 设置时必须走临时 `CODEX_HOME`，不能改写用户本地 `~/.codex`。
- Claude Code 使用 WeSight 设置时必须通过环境变量和临时上下文注入，不能改写用户本地 `~/.claude/settings.json`。
- 每次测试前后对本地 Claude/Codex 配置文件做 hash 对比，把“配置不被污染”作为验收条件。
- Codex 不测试 `local_cli` 直连 OpenAI 账号，因为该链路不经过 WeSight provider/proxy，不能证明本次修复是否有效。

适合验证的问题：

- “跟随 WeSight 设置”是否真实调用了当前 provider。
- Anthropic-compatible provider 是否能为 Codex 自动切换到同 provider 的 OpenAI-compatible endpoint。
- WeSight proxy 是否把 Codex `/responses` 请求正确转成上游 `/v1/chat/completions`。
- CLI 进程结束后，Cowork session 是否收到 `complete` 并落到 `completed` 状态。
- 本地 CLI 配置是否保持不变。

不适合验证的问题：

- 第三方模型内容质量。
- Codex 使用用户本地 OpenAI/ChatGPT 账号的原生能力。
- UI 交互细节，例如按钮状态、滚动、输入框禁用状态。
- provider 长时间稳定性或并发压测。

## 常用命令

先编译 Electron 主进程：

```bash
npx tsc -p electron-tsconfig.json
```

列出正式 DB 中 provider 摘要，不输出 API key：

```powershell
$env:WESIGHT_SMOKE_LIST_PROVIDERS='1'
npx electron scripts/wesight-agent-cli-smoke.cjs
```

跑 DeepSeek 最小关键 case：

```powershell
$env:WESIGHT_SMOKE_PROVIDERS='deepseek'
$env:WESIGHT_SMOKE_FORMATS='anthropic'
$env:WESIGHT_SMOKE_ENGINES='codex'
$env:WESIGHT_SMOKE_TIMEOUT_MS='300000'
npx electron scripts/wesight-agent-cli-smoke.cjs
```

跑完整 DeepSeek + MiniMax 矩阵：

```powershell
$env:WESIGHT_SMOKE_PROVIDERS='deepseek,minimax'
$env:WESIGHT_SMOKE_FORMATS='anthropic,openai'
$env:WESIGHT_SMOKE_ENGINES='claude,codex'
$env:WESIGHT_SMOKE_TIMEOUT_MS='300000'
npx electron scripts/wesight-agent-cli-smoke.cjs
```

可选环境变量：

```text
WESIGHT_SMOKE_PROVIDERS       默认 deepseek,minimax
WESIGHT_SMOKE_FORMATS         默认 anthropic,openai
WESIGHT_SMOKE_ENGINES         默认 claude,codex
WESIGHT_SMOKE_TIMEOUT_MS      默认 300000
WESIGHT_SMOKE_LIST_PROVIDERS  设置为 1 时只列 provider，不发起模型请求
WESIGHT_SMOKE_KEEP_TEMP       设置为 1 时保留临时目录
WESIGHT_SMOKE_PROMPT          覆盖默认测试 prompt
WESIGHT_SMOKE_USER_DATA       覆盖正式 WeSight userData 路径
```

## 本次真实测试结果

本次测试真实启动了 Claude Code 和 Codex CLI，并真实调用 DeepSeek / MiniMax provider。

通过的 case：

```text
DeepSeek + Anthropic-compatible + Claude Code
DeepSeek + Anthropic-compatible + Codex CLI
DeepSeek + OpenAI-compatible + Claude Code
DeepSeek + OpenAI-compatible + Codex CLI
MiniMax + Anthropic-compatible + Claude Code
MiniMax + Anthropic-compatible + Codex CLI
MiniMax + OpenAI-compatible + Claude Code
MiniMax + OpenAI-compatible + Codex CLI
```

关键日志证据：

```text
[ExternalCliRuntimeAdapter] starting Codex CLI.
configSource: 'wesight_model'
usesTemporaryCodexHome: true
codexServerUrl: 'http://127.0.0.1:<port>/'
wireApi: 'responses'
```

DeepSeek Anthropic-compatible 配置下，Codex 自动切换并通过 WeSight proxy 转发到：

```text
[CoworkProxy] Responses compat → https://api.deepseek.com/v1/chat/completions (provider: deepseek)
```

MiniMax Anthropic-compatible 配置下，Codex 自动切换并通过 WeSight proxy 转发到：

```text
[CoworkProxy] Responses compat → https://api.minimaxi.com/v1/chat/completions (provider: minimax)
```

本地 CLI 配置保护校验通过：

```json
{
  "claudeSettings": true,
  "codexConfig": true,
  "codexAuth": true
}
```

含义：

- `~/.claude/settings.json` 测试前后 hash 不变。
- `~/.codex/config.toml` 测试前后 hash 不变。
- `~/.codex/auth.json` 测试前后 hash 不变。

## 验收标准

每个通过的 case 满足：

- session 状态为 `completed`。
- 收到 runtime `complete` 事件。
- assistant 输出非空。
- assistant 输出包含 `WESIGHT_SMOKE_OK`。
- Codex case 使用临时 `CODEX_HOME`。
- Codex case 的 `base_url` 指向 WeSight local proxy。
- proxy upstream 指向 DeepSeek/MiniMax OpenAI-compatible endpoint。
- 本地 Claude/Codex 配置文件 hash 不变。

## 注意事项

- 该脚本会真实调用配置的第三方大模型，可能产生 token 消耗。
- 不测试 Codex `local_cli` 直连 OpenAI 原始本地账号，因为这与 WeSight 配置链路无关。
- MiniMax 当前正式配置中 `enabled=false`，但已有 API key 和模型。本次脚本仅在临时 DB 中启用 MiniMax 进行测试，不修改正式 DB。
- Windows 上临时目录偶尔会因为文件锁导致清理时报 `EPERM`。脚本已将清理改为 best-effort；如有残留，可稍后手动删除 `%TEMP%\wesight-agent-cli-smoke-*`。

## 相关验证命令

本次配套代码验证：

```bash
npx vitest run src/main/libs/claudeSettings.test.ts src/main/libs/agentEngine/externalCliRuntimeAdapter.test.ts src/main/libs/coworkOpenAICompatProxy.test.ts
npx tsc -p electron-tsconfig.json
npx eslint src/main/libs/claudeSettings.ts src/main/libs/claudeSettings.test.ts src/main/libs/agentEngine/externalCliRuntimeAdapter.ts src/main/libs/agentEngine/externalCliRuntimeAdapter.test.ts
```

lint 当前只有既有 `any` warning，没有 error。
