# Harness 探测功能实现总结

## 功能概述

在治理台添加了本地 Harness 安装探测功能，可以：
1. 自动扫描常见的 Pi 和 OpenCode 安装路径
2. 检测每个 Harness 是否安装了 Amos 插件
3. 在 Web 界面展示探测结果，区分受管理和未管理的 Harness

## 实现内容

### 1. 后端实现

#### `control-plane/harness-discovery.ts`
- 实现 `discoverHarnessInstallations()` 函数
- 扫描常见安装路径：
  - Pi: `~/.pi`, `~/.local/share/pi`, `/opt/pi`, `/usr/local/pi`
  - OpenCode: `~/.opencode`, `~/.config/opencode`, `~/.local/share/opencode`, `/opt/opencode`, `/usr/local/opencode`
- 检测 Harness 特征文件判断是否为有效安装
- 检测 Amos 插件标记：
  - Pi: `node_modules/@amos/pi-plugin`, `extensions/amos`, `.pi-extensions/amos`
  - OpenCode: `plugins/amos`, `.opencode/plugins/amos`
- 尝试读取版本信息（从 package.json、version.json 或 VERSION 文件）
- 优雅处理文件系统权限错误

#### `control-plane/contracts.ts`
- 添加 `HarnessInstallation` 接口
- 添加 `HarnessDiscoveryResult` 接口
- 在 `ControlPlane` 接口添加 `discoverHarnesses()` 方法

#### `control-plane/store.ts`
- 实现 `discoverHarnesses()` 方法，调用探测逻辑并返回冻结的结果

#### `control-plane/http.ts`
- 添加 `GET /api/harnesses` 路由
- 需要认证访问
- 返回探测结果 JSON

#### 测试
- `control-plane/harness-discovery.test.ts`: 验证数据结构和错误处理

### 2. 前端实现

#### `web/src/types/index.ts`
- 导出 `HarnessInstallation` 和 `HarnessDiscoveryResult` 类型

#### `web/src/lib/api.ts`
- 添加 `discoverHarnesses()` API 客户端方法

#### `web/src/views/HarnessesView.vue`
- 新的 Harness 探测页面
- 显示统计卡片：已扫描路径、发现的 Harness、受管理的 Harness
- 分两个区域展示：
  - 受管理的 Harness（已安装 Amos 插件）：绿色正面提示
  - 未管理的 Harness（未安装 Amos 插件）：橙色警告提示
- 每个 Harness 显示：名称、版本、安装路径、插件路径
- 可折叠的已扫描路径详情
- 支持手动刷新

#### `web/src/router/index.ts`
- 添加 `/harnesses` 路由

#### `web/src/components/layout/navigation.ts`
- 在"系统"导航区添加"Harness 探测"菜单项
- 使用 `ServerCog` 图标

## 安全考虑

1. **权限边界**：探测仅读取文件系统元数据，不执行代码或修改文件
2. **错误处理**：优雅处理权限拒绝、符号链接、不存在路径等情况
3. **认证要求**：API 需要经过认证的会话访问
4. **信息披露**：仅暴露安装路径和版本信息，不泄露敏感数据

## 用户体验

1. **自动探测**：页面加载时自动执行探测
2. **手动刷新**：提供刷新按钮重新扫描
3. **清晰分类**：用颜色和图标区分受管理/未管理状态
4. **安装提示**：对未管理的 Harness 显示安装插件提示
5. **详细信息**：展示安装路径、版本、插件路径等完整信息

## 测试覆盖

- ✅ 后端单元测试：数据结构验证、错误处理
- ✅ 前端类型检查：TypeScript 编译通过
- ✅ 完整构建：npm build 成功
- ✅ 现有测试：所有测试保持通过（973 个后端测试 + 21 个前端测试）

## 局限性说明

1. **快照性质**：探测结果是静态快照，不反映实时运行状态
2. **路径覆盖**：仅扫描常见路径，非标准安装可能遗漏
3. **版本检测**：依赖标准版本文件，某些安装可能无法获取版本
4. **插件检测**：基于文件系统标记，不验证插件功能完整性

## 未来改进方向

1. 支持用户自定义扫描路径
2. 检测 Harness 运行状态（进程、端口）
3. 提供插件安装引导链接
4. 支持刷新单个 Harness 而非全量扫描
5. 缓存探测结果减少文件系统访问
