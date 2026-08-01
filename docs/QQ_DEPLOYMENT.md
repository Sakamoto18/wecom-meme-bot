# QQ 部署：AstrBot + NapCat

这条部署链路与企业微信完全独立：

```text
QQ → NapCat（OneBot v11）→ AstrBot → 龙图 Bridge 插件 → QQ Bot HTTP 服务
                                                        ↓
                                         现有回复引擎 / 龙图库 / 大模型
```

原企业微信入口仍然是 `npm start`（`src/index.js`）；QQ 入口是 `npm run start:qq`（`src/qq-api.js`）。两边使用不同的连接方式和会话记忆文件，可以同时运行。

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

NapCat 登录数据在 `deploy/qq/napcat/`，AstrBot 数据在 `deploy/qq/astrbot-data/`，QQ 会话记忆在 `data/qq-conversation-memory.json`。这些运行数据都已加入 `.gitignore`。

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
