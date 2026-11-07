# Amos Electron 桌面壳

Electron 主进程启动本地治理控制面，再打开现有 Vue 控制台。渲染器保持 `contextIsolation`、`sandbox` 和关闭 Node 集成；外部窗口链接交给系统浏览器。

## 启动

根目录执行：

```bash
npm run electron
```

该命令先构建后端和控制台，再启动桌面窗口。桌面进程为控制面申请空闲回环端口，避免和其他本地服务冲突。

`AMOS_NODE_PATH` 可指定启动本地控制面的 Node.js 路径。Electron 退出时会回收控制面子进程。
