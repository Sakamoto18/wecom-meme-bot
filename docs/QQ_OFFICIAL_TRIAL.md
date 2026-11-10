# 官方 QQ Bot 实际试用

AppID `1903660238`，AstrBot 平台 ID `longtu-official-trial`，WebSocket 接入。2026-11-10 已部署；腾讯 token 鉴权通过、后台显示在线、实际 C2C 消息已进入原 Node 后端并回复。NapCat 平台与配置保留并行在线，不用退出原 QQ 号。

## 立即使用与退回

管理员从官方后台机器人的“添加二维码”扫码添加好友。私聊 `/指令`、`/usage-report`、图库请求或分享链接。群试用仅在已确认的群 OpenID 范围内通过 @官方机器人触发；普通 QQ 群号不能直接当 OpenID 使用。本轮指定测试群为 **1109147947**，已通过群内一次性绑定消息核实并配置白名单。

不满意时仍可直接使用原 NapCat 机器人。彻底关闭官方入口，在服务器 PowerShell 执行：

```powershell
& C:\longtu-qq-bot\scripts\windows\set-official-qq-trial.ps1 -Mode off
```

重新开启用 `-Mode on`。脚本备份配置，只切换 `longtu-official-trial` 与插件的官方开关，再重启 AstrBot；NapCat/Backend/Provider 不重启，但 OneBot 会在 AstrBot 重启期间短暂重连。官方 AppSecret 重置仅影响官方 API，不影响 NapCat QQ 登录或 OneBot Token。

## 已接回的业务

- 共享原 Node 人格、图库、语义选图、链接抓取服务；群/未绑定成员采用 `qqofficial:AppID:kind:OpenID` 命名空间。
- 经用户在已登录会话指定的一次性绑定码核实，配置官方 OpenID 到原 QQ 管理员映射；绑定后 `/指令`、`/add`、`/tag`、`/del`、词族及人格指令继承原权限。绝不按昵称推测身份。
- `/usage-report [YYYY-MM-DD]` 使用原用量查询与图片渲染，在官方管理员私聊回复；不将私人用量报告公开到群里。
- `/crazy-thursday` 及文案增删查转换为原后端请求。
- 官方 ark/msg_elements 卡片中的链接转给原媒体解析器，简介卡片继续复用原渲染。视频先由服务器下载，再走官方上传，避免腾讯访问不到本机媒体 URL；本地文件临时保存，发送结束删除，超过 200MiB 明确拒绝。
- 开启 `official_trial_push_enabled` 后，已绑定管理员的定时用量日报、学习日报/结果同步到官方私聊。官方专属学习目标通过官方平台发送，NapCat 原投递继续保留。
- `official_trial_push_groups` 可配置官方定时群推送目标，但本应用实测没有主动群消息权限，当前保持为空，原 NapCat 继续承担群定时推送。
- 日报通过已核验的 `official_trial_group_bindings` 将官方群 OpenID 映射回普通 QQ 群号，再查询真实群名；查不到时使用配置的名称或群号标签。图片不再展示内部路由字符串，官方来源副标题为“QQ 官方 Bot”。两个入口的用量仍分别统计。

## 尚未等价的部分

全量普通群消息、任意历史回捞、原生合并转发、消息挂 emoji 没有在本轮试用冒充支持。图集降级成逐图，单次被动回复合并文本后最多 5 条（含简介图）；超出会提示。群记忆尚未自动与旧 QQ 群号合并。官方主动推送受应用/群授权及配额限制，代码接通不代表所有定时场景都已实测成功。

初版曾遗漏 `media_share`、分享卡片、管理员映射和日报指令处理，导致看似“后端没连上”；已用实际日志确认后端始终可达，并在恢复版补齐。2026-11-10 实际回执：管理员私聊 `/usage-report` 收到日报图片；测试群绑定消息进入后端；官方群图片上传 HTTP 200，但不带被动回复消息 ID 的主动群发送被腾讯拒绝，HTTP 400 / code `40034105`（主动消息失败，无权限）。私聊定时推送、群被动图片和完整视频回传仍需实际消息验收，不能用“在线”代替验收。

## 配置与测试

`official_trial_enabled` 默认 false；`official_trial_appid` 指定唯一应用；`official_trial_groups` 限制群 @；`official_trial_user_bindings` 是经核验的 OpenID→QQ 身份 JSON；`official_trial_group_bindings` 是 OpenID→`{qq_group_id, name}` 的显示映射；`official_trial_push_enabled` 控制镜像推送；`official_trial_push_groups` 是明确允许推送的群 OpenID。AppSecret 只在 AstrBot 平台配置中保存，不进入插件配置或仓库。

群名修复版在服务器真实 AstrBot 环境 36 项测试通过，覆盖官方入口/指令/图片/卡片/投递、群日报私密投递失败提示、群名与日报渲染、学习队列及 OneBot 适配器；本地原链路此前 72 项回归通过。线上真实用量数据已验证群名解析及 PNG 渲染。备份目录：首次接入 `C:\migration-backup\official-trial-20261110-183212`；能力恢复版 `C:\migration-backup\official-trial-20261110-184329`；群名修复版 `C:\migration-backup\official-trial-20261110-185334`。

2026-11-10 19:00 私聊日报复测已发送图片；19:01 抖音私聊分享通过原 Provider 解析，官方入口依次发送简介图和 1,355,999 字节视频，用户确认私聊已返回。群视频必须与 @官方机器人放在同一条消息中，直接分享不会自动触发当前官方入口。群视频实测仍在核对。
