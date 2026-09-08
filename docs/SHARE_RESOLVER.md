# 通用外部分享解析

`src/share-resolver.js` 接受一条公开分享 URL，自动跟随短链跳转，并从公开 HTML 元数据中提取标题、封面和视频地址。它不依赖任何平台私有签名、设备指纹、Cookie 或验证码绕过。

`MediaResolver` 会优先尝试公开元数据得到的媒体地址，再交给 `yt-dlp` 生成 QQ 可播放的 MP4；公开元数据不可用时继续使用原始分享地址和现有网页兜底逻辑。

QQ Bridge 已经从文本、JSON/XML 卡片和引用消息中提取候选 URL。平台差异通过 `classifyMediaUrl` 和 `providerResolver` 扩展；需要接入授权第三方服务时，只需在 Provider 中返回 `mediaUrl`、`title` 或 `coverUrl`。

生产环境必须保留公网 URL 校验、重定向限制、响应大小限制和媒体缓存过期时间，避免把任意分享卡片变成 SSRF 或无限下载入口。
