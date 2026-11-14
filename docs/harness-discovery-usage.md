# Harness 探测功能使用指南

## 访问方式

在治理台侧边栏的"系统"分组中，点击"Harness 探测"菜单项，或直接访问 `#/harnesses` 路由。

## 功能说明

### 自动探测
页面加载时会自动扫描以下常见路径：
- **Pi**: `~/.pi`, `~/.local/share/pi`, `/opt/pi`, `/usr/local/pi`
- **OpenCode**: `~/.opencode`, `~/.config/opencode`, `/opt/opencode` 等

### 统计概览
页面顶部显示三个统计卡片：
- **已扫描路径**: 检查的安装位置数量
- **发现 Harness**: 找到的 Harness 实例总数
- **受 Amos 管理**: 已安装 Amos 插件的 Harness 数量

### 受管理的 Harness
显示已安装 Amos 插件的 Harness，绿色标识，包含：
- Harness 名称（Pi 或 OpenCode）
- 版本号
- 安装路径
- **Amos 插件路径**（绿色高亮显示）

这些 Harness 可以接受治理规则管理。

### 未管理的 Harness
显示未安装 Amos 插件的 Harness，橙色警告标识，包含：
- Harness 名称和版本
- 安装路径
- 安装提示信息

这些 Harness 无法接受治理规则，需要手动安装 Amos 插件。

### 刷新功能
点击页面右上角的"刷新"按钮可以重新扫描系统，获取最新的 Harness 安装状态。

## API 端点

后端提供 `GET /api/harnesses` API：
- 需要认证（human 或 agent token）
- 返回 JSON 格式的探测结果

### 响应格式
```json
{
  "installations": [
    {
      "harness": "pi",
      "path": "/home/user/.pi",
      "version": "2.1.0",
      "amosPluginInstalled": true,
      "amosPluginPath": "/home/user/.pi/extensions/amos"
    }
  ],
  "scannedPaths": [
    "/home/user/.pi",
    "/home/user/.opencode",
    "/opt/pi"
  ]
}
```

## 注意事项

1. **权限要求**: 探测需要读取文件系统，可能受权限限制影响
2. **快照性质**: 结果是探测时刻的快照，不实时更新
3. **路径限制**: 仅扫描预定义的常见路径，非标准安装可能遗漏
4. **安全边界**: 探测仅读取元数据，不执行代码或修改文件

## 典型用例

### 场景 1: 检查现有 Harness 状态
系统管理员可以快速查看本地所有 Harness 安装，确认哪些已经受 Amos 管理。

### 场景 2: 识别需要安装插件的 Harness
通过"未管理的 Harness"列表，可以识别需要安装 Amos 插件的实例。

### 场景 3: 验证插件安装
安装 Amos 插件后，刷新探测页面验证插件是否被正确识别。

## 技术细节

- **实现**: 纯文件系统扫描，无需 Harness 运行
- **性能**: 轻量级探测，通常在毫秒级完成
- **兼容性**: 支持 Pi 和 OpenCode 两种 Harness
- **错误处理**: 优雅处理权限拒绝、路径不存在等异常情况
