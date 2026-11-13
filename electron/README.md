# Amos Electron 桌面壳

Electron 主进程启动本地治理控制面，再打开现有 Vue 控制台。渲染器保持 `contextIsolation`、`sandbox` 和关闭 Node 集成；外部窗口链接交给系统浏览器。

## 启动

根目录执行：

```bash
npm run electron
```

该命令先构建后端和控制台，再启动桌面窗口。桌面进程为控制面申请空闲回环端口，避免和其他本地服务冲突。窗口使用系统原生标题栏和窗口控件，应用菜单在启动时移除，因此不显示 `File`、`Edit`、`View` 等默认菜单。

构建和控制面需要 Node.js 26。`AMOS_NODE_PATH` 可指定启动本地控制面的 Node.js 26 可执行文件路径。未设置时，打包后的应用使用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`），开发模式使用当前 npm 的 Node。Electron 退出时会回收控制面子进程。

## 打包

```bash
npm run build
npm run dist:electron -- --linux AppImage
npm run dist:electron -- --win nsis
npm run dist:electron -- --mac dmg
```

安装包输出到 `release/`，文件名格式为 `amos-console-<version>-<os>-<arch>.<ext>`。CI 在 Linux、Windows、macOS 上分别构建未签名安装包并上传为 `amos-console-<platform>` 工件；签名与公证凭据由发布流程单独提供。

## 原生登录与首次设置

macOS 仅在 `systemPreferences.canPromptTouchID()` 返回可用且存在 `promptTouchID()` 时显示 Touch ID 登录。Linux 需要桌面 polkit 身份验证代理、固定路径 `/usr/bin/pkaction` 和 `/usr/bin/pkcheck`，以及已安装的 Amos 专用 action。缺少任一能力时，原生登录保持不可用。检测能力不会弹出身份验证提示。

Linux 包维护者在安装包的 root 安装阶段安装本目录的策略文件（由包管理器维护，应用启动时不安装）：

```bash
install -o root -g root -m 0644 electron/org.amos.console.authenticate.policy /usr/share/polkit-1/actions/org.amos.console.authenticate.policy
```

策略仅允许活动会话使用 `auth_self`，每次调用均重新验证；不使用 `_keep`、通用 `pkexec` 或应用内系统密码输入。主进程检查已安装 action 的默认权限，并只执行固定的 `pkcheck --action-id org.amos.console.authenticate --process PID,START_TIME,UID --allow-user-interaction`。用户取消、命令失败或超时均不会签发证明。应用退出、主页面导航、窗口关闭或服务断开会废弃在途结果；Linux 同时终止在途 `pkcheck`。Touch ID 由系统控制关闭，废弃的结果即使稍后成功也不会签发证明。原生验证串行处理，并发调用直接报错。

每个控制面子进程获得独立的 32 字节随机密钥 `AMOS_SYSTEM_AUTH_SECRET` 和 IPC 通道。该 IPC 通道是控制面识别桌面宿主的前提，打包时与 `ELECTRON_RUN_AS_NODE` 同一条子进程配置一起生效。只有检测到原生能力时才传入 `AMOS_SYSTEM_AUTH_LABEL`。渲染器只通过 `window.amosDesktop.authenticateSystem(challenge)` 提交当前会话的 43 字符 base64url CSRF challenge；主进程验证发送者为当前主窗口的 mainFrame、精确控制面 origin 和根文档 URL（允许 hash 路由），并在原生验证成功后返回 `timestamp.mac`。MAC 为 HMAC-SHA256，消息为 `${timestamp}:${challenge}`；后端拒绝未来时间和超过 60 秒的证明，并在消费成功时轮换会话。此证明用于登录，不充当单项治理动作的批准。

首次密码设置另有独立的每次启动随机授权 `AMOS_SETUP_GRANT`。受信主页面可用 `window.amosDesktop.getSetupGrant()` 领取一次，随后调用返回 `null`。后端仅在尚未设置密码时接受该启动授权，10 分钟内有效，仅在成功设置密码时消费。启动授权和原生证明均不包含已有 human token；应用不读取系统密码。

这些通道属于本机同一用户进程内的登录机制，不提供同 UID 隔离：同 UID 进程仍可能读取进程环境、修改应用代码或操纵用户会话。密钥和授权不写入磁盘、页面存储或日志。

## 无提示验证

```bash
node --test electron/system-auth.test.mjs
```

测试使用注入的系统 API 和命令替身，不触发系统验证、不安装策略。后端证明测试由根目录 `npm test` 编译并运行。

构建后还可运行真实桌面首次设置与重登检查：

```bash
npm run build
npx electron electron/smoke.mjs
```

该检查使用独立临时状态目录，加载实际 main、沙箱兼容的 CommonJS preload 和本地服务；验证默认应用菜单已移除、自动启动授权、密码设置、退出及密码重登，不触发系统身份验证。运行环境须提供桌面显示服务和 Node.js 26。
