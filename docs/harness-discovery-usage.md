# Harness 探测使用指南

## 访问与刷新

在治理台侧边栏的“系统”分组中点击“Harness 探测”，或直接访问 `#/harnesses`。

页面加载时自动探测；点击右上角“刷新”可生成新的文件系统快照。

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

- **已探测到**：在 `PATH`、mise 补充路径或常见候选目录中找到了安装标记；
- **已受到管理**：在 Pi 或 OpenCode 的配置根中找到了 Amos 插件标记。

未探测到的行显示为灰色。已探测到但未找到 Amos 插件的 Harness 显示“未受管理”。未来支持项即使已安装，也不会因此变为当前支持或已受到管理。

Oh My Pi 通过 Pi 适配器接入，仓库已有项目级兼容验证。其项目级 `.pi/amos.json` 和显式扩展加载不属于当前全局探测 API 的扫描上下文，因此目录中的 Oh My Pi `managed` 保持 `false`；实际项目加载状态查看对应 Harness 加载报告。

“已受到管理”只描述插件文件探测结果，不表示插件已加载、治理规则已生效或 Harness 正在 enforcing 模式运行。

## 探测范围

探测会检查：

- 当前服务进程 `PATH` 中的 `pi`、`opencode`、`codex`、`claude`、`dsh` 和 `omp`；
- `~/.local/bin`；
- `~/.local/share/mise/shims`；
- `~/.local/share/mise/command-wrappers/bin`；
- 各 Harness 的常见安装、配置及数据候选目录；
- DSH 的 `$DSH_HOME`，未设置时使用 `~/.dsh`。

普通符号链接会被解析。mise 安装可通过 shim、命令包装脚本、嵌套 npm 包元数据及原生单文件安装路径识别。只有残留 mise shim 而没有对应安装标记时，不计为已探测到。

只有配置或数据目录本身而没有安装标记时，同样不计为已探测到。

## 统计与详情

顶部统计卡片显示：

- **已扫描路径**：本次实际检查并记录的候选或命中路径数量；
- **已探测到**：`detected=true` 的目录项数量；
- **已受到管理**：`managed=true` 的目录项数量。

可用时，每行还显示接入说明、版本、安装或命令路径和 Amos 插件路径。“已扫描路径”折叠区可用于排查服务实际看到的文件系统位置。

## API

后端提供 `GET /api/harnesses`，需要 human 或 agent 认证。

响应保留 `installations`、`scannedPaths`，并提供完整 `harnesses` 目录。以下为目录字段示例：

```json
{
  "installations": [],
  "scannedPaths": [
    "/home/user/.local/bin/opencode",
    "/home/user/.local/share/mise/installs/claude/2.1.316/claude"
  ],
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

1. 探测仅读取文件系统元数据及包版本信息，不执行 Harness，也不修改安装或配置。
2. 结果是请求时刻的快照；安装或插件变更后需手动刷新。
3. 服务进程的 `PATH` 可能与交互式终端不同。页面中的命令路径和已扫描路径可用于确认实际探测环境。
4. 非标准位置可能未被覆盖；版本元数据缺失时版本显示为未知。
5. 文件系统错误按未命中处理，不会中断其他 Harness 的探测。
