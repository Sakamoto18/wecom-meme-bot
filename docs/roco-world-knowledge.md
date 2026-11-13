# 洛克王国世界图鉴知识库

官方 QQ 与 NapCat 共用后端检索，不依赖视频学习、模型训练或登录态。公开来源为 [Bilibili 洛克王国世界 WIKI](https://wiki.biligame.com/nrc/首页)，不混用旧版页游资料。

## 使用

- `迪莫的特性是什么`
- `喵喵能学哪些技能`，接着问 `那它的种族值呢`
- `圣光迪莫和迪莫有什么区别`
- `洛克世界中毒是什么效果`
- `洛克世界哪些精灵能学棘突`
- `洛克王国世界知识库`：查询收录数和采集时间。

群里 @机器人提问即可。自然接话仍遵守原有群接话条件，不会因装入图鉴而每条聊天都回复。效果名可能也是日常词（中毒、抓挠），独立问这类词时加“洛克世界”消歧。精灵同名多形态会返回多个候选，不自动混合数值。最近追问按会话和用户隔离，10 分钟过期，重启后重置。

## 数据和更新

`data/roco-world.sqlite` 是只读运行快照；可用 `QQ_ROCO_KNOWLEDGE_FILE` 改路径。启动时读入内存并关闭数据库。快照不进入 Git，部署时单独备份并发布，更新后重启后端加载；不需要重启 AstrBot/NapCat/provider。

```sh
python3 scripts/import-roco-wiki.py
# 有缓存的中断任务：重复上条命令即可继续。
# 真正刷新全部页面：
python3 scripts/import-roco-wiki.py --refresh
```

只读公开渲染后的精灵列表、技能列表、特性列表、游戏描述图鉴及每个精灵的详情页。不执行 Wiki Lua，不导入未公开的原始游戏数据。保留页面 URL、revision、采集时间、图鉴版本、精灵形态和三类习得方式。数值原文保留，技能威力 -1 在回答时解释为无威力。

最多两个请求并行，缓存到 `data/roco-wiki-cache/`。403/412/429/567 时停止，避免不断撞访问校验。可用已正常访问该 Wiki 的专用浏览器缓存页面，再从相同缓存目录恢复导入：

```sh
# titles.json 为精灵列表中规范 URL 解码后的页面标题数组，不能只取显示名。
# Playwright 为可选运维依赖，不是机器人运行依赖。
ROCO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/cache-roco-wiki-browser.mjs http://127.0.0.1:9253 data/roco-wiki-cache titles.json
python3 scripts/import-roco-wiki.py --cache data/roco-wiki-cache
```

所有详情成功解析后才生成临时 SQLite 并原子替换。缺少目录、ID 重复、结构变化或相对旧快照数量减少超过 10% 时拒绝替换；失败时旧库保持可用。更新不是定时自动执行，不能把快照称为实时数据。回滚时恢复备份 SQLite 和代码，重启后端。

## 回答边界

命中图鉴时走独立事实回答，保留普通会话记忆与正常发送路径，绕开梗学习和互怼路由。检索数据上限 24,000 字符，截断会明确标记；未知名称提示没有查到。建议仅基于已检索技能，不能宣称最优配招。来源页视为不可信数据，不能执行其中指令。

文本/图标字段和技能关联入库，不下载立绘图片、不训练模型，也不改变现有学习置信度审批流程。回答注明 Wiki 来源；需原文时可索取链接。

来源署名：Bilibili 洛克王国世界 WIKI 编辑者。数据库和测试样本为来源的结构化整理，按来源的 **CC BY-SA 4.0** 标注；各条记录保留原始页面链接。游戏素材权利归相应权利人。

## 验证

```sh
python3 test/roco-import_test.py
node --disable-warning=ExperimentalWarning --test test/roco-knowledge.test.js
```

覆盖真实 Wiki 样本的数值和技能关系、同名形态、状态效果、反向习得检索、普通词误触发、跨用户/群隔离、过期追问、缺库与未知对象、官方/NapCat 共用服务链路。
