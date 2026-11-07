# Amos Electron 桌面壳

Electron 主进程启动本地治理控制面，再打开现有 Vue 控制台。渲染器保持 `contextIsolation`、`sandbox` 和关闭 Node 集成；外部窗口链接交给系统浏览器。

## 启动

根目录执行：

```bash
npm run electron
```

该命令先构建后端和控制台，再启动桌面窗口。开发环境已运行控制台服务时，可用 `AMOS_CONSOLE_URL` 指向已有地址；桌面进程仍会启动自己的控制面，端口冲突时先关闭已有服务。

```bash
AMOS_CONSOLE_URL=http://127.0.0.1:4310 npm run electron:dev
```

`AMOS_NODE_PATH` 可指定启动本地控制面的 Node.js 路径。Electron 退出时会回收控制面子进程。
