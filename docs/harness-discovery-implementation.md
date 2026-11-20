# Harness 探测功能实现

## 功能概述

治理台提供本地 Harness 安装探测，并在一个目录中展示：

- 当前支持的 Pi、OpenCode 和 Oh My Pi；
- 未来预期支持的 Codex、Claude Code 和 DSH；
- 每项独立的“已探测到”和“已受到管理”状态；
- 未探测到项的灰色展示，以及支持说明、版本、安装路径和 Amos 插件路径等可用详情。

Oh My Pi 复用 Pi 适配器。仓库已记录 Oh My Pi 18.12.6 的 Pi 扩展 API 兼容验证；目录中的“Pi 兼容，使用 Pi 适配器”描述这一接入方式，不引入独立运行适配器。

Claude Code 和 DSH 仅参与探测。DSH 的未来接入形式为 DSH 插件。Codex、Claude Code、DSH 均不加入 `HarnessId` 或运行时报告。

“已受到管理”表示探测到了当前 Pi/OpenCode 配置根中的 Amos 插件标记。它是文件系统快照，不表示插件已加载，也不表示 Harness 正在 enforcing 模式运行。项目级加载报告继续由 `GET /api/projects/:id/runtime` 提供。

## 后端实现

### `control-plane/harness-discovery.ts`

`discoverHarnessInstallations()` 对全部六个 Harness 执行同一套终端命令探测，流程为“定位 → 版本 → 组装”：

1. 定位：执行 `sh -c 'command -v <command>'`。退出码为 0 且 stdout 首行非空即视为终端可达；首行去空白后就是安装路径，非绝对路径经 `resolve()` 转换。非零退出、shell 启动错误、超时或空输出均视为未探测到。
2. 版本：执行 `sh -c '<command> --version'`，5 秒超时，`maxBuffer` 为 64 KiB。合并 stdout 与 stderr，取第一个版本形状的 token（`/[0-9]+(?:\.[0-9A-Za-z._+-]+)*/`），去空白并截断到 64 字符；无匹配、失败或超时返回 `null`。非零退出仍允许解析已打印的文本。
3. 组装：每个定义只保留一次探测结果；Pi/OpenCode 在探测到时额外写入 `installations` 条目，其余字段与既有契约一致。

Harness 目录项的 `id` 与命令名独立映射：Claude Code 使用 `claude`，Oh My Pi 使用 `omp`。命令名为模块内固定常量。

探测需要 POSIX shell。模块依次定位 `/bin/sh`、`/usr/bin/sh`、`/usr/local/bin/sh`，并以绝对路径启动：`spawnSync` 通过子进程 `PATH` 解析可执行文件，而探测会注入自定义 `PATH`，直接使用 `'sh'` 会在该 `PATH` 不含 shell 时失败。shell 不可用时所有探测失败，Harness 报告未探测到。

安装判定与路径只来自终端命令执行结果；探测不读取包元数据，也不解析 mise 或 Homebrew 安装路径。

Amos 插件从配置根检测：

- Pi：`~/.pi` 下的 `extensions/amos`、`extensions/amos.js`、`extensions/amos.ts` 及兼容标记；
- OpenCode：`${XDG_CONFIG_HOME:-~/.config}/opencode` 下的 `plugins/amos`、`plugin/amos` 及对应 `.js`、`.ts` 文件。

新增项不进入旧版 `installations`，其 `managed` 始终为 `false`。Oh My Pi 的既有接入验证使用项目级 `.pi/amos.json` 和显式扩展加载；当前全局探测 API 没有项目上下文，因此不将其他项目的配置归为 Oh My Pi 的受管证据。

### `control-plane/contracts.ts`

`HarnessDiscoveryResult` 保留既有 `installations`，并提供完整的 `harnesses` 目录：

```ts
interface HarnessDiscoveryItem {
  id: string
  name: string
  support: 'current' | 'future'
  supportNote: string | null
  detected: boolean
  managed: boolean
  path: string | null
  version: string | null
  amosPluginPath: string | null
}
```

`supportNote` 提供接入方式说明：DSH 返回“未来以 DSH 插件形式支持”，Oh My Pi 返回“Pi 兼容，使用 Pi 适配器”，其余项目前返回 `null`。

`installations` 继续只包含 Pi/OpenCode 安装，保持现有调用方与运行类型兼容。`harnesses` 始终返回 Pi、OpenCode、Codex、Claude Code、DSH、Oh My Pi 六项，包括未探测到项。

`web/src/types/index.ts` 通过共享契约导出这些类型，视图不维护重复响应类型或 Harness 名单。

## HTTP 与存储

- `control-plane/store.ts` 调用探测逻辑并返回冻结结果；
- `GET /api/harnesses` 要求认证，每次请求重新执行终端探测，不使用缓存；
- 响应仅包含路径、版本、支持说明和状态，不返回 Harness 配置正文或凭据。

## 前端实现

`web/src/views/HarnessesView.vue` 使用 `harnesses` 渲染统一列表：

- 每行显示“当前支持”或“未来支持”；
- 有 `supportNote` 时显示对应接入说明；
- 每行独立显示“已探测到 / 未探测到”和“已受到管理 / 未受管理”；
- 未探测到行整体灰色；
- 顶部统计已探测到数量和已受到管理数量；
- 已探测到的条目在安装位置一行小字中显示路径；
- 保留加载、错误和手动刷新。

页面明确说明“已受到管理”的插件标记语义，不将其呈现为实时治理或 enforcing 证据。

## 测试与边界

`control-plane/harness-discovery.test.ts` 使用真实 `sh` 与临时 home/bin 目录（脚本为 `#!/bin/sh` 并 `chmod 0o755`，注入 `env: { PATH: binDir, HOME: home }`），覆盖：

- 六项目录顺序与支持说明；opencode/pi 的终端路径与版本；dsh 退出失败时仍探测到但版本为 `null`；codex、claude-code、oh-my-pi 未探测；
- bin 目录中的非可执行同名文件不被 `command -v` 视为可执行；
- Pi 与 OpenCode 的 Amos 插件标记，`managed` 状态及 `installations` 路径、版本、插件字段；
- 空机器：六项全部未探测，`installations` 为空数组；
- 版本解析：`Something v10.1.2-beta+1 (build 42)` 得到 `10.1.2-beta+1`，无输出得到 `null`。

主要验证命令：

```bash
npm run build:service
node --test dist/control-plane/harness-discovery.test.js
npm run typecheck
```

探测结果是调用时刻的快照。执行 `command -v` 与 `--version` 说明终端可达并返回了自报版本，不代表 Harness 功能完好、插件已加载或治理规则已生效；实际运行状态以对应 Harness 加载报告为准。Oh My Pi 的兼容验证版本及项目级加载范围以 `docs/pi-adapter.md` 的记录为准。
