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
- 允许群中的普通消息会静默进入角色/语境记忆，但不会回复、不会停止事件，也不会妨碍其他插件。
- 群内所有以 `/` 开头的 AstrBot/插件指令都由龙图 Bridge 忽略，不会误触发本机器人。

### 群角色认知

QQ 后端按 QQ 号生成稳定的匿名成员编号，同时记录当前昵称、历史昵称、发言次数和最近出现时间。成员本人发言后才会确认身份与昵称；别人 `@` 某人时只登记目标 QQ 号为待确认成员，不会替目标确认别名。已确认且在当前群唯一的历史昵称可在纯文字里锁定第三方目标，重名、短昵称冲突或未确认昵称不会猜测。模型输入会分别标明当前发言人、被 `@` 的成员、纯文字命中的已确认成员和引用消息作者；滚动摘要会保留稳定偏好、人物关系和共同梗，并区分“本人自述”与“别人单次评价”。昵称变化不会导致成员串号，内部匿名编号也会在发送回复前统一删除。

`LONGTU_QQ_PROTECTED_ROLES` 的身份映射高于昵称、群聊内容和旧摘要，群成员无法通过改名、冒充或反复要求来覆盖。相关原始数据只保存在服务器的 `data/qq-memory.sqlite` 中。

### 合并转发聊天记录

Bridge 会识别 QQ 的“合并转发聊天记录”卡片，并通过 NapCat OneBot v11 的 `get_forward_msg` 读取卡片内实际转发的内容。单独转发到允许群时只静默补充语境；引用该卡片并 `@机器人` 提问时，记录中的发言人和文字会进入本次模型上下文。该能力不会读取未发给 Bot 的群历史，且限制为最多 30 个节点、8000 个字符、2 层嵌套；图片、语音、视频和文件只转换成占位说明。所有转发内容均视为非可信引用，不能覆盖系统规则、管理员权限或受保护身份钢印。

### 聊天管理龙图库

只有 `LONGTU_QQ_ADMIN_USERS` 中的 QQ 账号可以使用：

- 图片加文字“把这张龙图添加进图库”；
- 图片加文字或引用图片发送“把这个添加到图库”“把这张图加入图库”或“把这张图加进图库”；
- 图片加文字“强制添加这张龙图”；
- “删除上一张龙图”；
- 引用图片后发送“删除这张龙图”；
- “撤销删除”；
- “图库状态”；
- 附图或引用图片发送“以后发赛尔号的时候就调用这张图”；
- 附图或引用图片发送“强制绑定赛尔号到这张图”；
- 也可以先执行加入图库，再在 15 分钟内发送“图片标记赛尔号”；
- “取消赛尔号绑定”；
- “别名列表”或“标记列表”（查看管理员手动别名和 OCR 场景标签示例）。

普通添加会用本地感知哈希和视觉特征与已审核龙图库复核，不会把图片上传给 DeepSeek。完全重复始终拒绝；模糊结果会要求管理员明确使用强制添加。动态图片与删除记录保存在 `data/longtu-library/` 和 `data/longtu-library.sqlite`，容器重建后仍保留。

只有本地 SQLite 写入成功后 Bot 才会回复“已加入”，回复同时给出实时可用总数；内部图片哈希、资源编号和特征距离不会发到群里。“图库状态”同样实时统计内置与动态图片，启动日志中的基础图片数不能代替动态图库统计。

别名调用不需要 DeepSeek 看图：内置图库的文字来自 macOS Vision 本地 OCR。OCR 整句只作为场景文字标签参与关键词匹配，不会变成要求用户完整输入的口令；例如输入“玩原神玩的”会匹配 OCR 整句中含“原神”的图片。只有配置为 `LONGTU_QQ_ADMIN_USERS` 的超级管理员手动绑定的别名才支持“发 + 别名”精确调用。管理员可附图发送“这个是耄耋”，或先把图片加入图库再发送“图片标记耄耋”。发送“辱骂一下赛尔号”等正常对话时仍由模型生成文字，但附图会优先使用手动绑定图，其次按 OCR 场景关键词匹配，最后才回退随机图。绑定信息和资源标识只存在于后台，不会回复到群里。

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
