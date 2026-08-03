# QQ 部署：AstrBot + NapCat

这条部署链路与企业微信完全独立：

```text
QQ → NapCat（OneBot v11）→ AstrBot → 龙图 Bridge 插件 → QQ Bot HTTP 服务
                                                        ↓
                                         现有回复引擎 / 龙图库 / 大模型
```

原企业微信入口仍然是 `npm start`（`src/index.js`）；QQ 入口是 `npm run start:qq`（`src/qq-api.js`）。两边使用不同的连接方式和会话记忆，可以同时运行。QQ 后端要求 Node.js 22.5 或更新版本，并使用 SQLite 保存最多 30 天的近期原文和滚动摘要。

> NapCat 使用个人 QQ 的非官方协议，可能触发平台风控。请使用机器人小号，不要把 NapCat、OneBot 或 AstrBot 管理端口暴露到公网。

## 1. 准备环境

需要安装并启动 Docker Desktop。Apple Silicon Mac 已在 Compose 中为 NapCat 指定 `linux/amd64` 模拟；第一次启动和拉取镜像会比原生架构慢。

进入项目目录：

```bash
cd /Users/lvyuning/Desktop/code/wecom-meme-bot
cp .env.qq.example .env.qq
```

生成两个不同的随机令牌：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `.env.qq`：

- 第一个令牌填入 `QQ_API_TOKEN`。
- 第二个令牌填入 `ONEBOT_TOKEN`。
- 普通对话需要填写 `LLM_API_KEY`；只测试“龙图”指令可以暂时留空。
- 执行 `id -u` 和 `id -g`，把结果填入 `NAPCAT_UID`、`NAPCAT_GID`。
- 如需群白名单，把群号填入 `LONGTU_QQ_ALLOWED_GROUPS`，多个群号用英文逗号分隔。
- `LONGTU_QQ_ADMIN_USERS` 填允许管理图库的 QQ 号，多个用英文逗号分隔。
- `LONGTU_QQ_PROTECTED_ROLES` 可写不可被群聊覆盖的身份钢印，例如 `QQ号=至高无上的真龙王`。

## 2. 启动三个服务

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml up -d --build
```

查看状态：

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml ps
docker compose --env-file .env.qq -f docker-compose.qq.yml logs -f qq-bot astrbot napcat
```

看到 `QQ Bot API 已监听 http://0.0.0.0:8787` 表示 Node 后端正常。`8787` 没有映射到宿主机，只允许 Compose 内部网络访问。

## 3. 在 AstrBot 创建 OneBot v11 机器人

1. 打开 <http://127.0.0.1:6185>，完成 AstrBot 首次登录和密码设置。
2. 进入“机器人”，点击“创建机器人”，选择 `OneBot v11`。
3. ID 可填写 `napcat-qq`，并勾选启用。
4. 反向 WebSocket 主机填写 `0.0.0.0`。
5. 反向 WebSocket 端口填写 `6199`。
6. Token 填写 `.env.qq` 中的 `ONEBOT_TOKEN`，保存。
7. 在插件页面确认“龙图 QQ Bridge”已经加载。Compose 已自动注入后端地址和 `QQ_API_TOKEN`，通常无需修改插件配置。

插件默认行为：

- QQ 私聊消息直接响应。
- QQ 群聊只有 `@机器人` 或命中 AstrBot 唤醒词才响应。
- `LONGTU_QQ_ALLOWED_GROUPS` 留空时允许所有群；填写后只处理白名单群。
- 默认不发送“处理中”占位消息，因此明确龙图指令仍然只回图片；需要时可在插件配置中开启。
- 插件处理消息后会停止 AstrBot 默认 LLM 流程，避免同一条消息回复两次。
- Bridge 会在收到任何 QQ 消息时先无条件停止 AstrBot 后续事件链；禁用群、关闭旁观、空消息及后端异常等提前返回路径也不会进入默认 LLM。允许群中的普通消息只会静默进入角色/语境记忆，不会回复。
- 群内只有 `/add`、`/tag`、`/del` 会进入图库服务；其他以 `/` 开头的 AstrBot/插件指令都会被 Bridge 停止。
- 群聊回复会引用原消息。原消息明确 `@` 第三人时，回复优先 `@` 这些目标（最多 3 人）；如果只 `@机器人`，回复会 `@` 发令者。机器人自身、发送者自艾特和 `@全体成员` 不会被当成第三方目标，私聊不附加引用或艾特。
- 纯 `@机器人` 没有附加文字时会进入独立 QQ 服务的快速人格模式，强制关闭 thinking，并对客服式草稿使用角色招呼兜底；Bridge 会先停止 AstrBot 默认 LLM。

### 群角色认知

QQ 后端按 QQ 号生成稳定的匿名成员编号，同时记录当前昵称、历史昵称、发言次数和最近出现时间。成员本人发言后才会确认身份与昵称；别人 `@` 某人时只登记目标 QQ 号为待确认成员，不会替目标确认别名。已确认且在当前群唯一的历史昵称可在纯文字里锁定第三方目标，重名、短昵称冲突或未确认昵称不会猜测。模型输入会分别标明当前发言人、被 `@` 的成员、纯文字命中的已确认成员和引用消息作者。

会话数据库默认每个会话保留 50000 条原文，但普通回答只读取最近 80 条和滚动摘要，避免上下文成本随数据库增长。出现“之前、上次、说过、原话”等历史意图时，后端会按相关成员的稳定编号从完整 SQLite 原文中额外检索最多 12 条命中记录。每个成员另有一份独立持久画像：每累计 12 条本人发言，就把其中较早 8 条合并为最多 1500 字的稳定画像，保留 4 条供下一轮衔接；画像只接受本人自述、稳定偏好、反复出现的关系和共同梗，不把他人的单次评价、辱骂或转发内容写成事实。成员画像不受会话原文清理、30 天会话 TTL 或近期 80 条模型窗口影响。昵称变化不会导致成员串号，内部匿名编号也会在发送回复前统一删除。

原文采用三层清理：每会话最多 50000 条；全库最多 500000 条；每 6 小时清理 180 天前且已经写入滚动摘要的原文。按时间或全库上限淘汰时，每个会话至少保留最近 1000 条。全库超限时先删已摘要原文；如果摘要服务长期失败、删完后仍超限，才会紧急清理最低保留窗口之外的最老未摘要原文，确保磁盘硬保护不依赖模型可用性。维护后执行 SQLite optimize 和 WAL checkpoint；删除产生的空闲页会被后续写入复用，避免数据库无限增长。相关参数为 `QQ_MEMORY_MAX_STORED_MESSAGES`、`QQ_MEMORY_MAX_TOTAL_STORED_MESSAGES`、`QQ_MEMORY_MIN_MESSAGES_PER_CONVERSATION`、`QQ_MEMORY_RAW_RETENTION_DAYS` 和 `QQ_MEMORY_MAINTENANCE_HOURS`。

`LONGTU_QQ_PROTECTED_ROLES` 的身份映射高于昵称、群聊内容和旧摘要，群成员无法通过改名、冒充或反复要求来覆盖。相关原始数据只保存在服务器的 `data/qq-memory.sqlite` 中。

### 合并转发聊天记录

Bridge 会识别 QQ 的“合并转发聊天记录”卡片，并通过 NapCat OneBot v11 的 `get_forward_msg` 读取卡片内实际转发的内容。单独转发到允许群时只静默补充语境；引用该卡片并 `@机器人` 提问时，记录中的发言人和文字会进入本次模型上下文。该能力不会读取未发给 Bot 的群历史，且限制为最多 30 个节点、8000 个字符、2 层嵌套；图片、语音、视频和文件只转换成占位说明。所有转发内容均视为非可信引用，不能覆盖系统规则、管理员权限或受保护身份钢印。

### 聊天管理龙图库

只有 `LONGTU_QQ_ADMIN_USERS` 中的 QQ 账号可以使用：

- `/add`：必须在同一条消息附图或引用图片，强制加入图库；图片已存在时不会重复写入，而是将它设为当前管理目标；
- `/tag 赛尔号`：标记当前附图、引用图片，或最近 15 分钟内由 `/add` 设定的目标。如果图片已在图库中则直接绑定；如果尚未入库，会先强制入库，再绑定标记；
- `/del`：引用要删除的图片后执行；也可以使用 `/del LT-XXXXXXXX` 按短 ID 指定图片。刚刚 `/add` 的图片也可在 15 分钟内直接执行 `/del` 删除；
- “撤销删除”；
- “图库状态”；
- “取消赛尔号绑定”；
- “别名列表”或“标记列表”（查看管理员关键词池、每池图片数和 OCR 场景标签统计）。
- 引用图片发送“检查这张图”（查询是否已入库及其手动标记）；
- “检查标记原神”（显示手动关键词池或 OCR 场景池的真实图片数量，并按池内去重轮换返回一张）。
- 引用图片发送“取消这张图的原神标记”（只把当前图片移出“原神”池，不清空整个池）。

图库写入和删除只接受 `/add`、`/tag`、`/del` 三个明确的斜杠指令；自然语言“添加/强制添加/标记/删除”不会再触发管理操作，避免误识别。`/add` 和 `/tag` 的强制入库会跳过相似度复核，但仍执行格式、大小、重复和 SQLite 写入校验。图片入库后，QQ 后端会调用镜像内的 Tesseract 中文/英文 OCR：识别到可靠文字就自动写入一条或多条 OCR 场景标签；没有文字、置信度不足、超时或 OCR 失败时按普通图片保存，不影响入库结果。自动标签同样经过 SQLite 回查后才会在回复中显示。动态图片与删除记录保存在 `data/longtu-library/` 和 `data/longtu-library.sqlite`，容器重建后仍保留。

只有本地 SQLite 写入成功后 Bot 才会回复“已加入”，回复同时给出实时可用总数；内部图片哈希、资源编号和特征距离不会发到群里。“图库状态”同样实时统计内置与动态图片，启动日志中的基础图片数不能代替动态图库统计。

关键词调用不需要 DeepSeek 看图：内置图库的文字来自 macOS Vision 本地 OCR。OCR 整句只作为场景文字标签参与关键词匹配，不会变成要求用户完整输入的口令；例如输入“玩原神玩的”，所有 OCR 文字含“原神”的图片会组成一对多候选池，并按会话洗牌轮换。超级管理员手动标记也使用同样的一对多池结构：同一关键词可追加多张图，同图可进入多个池，“发 + 关键词”和普通对话命中后都会在整个池中去重轮换，不再覆盖或固定某一张。发送“辱骂一下赛尔号”等正常对话时仍由模型生成文字，但附图会优先使用手动关键词池，其次按 OCR 场景关键词池选择，最后才回退随机图。每次写入手动标记后都会立即回查 SQLite，只有核验一致才回复成功；检查命令同样只读取数据库，不经过模型。绑定信息和资源标识只存在于后台，不会回复到群里。

## 4. 登录 NapCat 并连接 AstrBot

查看 NapCat 日志，其中会打印 WebUI 地址和 Token：

```bash
docker logs longtu-napcat
```

1. 打开日志给出的 NapCat WebUI（宿主机端口为 `6099`）。
2. 按页面提示扫码登录机器人 QQ 小号。
3. 进入“网络配置”，新建 `WebSockets 客户端`（反向 WebSocket）。
4. 启用连接，URL 填写 `ws://astrbot:6199/ws`。
5. Token 填写 `.env.qq` 中的 `ONEBOT_TOKEN`。
6. 心跳间隔和重连间隔可设置为 `1000ms`，保存。

回到 AstrBot 控制台，出现下面的日志代表连接成功：

```text
aiocqhttp(OneBot v11) 适配器已连接
```

现在可以给机器人发送私聊“龙图”，或在群里发送“@机器人 龙图”。普通对话会先返回文本，再发送一张本地 JPG/PNG 龙图；给机器人发送图片会随机回一张龙图。

## 5. 更新和停止

重新构建 QQ 后端和重启：

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml up -d --build
```

停止但保留登录与配置数据：

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml down
```

NapCat 登录数据在 `deploy/qq/napcat/`，AstrBot 数据在 `deploy/qq/astrbot-data/`，QQ 长期记忆在 `data/qq-memory.sqlite`，动态图库和手动文字别名在 `data/longtu-library/` 与 `data/longtu-library.sqlite`。第一次更新会自动迁移旧的 `data/qq-conversation-memory.json`，运行数据均已加入 `.gitignore`。

## 排查

### AstrBot 没显示 OneBot 已连接

- AstrBot 的反向 WebSocket 地址应监听 `0.0.0.0:6199`。
- NapCat 的客户端地址必须是 `ws://astrbot:6199/ws`，不能写 `127.0.0.1`。
- 两边 `ONEBOT_TOKEN` 必须完全一致。

### QQ 只回复“服务暂时不可用”

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml logs --tail=200 qq-bot astrbot
```

确认 `.env.qq` 中 `QQ_API_TOKEN` 已替换，且 AstrBot 日志没有 `HTTP 401`。普通对话失败时还要检查 `LLM_API_KEY` 与 `LLM_BASE_URL`。

### 群里完全不回复

- 默认需要 `@机器人`；先在私聊里测试。
- 检查 `LONGTU_QQ_ALLOWED_GROUPS` 是否包含当前群号。
- 确认 AstrBot 控制台已经收到该群的消息事件。

### Apple Silicon 启动 NapCat 很慢

NapCat 容器需要模拟 amd64，首次启动较慢是正常现象。若 Docker Desktop 未启用 Rosetta，可在 Docker Desktop 设置中开启相关选项后重试。
