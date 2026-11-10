# QQ 接入隔离：第一阶段实施与回滚

2026-11-10。本阶段在 `feat/qq-transport-adapters` 实现。优先维持现有 NapCat，支持后续兼容版本/Fork 替换；官方 QQ Bot 的实现、权限申请和线上切换属于后续阶段。

## 已实现的边界

- `main.py` 保留原 NapCat 实现与注册入口。未配置时为 `legacy`，不会加载候选编排模块。
- 显式选择 `adapter` 后，单个插件实例绑定 `AdapterBridge` 的差异方法。两个注册 handler 各自只转交一次，不双发；缓存、定时任务、停止事件仍由同一个实例管理。
- `adapters/onebot.py` 收拢消息/合并转发发送、原生视频转发、回应、消息/图片/转发读取、近期历史和群查询。视频沿用每次请求克隆 API 包装器的 480 秒等待，不修改共享连接的 180 秒设置。
- `adapters/codec.py` 保留卡片原文、引用组件、图片 subtype 等解析；历史筛选继续复用原纯函数。
- `Target` 的 ID 是不透明字符串，在 OneBot 实现中转为数字；发送结果区分成功、明确拒绝和未知。候选路径的图集及多视频合并转发只有明确拒绝才逐条回退，未知结果不重发。
- 视频缓存增加 OneBot 平台实例和机器人账号命名空间，避免不同连接误复用消息 ID。

后端 HTTP 请求/响应、数据库、现有 QQ 群号/用户号、业务指令不迁移。`/指令` 没有新增聊天命令；接入模式是管理员插件配置，不能通过群消息修改。

## 配置与回滚

插件配置 `_conf_schema.json` 新增 `transport_mode`，可取 `legacy` 或 `adapter`，默认 `legacy`。环境变量 `LONGTU_QQ_TRANSPORT_MODE` 非空时覆盖插件配置。无效值拒绝加载，避免悄悄选择错误链路。选择在实例构造时固定，改配置后须重载插件或重启 AstrBot。

1. 备份生产插件目录和当前配置，保留当前 NapCat/QQ 安装包、OneBot 配置及数据。核对候选文件哈希。
2. 首次发布仍用 `legacy`，确认 Bridge 加载、OneBot 连接、后端健康及自然流量正常。
3. 在隔离测试账号/群验证 `adapter`，覆盖文字、PNG/JPG/GIF、引用、多张转发、卡片+视频、私聊、历史和定时投递。真实 QQ 测试发送需明确授权。
4. 仅验收后启用 `adapter`。失败时把环境变量与插件配置同时恢复为 `legacy`，重载插件。环境变量优先，不能只改 UI。
5. 若插件加载失败，恢复备份目录和配置再启动 AstrBot。切换不需要改 Node 数据库；禁止将结果未知的消息批量补发。

不要运行两份接收同一消息且都能发送的 Bridge 进行影子验证。切换时停止旧消费者并处理在途任务后再启动新消费者；未完成的上传可能已被 QQ 接收。

## 仍需明确的限制

这是 OneBot I/O 隔离准备，不是已经完成的通用多平台框架。候选编排仍有 OneBot 段格式及数字 ID 的业务兼容处理；官方平台要另做归一化事件、身份映射和输出降级。

为能立即回滚，候选模块保留了改变过的编排方法，尤其消息主 handler；共用规则继承原类。后续修改业务必须同时验证两种模式，待候选稳定后再考虑去重。模块只在显式启用时导入，不新增第二个插件注册。

严格回执仅覆盖直接消息/合并转发。视频沿用既有成功回执及原生转发 `None` 成功约定；AstrBot `send_message`、`event.send`、RespondStage 仍遵守原框架契约。学习日报沿用 `LegacyOneBotAdapter`：后端已有 lease 和失败重试，尚无 durable unknown 状态；发送后回执丢失或租约过期仍可能重投，不能宣称全链路 exactly-once。消除这一风险需要单独设计后端队列协议，不能伪报发送成功。

当前能力表默认针对已部署 NapCat。Fork 缺少扩展 API 时需要实测并配置能力，不应把“兼容 OneBot”理解为支持全部 NapCat 扩展。`native_forward` 不可用时只允许安全的上传回退。没有证据证明存在已获官方承诺的接替 Fork。

## 验证

本地：`npm run check`、`npm test`；Python 合同和既有媒体/图片/历史回归。实际 AstrBot 环境：

```powershell
$env:PYTHONUTF8 = '1'
$env:LONGTU_BRIDGE_TEST_PLUGIN_ROOT = 'C:\tmp\longtu-transport-check-20261110'
$env:PYTHONPATH = 'C:\AstrBot'
Set-Location $env:LONGTU_BRIDGE_TEST_PLUGIN_ROOT
C:\AstrBot\.venv\Scripts\python.exe -m unittest test.test_transport_adapters test.test_transport_bridge_integration test.test_gallery_reaction test.test_media_result_reaction
```

2026-11-10 在临时目录运行上述 45 项测试通过，模拟所有 QQ 请求；包括构造器绑定、注册 handler 分派、完整后端 payload/OneBot 参数对比、显式拒绝回退、未知结果不重发、真实 aiocqhttp 包装器超时及跨群视频复用。另有本地 72 项 Python 回归通过。未据此声称官方平台或候选路径真实 QQ 收发已经验收。

## 同分支表情包减少修复

线上 2026-11-09 20:30 启动后的统计：语义索引 284 张（268 high、16 medium）；词族检索 9 次仅 1 次成功，8 次失败均耗尽 180 输出 token，同时日志报告空内容。选图调用 23 次成功，但旧日志未保存具体置信度，无法反推每次拒绝原因。图库选图记录按上海日历为 11 月 9 日 47 次、11 月 10 日排查时 2 次；统计时长不同，仅说明减少，不能当作同比成功率。

代码确认的抑制点与修复：词族检索补 `thinking=disabled`、输出预算增至 400，失败继续图片场景排序；在模型确认的贴切候选中轮换，不预先永久排除近期图；high/medium 可用，low/非法候选不发；语义为空不取消纯 @/既有接梗模式的附图，普通无关对话仍不随机塞图。增加候选数量、置信度和选中数量日志，不记录聊天正文。8 次空返回与预算耗尽一致，但未保留 reasoning 内容，不能断言供应商内部原因已完全证明。
