# Harness 探测使用指南

## 访问与刷新

在治理台侧边栏的“系统”分组中点击“Harness 检测”，或直接访问 `#/harnesses`。

页面加载时自动探测；点击右上角“刷新”会重新执行终端探测。

## 统一 Harness 目录

页面固定列出：

| Harness | 支持级别 | 当前能力 |
| --- | --- | --- |
| Pi | 当前支持 | 安装与 Amos 插件探测，已有 Pi 适配器 |
| OpenCode | 当前支持 | 安装与 Amos 插件探测，已有 OpenCode 适配器 |
| Oh My Pi | 当前支持 | 安装探测；Pi 兼容，复用 Pi 适配器 |
| Codex | 未来支持 | 仅安装探测 |
| Claude Code | 未来支持 | 仅安装探测 |
| DSH | 未来支持 | 仅安装探测；未来以 DSH 插件形式支持 |

每行提供两个独立状态：

- **已探测到**：终端命令 `command -v <命令>` 解析到了该 Harness 的可执行文件；
- **已受到管理**：在 Pi 或 OpenCode 的配置根中找到了 Amos 插件标记。

未探测到的行显示为灰色。已探测到但未找到 Amos 插件的 Harness 显示“未受管理”。未来支持项即使已安装，也不会因此变为当前支持或已受到管理。

Oh My Pi 通过 Pi 适配器接入，仓库已有项目级兼容验证。其项目级 `.pi/amos.json` 和显式扩展加载不属于当前全局探测 API 的探测上下文，因此目录中的 Oh My Pi `managed` 保持 `false`；实际项目加载状态查看对应 Harness 加载报告。

“已受到管理”只描述插件文件探测结果，不表示插件已加载、治理规则已生效或 Harness 正在 enforcing 模式运行。

## 探测方式

探测对全部 Harness 使用同一套终端命令，命令名为模块内固定常量：`pi`、`opencode`、`codex`、`claude`、`dsh` 和 `omp`。

1. 存在性与路径：执行 `sh -c 'command -v <命令>'`。退出码为 0 且输出非空即视为已探测到，输出的路径行就是安装位置。
2. 版本（尽力而为）：执行 `sh -c '<命令> --version'`，5 秒超时，读取标准输出与标准错误，取第一个版本形状的 token。失败、超时或不匹配时为 `null`，不影响已探测到的结论。

探测需要 POSIX shell（`sh`）。服务进程无法启动 shell 时，所有 Harness 均报告未探测到。

Amos 插件按文件系统标记检测（Pi 的 `~/.pi` 与 OpenCode 配置根），与 Harness 二进制探测相互独立；安装判定与路径只来自终端命令执行结果，不读取包元数据。

## 统计与详情

顶部统计卡片显示：

- **已探测到**：`detected=true` 的目录项数量；
- **已受到管理**：`managed=true` 的目录项数量。

可用时，每行还显示接入说明、版本、安装位置和 Amos 插件路径；安装位置以 harness 名称下方的一行小字呈现。

## API

后端提供 `GET /api/harnesses`，需要 human 或 agent 认证。

响应保留 `installations`，并提供完整 `harnesses` 目录。以下为目录字段示例：

```json
{
  "installations": [],
  "harnesses": [
    {
      "id": "pi",
      "name": "Pi",
      "support": "current",
      "supportNote": null,
      "detected": false,
      "managed": false,
      "path": null,
      "version": null,
      "amosPluginPath": null
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "support": "current",
      "supportNote": null,
      "detected": true,
      "managed": false,
      "path": "/home/user/.local/bin/opencode",
      "version": "2.2.5",
      "amosPluginPath": null
    },
    {
      "id": "codex",
      "name": "Codex",
      "support": "future",
      "supportNote": null,
      "detected": false,
      "managed": false,
      "path": null,
      "version": null,
      "amosPluginPath": null
    },
    {
      "id": "claude-code",
      "name": "Claude Code",
      "support": "future",
      "supportNote": null,
      "detected": true,
      "managed": false,
      "path": "/home/user/.local/bin/claude",
      "version": "2.1.316",
      "amosPluginPath": null
    },
    {
      "id": "dsh",
      "name": "DSH",
      "support": "future",
      "supportNote": "未来以 DSH 插件形式支持",
      "detected": false,
      "managed": false,
      "path": null,
      "version": null,
      "amosPluginPath": null
    },
    {
      "id": "oh-my-pi",
      "name": "Oh My Pi",
      "support": "current",
      "supportNote": "Pi 兼容，使用 Pi 适配器",
      "detected": true,
      "managed": false,
      "path": "/home/user/.local/bin/omp",
      "version": "18.16.0",
      "amosPluginPath": null
    }
  ]
}
```

## 注意事项

1. 探测会执行 `command -v` 和 `<命令> --version`（5 秒超时），不会启动交互式会话，也不修改安装或配置。
2. 结果是请求时刻的快照；安装或插件变更后需手动刷新。
3. 探测使用服务进程的环境（包括 `PATH`），可能与交互式终端不同，因此结果可能与手动执行 `command -v` 不一致。每行显示的安装位置可用于确认实际探测环境。
4. 版本为尽力而为：命令未输出可识别版本、退出失败或超时均显示为未知。
5. shell 不可用、命令缺失或探测错误一律按未探测到处理，不会中断其他 Harness 的探测。
