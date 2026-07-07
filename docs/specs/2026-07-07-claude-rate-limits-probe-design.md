# Claude 5h/weekly 用量探测(claude -p /usage)— 设计

日期:2026-07-07

## 背景

Claude Code 不在任何本地文件或公开 API 暴露 Pro/Max 订阅的 5h/weekly 用量
(会话 JSONL、`~/.claude` 缓存均无,statusline 输入也不含;GitHub issue
anthropics/claude-code#44328 是未实现的功能请求)。实测确认
`claude -p "/usage"` 在 print 模式下本地执行,输出稳定文本、耗时约 5s、
不消耗模型配额:

```
Current session: 25% used · resets Jul 7 at 8:20pm (Asia/Shanghai)
Current week (all models): 8% used · resets Jul 14 at 1am (Asia/Shanghai)
Current week (Fable): 15% used · resets Jul 14 at 1am (Asia/Shanghai)
```

同时实测确认:每次执行会在 cwd 对应的 `~/.claude/projects/<munged>/` 下创建
一个**没有 assistant 条目**的会话 JSONL。现有 `readLatestClaudeUsage` 只读
最新文件,会被这类文件顶掉(返回 null)。

## 目标效果

- Claude 活跃:`Claude ⚡ 50% · 5h 25% · w 8%`;tooltip 自动多两行
  (`5h usage: 25%`、`Weekly usage: 8%`,无 Reset 时间)。
- 探测从未成功:段与 tooltip 行省略,显示与现状一致。
- 探测失败(CLI 缺失、超时、格式变化):沿用上次成功值;从未成功则无段。
  绝不影响 context 百分比主显示。

## 组件设计

### 1. 新模块 `src/claudeRateLimits.js`(纯逻辑层,不依赖 vscode)

- `parseUsageOutput(text)`:多行正则解析
  - `/^Current session:\s*(\d+(?:\.\d+)?)%\s*used/m` → `primary`,`window_minutes: 300`
  - `/^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used/m` → `secondary`,`window_minutes: 10080`
  - 输出与 Codex `rateLimits` 同构:`{ primary?: { used_percent, window_minutes }, secondary?: ... }`;
    某行不匹配则省略对应窗口,两者皆无 → 返回 `null`。不解析 resets 时间(YAGNI,
    英文+时区解析脆弱);忽略模型专项行(如 `Current week (Fable)`)。
- `resolveClaudeCliPath(configuredPath, existsSyncImpl = fs.existsSync, platform = process.platform, env = process.env)`:
  返回第一个存在的候选。POSIX:`configuredPath`(非空时)→ `~/.local/bin/claude` →
  `/opt/homebrew/bin/claude` → `/usr/local/bin/claude` → 裸 `"claude"`(PATH 兜底)。
  Windows(`win32`):`configuredPath` → `~\.local\bin\claude.exe`(原生安装器)→
  `%APPDATA%\npm\claude.cmd`(npm 全局)→ 裸 `"claude"`。
  必要性:VS Code extension host 的 PATH 通常不含 shell profile 添加的目录,
  本机 claude 即安装在 `~/.local/bin`;Windows 上可执行名带 `.exe`/`.cmd` 后缀,
  Unix 候选永不命中。
- `probeClaudeRateLimits(options)`:`options = { cliPath?, cwd?, timeoutMs?, execFileImpl?, platform? }`。
  用 `child_process.execFile` 异步执行 `<cli> -p /usage`,默认 `timeoutMs: 30000`、
  `cwd: os.tmpdir()`(munged 后不匹配任何工作区,探测会话不干扰项目过滤)。
  Windows 下 `.cmd`/`.bat` 及无路径分隔符的裸命令名走 `shell: true` 且路径加引号:
  Node 修复 CVE-2024-27980 后无 shell spawn 批处理直接抛 `EINVAL`,且裸名需要
  cmd.exe 的 PATHEXT 解析才能找到 npm 的 `claude.cmd`;`.exe` 与 POSIX 路径直接执行。
  返回 Promise:成功 resolve `parseUsageOutput(stdout)`,任何错误 resolve `null`
  (不 reject)。`execFileImpl` 供测试注入。

### 2. `src/claudeUsage.js`:文件选择回退(顺带修复既有隐患)

`readLatestClaudeUsage` 不再只读最新文件:按 mtime 降序尝试前
`MAX_SESSION_FILE_CANDIDATES = 10` 个文件,返回第一个能读出 assistant+usage
事件的。新增内部函数 `listClaudeSessionFilesByMtime(claudeRoot, workspaceFolders)`
承载扫描+排序;`findLatestClaudeSessionFile` 改为其薄封装(取 `[0]`),导出与
既有测试保持不变。该回退同时修复"刚开新会话尚无首个回复时 Claude 从状态栏
消失"的现存问题。`readLastMatchingEvent` 的 mtime+size 缓存使重复尝试成本低。

### 3. `src/agentUsage.js`:聚合层注入

`readLatestAgentUsage(options)` 新增 `options.claudeRateLimits`;当选出的
provider 为 `Claude` 且 `usage.rateLimits` 为空时附上。Codex 胜出时不附;
未来 Claude JSONL 若自带 `rateLimits` 则不覆盖。状态栏段与 tooltip 行由
既有 `formatRateLimitsStatusBar` / `formatRateLimits` 自动成立,零改动。

### 4. `src/extension.js`:探测定时器与缓存

- 新状态:`probeTimer`、`latestClaudeRateLimits = null`。
- 新配置:`agentTokenStatus.claudeUsageProbeIntervalMs`(默认 300000 = 5 分钟;
  `<= 0` 禁用;有效值下限钳制 60000,防误设过小频繁拉起进程)、
  `agentTokenStatus.claudeCliPath`(默认空 = 自动探测路径)。
- `probeClaude()`:调 `probeClaudeRateLimits({ cliPath: resolveClaudeCliPath(配置) })`;
  成功(非 null)则更新 `latestClaudeRateLimits` 并 `refreshStatus()`;失败保留旧值。
- `activate`:立即探测一次 + `startProbeTimer()`;两个新配置加入 `WATCHED_SETTINGS`,
  变更时重启探测定时器;`deactivate`/dispose 清理 `probeTimer`。
- `readUsage()` 传 `claudeRateLimits: latestClaudeRateLimits`。

### 5. `package.json`

`contributes.configuration.properties` 新增上述两个配置项声明。

## 测试

- `test/claudeRateLimits.test.js`(新):
  - `parseUsageOutput`:真实输出夹具全解析;缺 weekly 行只出 primary;乱文本/空 → null。
  - `resolveClaudeCliPath`:注入 fake existsSync 测候选顺序与 PATH 兜底。
  - `probeClaudeRateLimits`:注入 fake execFileImpl 测成功解析与错误 → null。
- `test/claudeUsage.test.js`:新增回退测试——最新文件仅 user 事件时返回次新
  文件的数据;既有 `findLatestClaudeSessionFile` 测试保持不变。
- `test/agentUsage.test.js`:`claudeRateLimits` 注入(Claude 胜出附上、Codex
  胜出不附、已有 rateLimits 不覆盖);Claude + rateLimits 的状态栏文本断言。

## 文档同步

CLAUDE.md / AGENTS.md / README.md:状态栏示例补 Claude 段、新配置项说明、
探测机制一句话(数据来自定期执行 `claude -p "/usage"`,默认 5 分钟)。
