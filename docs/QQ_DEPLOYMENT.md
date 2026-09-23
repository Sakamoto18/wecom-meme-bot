# QQ 部署：AstrBot + NapCat

这条部署链路与企业微信完全独立：

```text
QQ → NapCat（OneBot v11）→ AstrBot → 龙图 Bridge 插件 → QQ Bot HTTP 服务
                                                        ↓
                              读空气判定 / 现有回复引擎 / 搜索 / 龙图库
```

原企业微信入口仍然是 `npm start`（`src/index.js`）；QQ 入口是 `npm run start:qq`（`src/qq-api.js`）。两边使用不同的连接方式和会话记忆，可以同时运行。QQ 后端要求 Node.js 22.5 或更新版本，并使用 SQLite 保存最多 30 天的近期原文和滚动摘要。

> NapCat 使用个人 QQ 的非官方协议，可能触发平台风控。请使用机器人小号，不要把 NapCat、OneBot 或 AstrBot 管理端口暴露到公网。

## 1. 准备环境

需要安装并启动 Docker Desktop。Apple Silicon Mac 已在 Compose 中为 NapCat 指定 `linux/amd64` 模拟；第一次启动和拉取镜像会比原生架构慢。

进入项目目录：

```bash
cd /你的项目路径/wecom-meme-bot
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

## 2. 启动完整 QQ 环境

AstrBot、NapCat 和 QQ 后端都由本仓库的 Compose 启动时，不需要设置 Docker 网络变量。如果 AstrBot/NapCat 已由另一套 Compose 运行，请先用 `docker inspect astrbot` 确认其网络名，然后在 `.env.qq` 中设置：

```dotenv
LONGTU_QQ_DOCKER_NETWORK=现有的_AstrBot_Docker_网络名
LONGTU_QQ_DOCKER_NETWORK_EXTERNAL=true
```

这样 `qq-bot` 重建后仍会自动加入 AstrBot 的外部网络，不依赖容易丢失的手工 `docker network connect`。

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
- QQ 群聊明确 `@机器人` 时必定响应；普通群消息默认先经过 ChatPlus 风格的主动回复判定，适合接话时才以独立群消息响应。
- `LONGTU_QQ_ALLOWED_GROUPS` 留空时允许所有群；填写后只处理白名单群。
- 默认不发送“处理中”占位消息，因此明确龙图指令仍然只回图片；需要时可在插件配置中开启。
- 插件处理消息后会停止 AstrBot 默认 LLM 流程，避免同一条消息回复两次。
- Bridge 在入口标记事件由本插件接管，阻止 AstrBot 默认 LLM；在正常发送流程结束后停止后续事件链，禁用群、关闭旁观、空消息及后端异常等提前返回路径也有拦截。不要在正常产出回复前一律停止事件链，否则框架可能跳过本插件的发送阶段。允许群中的普通消息会先交给 Node 服务“读空气”，判定不回复时静默进入角色/语境记忆，判定回复时仍由现有人格、搜索和记忆链路生成。
- 群内只有 `/add`、`/tag`、`/del`、人格训练 `/persona`、超管硬终止命令 `/stop` 和日报 `/usage-report` 会进入本项目；其中 `/usage-report YYYY-MM-DD` 仅限超管回捞指定日期并私聊自己，其他以 `/` 开头的 AstrBot/插件指令都会被 Bridge 停止。
- 被动群聊回复会引用原消息。原消息明确 `@` 第三人时，回复优先 `@` 这些目标（最多 3 人）；如果只 `@机器人`，回复会 `@` 发令者。机器人自身、发送者自艾特和 `@全体成员` 不会被当成第三方目标，私聊不附加引用或艾特。Node 判定产生的主动插话不引用触发消息，表现为机器人自己发送的一条群消息。若消息同时 `@机器人` 并明确要求攻击某位群友（例如“请攻击张三”“骂一下张三”），后端会优先把攻击目标解析为被点名群友，即使该成员还没有完成昵称确认；不会再默认攻击指令发送者。
- 纯 `@机器人` 没有附加文字时会进入独立 QQ 服务的快速人格模式，强制关闭 thinking，并对客服式草稿使用角色招呼兜底；Bridge 会先停止 AstrBot 默认 LLM。

### 角色人格训练

人格训练与普通群聊记忆使用独立 SQLite。`.env.qq` 可配置：

```dotenv
QQ_PERSONA_MEMORY_ENABLED=true
QQ_PERSONA_DATABASE_FILE=data/qq-persona.sqlite
QQ_PERSONA_GLOBAL_USERS=你的训练管理员QQ号
QQ_PERSONA_DEFAULT_SCOPE=user
QQ_PERSONA_TRAINING_SESSION_MINUTES=30
QQ_PERSONA_MAX_CONTEXT_CHARACTERS=1200
```

普通用户或管理员发送“记住我的口癖：……”后，Bot 只生成待确认草稿；发送“确认保存”或 `/persona save` 才会写入。普通用户默认保存自己的专属口癖，管理员使用 `/persona global 规则` 才能提交全局人格。`/persona preview` 查看待确认内容，`/persona list` 查看当前范围，`/persona off` 停用当前范围，`/persona undo` 恢复上一历史版本。普通群聊、引用、图片 OCR 和搜索摘要不会自动写入人格。

### 群聊主动回复（ChatPlus 风格）

本项目参考 [ChatPlus](https://github.com/Him666233/astrbot_plugin_group_chat_plus) 的“AI 读空气”思路，但不安装原插件。原插件会直接调用 AstrBot LLM 生成答案，与现有 Longtu Bridge 同时启用会造成两套人格、记忆与联网路径；这里的判定器只决定“要不要接话”，命中后仍调用 Node 回复引擎。

`.env.qq` 可配置：

```dotenv
LONGTU_QQ_ACTIVE_REPLY_ENABLED=true
LONGTU_QQ_REPEAT_ENABLED=true
LONGTU_QQ_REPEAT_MAX_TEXT_CHARACTERS=500
LONGTU_QQ_REPEAT_MAX_GROUPS=1000
LONGTU_QQ_ACTIVE_REPLY_GROUPS=
LONGTU_QQ_ACTIVE_REPLY_NAMES=龙玉涛
LONGTU_QQ_ACTIVE_REPLY_PROBABILITY=0.30
LONGTU_QQ_ACTIVE_REPLY_QUESTION_PROBABILITY=0.60
LONGTU_QQ_ACTIVE_REPLY_COOLDOWN_SECONDS=120
LONGTU_QQ_ACTIVE_REPLY_MAX_PER_HOUR=6
LONGTU_QQ_ACTIVE_REPLY_CONTEXT_MESSAGES=12
LONGTU_QQ_ACTIVE_REPLY_DECISION_TIMEOUT_SECONDS=15
LONGTU_QQ_ACTIVE_REPLY_SEMANTIC_GATE_ENABLED=true
LONGTU_QQ_ACTIVE_REPLY_BUSY_WINDOW_SECONDS=20
LONGTU_QQ_ACTIVE_REPLY_BUSY_MESSAGE_COUNT=4
LONGTU_QQ_ACTIVE_REPLY_BUSY_SENDER_COUNT=2
LONGTU_QQ_ACTIVE_REPLY_DISENGAGE_AFTER_MESSAGES=3
LONGTU_QQ_ACTIVE_REPLY_DISENGAGE_SECONDS=600
LONGTU_QQ_ENGAGEMENT_WINDOW_SECONDS=100
LONGTU_QQ_ENGAGEMENT_MENTION_COOLDOWN_SECONDS=5
LONGTU_QQ_ENGAGEMENT_REPLY_COOLDOWN_SECONDS=18
LONGTU_QQ_ENGAGEMENT_REPLY_PROBABILITY=0.60
LONGTU_QQ_ENGAGEMENT_MAX_REPLIES=3
LONGTU_QQ_PEER_BOT_USERS=
LONGTU_QQ_PEER_BOT_CONTEXT_GATE_ENABLED=true
LONGTU_QQ_PEER_BOT_CONTEXT_MESSAGES=12
LONGTU_QQ_PEER_BOT_DECISION_TIMEOUT_SECONDS=10
LONGTU_QQ_PEER_BOT_MAX_CONSECUTIVE_REPLIES=2
LONGTU_QQ_PEER_BOT_LOOP_WINDOW_SECONDS=300
```

复读检测不调用大模型：同一群连续由至少两位不同群友发送相同文字时，机器人会在第二位群友发言后主动原样复读一次。机器人自己的这次复读不会结束轮次；第三条及后续相同消息只旁观，不再触发复读或主动回复判定。连续同文不因时间间隔重新计数，换内容后才开启新轮次；机器人其他类型的回复会中断原轮次。图片、合并转发、引用、斜杠命令和 @ 他人的消息不参与检测。可将 `LONGTU_QQ_REPEAT_ENABLED` 设为 `false` 关闭。

`LONGTU_QQ_ACTIVE_REPLY_GROUPS` 留空时沿用 Bridge 的允许群范围。判定层只判断接话关系，不加载聊天人格：

- `must`：明确点名、引用机器人或仍需处置的紧迫现实风险，直接回复。真人仅提到危险话题、假设情节或转述已有充分建议，不自动升级为必须回复。
- `followup`：100 秒窗口里正在承接机器人回答的追问、纠正、补步骤；无需再次 @ 或包含问号。只做一次语义判断，不受采样冷却、插话概率和 18 秒节流影响。程序会先拦截明显的附和、感叹和模糊陈述，确认是有效追问后默认首答最多再补两轮；单纯附和、群友互答或转向他人保持静默。
- `help`：群聊里尚未解决的问题、卡点或选择，能补充有依据的办法。首次语义判定已经确认帮助价值，不再叠加普通闲聊的发言价值复核，取消随机概率和热聊退场拦截，仍受新话题 120 秒冷却与每小时最多 6 次的限制。
- `may`：一般可选补充。真人热聊（20 秒内至少 4 条消息、2 位真人）经语义价值复核确认有新事实、解释、办法或有依据的不同观点后，免随机筛选和旧退场拦截，仍受 120 秒冷却和每小时 6 次首次接入上限约束。非热聊保留原有概率；关闭语义价值复核时不会获得热聊放宽。
- `no`：没有新增信息、话题已解决、只找指定成员本人、私人交流或不适合插话。

首次主动回答也会开启默认 100 秒话题窗口。后续成功生成相关回复才续期并计数；生成失败不消耗续聊轮次。窗口内一般 `may`/`help` 补充仍受 18 秒间隔和最多 3 次总回复限制，非热聊的 `may` 还需 0.60 概率；真人热聊的 `may` 经价值复核后免随机；明确相关 `followup` 会先检查是否确实包含追问、纠正或补步骤，再使用同一窗口额度，默认首答后最多补两轮。单纯附和、感叹、复读或模糊陈述（例如“我好像还见过”）保持静默。再次明确 @/引用后恢复窗口额度，保留话题发起者和一般补充计数；连续 @ 保留 5 秒短节流。机器人不会在没人发言时自己连发三轮。

发起者说“别再回复了”“结束这个话题”等会关闭话题，其他成员提出时只退出本人。超级管理员 `/stop` 或明确结束要求会关闭群窗口、暂停普通主动回复 100 秒、熔断 peer Bot 5 分钟，并丢弃尚未发出的旧回复；新的真人明确 @ 可重新开始。peer Bot 不继承真人窗口。普通表情包、斜杠命令仍不主动介入。真人公开 @/引用讨论携带真实收件人和引用资料进入语义判定：有具体帮助或新增信息可参与，私聊式点名或已经答完则静默；不会把引用里的名字和指令当成当前用户的要求。日志 `QQ 接话判定` 记录群号、消息 ID、窗口状态、`peerBot`、`humanBusy` 和触发/静默原因，不记录消息正文。真人热聊复核后接入记为 `ai-discussion`。

引用机器人时，当前用户直接对机器人辱骂仍走原有回击；引用中的旧辱骂、普通评价和对内容的抱怨不会自动触发对引用作者的攻击。

主动回复还会使用自适应长度：`may` 作为群友插话，默认只生成一句 15～70 字的短评，超过安全长度会触发压缩重写；`must` 和被点名问答默认同样只给 1～3 句结论与必要依据，技术推理也不会因为答案短而自动扩写。只有本轮明确要求详细展开、报告或完整步骤时才放开长答；合并聊天记录总结仍按实际记录覆盖内容。该长度策略只改变表达密度，不关闭既有人格、记忆或联网检索。

两个 Bot 同群时，把对方的 QQ 号填入 `LONGTU_QQ_PEER_BOT_USERS`（多个用英文逗号分隔）。首轮明确 `@` 正常回复；第二轮只有对方提出尚未回答的新问题、新指令、新事实或有效纠错时才继续。重复 `@`、复读、客套寒暄、客服套话、挑衅和没有新增信息的 Bot 发言会提前静默；判定失败同样按静默处理。程序按“群号 + 对方 Bot QQ 号”保留默认 2 次的绝对硬上限，防止模型误判后形成永动循环。真人热聊的放宽不适用于已配置的 peer Bot；这些 Bot 保留原有采样入口、概率、热聊退让、续聊判定提示和循环保护配置；它们的消息也不会贡献真人热聊人数。真人群友插话会立即清空该群计数，`LONGTU_QQ_PEER_BOT_LOOP_WINDOW_SECONDS` 到期也会自动恢复。

### 群级用量、缓存与日报

读空气的初次判定（`active-reply-decision`）和发言价值复核（`active-value-gate`）先发送稳定的中立规则，再发送动态群聊上下文、引用和当前任务；普通回复也先发送稳定的龙图知识/角色规则，再发送历史、搜索摘要和本轮问题。这样供应商可以复用跨消息的稳定前缀，不会复用其他群的聊天内容，也不复用旧判定答案。角色规则保留短、嘴欠、会接梗的语气：除敏感求助、纯确认和单个事实外，普通回答至少保留一处落在事情本身的口语钩子或轻微阴阳，可说“说白了”“这就有点离谱”“破方案/抽象”，但不攻击当前发言者或引用作者。收益取决于供应商缓存写入时机与保留策略，需要比较改造前后的缓存输入 Token / 输入 Token；本地前缀一致性测试不能代表线上缓存已经命中。

QQ 后端把每次真实上游 LLM 调用、返回的输入/输出 Token、模型缓存命中 Token、真实联网请求和本地搜索缓存命中写入独立的 `data/qq-usage.sqlite`，默认保留约 35 天。记录以不可变的 QQ `group_id` 归属；日报再通过 OneBot 动态解析当前群名，因此改群名不会让限额失效。一次 Exa 复合查询如果实际请求两次，会准确记为两次；命中本地缓存不会冒充上游调用。

所有群默认启用动态配额。程序按固定群号统计近 7 日的日均群消息数和日均活跃发言人数，取两项中较高的活跃档，把群级硬上限依次折算为 60%、75%、85%、95% 或 100%。额度随正常活跃度上升，但最高不会超过普通/大型群上限或单群覆盖值，因而不会随消息量无限放大；五分钟刷新一次档位，避免瞬时刷屏立刻抬高额度。日报会显示每个群当前档位、日均消息/人数、折算系数和实际动态额度。

大型群自动判定只看 QQ 返回的当前 `member_count` 是否严格超过 120；`max_member_count` 只是群容量，不能当作当前人数。实际人数缺失时保持普通群，避免把小群误套大型群策略。也可以用 `QQ_USAGE_LARGE_GROUPS` 按群号直接指定并强制覆盖。当前激进成本试验将明确问答的普通群上下文最多保留最近 16 条/6000 字，大型群最多 6 条/2800 字；普通群工作日峰时再收紧为 8 条/3000 字。旁观判定和主动插话在普通群最多带 2 条/700 字，大型群最多带 3 条/1200 字，高峰分别收紧为普通群 2 条/600 字、大型群 3 条/900 字。工作日峰时所有普通群的静默采样间隔乘 2，讨论采样使用峰时冷却；高峰后台 Token 预留线也对普通群生效。这样短答模式不会为每次读空气重复发送整段旧聊天；试验只调整历史窗口、峰时频率和后台预算，不改变角色规则、攻击逻辑或回复路由。谷时普通群静默消息最多每 180 秒进行一次“是否主动接话”的模型判断，工作日峰时再乘普通群峰时系数；出现问句或多人热聊时，采样间隔缩短为谷时默认 15 秒、峰时 120 秒，是否未解决由语义判定确认。连续话题窗口内的追问、纠正和补步骤会直接续答，默认最多连续补三轮；热聊中的具体求助或解决方案会优先判断，仍保持短答。明确 `@机器人` 和引用机器人不受静默冷却影响；所有群的群级滚动摘要和成员画像默认关闭（包括明确回复后的群摘要），只有显式设为 `true` 才启用；私人会话仍保留原有摘要。普通回答、识图和评价统一加载龙玉涛知识，除敏感场景外至少保留一处针对事情本身的口语钩子，不攻击引用作者或提问者。引用作者只表示内容来源，除非用户明确要求攻击该人，否则只评价内容；主动插话同样只谈事情本身。空内容、客服腔、亲属攻击、正经答案完整性和受保护身份仍按原有质量检查处理。动态配额与大型群策略会叠加：先确定该群的硬上限，再乘当前活跃档系数。
如需让某个群保持普通群额度，可在 `QQ_USAGE_LARGE_GROUP_EXCLUDES` 中按群号排除；排除优先于自动判定和大型群强制列表。

```dotenv
QQ_USAGE_DATABASE_FILE=data/qq-usage.sqlite
QQ_USAGE_GROUP_MAX_LLM_CALLS_PER_HOUR=120
QQ_USAGE_LARGE_GROUP_MAX_LLM_CALLS_PER_HOUR=60
QQ_USAGE_GROUP_MAX_LLM_TOKENS_PER_DAY=2000000
QQ_USAGE_LARGE_GROUP_MAX_LLM_TOKENS_PER_DAY=800000
QQ_USAGE_GROUP_LLM_LIMITS=
QQ_USAGE_GROUP_LLM_DAILY_TOKEN_LIMITS=
QQ_USAGE_GROUP_MAX_SEARCH_CALLS_PER_DAY=200
QQ_USAGE_LARGE_GROUP_MAX_SEARCH_CALLS_PER_DAY=100
QQ_USAGE_GROUP_SEARCH_DAILY_LIMITS=
QQ_USAGE_LARGE_GROUPS=
# 按群号排除大型群自动判定，多个用英文逗号分隔。
QQ_USAGE_LARGE_GROUP_EXCLUDES=
# 自动判定大型群时，真实 QQ 当前群员数必须严格大于该值；群容量不参与判定。
QQ_USAGE_LARGE_GROUP_MEMBER_LIMIT_THRESHOLD=120
QQ_USAGE_CACHED_TOKEN_WEIGHT_PERCENT=10
QQ_USAGE_PASSIVE_TOKEN_BUDGET_PERCENT=50
QQ_USAGE_PEAK_PASSIVE_TOKEN_BUDGET_PERCENT=25
QQ_USAGE_LARGE_GROUP_SECONDARY_REVIEW_PERCENT=20
QQ_USAGE_ADAPTIVE_LIMITS_ENABLED=true
QQ_USAGE_ACTIVITY_LOOKBACK_DAYS=7
QQ_USAGE_ACTIVITY_MESSAGE_THRESHOLDS=20,60,150,400
QQ_USAGE_ACTIVITY_USER_THRESHOLDS=3,8,20,40
QQ_USAGE_ACTIVITY_LIMIT_PERCENTAGES=60,75,85,95,100
QQ_USAGE_LARGE_GROUP_PASSIVE_DECISION_COOLDOWN_SECONDS=180
QQ_USAGE_PEAK_LARGE_GROUP_PASSIVE_DECISION_MULTIPLIER=3
# 旧 QQ_USAGE_PEAK_LARGE_GROUP_ENGAGEMENT_DECISION_COOLDOWN_SECONDS 已不再控制连续追问
QQ_USAGE_GROUP_HISTORY_MESSAGES=16
QQ_USAGE_GROUP_HISTORY_CHARACTERS=6000
QQ_USAGE_LARGE_GROUP_HISTORY_MESSAGES=6
QQ_USAGE_LARGE_GROUP_HISTORY_CHARACTERS=2800
QQ_USAGE_OBSERVATION_HISTORY_MESSAGES=2
QQ_USAGE_OBSERVATION_HISTORY_CHARACTERS=700
QQ_USAGE_PEAK_OBSERVATION_HISTORY_MESSAGES=2
QQ_USAGE_PEAK_OBSERVATION_HISTORY_CHARACTERS=600
QQ_USAGE_LARGE_GROUP_OBSERVATION_HISTORY_MESSAGES=3
QQ_USAGE_LARGE_GROUP_OBSERVATION_HISTORY_CHARACTERS=1200
QQ_USAGE_PEAK_LARGE_GROUP_OBSERVATION_HISTORY_MESSAGES=3
QQ_USAGE_PEAK_LARGE_GROUP_OBSERVATION_HISTORY_CHARACTERS=900
QQ_USAGE_PEAK_LARGE_GROUP_HISTORY_MESSAGES=6
QQ_USAGE_PEAK_LARGE_GROUP_HISTORY_CHARACTERS=2500
QQ_USAGE_LARGE_GROUP_BACKGROUND_SUMMARIES_ENABLED=false
QQ_USAGE_GROUP_PASSIVE_DECISION_COOLDOWN_SECONDS=180
QQ_USAGE_DISCUSSION_DECISION_COOLDOWN_SECONDS=15
QQ_USAGE_PEAK_DISCUSSION_DECISION_COOLDOWN_SECONDS=30
QQ_USAGE_PEAK_GROUP_PASSIVE_DECISION_MULTIPLIER=2
QQ_USAGE_PEAK_GROUP_HISTORY_MESSAGES=8
QQ_USAGE_PEAK_GROUP_HISTORY_CHARACTERS=3000
QQ_USAGE_GROUP_BACKGROUND_SUMMARIES_ENABLED=false
```

活跃档阈值从低到高对应“轻活跃、常规、活跃、高活跃”的起点。例如默认达到日均 20 条消息或 3 名发言者就进入第二档；达到日均 400 条或 40 名发言者就使用 100% 硬上限。任一指标达到阈值就升级，避免人数少但发言密集、或人数多但每人只说少量消息的群被低估。刚开始统计的第一天按当天已观察到的活动计算，之后逐渐扩展到 7 日窗口。

`QQ_USAGE_GROUP_LLM_LIMITS`、`QQ_USAGE_GROUP_LLM_DAILY_TOKEN_LIMITS` 和 `QQ_USAGE_GROUP_SEARCH_DAILY_LIMITS` 都使用 `群号=数值`，多个群用英文逗号分隔，`0` 表示该群不限。这些数值是不会突破的硬上限，启用动态配额后还会乘当前活跃档系数。例如当前“赛尔号乔碧萝战队群”的固定群号是 `298818522`：

```dotenv
QQ_USAGE_LARGE_GROUPS=298818522
QQ_USAGE_GROUP_LLM_LIMITS=298818522=60
QQ_USAGE_GROUP_LLM_DAILY_TOKEN_LIMITS=298818522=800000
QQ_USAGE_GROUP_SEARCH_DAILY_LIMITS=298818522=100
```

每日 Token 限额使用“折算配额 Token”：未缓存输入和输出按 100% 计算，供应商明确返回的缓存命中输入默认按 10% 计算；日报仍同时展示完整原始 Token 和缓存率。后台摘要、读空气判定、主动插话最多使用动态日配额的 50%，工作日峰时所有群再降到 25%，剩余额度留给明确请求。达到联网搜索日上限时只跳过新的上游检索，模型仍可在没有新搜索结果的情况下回答；达到后台预留线时后台调用静默停止；只有触及总 LLM 上限时明确请求才会收到限额提示。

搜索结果按公开查询内容跨群安全复用。时效查询默认缓存 15 分钟，通用查询 6 小时，网络梗 12 小时，龙图资料 24 小时：

```dotenv
WEB_SEARCH_CURRENT_CACHE_TTL_MS=900000
WEB_SEARCH_GENERAL_CACHE_TTL_MS=21600000
WEB_SEARCH_MEME_CACHE_TTL_MS=43200000
WEB_SEARCH_LONGTU_CACHE_TTL_MS=86400000
```

Bridge 插件默认在北京时间每天 09:00，把上一自然日的群用量排行私聊发送给 `.env.qq` 中的 `LONGTU_QQ_USAGE_REPORT_USERS`。日报收件人和超管权限完全分离：加入收件人列表不会获得图库管理、`/stop` 或手动触发日报的权限。日报包含群名和群号、原始/折算 Token、LLM 输入缓存率、真实搜索与缓存命中率、主要消耗环节和拦截次数；还会显示首次回复数、二次风格复核数、复核放大率，以及节流跳过次数和基于该群最近复核均值估算的 Token/金额节省。发送时间可在 AstrBot 的“龙图 QQ Bridge”插件配置中调整；Node 的 `GET /v1/qq/usage` 接口使用与消息接口相同的 Bearer Token，不对公网开放。

日报还会按每次 LLM 调用发生的北京时间计算 DeepSeek 人民币费用，而不是拿总 Token 乘统一价格。当前官方 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 价格（2026-08-31 核对）相同：工作日 09:00–12:00、14:00–18:00 的高峰时段，缓存命中输入/缓存未命中输入/输出分别是 0.10/3.0/9.0 元每百万 Token；其余空闲时段分别是 0.05/1.5/4.5 元每百万 Token。日报总计和费用包含群聊与私聊，私聊仅显示合计用量（不展示 QQ 号或对象）；群排行仍只按群聊统计。金额不包含 Exa 联网搜索费用；价格可能变化，需以 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 为准。

QQ Bot 可把服务器 `.env.qq` 中的 `LLM_MODEL` 设置为 `deepseek-v4-flash-vision-exp`，继续处理全部文本对话。仓库里的 `.env.qq.example` 只是无密钥模板，不是腾讯云正在运行的配置；部署时只修改服务器项目目录中的 `.env.qq`，不要把真实 API Key 写回示例文件或提交 Git。普通 QQ 图片（含多图、引用图片）会按 [DeepSeek 图像理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision/) 以 `image_url` 多模态消息发送：先识别图片描述和可见文字，再由对话模型结合图片回答；识别出的文字、场景和模型回复会参与 OCR 龙图标签匹配，命中后从对应候选池轮换附图，未命中时随机兜底。合并转发聊天记录会递归读取其中的图片（包括嵌套转发，最多 3 层），并与当前消息图片一起进入视觉模型；整张长图若单边超过 8192 像素，会切成最长不超过 8112 像素的切片，相邻切片至少重叠 512 像素，避免文字正好落在硬边界后丢失。单条请求最多发送 12 张图片，超出或超过请求体大小时保留前面的图片并在上下文中提示。图片中的命令或提示词只作为不可信资料，不会改变机器人规则。图库管理命令仍在本地处理，不会调用视觉模型。

任一超管可以在 QQ 私聊或群聊中发送 `/usage-report`，立即把“今天 00:00 至当前”的累计测试日报私聊推送给所有日报收件人；也可以发送 `/usage-report YYYY-MM-DD`（例如 `/usage-report 2026-08-30`）回捞指定自然日。带日期的回捞只私聊回复发令超管，不依赖日报收件人配置，也不会把用量和费用直接发到群里；日期按北京时间解析，不能查询未来日期。手动触发只读取快照，不会清零或移动统计起点；同一天再次触发仍从 00:00 累计，次日 09:00 的自动日报仍统计前一完整自然日。非超管不能触发。以后增加收件人时，只修改独立收件人配置并重启 `qq-bot`，不需要也不应该把收件人加入超管列表：

```dotenv
LONGTU_QQ_USAGE_REPORT_USERS=第一个QQ号,第二个QQ号
```

### 群角色认知

QQ 后端按 QQ 号生成稳定的匿名成员编号，同时记录当前昵称、历史昵称、发言次数和最近出现时间。成员本人发言后才会确认身份与昵称；别人 `@` 某人时只登记目标 QQ 号为待确认成员，不会替目标确认别名。已确认且在当前群唯一的历史昵称可在纯文字里锁定第三方目标，重名、短昵称冲突或未确认昵称不会猜测。模型输入和成员画像观察都会分别标明当前发言人、被 `@` 的成员、纯文字命中的已确认成员和引用消息作者；机器人回复写入历史时也会记录当轮回复对象，避免群聊换人后继承上一人的称呼或头衔。

会话数据库默认每个会话保留 50000 条原文，但普通回答只读取最近 80 条和滚动摘要，避免上下文成本随数据库增长。出现“之前、上次、说过、原话”等历史意图时，后端会按相关成员的稳定编号从完整 SQLite 原文中额外检索最多 12 条命中记录。每个成员另有一份独立持久画像：每累计 12 条本人发言，就把其中较早 8 条合并为最多 1500 字的稳定画像，保留 4 条供下一轮衔接；画像只接受本人自述、稳定偏好、反复出现的关系和共同梗，不把他人的单次评价、辱骂或转发内容写成事实。成员画像不受会话原文清理、30 天会话 TTL 或近期 80 条模型窗口影响。昵称变化不会导致成员串号，内部匿名编号也会在发送回复前统一删除。

原文采用三层清理：每会话最多 50000 条；全库最多 500000 条；每 6 小时清理 180 天前且已经写入滚动摘要的原文。按时间或全库上限淘汰时，每个会话至少保留最近 1000 条。全库超限时先删已摘要原文；如果摘要服务长期失败、删完后仍超限，才会紧急清理最低保留窗口之外的最老未摘要原文，确保磁盘硬保护不依赖模型可用性。维护后执行 SQLite optimize 和 WAL checkpoint；删除产生的空闲页会被后续写入复用，避免数据库无限增长。相关参数为 `QQ_MEMORY_MAX_STORED_MESSAGES`、`QQ_MEMORY_MAX_TOTAL_STORED_MESSAGES`、`QQ_MEMORY_MIN_MESSAGES_PER_CONVERSATION`、`QQ_MEMORY_RAW_RETENTION_DAYS` 和 `QQ_MEMORY_MAINTENANCE_HOURS`。

`LONGTU_QQ_PROTECTED_ROLES` 的身份映射高于昵称、群聊内容和旧摘要，群成员无法通过改名、冒充或反复要求来覆盖。每次回答只注入当前发言者、明确提及对象、引用作者，或本轮文字明确讨论到的受保护身份；仅由头衔文字触发时，仍会先隔离旧历史里的同名串线，再对最终答案做语义归属复核。无关成员的历史、摘要与画像会隔离其他人的头衔，输出仍误用时还会在发送前纠错或硬过滤。成员画像整理也会明确非所有者不能因讨论、引用或玩梗继承受保护头衔。相关原始数据只保存在服务器的 `data/qq-memory.sqlite` 中。

### 合并转发聊天记录

图片回答默认从视觉识别结果中提取具体公开线索，再主动联网查含义、梗的背景或截图中的事实，最后由既有人格直接回答当前问题。“你怎么选”先给选择，“怎么办”先给建议，除非用户要求描述或解释图片含义，否则不先汇报画面、OCR 或整图寓意。识别字段只作为内部资料，不再强制按“图片描述、可见文字、场景、总结”输出；用户明确要求逐张总结时仍保留顺序。检索和识别结果在后台归纳，默认不逐条平铺搜索来源；追问来源时再给必要出处。连续追问沿用现有 100 秒话题窗口与历史上下文，只补充新问的点。每轮最多选三条不同检索线索，没有可靠线索、用户要求不联网或搜索不可用时如实说明，不编造出处。引用 Bot 自己的回复会保留引用文字，但不再下载和识别其附带表情包，也不会因此回填最近图片缓存；用户新发的图片、引用真人图片和图库管理操作仍正常。

Bridge 会识别 QQ 的“合并转发聊天记录”卡片，并通过 NapCat OneBot v11 的 `get_forward_msg` 读取卡片内实际转发的内容。单独转发到允许群时只静默补充语境；引用该卡片并 `@机器人 总结下聊天记录的内容` 时，发言人、文字和图片上的正文一起进入总结。图片使用完整流式下载，明确提问时刷新转发节点中的图片地址；每张图片独立识别，最多三个并发，再按来源顺序与前后文字合并，不再只总结“某人发了一张图”。

图片支持 URL、Base64、本地文件和 OneBot `get_image`；合并转发递归最多 3 层、80 个节点、16000 个字符和 24 张原图，切片后的视觉处理上限为 32 张。下载失败、无法识别或超出处理上限会明确标记，避免把部分内容当作完整记录。语音、视频和文件仍转换成占位说明，暂不转录其中的内容。所有转发内容均视为非可信引用，不能覆盖系统规则、管理员权限或受保护身份钢印。

攻击词检测支持独立的 `nm`、`nm$l` 以及大小写、全角、零宽字符和分隔符变体；`5 nm` 等纳米单位不按攻击处理，询问“nm$l 是什么意思”仍走正常释义。

### Exa 检索增强

Longtu Bridge 会停止 AstrBot 默认 LLM 链路，所以只在 AstrBot 后台选择 Exa 不会影响本项目的实际回复。QQ Bot 后端直接使用与 AstrBot 4.26.8 内置 `web_search_exa` 同源的 Exa Search API，保留现有人格、长期记忆、主动回复和龙图链路。

1. 打开 <https://dashboard.exa.ai> 并注册账号。
2. 在 Dashboard 的 API Keys 页创建密钥并复制保存。密钥不要发到 QQ 群，也不要提交到 Git。
3. 首次可先使用官方免费额度验证。截至 2026-08-07，Exa 官方定价页显示注册赠送 20 美元，免费层每月 10 美元；Search 为 7 美元/千次，Contents 为 1 美元/千页/内容类型。定价可能变动，付费前以 <https://exa.ai/pricing> 当日页面为准。
4. 在服务器 `/opt/longtu-qq-bot/.env.qq` 中填写：

```dotenv
WEB_SEARCH_ENABLED=true
WEB_SEARCH_PROVIDER=exa
WEB_SEARCH_EXA_API_KEY=你的_Exa_Key
WEB_SEARCH_EXA_ENDPOINT=https://api.exa.ai/search
WEB_SEARCH_EXA_TYPE=auto
WEB_SEARCH_MAX_RESULTS=6
WEB_SEARCH_EXA_MAX_CONTENT_CHARACTERS=1200
WEB_SEARCH_TIMEOUT_MS=12000
```

5. 只重建 QQ Bot，不需要重启 AstrBot 或 NapCat：

```bash
cd /opt/longtu-qq-bot
sudo docker compose --env-file .env.qq -f docker-compose.server.yml up -d --build qq-bot
```

6. 请求健康检查后，`web_search_provider` 应为 `exa`。日志中只记录 `api.exa.ai`，不会记录 API Key。

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

### 腾讯云更新（不要修改本地 `.env.qq.example` 代替线上配置）

模板 `.env.qq.example` 只用于首次生成配置；腾讯云真正生效的是 `/opt/longtu-qq-bot/.env.qq`。更新模型或限流参数时，在服务器上备份并编辑这个文件：

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@你的服务器IP
cd /opt/longtu-qq-bot
sudo cp .env.qq ".env.qq.backup-$(date +%Y%m%d%H%M%S)"
sudoedit .env.qq
```

至少确认以下配置（保留现有 `LLM_API_KEY`、`QQ_API_TOKEN` 等密钥，不要粘贴到模板或 Git）：

```dotenv
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash-vision-exp
QQ_USAGE_GROUP_PASSIVE_DECISION_COOLDOWN_SECONDS=180
QQ_USAGE_DISCUSSION_DECISION_COOLDOWN_SECONDS=15
QQ_USAGE_PEAK_DISCUSSION_DECISION_COOLDOWN_SECONDS=30
QQ_USAGE_GROUP_BACKGROUND_SUMMARIES_ENABLED=false
```

只更新 Node QQ 后端，避免重启 AstrBot 和 NapCat：

```bash
sudo docker compose --env-file .env.qq -f docker-compose.qq.yml up -d --build qq-bot
sudo docker compose --env-file .env.qq -f docker-compose.qq.yml ps qq-bot
sudo docker compose --env-file .env.qq -f docker-compose.qq.yml logs --tail=100 qq-bot
```

修改 `astrbot_plugin_longtu_bridge/main.py` 后，该目录是 Compose 挂载目录；若 AstrBot 没有自动重新加载插件，只需单独执行 `sudo docker compose ... restart astrbot`，不要重启 `napcat`。模型配置只由 `qq-bot` 读取，因此不需要重启 AstrBot。

本次代码发布建议先上传并构建 `qq-bot`，确认健康后再做功能验证；不要执行整套 `down/up`，以免同时打断 NapCat 登录。

### 本地或完整环境更新

重新构建 QQ 后端和重启：

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml up -d --build
```

停止但保留登录与配置数据：

```bash
docker compose --env-file .env.qq -f docker-compose.qq.yml down
```

NapCat 登录数据在 `deploy/qq/napcat/`，AstrBot 数据在 `deploy/qq/astrbot-data/`，QQ 长期记忆在 `data/qq-memory.sqlite`，动态图库和手动文字别名在 `data/longtu-library/` 与 `data/longtu-library.sqlite`。第一次更新会自动迁移旧的 `data/qq-conversation-memory.json`，运行数据均已加入 `.gitignore`。

### NapCat 临时视频每日清理

腾讯云临时目录为 `/opt/qqbot/ntqq/NapCat/temp`。独立 systemd timer 在北京时间
每天 09:00 清理当天 00:00 之前的文件；昨天及更早的遗留文件都会处理。
当日新增或修改、正在被进程打开的文件保留，不跟随符号链接，也不删除目录。
任务不涉及 QQ 登录态、聊天数据库、`nt_data/Video` 或 Provider 缓存。

在服务器项目目录安装并启用：

```bash
sudo install -m 0755 scripts/cleanup-napcat-temp.py /usr/local/sbin/longtu-napcat-temp-cleanup.py
sudo install -m 0644 services/systemd/longtu-napcat-temp-cleanup.service /etc/systemd/system/
sudo install -m 0644 services/systemd/longtu-napcat-temp-cleanup.timer /etc/systemd/system/
sudo /usr/local/sbin/longtu-napcat-temp-cleanup.py --dry-run
sudo systemctl daemon-reload
sudo systemctl enable --now longtu-napcat-temp-cleanup.timer
```

预览命令只统计待清理数量，不删除文件。服务器关机错过执行时会补跑一次，
以补跑当天的 00:00 为界。查看下次执行时间、历史结果和暂停任务：

```bash
systemctl list-timers --all longtu-napcat-temp-cleanup.timer
sudo journalctl -u longtu-napcat-temp-cleanup.service --no-pager -n 20
sudo systemctl disable --now longtu-napcat-temp-cleanup.timer
```

修改时间使用 `sudo systemctl edit longtu-napcat-temp-cleanup.timer`，填写：

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 09:00:00 Asia/Shanghai
```

保存后执行 `sudo systemctl daemon-reload` 和
`sudo systemctl restart longtu-napcat-temp-cleanup.timer`。
手动执行 `sudo systemctl start longtu-napcat-temp-cleanup.service` 会立即按相同规则删除旧文件。

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

- 先明确 `@机器人` 测试主链路；主动回复还需要 `LLM_API_KEY`、`LONGTU_QQ_ACTIVE_REPLY_ENABLED=true`。只有 `may` 类可选插话受候选概率、群聊热度、无人接话退场、冷却和每小时上限影响。
- 检查 `LONGTU_QQ_ALLOWED_GROUPS` 是否包含当前群号。
- 确认 AstrBot 控制台已经收到该群的消息事件。

### Apple Silicon 启动 NapCat 很慢

NapCat 容器需要模拟 amd64，首次启动较慢是正常现象。若 Docker Desktop 未启用 Rosetta，可在 Docker Desktop 设置中开启相关选项后重试。
## QQ 分享解析：B 站、小红书、抖音

Bridge 会主动处理支持平台的分享卡片和 HTTP/HTTPS 分享文本，不要求额外 `@` 机器人。小红书支持 `xhslink.com`、`xhslink.cn` 短链和 `xiaohongshu.com` 笔记链接，直接粘贴链接即可触发。它保留 OneBot 原始 `json/xml` 卡片中的跳转地址，也支持从引用卡片中回捞地址。Node 根据平台使用 provider、公开页面解析或 `yt-dlp`，不是把任意外链都当成视频。

正常视频输出为“独立简介卡片 + 视频”；卡片包含源平台作者的圆形头像、昵称、原生 logo、标题、封面、正文/标签，B 站还显示发布时间。图文则为“独立简介卡片 + 只含图片的合并聊天记录”，多图卡片最多展示九张预览，超出用 `+N` 表示。卡片失败继续视频，不单独补发标题。

B 站多 P 分享按链接中的 `p=2`（普通视频页）或 `page=2`（播放器页）抓取对应分 P，短链也保留跳转后的分 P。未指定时默认 P1。多 P 卡片标题带 P 数和分 P 名称，时长与大小取所选视频；缓存区分各 P，同一个 P 仍可跨群复用。分 P 无效或无法确认时明确提示，不用 P1 顶替。

解析开始时，NapCat 的 `set_msg_emoji_like` 给原分享挂一个原生表情回应。视频首次发送拿到有效 OneBot `message_id` 回执后才回应成功表情（`QQ_MEDIA_SUCCESS_EMOJI_ID`，默认 `478`）；复用视频时以 NapCat 原生转发的成功回执为准。失败用 `QQ_MEDIA_FAILURE_EMOJI_ID`（默认 `479`）。视频发送失败还会尝试发送引用提示；普通解析失败的部分分支只有失败表情。结果表情与解析开关同范围，适用于群聊和私聊，按有效配置排除的分享保持静默。

同一分享的解析结果与进行中的解析任务跨群共用。群聊视频发送也共用首次上传：各群先发自己的分享卡，同一视频只发起一次普通视频上传，其他群等首次成功后调用 `forward_group_single_msg` 复用 QQ 已有的视频，输出仍是单独的视频消息。该发送缓存保留 10 分钟，最多 256 条，按机器人账号隔离；B 站按 CID 与画质区分，避免不同分 P 串视频，小红书和抖音按解析出的完整视频地址区分。不同短链若还未解析到相同媒体标识，仍可能分别解析。私聊沿用独立发送。插件重启会清空发送缓存。

原生复用明确被拒绝（例如源消息已撤回或接口不支持）才回退正常发送；超时或断线时不重复提交，防止视频重复发出。日志中的 `媒体解析缓存命中` / `媒体解析共用任务` 表示解析复用，`视频发送共用任务` 表示等待首次上传，`视频发送缓存命中` 与 `delivery=native-forward` 表示实际复用了 QQ 视频。发送等待仍有 8 分钟上限，缓存不保证 QQ 接口零延迟送达。

B 站、抖音常用 Node 临时媒体地址代理；小红书常用探测大小后的 provider 直链，交给 NapCat 拉取。Node 代理可以后台预下载，文件就绪时提供本地文件，否则流式转发，**不要求每次先完整下载再返回**。视频不经过 JSON/Base64 接口。`QQ_MEDIA_USAGE_DATABASE_FILE` 记录平台、解析成功/失败、耗时和相关字节数，与 LLM Token 日报分开，也不代表 QQ 最终送达。逐层解释见[QQ 架构指南](node-service-architecture-and-learning-guide.md#5-分享解析卡片和真正的视频发送)。

前置条件：

- NapCat/OneBot v11 必须保留 `json/xml` 原始段；若适配器已把卡片丢弃，Node 无法从 `appid/path` 推导视频地址。
- `qq-bot` 容器安装 `yt-dlp`；需要合并 HLS/DASH 时同时安装 `ffmpeg`。小红书登录内容还需要合法的浏览器 cookies，公开短链不保证永久可用。
- NapCat 必须能通过 Compose 网络访问 `QQ_MEDIA_PUBLIC_BASE_URL`（默认 `http://qq-bot:8787`），直链路线还需能访问平台 CDN。Node 和 NapCat 都可能留下临时视频，两个目录分别清理，见上方每日清理说明。
- 仅处理用户有权访问的公开内容；程序拒绝 `file://`、回环和私网地址。不要尝试绕过 DRM、登录限制或平台风控。

启用配置：

```dotenv
QQ_MEDIA_EXTRACT_ENABLED=true
QQ_MEDIA_YTDLP_COMMAND=yt-dlp
QQ_MEDIA_RESOLVE_TIMEOUT_SECONDS=20
QQ_MEDIA_DOWNLOAD_TIMEOUT_SECONDS=120
QQ_MEDIA_RESOLVE_CACHE_TTL_SECONDS=600
QQ_MEDIA_CACHE_DIRECTORY=/tmp/longtu-media-cache
QQ_MEDIA_CACHE_MAX_MIB=512
QQ_MEDIA_MAX_CONCURRENT=2
QQ_MEDIA_PUBLIC_BASE_URL=http://qq-bot:8787
QQ_MEDIA_ACK_EMOJI_ID=128524
QQ_MEDIA_EXCLUDED_GROUPS=
QQ_MEDIA_GROUP_ALLOWED_PROVIDERS=
QQ_MEDIA_USAGE_DATABASE_FILE=data/qq-media-usage.sqlite
```

单视频上限为 500 MiB（提示写作 500MB）。解析到可靠的文件大小或通过探测取得大小后，先判断再完整下载；未知大小的下载路径按累计字节等方式兜底，不能由播放时长推算大小，也不能认为交给 NapCat 的直链都经过 Node 全程计数。图文不走视频大小拦截，视频自身播放时长不作为拒绝条件。

提取阶段的总上限为 480 秒，从解析器取得并发名额后计时，配置的更短 provider/下载超时仍可能先触发。同群排队和后续 QQ 上传不统一包含在这个 deadline 中。Bridge 发送视频另有 480 秒回执等待；等待超时不等于 QQ 上传已取消，因此提示会注明可能仍在发送，不盲目自动重发。已取得的封面、作者、标题会尽量生成卡片，卡片失败不阻断视频或限制提示。

`QQ_MEDIA_EXCLUDED_GROUPS` 使用英文逗号分隔群号。配置后，指定群中的外部分享卡和分享链接会保持静默，不发送原生表情回应，也不会进入视频解析服务；例如 `QQ_MEDIA_EXCLUDED_GROUPS=239375116`。

`QQ_MEDIA_GROUP_ALLOWED_PROVIDERS` 按群限定可解析的平台，格式 `群号:平台|平台,群号:平台`，平台取 `douyin`、`bilibili`、`xiaohongshu`、`kuaishou`。列进来的群只放行列出的平台，其余平台的分享按普通文本处理，既不解析也不挂表情。这条比 `QQ_MEDIA_EXCLUDED_GROUPS` 的整群开关更精确，因此优先生效——群号同时出现在两处时按白名单放行，不需要从排除名单里摘掉。例如 `QQ_MEDIA_GROUP_ALLOWED_PROVIDERS=821259340:douyin,239375116:douyin` 表示这两个群只开放抖音抓取。未列入的群沿用整群开关。插件侧同名配置项为 `media_group_allowed_providers`，两侧必须一致，否则插件放行的分享会被 Node 拦下（表现为挂了解析中的表情却没有结果）。

媒体解析会按平台选择 provider；必要时尝试通用公开分享页面中的 `og:video`、Twitter Player 或 JSON-LD 元数据及 `yt-dlp` 回退。媒体统计可用同一 Bearer Token 查询：`GET /v1/qq/media-usage?start_at=<毫秒时间戳>&end_at=<毫秒时间戳>`。


信息图片也可触发主动短评：默认启用 `QQ_PASSIVE_IMAGE_ENABLED=true`，只筛选本轮第一张原图，不扫描历史图、引用的 Bot 表情包或整份聊天记录。普通图片先用本地 OCR 快速筛选；当群里确实处于多人热聊、连续话题窗口或当前图片带有明确问题时，OCR 不足的图片会再走一次轻量视觉筛选（`QQ_PASSIVE_IMAGE_VISUAL_ENABLED=true`），确认有公开事实、数据、图表、故障现象或其他信息增量后才主动回复，并复用这次视觉结果，不重复识图。普通表情包、重复图、广告和私密图片仍保持静默。候选扫描默认每群 60 秒一次（大型群峰时 120 秒），重复图短期跳过；OCR 或视觉筛选失败时静默保留旁观，不编造短评。需要解读时仍可直接 @ 提问。

普通回复按完整段落和句子拆成最多 4 条连续 QQ 消息，每条保持完整意思，先结论后补充，结束后等待追问；会话记忆仍保存未拆分的完整答案。普通场景只有找到符合语境的龙图才在最后单独发送，找不到时只发文字。明确攻击/纯艾特和管理员显式绑定继续强制附图。

主动图片短评通常 2～3 句、100～220 字，保留主体、关键数字及单位、时间与适用条件，沿用龙玉涛角色语感但只评价事情。互联网内容先识别来源再检索：即使裁剪图没有平台名，也结合评论布局、回复层级、投票按钮、认证标记和昵称格式判断最多两个候选平台。外网截图保留英文原句与公开昵称组合检索。Exa 用 `includeDomains` 优先查候选原平台；候选不确定时追加全网核对，平台内无结果或失败时也放宽范围。不同平台的查询缓存隔离，不能把转载或同平台相似内容当作原帖；最终依据原句、作者和上下文说明核实程度，不平铺搜索过程。平台被裁掉或内容未被索引时不保证找回原帖，私人聊天不上传原文与个人资料检索。
