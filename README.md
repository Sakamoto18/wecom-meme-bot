# 企业微信长连接龙图机器人

用户在单聊或群聊中发送龙图请求或图片时，机器人只从 `memes/longtu/` 中经过校准的龙图库回复；目录尚未导出时才回退到 Mac 版企业微信本地 `Emotion` 缓存索引。通用表情包和普通熊猫头能力已关闭。项目使用企业微信官方 `@wecom/aibot-node-sdk`，SDK 自动处理长连接认证、心跳和断线重连。

## 1. 企业微信后台配置

进入智能机器人的配置页面：

1. 开启「API 模式」。
2. 接入方式选择「长连接」。
3. 复制长连接专用的 `BotID` 和 `Secret`。

切换到长连接后，原来的 Webhook 回调地址会停止生效。每个机器人同时只能保持一个有效长连接。

## 2. 填写凭证

编辑项目根目录的 `.env`：

```dotenv
WECOM_BOT_ID=你的BotID
WECOM_BOT_SECRET=你的长连接Secret
```

`.env` 已加入 `.gitignore`。不要把 Secret 提交到 Git 或发送到群聊。

## 3. 添加表情包

首次在 Mac 上完成龙图校准后运行：

```bash
npm run export:longtu
```

命中的龙图会按人工审查范围、排除哈希和内容哈希去重后复制到 `memes/longtu/`，可以随代码部署到服务器。

要直接读取 Mac 版企业微信的本地表情缓存，在 `.env` 中填写：

```dotenv
WECOM_EMOTION_DIR=/Users/你的用户名/Library/Containers/com.tencent.WeWorkMac/Data/Library/Application Support/WXWork/Data/账号ID/Emotion
```

项目会递归扫描该目录，只读取 PNG、JPG、JPEG 和 GIF 文件，不读取聊天文本。这个目录包含企微已经下载到本机的表情缓存，不保证等同于“收藏表情”列表；企微当前的缓存索引没有提供收藏标记。

服务器运行时直接读取仓库中的 `memes/longtu/`，不再依赖 Mac 的企微缓存绝对路径。

### 群成员标注

企微长连接消息只提供发送者 `userid`，项目默认将它哈希成稳定的 `群成员-xxxxxx` 标签。可以在 `data/member-aliases.json` 中按匿名标识人工填写昵称：

```json
{
  "a01da3": "玉涛龙大王",
  "20bf62": "爆豹"
}
```

已标注成员会以昵称进入大模型上下文；未标注成员仍使用匿名标签。可通过 `WECOM_MEMBER_ALIASES_FILE` 指定其他映射文件。

## 4. 启动

要求 Node.js 20 或更高版本：

```bash
npm install
npm test
npm start
```

看到 `企业微信长连接认证成功` 后，在企业微信中给机器人发送“表情包”或“梗图”。群聊里需要 `@机器人`。

普通对话启用大模型后，机器人会先完成流式文本回复，再通过同一条长连接主动推送一张本地 JPG/PNG 龙图。之所以拆成两条消息，是因为部分企微客户端不会渲染流式回复中的 `msg_item` 图片。附图准备或主动推送失败时，已经发送的模型文本不受影响。

明确攻击消息采用“参考式生成”模式：程序只提交固定龙图查询词，不上传群聊原文；先查百度公开摘要，遇到验证页或无结果会自动降级到 Bing RSS。搜索摘要与 `config/online-quotes.json` 中轮换的少量已核验原句只作为大模型风格参考，最终回复必须针对用户本轮原话重新组织，不能整句复读。生成后会拦截孤立 `ma`、固定语料复刻和关键词清单；`ma` 只用于识别输入中的同音攻击，不是输出格式。

开发时可使用：

```bash
npm run dev
```

## 自定义触发词

编辑 `.env` 中的 `MEME_TRIGGERS`，使用英文逗号分隔：

```dotenv
MEME_TRIGGERS=表情包,梗图,斗图,整一个
```

龙图索引最多读取前 800 个候选，Apple Vision 距离和 `data/longtu-exclusions.json` 只负责缩小待审范围。最终导出必须命中 `data/longtu-approvals.json` 的人工 SHA-256 白名单，运行时也只读取 `memes/longtu/manifest.json` 中的通过项。可覆盖候选范围与阈值：

```dotenv
LONGTU_LIMIT=800
LONGTU_MAX_SCORE=0.6
```

“龙图”单独发送会触发；消息中同时包含“发”与“龙图”，或同时包含“来点”与“龙图”，也会触发，例如“你能不能给我发一个龙图看看”。“龙图是什么”仍作为普通对话交给模型。

## Docker 部署

```bash
docker build -t wecom-meme-bot .
docker run -d --restart unless-stopped \
  --name wecom-meme-bot \
  --env-file .env \
  -v "$(pwd)/memes:/app/memes:ro" \
  wecom-meme-bot
```

服务只需要访问外网的 `wss://openws.work.weixin.qq.com:443`，不需要公网 IP 或入站端口。不要同时运行本地和线上实例，否则新连接会踢掉旧连接。

## 工作方式

1. 收到 `message.text` 长连接回调。
2. 明确龙图指令直接选图；普通消息区分检索式攻击回复和大模型问答。
3. 文本回复后只从校准龙图库随机选择图片。
4. 通过 SDK 上传企业微信临时素材并用 `media_id` 发图。
5. 同一素材的 `media_id` 在进程内缓存 48 小时，避免重复上传。
