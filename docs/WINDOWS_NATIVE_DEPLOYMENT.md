# Windows 原生部署与 Linux 并行保留

目标：Windows Server 2022 上的 **Windows QQ → NapCat Windows → AstrBot → Node QQ 后端**，媒体 Provider 使用 Windows Python + Edge。这里不使用 WSL、Docker Desktop、Linux 容器或嵌套虚拟化。

Linux 继续使用 `docker-compose.server.yml` / `docker-compose.qq.yml` 和原 `.env.qq`。Windows 启动器只对自己的子进程覆盖本机地址与文件路径；人格、群聊学习、联网、缓存 TTL、用量和推送逻辑共用原有代码。`runtime_config.py` 在 Linux 继续默认 `/usr/bin/chromium`、`/data/profile` 和原有启动参数。

## 本次恢复状态

- Windows 实例：`124.222.111.193`，2 核 8GB，80GB 系统盘。
- 代码及主备份已解压到 `C:\longtu-qq-bot`。
- 两份原始归档及 SHA256 校验文件在 `C:\migration-backup`，用户已验证 Match=True。
- 一致性 SQLite 源在 `C:\sqlite-restore-temp\consistent-sqlite\data`。
- 主归档里的数据库已被覆盖过，但**旧 WAL/SHM 尚未隔离**；首次启动前必须执行下面的恢复脚本。
- 50GB 旧 Linux 数据盘保持原样；Windows 显示 RAW 不等于空盘，不初始化、不格式化。
- WSL2 导入没有成功；误启用的组件已禁用并重启。
- COS 桶 `long-bot-01-1257219847` 保持私有。账号与桶所有者已确认相同；COSBrowser 列表异常并不能证明无权限，当前使用网页控制台上传/下载。

## 1. 安装 Windows 运行环境

部署包中的 `install-runtimes.ps1` 先比对 SHA256 并验证 Windows Authenticode 签名，再安装 Windows x64 Node.js 22.23.4 和 Python 3.12.10。不会启动 Bot，不会更改数据库或 `.env.qq`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\migration-backup\windows-native-kit\install-runtimes.ps1
```

`ExecutionPolicy Bypass` 仅影响这一次脚本进程，不修改系统执行策略。安装成功后重开管理员 PowerShell。

## 2. 修复数据库恢复步骤

确认 Node、AstrBot 和任何数据库写入进程尚未启动。应用项目补丁后执行：

部署包的补丁可通过 `apply-project-patch.ps1` 应用：它先核对全部补丁与恢复的代码版本，再备份并覆盖匹配的源文件。如果发现服务器代码与本地基线不一致，会停止，不覆盖未知改动。它不包含 `.env.qq`、密钥或业务数据。

```powershell
py -3.12 C:\longtu-qq-bot\scripts\windows\restore_sqlite.py --source C:\sqlite-restore-temp\consistent-sqlite\data --target C:\longtu-qq-bot\data --backup-root C:\migration-backup\sqlite-before-native --services-stopped
```

脚本先对全部源数据库执行只读 `quick_check`，暂存并比对哈希，再按每个匹配的数据库隔离旧数据库及其 `-wal`、`-shm`、`-journal`，最后安装并校验新副本。旧文件保存在独立备份目录，拷贝失败时回滚。它不会全盘删除 `*-wal`，也不处理没有一致性副本的其他数据库或浏览器档案。恢复后的数据库仍需要启动服务并核对人格、记忆、图库数量。

## 3. 安装后端依赖并逐项验证

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\longtu-qq-bot\scripts\windows\install-backend.ps1
```

Node 使用项目 lockfile。媒体 Provider 使用 `.venv-windows`，AstrBot 使用自己的 `.venv`，避免 FastAPI 等依赖冲突。Python pip 使用腾讯云镜像；浏览器使用服务器已安装的 Windows Edge。首次启动前确认 Edge 可打开。

还需要 Windows x64 FFmpeg（默认 `C:\tools\ffmpeg\bin\ffmpeg.exe`）和 Tesseract OCR（默认 `C:\Program Files\Tesseract-OCR\tesseract.exe`，须有 `chi_sim`、`eng` 语言数据）。路径不同时复制 `.env.windows.example` 为 `.env.windows` 并修改。不能把缺少这些依赖视为已保留全部能力。

在项目根目录分别启动两个窗口：

```powershell
node scripts/windows/run.mjs node
```

```powershell
node scripts/windows/run.mjs provider
```

核验 `http://127.0.0.1:8787/healthz` 和 `http://127.0.0.1:9001/healthz`。不要把这些端口开放到公网。三个网站的 Windows 浏览器状态保存在 `data/windows`；原 Linux profile 保留，跨平台 Cookie 加密可能不兼容，需要重新验证登录。

## 4. Windows QQ / NapCat 与 AstrBot

NapCat 官方 Windows Shell 文档：<https://napneko.github.io/guide/boot/Shell>（以页面 Windows 一键安装部分为准）。官方发布的 `NapCat.Shell.Windows.OneKey.zip` 解压后运行 `NapCatInstaller.exe`，安装器会下载 Windows QQ 与 NapCat，完成后通过生成目录里的 `napcat.bat` 启动并登录机器人账号。它可能还需联网下载组件；失败时保留报错再处理，不能将安装器下载完成视作 QQ 已安装。

已在本次服务器安装中遇到两个前置问题：

- 安装器直接退出，退出码 `-1073741515`（`0xC0000135`），且 `C:\Windows\System32\vcruntime140_1.dll` 不存在：补装微软官方 [Visual C++ x64 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)。Node/Python 安装成功不代表这个运行库齐全；原 `install-runtimes.ps1` 没有包含它。
- `NapCat.Shell.zip` 解压报 `Unexpected end of archive`：本次下载只有 7,970,816 字节，官方 v4.18.41 完整包是 35,894,640 字节，SHA256 为 `6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b`。安装器会复用同目录缓存，直接重跑会再次解压坏包。

可从官方 release 获取完整 Shell ZIP，通过私有 COS 传入 Windows，与 `scripts/windows/repair-napcat-download.ps1` 放在同一目录。退出旧安装器后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\migration-backup\napcat-fix\repair.ps1 -RunInstaller
```

交付用 `napcat-fix.zip` 内将该脚本命名为 `repair.ps1`。脚本先核对官方归档大小、SHA256 和原 OneKey 安装器版本，再暂存替换缓存、保留旧归档；不会删除已下载的 QQ 包、旧 Linux 文件或 Bot 数据。`-RunInstaller` 在原安装目录继续执行原安装器，不会启动 Bot。压缩包同时携带 Windows/Linux 的原生模块，日志中的 `linux.x64.node` 文件名不代表启用了 Linux 运行环境。

AstrBot 先确认备份中的部署版本及 `deploy` 目录结构，再选对应版本安装，避免未经核对直接升级。源码原生部署使用 `C:\AstrBot` 与独立 `.venv`，Windows 需确保 `tzdata` 可用。恢复原 AstrBot `data` 和 Bridge 插件，保留定时推送、群白名单与管理配置。在 `.env.windows` 写入 `ASTRBOT_ROOT=C:/AstrBot` 后：

```powershell
node scripts/windows/run.mjs astrbot
```

启动器为 Bridge 注入本机后端地址和同一个 API token，并把主动视频内部接口绑定到本机；不打印密钥。AstrBot 的 OneBot 反向 WebSocket 监听 `127.0.0.1:6199`，NapCat 的 WebSocket 客户端使用 `ws://127.0.0.1:6199/ws`，两端 token 一致。具体以恢复后的平台配置为准，保持原 platform ID，避免定时任务会话标识失配。

## 5. 验收后再做常驻启动

需要实际确认：Windows QQ 登录设备、OneBot 双向通信、Bridge 接管无双回复、原人格与群记忆、图库与中文 OCR、搜索、抖音视频/动态图文交替解析、B 站/小红书、定时任务时间和目标。验证时仅做本机健康检查；群消息测试及推送按用户指定范围执行。

原生 QQ/浏览器有桌面会话要求。常驻配置应分开处理 Node 后台进程与 QQ/浏览器交互会话；不要贸然将所有组件设成无桌面的 SYSTEM 服务。远程桌面断开与注销不同，注销可能终止交互进程。安排启动策略后应做一次重启验收。

当前本地自动测试覆盖配置保留、浏览器默认值、SQLite 日志隔离及原解析回归；**尚未在目标 Windows 上完成运行验收**。旧 Compose 与归档保留供以后 Linux 部署，Windows 原生配置不自动写回 Linux。
