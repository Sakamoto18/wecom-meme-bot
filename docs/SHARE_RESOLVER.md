# 通用外部分享解析

`src/share-resolver.js` 接受一条公开分享 URL，自动跟随短链跳转，并从公开 HTML 元数据中提取标题、封面和视频地址。它不依赖任何平台私有签名、设备指纹、Cookie 或验证码绕过。

`MediaResolver` 会优先尝试公开元数据得到的媒体地址，再交给 `yt-dlp` 生成 QQ 可播放的 MP4；公开元数据不可用时继续使用原始分享地址和现有网页兜底逻辑。

QQ Bridge 已经从文本、JSON/XML 卡片和引用消息中提取候选 URL。平台差异通过 `classifyMediaUrl` 和 `providerResolver` 扩展；需要接入授权第三方服务时，只需在 Provider 中返回 `mediaUrl`、`title` 或 `coverUrl`。

生产环境必须保留公网 URL 校验、重定向限制、响应大小限制和媒体缓存过期时间，避免把任意分享卡片变成 SSRF 或无限下载入口。

## 官方 QQ 小程序卡片

官方入口使用 `astrbot_plugin_longtu_bridge/official_media.py`，在读取完整的 `raw_data` 结构后提取地址，再交给共用的视频解析后端。支持嵌套 JSON、转义/百分号编码的跳转地址、B 站播放器地址、`bilibili://video/...`，以及已确认 B 站来源的卡片中的 `bvid` / `aid` / 小程序路径；播放器分 P 参数保留。来源不明的数字、标题中的 BV 字符串不会用于猜测视频。

图标、封面、头像字段不作为视频入口；当前消息中的视频地址优先于其他链接，避免后端的 8 项上限截掉真正地址。引用消息的 `msg_elements` 不当作新分享处理。NapCat 仍保留原来的 OneBot JSON/XML 卡片提取流程。

只有标题和封面的 B 站小程序卡片，会先执行下述公开检索和身份核验；核验失败才提示补发链接，不进入普通网页问答。日志 `官方分享卡片诊断` 记录字段路径/类型、链接域名、识别数量和遍历截断状态，不记录卡片原文或身份字段。该日志用于区分传输字段缺失和提取遗漏。

2026-11-22 18:22:01 的历史消息确认收到了小程序卡片，但仅存展示文本，没有完整原始事件。测试中的该文本回放验证了缺少视频地址时的处理，不能证明当时 QQ 下发的所有字段均不含视频 ID；2026-11-23 10:32:11 用户重新分享同一卡片，现场诊断确认 `message_type=3`，`ark_data.fields` 除图标和封面外只有 `source`、`title`，没有视频 URL、`bvid`、`aid` 或跳转路径；`video_count=0`、`truncated=false`。该次验证仅确认事件缺少视频定位信息，尚未实现下面的公开检索补全。

验证：`python -m unittest test.test_official_media test.test_official_trial test.test_gallery_reaction`（后两项需真实 AstrBot 依赖，外部发送均为 mock）；`node --test test/media-link-extractor.test.js test/media-resolver.test.js`。线上有独立更新的 `official_groups` 导入，发布时仅应用解析改动，保留该导入。


### 网关转换前的原始事件

`official_gateway.py` 在 `BotWebSocket.on_message` 调用原 SDK 前保留卡片事件，按 AppID、群 OpenID、消息 ID 精确匹配。官方提取器优先使用该原始事件的 `d`，不依赖 Plain 展示文本或 SDK 对象字段；若原始事件不可用，则兼容原来的 `raw_data`。日志 `官方卡片使用网关原始消息：same_body=...` 用于检查 SDK/适配器是否改写消息体。

原始卡片仅在内存中保留 10 分钟，最多 64 条、总计 8 MiB。完整落盘默认关闭；排障时在 AstrBot 工作目录的 `data/longtu-official-raw/arm.json` 设置目标 `group_openid`、`capture_id`、Unix 秒 `expires_at`（未来一小时以内）和 `max_events`（最多 10）。文件保留网关收到的完整 JSON，包含事件头和消息体，不做字段过滤。公开日志只记录文件名/大小，分享诊断文件前应脱敏 `message_scene.ext` 中的 `auth_token`。排查后移除 arm 文件。

官方事件字段依据：[群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。文档列出了 `ark_data.fields.jump_url`，但未保证每种卡片都下发该字段。`message_scene.ext` 文档定义为 `msg_idx`、`ref_msg_idx`、`auth_token` 等消息上下文，不能默认当成视频地址。

新增回归：`python -m unittest test.test_official_gateway`，覆盖原始捕获先于 SDK、适配器丢失 jump_url 时恢复提取、jumpUrl/qqdocurl/编码卡片、应用隔离、缓存上限、抓包范围和抓包失败不阻断原消息。


2026-11-23 10:52:03（北京时间）现场复测：SDK 转换前的 `GROUP_MESSAGE_CREATE` 网关帧为 2108 字节，SHA-256 `6b82b4b7c37c7ada9ca4a9b0661abf355b1cefab193f3dba01fa32941f51e314`。原包 `d.ark_data.fields` 恰好为 `preview`、`source`、`source_logo`、`title`；递归检查整包没有 `jumpUrl` / `jump_url` / `qqdocurl` / `bvid` / `aid` 字段。`message_scene.ext` 为 `msg_idx` 与 `auth_token`。运行日志 `same_body=True` 证明本条消息在 botpy/AstrBot 转换时没有丢失字段。完整私有原包已留存服务器，另有鉴权令牌脱敏副本；采集开关在该次验证后关闭。

因此该卡片缺少跳转地址的问题发生在官方事件到达本机之前，网关原文透传本身不能补出不存在的 jump_url。原始数据通路只能保留实际收到的字段；后续公开检索作为独立补全步骤。官方文档中的[获取指定消息](https://bot.q.qq.com/wiki/develop/pythonsdk/api/message/get_message.html)接收 `channel_id`，是频道消息接口，不能直接用于 QQ 群消息补取。自动补全采用下面的公开搜索方案，不依赖 NapCat。


### 无链接卡片的公开检索补全

官方入口将当前 B 站 `miniapp` 的 `title` 和 `preview` 交给后端，仅在缺少直接视频地址且不是引用消息时启用。`src/bilibili-card-recovery.js` 读取卡片中实际可见的 UP 主，然后运行 `scripts/bilibili-card-search.py`，使用一次性匿名浏览器按完整标题和作者搜索。搜索结果通过视频详情接口复核完整标题、作者、分 P 数，再由视觉模型核对卡片画面和候选封面；仅允许唯一匹配的单 P 视频进入现有 `MediaResolver.resolve()`。有直接链接时仍走原来的提取路径，群禁用和平台白名单依旧生效。

边界：官方入口不检查登录，不请求 provider 搜索，不读取它的登录状态或 Cookie。浏览器仅建立自己的临时匿名站点会话；搜索结束关闭。查到标准 B 站 URL 后，现有解析下载链路继续使用原 provider 的会话处理，provider 代码、接口及配置均不变。Python 解释器依次使用 `BILIBILI_CARD_SEARCH_PYTHON`、现有 `XHS_PYTHON_COMMAND`、`python3`；需 Playwright 和 Chromium（Windows 使用既有 `MEDIA_BROWSER_CHANNEL=msedge`）。

这是依据标题、可读作者和画面寻找对应视频，不是恢复原包未下发的 jumpUrl。作者不可读、同名候选不唯一、封面不同、多 P、公开搜索受限或超时时明确失败，不按标题随意挑选视频。预览/封面限制来源域名和 2 MiB 大小、不跟随重定向；每进程最多同时运行一次浏览器搜索，子进程限时 65 秒。

2026-11-23 实际原卡片在生产服务器隔离回放：视觉模型读出作者“内松兔司”，匿名公开搜索得到 `BV1VbyxzsEpo`，封面比对通过，约 11 秒返回标准链接。此项只验证链接补全，不代表 QQ 已发送。回归覆盖作者/封面错误、模糊候选、多 P、外部图片域名、原有解析路径以及失败不进入普通问答；真实 AstrBot 环境 62 项 Python 测试、服务器 22 项 Node 测试通过，外部发消息使用 mock。

部署后使用原卡片对本机 `/v1/qq/message` 回放（没有 QQ 发送调用），HTTP 200、`mode=media`，标题与作者一致、平台标注时长 17 秒，耗时约 20 秒；本机媒体地址完整下载为 3,618,722 字节 MP4。ffprobe 确认 H.264 视频、AAC 音频，实际文件时长 16.07 秒。群内实际投递仍需新分享消息验证。

卡片链接补全缓存与媒体缓存都按资源跨群共享，不以群号作键。补全缓存按“完整标题 + 预览 URL”命中后跳过图片请求；同图更换 URL 时按“完整标题 + 预览图片内容摘要”复用核验结果。相同卡片的并发请求合并，最多保留 256 个索引，TTL 使用现有媒体缓存配置 `QQ_MEDIA_RESOLVE_CACHE_TTL_SECONDS`（默认 600 秒）。仅缓存成功核验；过期和失败会重新查找。不同图片不会仅因标题相同而复用。随后得到的标准视频链接进入原有跨群媒体缓存及并发合并，provider 不变。

部署后用三个不同的模拟官方群标识调用本机后端（不调用 QQ 发送）：同一卡片首次 12,683 ms，第二、第三群均 15 ms，三次均返回 `mode=media` 且媒体 URL 完全相同。线上缓存配置确认为 600 秒。缓存回归验证并发合并、换预览 URL 的同图复用、不同图不复用、过期重查以及失败后重试；相关 Node 回归 28 项通过。
