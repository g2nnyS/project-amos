# Tauri Desktop Application

Amos控制台的桌面应用，使用Tauri框架构建，相比Electron减少90%+体积。

## 架构

```
┌─────────────────────────────┐
│   Tauri Window              │
│   (System Native WebView)   │
│                             │
│  ┌───────────────────────┐  │
│  │  Vue.js Console       │  │
│  │  (web/src/)           │  │
│  └───────────┬───────────┘  │
│              ↓               │
│         HTTP Request         │
└──────────────┬──────────────┘
               ↓
┌──────────────────────────────┐
│  Node.js Control Plane       │
│  (spawned subprocess)        │
│  - HTTP server               │
│  - Policy engine             │
│  - Audit journal             │
└──────────────────────────────┘
```

## 体积对比

### Electron (旧方案)
- Linux x64: 127 MB
- Windows: 122 MB
- macOS: 122 MB

### Tauri (当前方案)
- Linux x64: ~10 MB (92%减少)
- Linux ARM64: ~10 MB
- Windows: ~5 MB (96%减少)
- macOS: ~3 MB (98%减少)

## 开发环境设置

### 前置条件

1. **Node.js 26+**
   ```bash
   node --version  # 应显示 v26.x.x
   ```

2. **Rust工具链**
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```

3. **系统依赖**

   **Linux (Ubuntu/Debian):**
   ```bash
   sudo apt-get update
   sudo apt-get install -y libwebkit2gtk-4.1-dev \
     build-essential \
     curl \
     wget \
     file \
     libssl-dev \
     libayatana-appindicator3-dev \
     librsvg2-dev
   ```

   **macOS:**
   ```bash
   xcode-select --install
   ```

   **Windows:**
   - 安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   - WebView2已预装在Windows 11，Windows 10会自动安装

### 安装依赖

```bash
npm ci
```

## 开发

### 启动开发模式

```bash
npm run tauri:dev
```

这会：
1. 构建后端TypeScript代码
2. 构建前端Vue应用
3. 启动Tauri开发窗口（带热重载）

### 仅构建后端

```bash
npm run build
```

### 仅启动HTTP服务（不启动桌面窗口）

```bash
npm run console
```

## 生产构建

### 构建所有平台

```bash
npm run tauri:build
```

输出位置：
- Linux: `src-tauri/target/release/bundle/appimage/`
- Windows: `src-tauri/target/release/bundle/nsis/`
- macOS: `src-tauri/target/release/bundle/dmg/`

### 交叉编译 (Linux)

构建ARM64版本（在x64机器上）：
```bash
rustup target add aarch64-unknown-linux-gnu
sudo apt-get install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu
npm run tauri build -- --target aarch64-unknown-linux-gnu
```

## 配置

主要配置文件：
- `src-tauri/tauri.conf.json` - Tauri配置
- `src-tauri/Cargo.toml` - Rust依赖
- `src-tauri/src/main.rs` - 主程序入口

### 重要配置项

**tauri.conf.json:**
- `build.beforeDevCommand` - 开发模式前置命令
- `build.beforeBuildCommand` - 构建前置命令
- `bundle.resources` - 打包资源（dist/、constraints/、guidance/）
- `app.windows` - 窗口尺寸和行为

## 工作原理

1. **启动阶段**
   - Tauri启动Rust进程
   - Rust执行`spawn_control_plane()`
   - 启动Node.js子进程：`node dist/control-plane/cli.js serve --port 0`
   - 读取stdout获取实际服务URL（如`http://127.0.0.1:xxxxx`）

2. **运行阶段**
   - Tauri窗口使用系统WebView加载服务URL
   - Vue前端通过HTTP与Node.js后端通信
   - 所有治理逻辑、策略评估、审计日志在Node.js后端执行

3. **退出阶段**
   - 窗口关闭时Tauri发送终止信号
   - Node.js子进程正常退出
   - Tauri进程退出

## 资源打包

构建时自动打包：
- `dist/` - 编译后的TypeScript代码和Web资源
- `constraints/` - YAML规则定义
- `guidance/` - 注入指导文本

运行时路径解析：
```rust
// 开发模式: 项目根目录
#[cfg(debug_assertions)]
let working_dir = project_root;

// 生产模式: 可执行文件旁边
#[cfg(not(debug_assertions))]
let working_dir = exe_parent_dir;
```

## 调试

### 查看Rust日志
```bash
RUST_LOG=debug npm run tauri:dev
```

### 查看Node.js输出
Node.js的stdout/stderr会转发到Tauri控制台。

### 打开DevTools
开发模式下在窗口内右键选择"Inspect"。

## 常见问题

### Linux: WebKitGTK错误
确保安装了`libwebkit2gtk-4.1-dev`：
```bash
sudo apt-get install libwebkit2gtk-4.1-dev
```

### Windows: 缺少WebView2
Windows 10需要WebView2运行时，会在首次运行时自动下载。或手动下载：
https://developer.microsoft.com/microsoft-edge/webview2/

### macOS: 代码签名问题
开发模式不需要签名。生产构建需要Apple Developer证书。

### 构建体积仍然很大
确保使用release模式：
```bash
npm run tauri:build  # 自动使用--release
```

Debug构建会包含符号信息，体积大10倍以上。

## 对比Electron

| 特性 | Electron | Tauri |
|------|----------|-------|
| 渲染引擎 | 捆绑Chromium | 系统WebView |
| 后端语言 | Node.js | Rust (调用Node.js) |
| 包体积 | 120-130 MB | 3-10 MB |
| 启动速度 | 慢 | 快 |
| 内存占用 | 高 | 低 |
| 安全性 | 好 | 更好 |
| 跨平台 | 完全一致 | 依赖系统WebView版本 |

## 许可证

与主项目相同。
