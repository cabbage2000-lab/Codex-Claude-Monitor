# Claude 限流:OAuth 直读源与代理支持 — 设计

日期:2026-08-05

## 背景

`docs/specs/2026-07-23-statusline-usage-bridge-design.md` 的 statusline 桥接方案
只在终端会话下有效:statusline 输入构造函数挂在 ink 的 `useCallback` 上,属于
TUI 渲染路径的一部分。纯粹通过 VS Code 面板驱动的 Claude Code 会话从不执行它,
`~/.claude/.usage-cache.json` 因此长期不更新,余量段被 staleness 规则隐藏。

补齐这个缺口的通道是 `GET /api/oauth/usage` —— Claude Code 自己的用量面板走的
就是这个接口(内部 `fetchUsageData`),用本地已有的 OAuth 凭据,不依赖任何终端
渲染路径。

## 一次错误结论,以及它是怎么产生的

首版实现落地后该数据源始终无数据,端点稳定返回:

```json
403 {"type":"forbidden","message":"Request not allowed"}
```

当时据此判定"端点不服务 team / enterprise 订阅",并设了永久 `unsupported` 标记
彻底停止重试,还把这个结论写进了 CLAUDE.md 和 package.json 的配置说明。

**这个结论是错的。** 2026-08-05 复查(对照 cc-switch 的同类实现)发现:

| 请求路径 | 结果 |
| --- | --- |
| 直连 `/api/oauth/usage`,任意 header 组合(6 种) | 403 |
| 直连 `/v1/messages` | 403 |
| **经本机代理隧道 `/api/oauth/usage`** | **200,完整数据** |

同一个 token、同一个账号,唯一的差别是走不走代理。真正的原因是 `node:https`
**完全忽略** `http_proxy` / `https_proxy` 环境变量,请求一直在直连出网,而
Anthropic 对部分地区的直连一律拒绝。

致命处在于**这个 403 与账号级拒绝的响应完全相同** —— 同样的 status、同样的
`type` 与 `message`。仅凭响应无法区分"这个账号不被服务"和"这条连接不被允许",
而当时的实现把二义信号当成了确定结论,还据此永久关闭了重试。

对照实现 cc-switch(Rust)之所以正常,只是因为 reqwest 默认跟随系统代理环境
变量,与它的 header、鉴权方式无关。

## 设计要点

### 1. 代理支持是必需项,不是增强项

零依赖实现(项目约束:除 Node 内置模块与 `vscode` API 外无依赖):

- `resolveProxyUrl(hostname, override, env)` — 按 curl 的优先级挑选代理:
  scheme 专用变量优先(`https_proxy` 先于 `http_proxy`),同名时小写先于大写;
  容忍裸 `host:port`(补 `http://`);拒绝 `socks`,因为 CONNECT 隧道说不了这个
  协议。`no_proxy` 按主机后缀匹配,支持可选前导点、可选 `:port`、以及裸 `*`;
  IP 字面量只做精确匹配(不支持 CIDR,与 curl 一致)。
- `connectViaProxy(...)` — 发 CONNECT 建隧道,再让 `tls.connect` 跑在返回的
  socket 上。**非 200 必须 reject**:代理的 407/403 常带 HTML body,若当成可用
  socket 继续握手,最终会以一个与代理无关的 TLS 错误冒出来,极难定位。

代理来源的优先级是 `extension.js` 注入的 VS Code `http.proxy` 设置 > 环境变量。
这个顺序是必要的:从 Finder 或 Dock 启动的编辑器不继承任何 shell 环境,环境
变量那条路在最常见的启动方式下恰好是空的。

### 2. 401/403 不再是永久判决

`state.unsupported`(永久)改为 `state.usageRefused`(可恢复):

- 它的作用只有两个 —— 启用备用的 quota probe,以及经
  `isClaudeOAuthUsageUnsupported()` 暴露给诊断。
- 每次尝试仍会重新请求端点(受正常退避约束),任何一次成功立即清除该标记。
  网络切换、代理启动这类外部条件变化必须能自愈,否则用户只能重载扩展。

唯一保留的粘性标记是 `probeUnsupported`,且只对一种无歧义的情形生效:probe
**成功**但响应里没有任何 rate-limit 头。那是套餐属性而非网络问题,重试只是白
花 token。probe 被 403 拒绝**不**设这个标记。

### 3. 双源顺序

1. `/api/oauth/usage` — 数据最全(`utilization` 已是 0–100,`resets_at` 为 ISO
   8601 字符串),每次都试。
2. quota probe — 复刻 Claude Code 自己的 `quota_check`:`max_tokens: 1` + 单词
   提示,只为收割响应头里的 `anthropic-ratelimit-unified-{5h,7d}-*`(注意这里的
   `utilization` 是 0–1,需要乘 100)。因为要花 token,默认关闭,且只在第 1 源
   确实被拒后才跑。

## 验证

本机实测(2026-08-05),修复后经代理返回:

```text
来源: usage-endpoint    错误: null    被拒: false
5h : 11%  重置于 2026/8/5 19:59:59
7d : 14%  重置于 2026/8/11 00:59:59
```

`npm test` 106 项通过。测试覆盖:代理解析的优先级/裸 host:port/`no_proxy`
各形态/socks 拒绝,以及 403 后仍重试、成功后清除标记两条行为。原有那条把错误
行为固化成断言的用例(`a 403 marks the endpoint unsupported and stops all
further attempts`)已重写。

## 教训

一个二义的失败信号不该被当成确定结论去做永久决策。403 在这里同时覆盖
"账号无权限"和"连接不被允许"两种情况,而后者是可自愈的 —— 把可自愈的失败
永久化,代价是功能静默失效且没有任何恢复路径。凡是要设"永不重试"的地方,先
确认这个信号是否真的无歧义。
