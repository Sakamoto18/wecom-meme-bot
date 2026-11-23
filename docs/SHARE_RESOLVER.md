# 通用外部分享解析

`src/share-resolver.js` 接受一条公开分享 URL，自动跟随短链跳转，并从公开 HTML 元数据中提取标题、封面和视频地址。它不依赖任何平台私有签名、设备指纹、Cookie 或验证码绕过。

`MediaResolver` 会优先尝试公开元数据得到的媒体地址，再交给 `yt-dlp` 生成 QQ 可播放的 MP4；公开元数据不可用时继续使用原始分享地址和现有网页兜底逻辑。

QQ Bridge 已经从文本、JSON/XML 卡片和引用消息中提取候选 URL。平台差异通过 `classifyMediaUrl` 和 `providerResolver` 扩展；需要接入授权第三方服务时，只需在 Provider 中返回 `mediaUrl`、`title` 或 `coverUrl`。

生产环境必须保留公网 URL 校验、重定向限制、响应大小限制和媒体缓存过期时间，避免把任意分享卡片变成 SSRF 或无限下载入口。

## 官方 QQ 小程序卡片

官方入口使用 `astrbot_plugin_longtu_bridge/official_media.py`，在读取完整的 `raw_data` 结构后提取地址，再交给共用的视频解析后端。支持嵌套 JSON、转义/百分号编码的跳转地址、B 站播放器地址、`bilibili://video/...`，以及已确认 B 站来源的卡片中的 `bvid` / `aid` / 小程序路径；播放器分 P 参数保留。来源不明的数字、标题中的 BV 字符串不会用于猜测视频。

图标、封面、头像字段不作为视频入口；当前消息中的视频地址优先于其他链接，避免后端的 8 项上限截掉真正地址。引用消息的 `msg_elements` 不当作新分享处理。NapCat 仍保留原来的 OneBot JSON/XML 卡片提取流程。

只有标题和封面的 B 站小程序卡片，会明确提示用户复制链接，不再进入普通网页问答。日志 `官方分享卡片诊断` 记录字段路径/类型、链接域名、识别数量和遍历截断状态，不记录卡片原文或身份字段。该日志用于区分传输字段缺失和提取遗漏。

2026-11-22 18:22:01 的历史消息确认收到了小程序卡片，但仅存展示文本，没有完整原始事件。测试中的该文本回放验证了缺少视频地址时的处理，不能证明当时 QQ 下发的所有字段均不含视频 ID；2026-11-23 10:32:11 用户重新分享同一卡片，现场诊断确认 `message_type=3`，`ark_data.fields` 除图标和封面外只有 `source`、`title`，没有视频 URL、`bvid`、`aid` 或跳转路径；`video_count=0`、`truncated=false`。因此本次官方事件缺少视频定位信息，缺链接提示分支已触发，不能宣称这张卡片已成功抓取视频。

验证：`python -m unittest test.test_official_media test.test_official_trial test.test_gallery_reaction`（后两项需真实 AstrBot 依赖，外部发送均为 mock）；`node --test test/media-link-extractor.test.js test/media-resolver.test.js`。线上有独立更新的 `official_groups` 导入，发布时仅应用解析改动，保留该导入。


### 网关转换前的原始事件

`official_gateway.py` 在 `BotWebSocket.on_message` 调用原 SDK 前保留卡片事件，按 AppID、群 OpenID、消息 ID 精确匹配。官方提取器优先使用该原始事件的 `d`，不依赖 Plain 展示文本或 SDK 对象字段；若原始事件不可用，则兼容原来的 `raw_data`。日志 `官方卡片使用网关原始消息：same_body=...` 用于检查 SDK/适配器是否改写消息体。

原始卡片仅在内存中保留 10 分钟，最多 64 条、总计 8 MiB。完整落盘默认关闭；排障时在 AstrBot 工作目录的 `data/longtu-official-raw/arm.json` 设置目标 `group_openid`、`capture_id`、Unix 秒 `expires_at`（未来一小时以内）和 `max_events`（最多 10）。文件保留网关收到的完整 JSON，包含事件头和消息体，不做字段过滤。公开日志只记录文件名/大小，分享诊断文件前应脱敏 `message_scene.ext` 中的 `auth_token`。排查后移除 arm 文件。

官方事件字段依据：[群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。文档列出了 `ark_data.fields.jump_url`，但未保证每种卡片都下发该字段。`message_scene.ext` 文档定义为 `msg_idx`、`ref_msg_idx`、`auth_token` 等消息上下文，不能默认当成视频地址。

新增回归：`python -m unittest test.test_official_gateway`，覆盖原始捕获先于 SDK、适配器丢失 jump_url 时恢复提取、jumpUrl/qqdocurl/编码卡片、应用隔离、缓存上限、抓包范围和抓包失败不阻断原消息。
