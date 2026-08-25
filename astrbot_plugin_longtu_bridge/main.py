import asyncio
import contextlib
from datetime import datetime, time as datetime_time, timedelta
import os
import re
import time
from zoneinfo import ZoneInfo

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
import astrbot.api.message_components as Comp
from astrbot.api.star import Context, Star, register


MAX_FORWARD_NODES = 30
MAX_FORWARD_CHARACTERS = 8000
MAX_FORWARD_NODE_CHARACTERS = 600
MAX_FORWARD_DEPTH = 2
FORWARD_CACHE_TTL_SECONDS = 60 * 60
FORWARD_CACHE_MAX_ENTRIES = 128
REPORT_TIMEZONE = ZoneInfo("Asia/Shanghai")
ALLOWED_BRIDGE_SLASH_COMMANDS = {
    "/add", "/tag", "/del", "/stop", "/usage-report",
}
PURE_BOT_MENTION_TEXT = "（用户仅 @ 了你，没有附加文字）"


@register(
    "astrbot_plugin_longtu_bridge",
    "Sakamoto18",
    "把 AstrBot 的 QQ 消息转发给本项目的独立 QQ Bot 服务",
    "1.9.2",
)
class LongtuQqBridge(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.session: aiohttp.ClientSession | None = None
        self.forward_cache: dict[str, tuple[float, str]] = {}
        self.report_task: asyncio.Task | None = None
        self.report_stop = asyncio.Event()

    async def initialize(self):
        timeout_seconds = max(
            10,
            int(self.config.get("request_timeout_seconds", 190)),
        )
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout_seconds),
        )
        if self._daily_report_enabled():
            self.report_task = asyncio.create_task(
                self._daily_usage_report_loop(),
                name="longtu-daily-usage-report",
            )

    def _api_url(self) -> str:
        return (
            os.getenv("LONGTU_QQ_API_URL")
            or self.config.get("api_url")
            or "http://qq-bot:8787/v1/qq/message"
        ).strip()

    def _api_token(self) -> str:
        return (
            os.getenv("LONGTU_QQ_API_TOKEN")
            or self.config.get("api_token")
            or ""
        ).strip()

    def _usage_api_url(self) -> str:
        api_url = self._api_url().rstrip("/")
        if api_url.endswith("/v1/qq/message"):
            return api_url.removesuffix("/v1/qq/message") + "/v1/qq/usage"
        return api_url + "/v1/qq/usage"

    def _daily_report_enabled(self) -> bool:
        return self._enabled(self.config.get("daily_usage_report_enabled", True), True)

    def _daily_report_time(self) -> datetime_time:
        hour = min(23, max(0, int(self.config.get("daily_usage_report_hour", 9))))
        minute = min(59, max(0, int(self.config.get("daily_usage_report_minute", 0))))
        return datetime_time(hour=hour, minute=minute, tzinfo=REPORT_TIMEZONE)

    def _qq_platform(self):
        platform_manager = getattr(self.context, "platform_manager", None)
        for platform in getattr(platform_manager, "platform_insts", []):
            try:
                if platform.meta().name == "aiocqhttp":
                    return platform
            except Exception:
                continue
        return None

    async def _fetch_usage_report(self, start_at: int, end_at: int) -> dict:
        if not self.session or self.session.closed:
            raise RuntimeError("HTTP 客户端尚未初始化")
        token = self._api_token()
        if not token:
            raise RuntimeError("插件缺少 api_token / LONGTU_QQ_API_TOKEN")
        async with self.session.get(
            self._usage_api_url(),
            params={"start_at": start_at, "end_at": end_at, "limit": 100},
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if response.status != 200:
                detail = (await response.text())[:300]
                raise RuntimeError(
                    f"QQ Bot 用量 API 返回 HTTP {response.status}: {detail}",
                )
            body = await response.json(content_type=None)
            if not body.get("ok") or not isinstance(body.get("report"), dict):
                raise RuntimeError("QQ Bot 用量 API 返回格式无效")
            return body

    async def _group_catalog(self) -> dict[str, str]:
        platform = self._qq_platform()
        bot = getattr(platform, "bot", None)
        if not bot:
            return {}
        try:
            groups = await asyncio.wait_for(
                bot.get_group_list(no_cache=False),
                timeout=15,
            )
        except Exception as error:
            logger.warning(f"用量日报无法读取 QQ 群列表：{error}")
            return {}
        allowed_groups = self._allowed_groups()
        catalog = {}
        for group in groups or []:
            group_id = str((group or {}).get("group_id") or "").strip()
            if not group_id or (allowed_groups and group_id not in allowed_groups):
                continue
            catalog[group_id] = str((group or {}).get("group_name") or "").strip()
        return catalog

    async def _group_names(self, group_ids: list[str]) -> dict[str, str]:
        platform = self._qq_platform()
        bot = getattr(platform, "bot", None)
        if not bot:
            return {}
        names = {}
        for group_id in group_ids[:20]:
            if not str(group_id).isdigit():
                continue
            try:
                info = await asyncio.wait_for(
                    bot.get_group_info(group_id=int(group_id), no_cache=False),
                    timeout=8,
                )
                name = str((info or {}).get("group_name") or "").strip()
                if name:
                    names[str(group_id)] = name
            except Exception:
                continue
        return names

    @staticmethod
    def _number(value) -> str:
        return f"{max(0, int(value or 0)):,}"

    @staticmethod
    def _money(value) -> str:
        amount = max(0.0, float(value or 0))
        if amount >= 1:
            return f"¥{amount:,.2f}"
        if amount >= 0.01:
            return f"¥{amount:,.4f}"
        return f"¥{amount:,.6f}"

    async def _format_usage_report(
        self,
        body: dict,
        report_date,
        header_suffix: str = "",
    ) -> str:
        report = body["report"]
        totals = report.get("totals") or {}
        groups = report.get("groups") or []
        sources = report.get("sources") or []
        pricing = report.get("pricing") or {}
        catalog = await self._group_catalog()
        group_ids = [str(group.get("groupId") or "") for group in groups]
        missing_name_ids = [group_id for group_id in group_ids if group_id not in catalog]
        names = {
            **catalog,
            **(await self._group_names(missing_name_ids)),
        }
        total_tokens = max(0, int(totals.get("totalTokens") or 0))
        input_tokens = max(0, int(totals.get("inputTokens") or 0))
        cached_input_tokens = max(0, int(totals.get("cachedInputTokens") or 0))
        cache_rate = (
            cached_input_tokens / input_tokens * 100 if input_tokens else 0
        )
        total_cost = float(pricing.get("estimatedCostCny") or 0)
        primary_reply_calls = int(totals.get("primaryReplyCalls") or 0)
        secondary_review_calls = int(totals.get("secondaryReviewCalls") or 0)
        review_rate = (
            secondary_review_calls / primary_reply_calls * 100
            if primary_reply_calls else 0
        )
        lines = [
            f"【龙玉涛 Bot 用量日报｜{report_date:%Y-%m-%d}{header_suffix}】",
            (
                f"群消息 {self._number(totals.get('requests'))} 条；"
                f"LLM {self._number(totals.get('llmCalls'))} 次，"
                f"Token {self._number(total_tokens)} "
                f"（输入 {self._number(totals.get('inputTokens'))} / "
                f"输出 {self._number(totals.get('outputTokens'))}）；"
                f"联网搜索 {self._number(totals.get('searchCalls'))} 次。"
            ),
            (
                f"LLM 输入缓存命中 {self._number(cached_input_tokens)} token"
                f"（{cache_rate:.1f}%）；折算配额用量 "
                f"{self._number(totals.get('quotaTokens'))} token。"
            ),
            (
                f"无感节流：首次回复 {self._number(primary_reply_calls)} 次，"
                f"二次风格复核 {self._number(secondary_review_calls)} 次"
                f"（放大率 {review_rate:.1f}%）；已跳过 "
                f"{self._number(totals.get('skippedSecondaryReviews'))} 次，"
                f"估算少用 {self._number(totals.get('estimatedSavedTokens'))} token / "
                f"{self._money(totals.get('estimatedSavedCostCny'))}。"
            ),
        ]
        if pricing.get("provider") == "deepseek":
            models = "、".join(str(model) for model in pricing.get("models") or [])
            model_label = models or "DeepSeek"
            lines.append(
                f"DeepSeek 费用估算（{model_label}）：{self._money(total_cost)}；"
                f"缓存命中输入 {self._money(pricing.get('cachedInputCostCny'))}，"
                f"未命中输入 {self._money(pricing.get('uncachedInputCostCny'))}，"
                f"输出 {self._money(pricing.get('outputCostCny'))}；"
                f"高峰 {self._money(pricing.get('peakCostCny'))} / "
                f"空闲 {self._money(pricing.get('offPeakCostCny'))}。",
            )
            lines.append(
                f"计费口径：按 DeepSeek 官网 {pricing.get('checkedAt') or ''} "
                f"分时单价逐次计算（{pricing.get('peakPeriods') or '北京时间'}）；"
                "金额为人民币估算，不含 Exa 联网搜索费用。",
            )
            if int(pricing.get("unpricedCalls") or 0) > 0:
                lines.append(
                    f"费用提醒：另有 {self._number(pricing.get('unpricedCalls'))} 次调用"
                    f"（{self._number(pricing.get('unpricedTokens'))} token）"
                    "未匹配已知 DeepSeek 型号，未计入上述金额。",
                )
        data_available_from = int(report.get("dataAvailableFrom") or 0)
        report_start = int(report.get("startAt") or 0)
        if data_available_from and report_start and data_available_from > report_start:
            available_at = datetime.fromtimestamp(
                data_available_from / 1000,
                tz=REPORT_TIMEZONE,
            )
            lines.append(
                f"统计说明：用量数据库从 {available_at:%Y-%m-%d %H:%M} 开始记录；"
                "更早的消息与 Token 无法补录，本期不是完整自然日。",
            )
        blocked = int(totals.get("blockedLlmCalls") or 0)
        normal_limit = report.get("groupLlmLimitPerHour")
        large_limit = report.get("largeGroupLlmLimitPerHour")
        normal_token_limit = report.get("groupLlmTokenLimitPerDay")
        large_token_limit = report.get("largeGroupLlmTokenLimitPerDay")
        normal_search_limit = report.get("groupSearchLimitPerDay")
        large_search_limit = report.get("largeGroupSearchLimitPerDay")
        if normal_limit or large_limit or normal_token_limit or large_token_limit:
            adaptive_note = ""
            if report.get("adaptiveLimitsEnabled"):
                percentages = report.get("activityLimitPercentages") or []
                adaptive_note = (
                    f"；近 {self._number(report.get('activityLookbackDays'))} 日"
                    f"活跃分档按硬上限的 "
                    f"{'/'.join(str(value) + '%' for value in percentages)} 执行"
                )
            lines.append(
                "群级硬上限：普通/大型群每小时 "
                f"{normal_limit or '不限'}/{large_limit or '不限'} 次调用，"
                "每日折算 Token "
                f"{self._number(normal_token_limit) if normal_token_limit else '不限'}/"
                f"{self._number(large_token_limit) if large_token_limit else '不限'}；"
                "每日搜索 "
                f"{self._number(normal_search_limit) if normal_search_limit else '不限'}/"
                f"{self._number(large_search_limit) if large_search_limit else '不限'}"
                f"{adaptive_note}；"
                f"统计期拦截 LLM {blocked} 次、搜索 "
                f"{self._number(totals.get('blockedSearchCalls'))} 次。",
            )

        if groups:
            lines.append("群用量排行：")
            for index, group in enumerate(groups[:10], 1):
                group_id = str(group.get("groupId") or "未知")
                label = names.get(group_id)
                display = f"{label}（{group_id}）" if label else group_id
                tokens = int(group.get("totalTokens") or 0)
                share = (tokens / total_tokens * 100) if total_tokens else 0
                group_cost = float(group.get("estimatedCostCny") or 0)
                cost_share = (group_cost / total_cost * 100) if total_cost else 0
                search_calls = int(group.get("searchCalls") or 0)
                search_hits = int(group.get("searchCacheHits") or 0)
                search_total = search_calls + search_hits
                search_hit_rate = search_hits / search_total * 100 if search_total else 0
                activity_labels = {
                    "quiet": "低活跃",
                    "light": "轻活跃",
                    "normal": "常规",
                    "active": "活跃",
                    "hot": "高活跃",
                    "fixed": "固定",
                }
                activity_tier = str(group.get("activityTier") or "fixed")
                activity = activity_labels.get(activity_tier, activity_tier)
                activity_days = self._number(group.get("activityLookbackDays"))
                activity_messages = float(group.get("activityMessagesPerDay") or 0)
                activity_users = float(group.get("activityUsersPerDay") or 0)
                quota_limit = group.get("llmTokenLimitPerDay")
                quota_status = (
                    f"{self._number(group.get('quotaTokens'))}/"
                    f"{self._number(quota_limit)}"
                    if quota_limit else f"{self._number(group.get('quotaTokens'))}/不限"
                )
                lines.append(
                    f"{index}. {display}：约 {self._money(group_cost)}"
                    f"（费用 {cost_share:.1f}%），{self._number(tokens)} token"
                    f"（Token {share:.1f}%），LLM {self._number(group.get('llmCalls'))} 次，"
                    f"搜索 {self._number(search_calls)} 次"
                    f"/缓存命中 {search_hit_rate:.0f}%，"
                    f"消息 {self._number(group.get('requests'))} 条；"
                    f"近 {activity_days} 日{activity} "
                    f"({activity_messages:.1f} 条/{activity_users:.1f} 人/日，"
                    f"系数 {self._number(group.get('activityLimitPercent'))}%)，"
                    f"折算配额 {quota_status}",
                )
                group_primary_calls = int(group.get("primaryReplyCalls") or 0)
                group_review_calls = int(group.get("secondaryReviewCalls") or 0)
                group_skipped_reviews = int(group.get("skippedSecondaryReviews") or 0)
                if group_review_calls or group_skipped_reviews:
                    group_review_rate = (
                        group_review_calls / group_primary_calls * 100
                        if group_primary_calls else 0
                    )
                    lines.append(
                        f"   复核 {self._number(group_review_calls)}/"
                        f"{self._number(group_primary_calls)}"
                        f"（{group_review_rate:.1f}%），节流跳过 "
                        f"{self._number(group_skipped_reviews)} 次，约省 "
                        f"{self._number(group.get('estimatedSavedTokens'))} token / "
                        f"{self._money(group.get('estimatedSavedCostCny'))}。",
                    )
            top_cost = float(groups[0].get("estimatedCostCny") or 0)
            top_tokens = int(groups[0].get("totalTokens") or 0)
            top_share = (
                top_cost / total_cost * 100
                if total_cost else (
                    top_tokens / total_tokens * 100 if total_tokens else 0
                )
            )
            if top_share >= 50:
                lines.append(
                    f"提醒：第一名群占统计期 DeepSeek 费用的 "
                    f"{top_share:.1f}%，用量较集中。",
                )
        else:
            lines.append("昨日没有记录到群聊上游调用。")

        if catalog:
            tracked_ids = {
                str(group.get("groupId") or "").strip()
                for group in groups
                if str(group.get("groupId") or "").strip() in catalog
            }
            inactive_ids = sorted(set(catalog) - tracked_ids)
            lines.append(
                f"覆盖检查：机器人当前可用 {len(catalog)} 个群；"
                f"本期有消息 {len(tracked_ids)} 个、零消息 {len(inactive_ids)} 个。",
            )
            if inactive_ids:
                inactive_labels = []
                for group_id in inactive_ids[:10]:
                    group_name = catalog.get(group_id)
                    inactive_labels.append(
                        f"{group_name}（{group_id}）" if group_name else group_id,
                    )
                suffix = "等" if len(inactive_ids) > len(inactive_labels) else ""
                lines.append(f"本期零消息群：{'、'.join(inactive_labels)}{suffix}。")

        active_sources = [source for source in sources if source.get("llmCalls")]
        if active_sources:
            labels = {
                "active-reply-decision": "主动回复判定",
                "active-value-gate": "主动回复复核",
                "active-reply": "主动回复生成",
                "attack-reply": "对线回复生成",
                "attack-reply-retry": "对线回复重试",
                "conversation-reply": "普通回复生成",
                "conversation-reply-review": "普通回复复核",
                "conversation-summary": "会话摘要",
                "member-memory-summary": "成员画像摘要",
                "peer-bot-gate": "Bot 续聊判定",
                "pure-mention-reply": "纯艾特回复",
            }
            summary = "；".join(
                f"{labels.get(str(item.get('source')), item.get('source'))} "
                f"{self._number(item.get('llmCalls'))} 次/"
                f"{self._number(item.get('totalTokens'))} token"
                for item in active_sources[:6]
            )
            lines.append(f"主要消耗环节：{summary}。")
        return "\n".join(lines)

    async def _send_daily_usage_report(
        self,
        report_date,
        *,
        end_at: datetime | None = None,
        requested_by: str = "",
    ) -> int:
        start = datetime.combine(
            report_date,
            datetime_time.min,
            tzinfo=REPORT_TIMEZONE,
        )
        end = end_at or (start + timedelta(days=1))
        body = await self._fetch_usage_report(
            int(start.timestamp() * 1000),
            int(end.timestamp() * 1000),
        )
        admins = {
            str(user_id).strip()
            for user_id in body.get("admin_user_ids", [])
            if str(user_id).strip().isdigit()
        }
        normalized_requester = str(requested_by or "").strip()
        if normalized_requester and normalized_requester not in admins:
            raise PermissionError("只有 LONGTU_QQ_ADMIN_USERS 中的超管可以测试日报")
        recipients = [
            str(user_id).strip()
            for user_id in body.get("report_user_ids", [])
            if str(user_id).strip().isdigit()
        ]
        if not recipients:
            logger.warning("每日用量日报未发送：LONGTU_QQ_USAGE_REPORT_USERS 为空")
            return 0
        platform = self._qq_platform()
        if not platform:
            raise RuntimeError("未找到已启用的 aiocqhttp 平台")
        header_suffix = ""
        if end_at:
            header_suffix = f"｜截至 {end_at.astimezone(REPORT_TIMEZONE):%H:%M}"
        report_text = await self._format_usage_report(
            body,
            report_date,
            header_suffix,
        )
        platform_id = platform.meta().id
        for recipient_id in recipients:
            sent = await self.context.send_message(
                f"{platform_id}:FriendMessage:{recipient_id}",
                MessageChain(chain=[Comp.Plain(report_text)]),
            )
            if not sent:
                logger.warning(f"每日用量日报发送失败：{recipient_id}")
        logger.info(f"每日用量日报已推送给 {len(recipients)} 个收件账号")
        return len(recipients)

    async def _send_current_usage_report(self, requested_by: str) -> int:
        now = datetime.now(REPORT_TIMEZONE)
        return await self._send_daily_usage_report(
            now.date(),
            end_at=now + timedelta(milliseconds=1),
            requested_by=requested_by,
        )

    async def _daily_usage_report_loop(self) -> None:
        while not self.report_stop.is_set():
            now = datetime.now(REPORT_TIMEZONE)
            target = datetime.combine(now.date(), self._daily_report_time())
            if target <= now:
                target += timedelta(days=1)
            try:
                await asyncio.wait_for(
                    self.report_stop.wait(),
                    timeout=max(1, (target - now).total_seconds()),
                )
                return
            except asyncio.TimeoutError:
                pass
            try:
                await self._send_daily_usage_report(target.date() - timedelta(days=1))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error(f"每日用量日报生成或发送失败：{error}")

    def _allowed_groups(self) -> set[str]:
        configured = (
            os.getenv("LONGTU_QQ_ALLOWED_GROUPS")
            or self.config.get("allowed_groups")
            or ""
        )
        return {
            group_id.strip()
            for group_id in str(configured).split(",")
            if group_id.strip()
        }

    @staticmethod
    def _enabled(value, default: bool = False) -> bool:
        if value is None or str(value).strip() == "":
            return default
        return str(value).strip().lower() not in {"0", "false", "off", "no"}

    def _group_is_allowed(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat():
            return True
        allowed_groups = self._allowed_groups()
        return not allowed_groups or event.get_group_id() in allowed_groups

    @staticmethod
    def _is_explicitly_at_bot(event: AstrMessageEvent) -> bool:
        bot_user_id = str(event.get_self_id() or "").strip()
        if not bot_user_id:
            return False
        return any(
            isinstance(component, Comp.At)
            and str(getattr(component, "qq", "") or "").strip() == bot_user_id
            for component in event.get_messages()
        )

    @staticmethod
    def _raw_text(event: AstrMessageEvent) -> str:
        """读取 WakingCheck 修改前的原始文字，避免斜杠唤醒词被剥掉。"""
        raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
        if isinstance(raw_message, dict):
            segments = raw_message.get("message")
            if isinstance(segments, list):
                text_parts = []
                for segment in segments:
                    if not isinstance(segment, dict) or segment.get("type") != "text":
                        continue
                    data = segment.get("data")
                    if isinstance(data, dict):
                        text_parts.append(str(data.get("text") or ""))
                segment_text = "".join(text_parts).strip()
                if segment_text:
                    return segment_text
            raw_text = raw_message.get("raw_message")
            if isinstance(raw_text, str) and raw_text.strip():
                return re.sub(r"\[CQ:[^\]]+\]", "", raw_text).strip()
        return ""

    @staticmethod
    def _plain_component_text(components: list) -> str:
        """只读取用户实际输入的 Plain 文本，不把 At 的显示昵称算作正文。"""
        return "".join(
            str(getattr(component, "text", "") or "")
            for component in components
            if isinstance(component, Comp.Plain)
        ).strip()

    @classmethod
    def _is_pure_bot_mention(cls, event: AstrMessageEvent) -> bool:
        """只认 OneBot 组件中的纯 At，避免把昵称渲染文字当成正文。"""
        components = event.get_messages()
        reply_component = cls._reply_component(components)
        quoted_chain = getattr(reply_component, "chain", None) or []
        has_image = any(isinstance(component, Comp.Image) for component in components)
        has_forward = bool(
            cls._forward_components(components)
            or cls._forward_components(quoted_chain)
        )
        return bool(
            not str(cls._raw_text(event) or "").strip()
            and not cls._plain_component_text(components)
            and not has_image
            and not has_forward
            and reply_component is None
            and cls._is_explicitly_at_bot(event)
        )

    @classmethod
    def _is_slash_command(cls, event: AstrMessageEvent) -> bool:
        raw_text = cls._raw_text(event)
        return (raw_text or event.message_str or "").lstrip().startswith("/")

    @classmethod
    def _is_allowed_bridge_slash_command(cls, event: AstrMessageEvent) -> bool:
        raw_text = (cls._raw_text(event) or event.message_str or "").strip()
        matched = re.match(r"^/([a-z][a-z0-9_-]*)\b", raw_text, re.IGNORECASE)
        return bool(matched and f"/{matched.group(1).lower()}" in ALLOWED_BRIDGE_SLASH_COMMANDS)

    @classmethod
    def _is_usage_report_command(cls, event: AstrMessageEvent) -> bool:
        raw_text = (cls._raw_text(event) or event.message_str or "").strip()
        return bool(re.match(r"^/usage-report\s*$", raw_text, re.IGNORECASE))

    def _ignore_slash_commands(self) -> bool:
        configured = (
            os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS")
            if os.getenv("LONGTU_QQ_IGNORE_SLASH_COMMANDS") is not None
            else self.config.get("ignore_slash_commands", True)
        )
        return self._enabled(configured, True)

    def _should_reply(self, event: AstrMessageEvent) -> bool:
        # 斜杠命令是 Bridge 的硬白名单，不受旧配置开关影响：图库管理命令
        # 与超管 /stop 可以继续进入本项目，其余命令必须在这里停止。
        if self._is_slash_command(event):
            return self._is_allowed_bridge_slash_command(event)
        if event.is_private_chat():
            return True
        if not self._group_is_allowed(event):
            return False
        normalized_text = event.message_str.strip().lower()
        ignored_commands = (
            os.getenv("LONGTU_QQ_IGNORED_WAKE_COMMANDS")
            or self.config.get("ignored_wake_commands")
            or "/w"
        )
        ignored = {
            command.strip().lower()
            for command in str(ignored_commands).split(",")
            if command.strip()
        }
        if normalized_text in ignored:
            return False
        reply_only_when_at = self._enabled(
            os.getenv("LONGTU_QQ_REPLY_ONLY_WHEN_AT")
            if os.getenv("LONGTU_QQ_REPLY_ONLY_WHEN_AT") is not None
            else self.config.get("reply_only_when_at", True),
            True,
        )
        if reply_only_when_at:
            return self._is_explicitly_at_bot(event)
        reply_only_when_waked = bool(
            self.config.get("reply_only_when_waked", True),
        )
        return not reply_only_when_waked or event.is_at_or_wake_command

    def _should_observe(self, event: AstrMessageEvent) -> bool:
        if event.is_private_chat() or not self._group_is_allowed(event):
            return False
        if self._is_slash_command(event):
            return False
        configured = os.getenv("LONGTU_QQ_OBSERVE_GROUP_MESSAGES")
        if configured is None:
            configured = self.config.get("observe_group_messages", True)
        return self._enabled(configured, True)

    @classmethod
    def _text_for_backend(
        cls,
        event: AstrMessageEvent,
        text: str,
        *,
        should_reply: bool,
        has_image: bool,
        has_forward: bool,
    ) -> str:
        normalized = str(text or "").strip()
        if normalized or has_image or has_forward or not should_reply:
            return normalized
        if cls._is_explicitly_at_bot(event):
            return PURE_BOT_MENTION_TEXT
        return ""

    @staticmethod
    def _quoted_text(components: list) -> str:
        for component in components:
            if isinstance(component, Comp.Reply):
                return str(getattr(component, "message_str", "") or "").strip()
        return ""

    @staticmethod
    def _mentions(components: list) -> list[dict]:
        mentions = []
        seen = set()
        for component in components:
            if not isinstance(component, Comp.At):
                continue
            user_id = str(getattr(component, "qq", "") or "").strip()
            if not user_id or user_id.lower() == "all" or user_id in seen:
                continue
            seen.add(user_id)
            mentions.append({
                "user_id": user_id,
                "name": str(getattr(component, "name", "") or "").strip(),
            })
        return mentions

    @classmethod
    def _reply_prefix(cls, event: AstrMessageEvent, components: list) -> list:
        """群聊回复引用原消息，并把回复明确送达被艾特的成员。"""
        if event.is_private_chat():
            return []

        prefix = []
        message_id = str(
            getattr(getattr(event, "message_obj", None), "message_id", "") or "",
        ).strip()
        if message_id:
            prefix.append(Comp.Reply(id=message_id))

        bot_user_id = str(event.get_self_id() or "").strip()
        sender_id = str(event.get_sender_id() or "").strip()
        targets = []
        seen = set()
        for component in components:
            if not isinstance(component, Comp.At):
                continue
            user_id = str(getattr(component, "qq", "") or "").strip()
            if (
                not user_id
                or user_id.lower() == "all"
                or user_id in {bot_user_id, sender_id}
                or user_id in seen
            ):
                continue
            seen.add(user_id)
            targets.append((
                user_id,
                str(getattr(component, "name", "") or "").strip(),
            ))

        # 没有第三方目标但发送者明确 @ 了机器人时，把回复送达发送者本人。
        if not targets and cls._is_explicitly_at_bot(event) and sender_id:
            targets.append((sender_id, str(event.get_sender_name() or "").strip()))

        for user_id, name in targets[:3]:
            prefix.append(Comp.At(qq=user_id, name=name))
        if targets:
            prefix.append(Comp.Plain(" "))
        return prefix

    @staticmethod
    def _reply_component(components: list):
        for component in components:
            if isinstance(component, Comp.Reply):
                return component
        return None

    @staticmethod
    def _forward_components(components: list) -> list:
        return [
            component
            for component in components
            if isinstance(component, Comp.Forward)
        ]

    @staticmethod
    def _compact_forward_value(value, limit: int) -> str:
        return " ".join(str(value or "").split()).strip()[:limit]

    @classmethod
    def _format_forward_segments(
        cls,
        segments,
        depth: int,
        budget: dict,
    ) -> str:
        if isinstance(segments, str):
            return cls._compact_forward_value(
                segments,
                MAX_FORWARD_NODE_CHARACTERS,
            )
        if not isinstance(segments, list):
            return ""

        parts = []
        placeholders = {
            "image": "[图片]",
            "mface": "[表情]",
            "face": "[表情]",
            "record": "[语音]",
            "video": "[视频]",
            "file": "[文件]",
            "json": "[卡片消息]",
            "xml": "[卡片消息]",
            "reply": "[引用消息]",
        }
        for segment in segments:
            if isinstance(segment, str):
                text = cls._compact_forward_value(segment, MAX_FORWARD_NODE_CHARACTERS)
                if text:
                    parts.append(text)
                continue
            if not isinstance(segment, dict):
                continue
            segment_type = str(segment.get("type") or "").lower()
            data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
            if segment_type == "text":
                text = cls._compact_forward_value(
                    data.get("text"),
                    MAX_FORWARD_NODE_CHARACTERS,
                )
                if text:
                    parts.append(text)
            elif segment_type == "at":
                name = cls._compact_forward_value(data.get("name"), 40)
                parts.append(f"@{name}" if name else "@某人")
            elif segment_type == "forward":
                nested = data.get("content")
                if depth >= MAX_FORWARD_DEPTH or not isinstance(nested, list):
                    parts.append("[嵌套合并转发]")
                    continue
                nested_text = cls._format_forward_nodes(
                    nested,
                    depth + 1,
                    budget,
                )
                parts.append(
                    f"[嵌套合并转发：{nested_text.replace(chr(10), ' / ')}]"
                    if nested_text
                    else "[嵌套合并转发]"
                )
            elif segment_type in {"node", "nodes"}:
                nested = data.get("content") or data.get("message") or data.get("messages")
                nested_text = cls._format_forward_nodes(
                    nested if isinstance(nested, list) else [],
                    depth + 1,
                    budget,
                )
                if nested_text:
                    parts.append(nested_text.replace("\n", " / "))
            elif segment_type in placeholders:
                parts.append(placeholders[segment_type])
            else:
                summary = cls._compact_forward_value(
                    data.get("summary") or data.get("text"),
                    80,
                )
                if summary:
                    parts.append(summary)

            if sum(len(part) for part in parts) >= MAX_FORWARD_NODE_CHARACTERS:
                break

        return " ".join(parts).strip()[:MAX_FORWARD_NODE_CHARACTERS]

    @classmethod
    def _format_forward_nodes(
        cls,
        nodes,
        depth: int = 0,
        budget: dict | None = None,
    ) -> str:
        if not isinstance(nodes, list) or depth > MAX_FORWARD_DEPTH:
            return ""
        if budget is None:
            budget = {"nodes": 0, "truncated": False}
        lines = []
        for node in nodes:
            if budget["nodes"] >= MAX_FORWARD_NODES:
                budget["truncated"] = True
                break
            if not isinstance(node, dict):
                continue

            budget["nodes"] += 1
            if str(node.get("type") or "").lower() == "node":
                node_data = node.get("data") if isinstance(node.get("data"), dict) else {}
                name = node_data.get("nickname") or node_data.get("name")
                segments = (
                    node_data.get("message")
                    or node_data.get("content")
                    or []
                )
            else:
                sender = node.get("sender") if isinstance(node.get("sender"), dict) else {}
                name = (
                    sender.get("card")
                    or sender.get("nickname")
                    or node.get("nickname")
                    or node.get("name")
                )
                segments = node.get("message") or node.get("content") or []

            display_name = cls._compact_forward_value(name, 40) or "未知成员"
            content = cls._format_forward_segments(segments, depth, budget)
            lines.append(f"{display_name}：{content or '[非文本消息]'}")

        if depth == 0 and budget.get("truncated"):
            lines.append(f"（仅展开前 {MAX_FORWARD_NODES} 条消息）")
        formatted = "\n".join(lines)
        if len(formatted) > MAX_FORWARD_CHARACTERS:
            formatted = formatted[:MAX_FORWARD_CHARACTERS].rstrip()
            formatted += "\n（转发内容过长，已截断）"
        return formatted

    async def _fetch_forward_text(
        self,
        event: AstrMessageEvent,
        forward_id: str,
    ) -> str:
        normalized_id = str(forward_id or "").strip()
        if not normalized_id:
            return ""
        now = time.monotonic()
        cached = self.forward_cache.get(normalized_id)
        if cached and now - cached[0] <= FORWARD_CACHE_TTL_SECONDS:
            return cached[1]

        bot = getattr(event, "bot", None)
        if not bot or not callable(getattr(bot, "call_action", None)):
            logger.warning("当前 QQ 事件没有可用的 OneBot API 客户端，无法展开合并转发")
            return ""
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        try:
            result = await asyncio.wait_for(
                bot.call_action(
                    action="get_forward_msg",
                    message_id=normalized_id,
                    **routing_params,
                ),
                timeout=20,
            )
        except Exception as error:
            logger.warning(f"合并转发内容展开失败：{type(error).__name__}")
            return ""

        nodes = result.get("messages") if isinstance(result, dict) else None
        formatted = self._format_forward_nodes(nodes)
        if not formatted:
            logger.warning("合并转发 API 未返回可解析的消息节点")
            return ""

        self.forward_cache[normalized_id] = (now, formatted)
        if len(self.forward_cache) > FORWARD_CACHE_MAX_ENTRIES:
            oldest_id = min(
                self.forward_cache,
                key=lambda key: self.forward_cache[key][0],
            )
            self.forward_cache.pop(oldest_id, None)
        logger.info(f"已展开合并转发内容，共 {formatted.count(chr(10)) + 1} 行")
        return formatted

    async def _forwarded_text(
        self,
        event: AstrMessageEvent,
        components: list,
    ) -> str:
        texts = []
        seen = set()
        for component in self._forward_components(components):
            forward_id = str(getattr(component, "id", "") or "").strip()
            if not forward_id or forward_id in seen:
                continue
            seen.add(forward_id)
            text = await self._fetch_forward_text(event, forward_id)
            if text:
                texts.append(text)
        return "\n\n".join(texts)[:MAX_FORWARD_CHARACTERS]

    @staticmethod
    def _quoted_author(reply_component) -> tuple[str, str]:
        if not reply_component:
            return "", ""
        user_id = str(
            getattr(reply_component, "sender_id", "")
            or getattr(reply_component, "user_id", "")
            or ""
        ).strip()
        name = str(
            getattr(reply_component, "sender_nickname", "")
            or getattr(reply_component, "sender_name", "")
            or ""
        ).strip()
        return user_id, name

    @staticmethod
    async def _image_base64(image_component) -> str:
        if not image_component:
            return ""
        converted = await image_component.convert_to_base64()
        if isinstance(converted, str):
            return converted.removeprefix("base64://")
        for attribute in ("base64", "file"):
            value = str(getattr(converted, attribute, "") or "")
            if value.startswith("base64://"):
                return value.removeprefix("base64://")
        return ""

    @classmethod
    async def _first_image_base64(cls, components: list) -> str:
        for component in components:
            if isinstance(component, Comp.Image):
                return await cls._image_base64(component)
        return ""

    @classmethod
    async def _quoted_image_base64(cls, reply_component) -> str:
        chain = getattr(reply_component, "chain", None) or []
        return await cls._first_image_base64(chain)

    @staticmethod
    def _is_image_management_text(text: str) -> bool:
        if re.match(r"^/(?:add|tag|del)(?:\s|$)", str(text or "").strip(), re.IGNORECASE):
            return True
        normalized = str(text or "").replace(" ", "")
        library_management = (
            ("龙图" in normalized or "图库" in normalized)
            and any(keyword in normalized for keyword in (
                "添加", "加入", "加进", "加到", "收录", "存入", "保存",
                "删除", "删掉", "移除", "强制",
            ))
        )
        alias_binding = (
            any(reference in normalized for reference in (
                "这张图", "这个图", "这张图片", "图片",
            ))
            and any(keyword in normalized for keyword in (
                "绑定", "关联", "标记", "打标", "标签", "设为", "设置",
                "指定", "固定", "调用", "使用",
            ))
        )
        return library_management or alias_binding

    async def _request_backend(self, payload: dict) -> dict:
        if not self.session or self.session.closed:
            raise RuntimeError("HTTP 客户端尚未初始化")
        token = self._api_token()
        if not token:
            raise RuntimeError("插件缺少 api_token / LONGTU_QQ_API_TOKEN")

        async with self.session.post(
            self._api_url(),
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if response.status != 200:
                detail = (await response.text())[:500]
                raise RuntimeError(
                    f"QQ Bot API 返回 HTTP {response.status}: {detail}",
                )
            body = await response.json(content_type=None)
            if not body.get("ok") or not isinstance(body.get("messages"), list):
                raise RuntimeError("QQ Bot API 返回格式无效")
            return body

    @staticmethod
    def _reply_chain_from_backend(response: dict) -> list:
        reply_chain = []
        for message in response.get("messages", []):
            message_type = message.get("type")
            if message_type == "text" and message.get("text"):
                reply_chain.append(Comp.Plain(str(message["text"])))
            elif message_type == "image" and message.get("base64"):
                reply_chain.append(
                    Comp.Image.fromBase64(str(message["base64"])),
                )
        return reply_chain

    def _pure_mention_payload(self, event: AstrMessageEvent) -> dict:
        components = event.get_messages()
        return {
            "message_id": str(event.message_obj.message_id or ""),
            "message_type": "private" if event.is_private_chat() else "group",
            "group_id": event.get_group_id(),
            "user_id": event.get_sender_id(),
            "sender_name": event.get_sender_name(),
            "text": PURE_BOT_MENTION_TEXT,
            "quoted_text": "",
            "forwarded_text": "",
            "quoted_forwarded_text": "",
            "quoted_user_id": "",
            "quoted_sender_name": "",
            "mentions": self._mentions(components),
            "bot_user_id": str(event.get_self_id() or "").strip(),
            "has_image": False,
            "pure_bot_mention": True,
            "image_base64": "",
            "quoted_image_base64": "",
            "observe_only": False,
        }

    @filter.on_waiting_llm_request(priority=1000)
    async def rescue_pure_mention_before_default_llm(
        self,
        event: AstrMessageEvent,
    ) -> None:
        """纯 At 未进入 Adapter handler 时，在默认 LLM 调用前改走 Node。"""
        if event.get_platform_name() != "aiocqhttp":
            return
        if event.is_private_chat() or not self._group_is_allowed(event):
            return
        if not self._is_pure_bot_mention(event):
            return
        if event.get_extra("longtu_pure_mention_sent", False):
            event.call_llm = True
            event.stop_event()
            return

        event.call_llm = True
        try:
            response = await self._request_backend(
                self._pure_mention_payload(event),
            )
        except Exception as error:
            logger.error(f"纯 At 前置兜底请求失败，保持静默以避免默认客服回复：{error}")
            event.stop_event()
            return

        reply_chain = self._reply_chain_from_backend(response)
        if reply_chain:
            reply_chain = self._reply_prefix(event, event.get_messages()) + reply_chain
            await event.send(MessageChain(chain=reply_chain))
            event.set_extra("longtu_pure_mention_sent", True)
            logger.info(
                "纯 At 未进入 Adapter handler，已在默认 LLM 前改走 Node 人格回复",
            )
        else:
            logger.info("纯 At 前置兜底被 Node 判定为静默")
        event.stop_event()

    @filter.platform_adapter_type(filter.PlatformAdapterType.AIOCQHTTP)
    @filter.event_message_type(filter.EventMessageType.ALL, priority=1000)
    async def on_qq_message(self, event: AstrMessageEvent):
        """回复唤醒消息，并静默观察允许群中的普通消息。"""
        # 这是专用 QQ Bot：任何 AIOCQHTTP 消息都不得继续进入 AstrBot 的
        # 默认 LLM 或其他命令链路。先禁止 ProcessStage 的默认 LLM；不能在
        # yield 回复前 stop_event，否则 AstrBot 4.26 会跳过 RespondStage，纯 At
        # 便会落回默认模型。结果发送完成后再在 finally 中停止后续传播。
        event.call_llm = True

        try:
            if self._is_slash_command(event):
                # AstrBot 的 WakingCheck 会先剥掉 / 唤醒前缀；这里用原始 OneBot
                # 消息识别。仅放行图库管理命令与超管 /stop，其余斜杠命令继续
                # 停止，避免 /w、/help 等内置命令或其他插件被误触发。
                if not self._is_allowed_bridge_slash_command(event):
                    return
                if self._is_usage_report_command(event):
                    try:
                        recipient_count = await self._send_current_usage_report(
                            str(event.get_sender_id() or ""),
                        )
                    except PermissionError:
                        yield event.plain_result("只有超级管理员可以测试用量日报。")
                    except Exception as error:
                        logger.error(f"手动测试用量日报失败：{error}")
                        yield event.plain_result("用量日报测试失败，请检查服务日志。")
                    else:
                        logger.info(
                            f"手动用量日报测试完成：已发送给 "
                            f"{recipient_count} 个收件账号",
                        )
                    return
            should_reply = self._should_reply(event)
            observe_only = not should_reply and self._should_observe(event)
            if not should_reply and not observe_only:
                return

            components = event.get_messages()
            raw_text = self._raw_text(event)
            text = (
                raw_text
                if self._is_allowed_bridge_slash_command(event) and raw_text
                else event.message_str.strip()
            )
            has_image = any(
                isinstance(component, Comp.Image)
                for component in components
            )
            reply_component = self._reply_component(components)
            quoted_chain = getattr(reply_component, "chain", None) or []
            has_forward = bool(
                self._forward_components(components)
                or self._forward_components(quoted_chain)
            )

            # event.message_str 会把 At 组件渲染成“@机器人昵称”，不能用它判断
            # 用户是否附带正文。只检查 OneBot 原始 text 段和 Plain 组件。
            pure_bot_mention = bool(
                should_reply and self._is_pure_bot_mention(event)
            )
            text = (
                PURE_BOT_MENTION_TEXT
                if pure_bot_mention
                else self._text_for_backend(
                    event,
                    text,
                    should_reply=should_reply,
                    has_image=has_image,
                    has_forward=has_forward,
                )
            )
            if not text and not has_image and not has_forward:
                return
            if (
                should_reply
                and bool(self.config.get("send_processing_hint", False))
                and text
            ):
                yield event.plain_result("正在翻龙图小本本……")

            quoted_user_id, quoted_sender_name = self._quoted_author(reply_component)
            forwarded_text = await self._forwarded_text(event, components)
            quoted_forwarded_text = await self._forwarded_text(event, quoted_chain)
            image_base64 = ""
            quoted_image_base64 = ""
            if should_reply and self._is_image_management_text(text):
                try:
                    image_base64 = await self._first_image_base64(components)
                    quoted_image_base64 = await self._quoted_image_base64(
                        reply_component,
                    )
                except Exception as error:
                    logger.warning(f"龙图库管理图片读取失败：{error}")

            bot_user_id = str(event.get_self_id() or "").strip()

            payload = {
                "message_id": str(event.message_obj.message_id or ""),
                "message_type": "private" if event.is_private_chat() else "group",
                "group_id": event.get_group_id(),
                "user_id": event.get_sender_id(),
                "sender_name": event.get_sender_name(),
                "text": text,
                "quoted_text": self._quoted_text(components),
                "forwarded_text": forwarded_text,
                "quoted_forwarded_text": quoted_forwarded_text,
                "quoted_user_id": quoted_user_id,
                "quoted_sender_name": quoted_sender_name,
                "mentions": self._mentions(components),
                "bot_user_id": bot_user_id,
                "has_image": has_image,
                "pure_bot_mention": pure_bot_mention,
                "image_base64": image_base64,
                "quoted_image_base64": quoted_image_base64,
                "observe_only": observe_only,
            }

            try:
                response = await self._request_backend(payload)
            except Exception as error:
                logger.error(f"龙图 QQ Bridge 请求失败：{error}")
                if observe_only:
                    return
                error_message = self.config.get(
                    "error_message",
                    "龙图服务暂时不可用，请稍后再试。",
                )
                yield event.plain_result(str(error_message))
                return

            # 普通群消息原本以 observe_only 进入 Node 服务。Node 现在可能通过
            # “读空气”判定把它升级为主动回复；只有确实没有返回消息时才保持静默。
            if observe_only and not response["messages"]:
                return

            reply_chain = self._reply_chain_from_backend(response)

            # AstrBot only consumes one result from this handler in the normal
            # response pipeline. Keep text and the attached meme in one chain so
            # the image is not dropped after the text response has been sent.
            if reply_chain:
                # 主动插话应该像群友自己发言，不挂在触发它的普通消息下面；明确
                # @、引用和私聊等被动问答仍保留原有引用/送达前缀。
                if not bool(response.get("active_reply")):
                    reply_chain = self._reply_prefix(event, components) + reply_chain
                yield event.chain_result(reply_chain)
        finally:
            event.stop_event()

    async def terminate(self):
        self.report_stop.set()
        if self.report_task:
            self.report_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.report_task
        if self.session and not self.session.closed:
            await self.session.close()
