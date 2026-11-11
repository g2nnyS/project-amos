# Amos Electron 桌面壳

Electron 主进程启动本地治理控制面，再打开现有 Vue 控制台。渲染器保持 `contextIsolation`、`sandbox` 和关闭 Node 集成；外部窗口链接交给系统浏览器。

## 启动

根目录执行：

```bash
npm run electron
```

该命令先构建后端和控制台，再启动桌面窗口。桌面进程为控制面申请空闲回环端口，避免和其他本地服务冲突。

`AMOS_NODE_PATH` 可指定启动本地控制面的 Node.js 路径。未设置时，打包后的应用使用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`），开发模式使用当前 npm 的 Node。Electron 退出时会回收控制面子进程。

## 打包

```bash
npm run build
npm run dist:electron -- --linux AppImage
npm run dist:electron -- --win nsis
npm run dist:electron -- --mac dmg
```

安装包输出到 `release/`，文件名格式为 `amos-console-<version>-<os>-<arch>.<ext>`。CI 在 Linux、Windows、macOS 上分别构建未签名安装包并上传为 `amos-console-<platform>` 工件；签名与公证凭据由发布流程单独提供。
