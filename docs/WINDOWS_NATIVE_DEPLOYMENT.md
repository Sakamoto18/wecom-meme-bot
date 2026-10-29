# Windows 原生部署与 Linux 并行保留

目标：Windows Server 2022 上的 **Windows QQ → NapCat Windows → AstrBot → Node QQ 后端**，媒体 Provider 使用 Windows Python + Edge。这里不使用 WSL、Docker Desktop、Linux 容器或嵌套虚拟化。

Linux 继续使用 `docker-compose.server.yml` / `docker-compose.qq.yml` 和原 `.env.qq`。Windows 启动器只对自己的子进程覆盖本机地址与文件路径；人格、群聊学习、联网、缓存 TTL、用量和推送逻辑共用原有代码。`runtime_config.py` 在 Linux 继续默认 `/usr/bin/chromium`、`/data/profile` 和原有启动参数。

## 本次恢复状态

- Windows 实例：`124.222.111.193`，2 核 8GB，80GB 系统盘。
- 代码及主备份已解压到 `C:\longtu-qq-bot`。
- 两份原始归档及 SHA256 校验文件在 `C:\migration-backup`，用户已验证 Match=True。
- 一致性 SQLite 源在 `C:\sqlite-restore-temp\consistent-sqlite\data`。
- 已应用 `windows-backend-patch`；一致性恢复脚本已隔离旧 WAL/SHM，并恢复及校验 12 个数据库。Node 后端现在已启动，不要再对运行中的数据重跑恢复脚本。
- Windows QQ / NapCat 已登录并收到消息。Node 的 `/healthz` 已通过：53,703 条群事件、7 份人格档案、284 张图片；消息总数需重新查询，旧截图的数字不能可靠辨读。Provider 的 `/healthz` 已通过，`browser_ready=True`。这些是之前的启动检查，当前进程状态、端到端回复、检索与媒体发送仍待验收。
- Windows OpenSSH Server 组件已安装，`RestartNeeded=False`。首次初始化在服务启动后立即退出，配置已回滚；远程维护通道尚未建立，详见下述诊断步骤。
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

本次原始备份的插件布局已实际核对：根目录只有旧的 `astrabot_plugin_longtu_bridge`（`astra` 中多一个 `a`），其 `video_card.py` 是空文件，且缺少多个被 `main.py` 导入的模块。Compose 实际配置挂载的是 `astrbot_plugin_longtu_bridge`，这个正确目录没有进入原归档。因此原 `windows-native-kit` 增量补丁会报 `Missing restored source`；不是 PowerShell 工作目录错误，也不能只重命名旧目录。

改用基于实际归档生成的完整代码补丁 `windows-backend-patch.zip`。它补齐正确目录的全部 22 个 Bridge 源码/字体/素材文件，保留拼错名字的旧目录和 AstrBot 配置；其余已有后端文件仍严格校验旧版本哈希。生成器只从已跟踪的插件文件和原补丁清单取代码，不把备份数据打入补丁：

```sh
python3 scripts/windows/build-project-patch.py --backup /tmp/longtu-migration-20261028-181454.tar.gz --template .build/windows-native-kit --output /Users/lvyuning/Desktop/windows-backend-patch.zip
```

通过 COS 传入 Windows 并解压到 `C:\migration-backup` 后执行新包里的脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\migration-backup\windows-backend-patch\apply-project-patch.ps1
```

看到 `PROJECT PATCH OK` 后再恢复数据库。新包和本地归档已进行完整性/源文件基线校验，不等于服务器上已成功应用；以实际命令结果为准。

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

## 6. 恢复远程维护通道

安装组件后，使用 `scripts/windows/enable-ssh.ps1` 初始化新的、尚未启动的 Windows SSH 服务。交付包 `ssh-setup.zip` 包含该脚本（命名为 `enable.ps1`）、部署公钥 `deploy-key.pub` 和 `SSH-SETUP.json`（脚本/公钥哈希、公钥指纹），不包含私钥。

```powershell
Set-Location C:\migration-backup\ssh-setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\enable.ps1
```

脚本在检查管理员权限、安装状态和包完整性后，备份 SSH 配置与授权文件，保留已有公钥，将管理员授权文件权限设为 SYSTEM 和 Administrators，限制 SSH 为 administrator 公钥认证，验证配置后启用 TCP 22 防火墙规则和 sshd 自启动。验证失败时恢复原配置；不会重启系统或触碰 Node、NapCat、Provider。默认的远程 shell 保持不变，部署时可显式调用 PowerShell。

### 启动后立即退出时的诊断

2026-10-29 的服务器截图确认：服务使用 `C:\Windows\System32\OpenSSH\sshd.exe` 和 LocalSystem，系统事件先报告运行（7036）随后异常停止（7034），脚本随后回滚启动类型（7040）。OpenSSH 事件通道没有记录。使用默认配置、回环地址和 22222 端口进行前台调试能正常监听；22 端口未发现监听进程。`ssh` 目录的 SYSTEM/Administrators 完全控制、Authenticated Users 只读，以及 `logs` 目录仅 SYSTEM/Administrators 完全控制的 DACL 均没有展示异常。目录所有者、服务退出码和服务模式下的日志尚待确认；不能据此前台成功就认定 SSH 服务正常，也不能直接认定目录权限是根因。

新版 `enable-ssh.ps1 -Diagnostics` 临时启用 `LOCAL0` / `DEBUG3` 文件日志。失败时先收集退出码、程序版本、目录与密钥文件的所有者/SDDL、22 端口及本次启动日志和事件，再执行原有回滚；报告只记录权限元数据，不读取私钥内容。每次尝试的报告在对应备份目录内，包目录另有 `ssh-diagnostic.txt` 便于 VNC 打开。如果成功，则切换为 `LOCAL0` / `INFO` 并重启复核；两次启动均要求服务持续运行五秒且自身进程持有 TCP 22 监听，避免瞬间运行被误报为成功。该分支不改变目录 ACL，不重装 OpenSSH，也不将前台调试当作常驻方案。

18:21 的完整报告补充了明确的主机密钥权限问题：Windows Server 2022 为 20348.5499，OpenSSH 文件版本 9.5.5.1 / 产品版本 9.5p2，服务退出码为 1067，没有新文件日志或应用程序崩溃事件。两个目录的所有者均为 Administrators，配置和管理员授权文件仅 SYSTEM/Administrators 完全控制；但三个私有主机密钥的所有者都是具体账号 `10_0_0_6\Administrator`，且还存在该账号的显式访问 ACE（SDDL 中的 LA）。[官方主机密钥要求](https://github.com/PowerShell/Win32-OpenSSH/wiki/Security-protection-of-various-files-in-Win32-OpenSSH#host-private-key-files) 是 SYSTEM 或 Administrators 组拥有，且不允许其他用户访问。这解释了为何同一密钥可能通过 Administrator 前台检查，却不符合 SYSTEM 服务的要求；是否是唯一启动故障，仍需实际修复后验证。

后续初始化会在 `ssh-keygen -A` 后保存全部标准私有主机密钥的原始安全描述符到独立备份里的 `host-key-permissions.json`，再将所有者和访问规则统一为 Administrators/SYSTEM。只修改 ACL，保留现有密钥内容、主机指纹和 `.pub` 文件；不读取或复制私钥内容。检测到重解析点会停止。后续初始化失败时恢复所保存的权限。已上传的旧诊断包没有这项修复，可先按截图中确认的账号手动修正，再执行原诊断包：

```powershell
cd C:\ProgramData\ssh
icacls ssh_host_*_key /setowner "*S-1-5-32-544"
icacls ssh_host_*_key /remove:g "10_0_0_6\Administrator"
cd C:\migration-backup\ssh-diag
powershell -NoProfile -ep Bypass -File .\enable.ps1 -Diagnostics
```

这组手动命令只适用于本次报告确认的三份标准主机密钥及已有的 SYSTEM/Administrators 完全控制权限。两条 `icacls` 均须显示三文件成功、零失败再继续；原所有者和完整 SDDL 已保存在先前独立诊断备份里。禁止将它直接套用于用户登录私钥或未经核实的其他目录。

生成包含新脚本和原部署公钥的独立诊断包（生成器拒绝非 `.pub` 文件及非 Ed25519 公钥内容）：

```sh
python3 scripts/windows/build-ssh-setup.py --public-key /Users/lvyuning/.ssh/id_ed25519_longtu_windows.pub --output /Users/lvyuning/Desktop/ssh-diag.zip
```

传入 Windows 的 `C:\migration-backup` 后，逐条执行：

```powershell
cd C:\migration-backup
Expand-Archive .\ssh-diag.zip .
cd ssh-diag
powershell -NoProfile -ep Bypass -File .\enable.ps1 -Diagnostics
```

若失败，打开 `notepad .\ssh-diagnostic.txt` 回传报告中的服务退出码、新 OpenSSH 日志和应用程序崩溃事件。若文件日志仍未生成，报告会明确标出，不能把前一次日志当成本次错误。本地的语法和打包校验不代替 Windows 服务执行验收。

用户需回传脚本末尾的服务器 ED25519 主机指纹；连接端先比对再保存新的主机密钥，不能因系统重装而直接跳过主机身份检查。连接端本次专用密钥路径为 `~/.ssh/id_ed25519_longtu_windows`，私钥只保留在本机，不打包、不上传 COS、不提交 Git。

远程通道验证通过后，后续源码/依赖/环境配置同步与健康检查走 SSH；COS 继续用于备份和必要的安装包传递。首次迁移剩余工作包括 AstrBot、FFmpeg、中文 OCR、浏览器登录态和完整消息链路验证。
