import asyncio
import base64
import contextlib
import hmac
from datetime import datetime, time as datetime_time, timedelta
import os
import re
import time
from zoneinfo import ZoneInfo

import aiohttp
from aiohttp import web

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
import astrbot.api.message_components as Comp
from astrbot.api.star import Context, Star, register


MAX_FORWARD_NODES = 30
MAX_FORWARD_CHARACTERS = 8000
MAX_FORWARD_NODE_CHARACTERS = 600
MAX_FORWARD_DEPTH = 3
MAX_QUOTED_REPLY_DEPTH = 3
FORWARD_CACHE_TTL_SECONDS = 60 * 60
FORWARD_CACHE_MAX_ENTRIES = 128
GROUP_INFO_CACHE_TTL_SECONDS = 10 * 60
GROUP_INFO_CACHE_MAX_ENTRIES = 512
MAX_IMAGE_COMPONENTS = 12
MAX_FORWARD_IMAGE_BYTES = 32 * 1024 * 1024
RECENT_IMAGE_CACHE_TTL_SECONDS = 10 * 60
RECENT_IMAGE_CACHE_MAX_ENTRIES = 256
RECENT_IMAGE_CACHE_MAX_BASE64_CHARACTERS = 24 * 1024 * 1024 * 4 // 3
RECENT_IMAGE_REFERENCE_PATTERN = re.compile(
    r"(?:上面|刚才|前面|上一张|前一张|这张(?:图|图片)|这个(?:图|图片)|图里|图片里)",
)
REPORT_TIMEZONE = ZoneInfo("Asia/Shanghai")
ALLOWED_BRIDGE_SLASH_COMMANDS = {
    "/add", "/tag", "/del", "/stop", "/usage-report",
}
PURE_BOT_MENTION_TEXT = "（用户仅 @ 了你，没有附加文字）"
MEDIA_SHARE_PATTERN = re.compile(r"https?://[^\s<>\u3000]+", re.IGNORECASE)
MEDIA_ACK_PATTERN = re.compile(
    r"https?://[^\s<>\u3000]*(?:bilibili\.com|b23\.tv|xhslink\.com|xiaohongshu\.com|"
    r"douyin\.com|iesdouyin\.com|kuaishou\.com|gifshow\.com|v\.qq\.com)[^\s<>\u3000]*",
    re.IGNORECASE,
)


@register(
    "astrbot_plugin_longtu_bridge",
    "Sakamoto18",
    "把 AstrBot 的 QQ 消息转发给本项目的独立 QQ Bot 服务",
    "1.9.4",
)
class LongtuQqBridge(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.session: aiohttp.ClientSession | None = None
        self.forward_cache: dict[str, tuple[float, str]] = {}
        self.forward_nodes_cache: dict[str, tuple[float, list]] = {}
        self.group_info_cache: dict[str, tuple[float, dict[str, int]]] = {}
        self.media_status_cache: dict[str, float] = {}
        # 静默观察不调用模型，但保留短时间内最近一批图片，支持用户先发图、
        # 再单独 @ 机器人询问“上面这张图”的常见 QQ 使用方式。
        self.recent_image_cache: dict[str, tuple[float, list[str]]] = {}
        self.report_task: asyncio.Task | None = None
        self.report_stop = asyncio.Event()
        self.internal_send_runner: web.AppRunner | None = None

    async def initialize(self):
        timeout_seconds = max(
            10,
            int(self.config.get("request_timeout_seconds", 190)),
        )
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout_seconds),
        )
        await self._start_internal_send_server()
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

    async def _start_internal_send_server(self):
        app = web.Application(client_max_size=16 * 1024)
        app.router.add_post('/send-video', self._handle_internal_send_video)
        self.internal_send_runner = web.AppRunner(app, access_log=None)
        await self.internal_send_runner.setup()
        site = web.TCPSite(
            self.internal_send_runner, '0.0.0.0',
            int(os.getenv('LONGTU_QQ_INTERNAL_SEND_PORT', '8790')),
        )
        await site.start()
        logger.info('QQ 主动视频发送内网接口已启动')

    async def _handle_internal_send_video(self, request: web.Request):
        expected = self._api_token()
        provided = request.headers.get('Authorization', '').removeprefix('Bearer ').strip()
        if not expected or not hmac.compare_digest(provided, expected):
            return web.json_response({'ok': False, 'error': 'unauthorized'}, status=401)
        try:
            body = await request.json()
            group_id = str(body.get('group_id') or '').strip()
            video_url = str(body.get('video_url') or '').strip()
            if not group_id.isdigit() or not video_url.startswith(('http://', 'https://')):
                raise ValueError('group_id 或 video_url 无效')
            platform = self._qq_platform()
            if not platform:
                raise RuntimeError('QQ 平台未连接')
            session = f'{platform.meta().id}:GroupMessage:{group_id}'
            sent = await self.context.send_message(
                session, MessageChain([Comp.Video(file=video_url)]),
            )
            if not sent:
                raise RuntimeError('未找到 QQ 平台实例')
            return web.json_response({'ok': True})
        except Exception as error:
            logger.error(f'QQ 主动视频发送失败：{error}')
            return web.json_response(
                {'ok': False, 'error': str(error)}, status=400,
            )

    async def _react_media_share(self, event: AstrMessageEvent) -> bool:
        """Use QQ's native message reaction instead of sending a visible message."""
        message_id = str(
            getattr(getattr(event, "message_obj", None), "message_id", "") or "",
        ).strip()
        bot = getattr(event, "bot", None)
        call_action = getattr(bot, "call_action", None)
        if not message_id or not callable(call_action):
            logger.debug("QQ 原生消息回应不可用：缺少 message_id 或 OneBot bot")
            return False
        emoji_id = str(
            os.getenv("QQ_MEDIA_ACK_EMOJI_ID")
            or self.config.get("media_ack_emoji_id")
            or "128524"
        ).strip()
        if not emoji_id:
            return False
        try:
            numeric_message_id = int(message_id)
        except ValueError:
            numeric_message_id = message_id
        await call_action(
            "set_msg_emoji_like",
            message_id=numeric_message_id,
            emoji_id=emoji_id,
            set=True,
        )
        return True

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

    async def _group_info(self, group_id: str) -> dict[str, int]:
        """读取并短暂缓存 QQ 群员上限，供大型群策略使用。"""
        normalized_group_id = str(group_id or "").strip()
        if not normalized_group_id.isdigit():
            return {}
        now = time.monotonic()
        cached = self.group_info_cache.get(normalized_group_id)
        if cached and now - cached[0] < GROUP_INFO_CACHE_TTL_SECONDS:
            return dict(cached[1])

        platform = self._qq_platform()
        bot = getattr(platform, "bot", None) if platform else None
        if not bot:
            return {}
        try:
            info = await asyncio.wait_for(
                bot.get_group_info(
                    group_id=int(normalized_group_id),
                    no_cache=False,
                ),
                timeout=8,
            )
        except Exception as error:
            logger.debug(f"读取 QQ 群 {normalized_group_id} 群员上限失败：{error}")
            return {}

        def _nonnegative_int(value):
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                return None
            return parsed if parsed >= 0 else None

        result = {}
        member_count = _nonnegative_int((info or {}).get("member_count"))
        member_limit = _nonnegative_int((info or {}).get("max_member_count"))
        if member_count is not None:
            result["group_member_count"] = member_count
        if member_limit is not None:
            result["group_member_limit"] = member_limit
        self.group_info_cache[normalized_group_id] = (now, result)
        if len(self.group_info_cache) > GROUP_INFO_CACHE_MAX_ENTRIES:
            oldest_group_id = min(
                self.group_info_cache,
                key=lambda key: self.group_info_cache[key][0],
            )
            self.group_info_cache.pop(oldest_group_id, None)
        return dict(result)

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
        private_usage = report.get("privateUsage") or {}
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
        search_calls = max(0, int(totals.get("searchCalls") or 0))
        search_cache_hits = max(0, int(totals.get("searchCacheHits") or 0))
        search_total = search_calls + search_cache_hits
        search_cache_rate = (
            search_cache_hits / search_total * 100 if search_total else 0
        )
        total_cost = float(pricing.get("estimatedCostCny") or 0)
        lines = [
            f"【龙玉涛 Bot 日报｜{report_date:%Y-%m-%d}{header_suffix}】",
            (
                f"约 {self._money(total_cost)}｜消息 "
                f"{self._number(totals.get('requests'))}｜LLM "
                f"{self._number(totals.get('llmCalls'))} 次｜Token "
                f"{self._number(total_tokens)}"
            ),
            (
                f"LLM 输入缓存 {cache_rate:.1f}% "
                f"（{self._number(cached_input_tokens)}/"
                f"{self._number(input_tokens)}）；搜索 API "
                f"{self._number(search_calls)} 次"
                f"（结果缓存 {search_cache_rate:.1f}%）"
            ),
        ]
        private_cost = float(private_usage.get("estimatedCostCny") or 0)
        private_llm_calls = int(private_usage.get("llmCalls") or 0)
        private_total_tokens = int(private_usage.get("totalTokens") or 0)
        if private_cost or private_llm_calls or private_total_tokens:
            lines.append(
                f"私聊用量：约 {self._money(private_cost)}｜LLM "
                f"{self._number(private_llm_calls)} 次｜Token "
                f"{self._number(private_total_tokens)}",
            )
        skipped_reviews = int(totals.get("skippedSecondaryReviews") or 0)
        if skipped_reviews:
            lines.append(
                f"节流跳过复核 {self._number(skipped_reviews)} 次，约省 "
                f"{self._number(totals.get('estimatedSavedTokens'))} token / "
                f"{self._money(totals.get('estimatedSavedCostCny'))}。",
            )
        if pricing.get("provider") == "deepseek":
            lines.append(
                "费用：未缓存输入 "
                f"{self._money(pricing.get('uncachedInputCostCny'))}｜缓存输入 "
                f"{self._money(pricing.get('cachedInputCostCny'))}｜输出 "
                f"{self._money(pricing.get('outputCostCny'))}（搜索费另计）",
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
        blocked_search = int(totals.get("blockedSearchCalls") or 0)
        if blocked or blocked_search:
            lines.append(
                f"限额拦截：LLM {self._number(blocked)} 次｜搜索 "
                f"{self._number(blocked_search)} 次。",
            )

        if groups:
            lines.append("群排行：")
            for index, group in enumerate(groups[:10], 1):
                group_id = str(group.get("groupId") or "未知")
                label = names.get(group_id)
                display = f"{label}（{group_id}）" if label else group_id
                tokens = int(group.get("totalTokens") or 0)
                group_cost = float(group.get("estimatedCostCny") or 0)
                cost_share = (group_cost / total_cost * 100) if total_cost else 0
                search_calls = int(group.get("searchCalls") or 0)
                group_input_tokens = int(group.get("inputTokens") or 0)
                group_cached_input_tokens = int(group.get("cachedInputTokens") or 0)
                group_llm_cache_rate = (
                    group_cached_input_tokens / group_input_tokens * 100
                    if group_input_tokens else 0
                )
                lines.append(
                    f"{index}. {display}｜{self._money(group_cost)} "
                    f"({cost_share:.1f}%)｜消息 {self._number(group.get('requests'))}｜"
                    f"LLM {self._number(group.get('llmCalls'))}｜"
                    f"Token {self._number(tokens)}｜缓存 {group_llm_cache_rate:.1f}%｜"
                    f"搜索 {self._number(search_calls)}",
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
            lines.append("本期没有群聊上游调用。")

        if catalog:
            tracked_ids = {
                str(group.get("groupId") or "").strip()
                for group in groups
                if str(group.get("groupId") or "").strip() in catalog
            }
            inactive_ids = sorted(set(catalog) - tracked_ids)
            lines.append(
                f"群覆盖：本期活跃 {len(tracked_ids)}/{len(catalog)} 个"
                f"（零消息 {len(inactive_ids)} 个）。",
            )

        active_sources = [source for source in sources if source.get("llmCalls")]
        if active_sources:
            labels = {
                "active-reply-decision": "主动判定",
                "active-value-gate": "主动复核",
                "active-reply": "主动回复",
                "attack-reply": "对线回复",
                "attack-reply-retry": "对线重试",
                "conversation-reply": "普通回复",
                "conversation-reply-review": "回复复核",
                "conversation-summary": "会话摘要",
                "member-memory-summary": "成员摘要",
                "peer-bot-gate": "Bot判定",
                "pure-mention-reply": "纯艾特",
            }
            source_summaries = []
            for item in active_sources[:3]:
                source_input_tokens = int(item.get("inputTokens") or 0)
                source_cached_tokens = int(item.get("cachedInputTokens") or 0)
                source_cache_rate = (
                    source_cached_tokens / source_input_tokens * 100
                    if source_input_tokens else 0
                )
                source_summaries.append(
                    f"{labels.get(str(item.get('source')), item.get('source'))} "
                    f"{self._number(item.get('llmCalls'))}次/"
                    f"{self._number(item.get('totalTokens'))}t/"
                    f"缓存{source_cache_rate:.1f}%"
                )
            summary = "｜".join(source_summaries)
            lines.append(f"主要调用：{summary}")
        return "\n".join(lines)

    async def _send_daily_usage_report(
        self,
        report_date,
        *,
        end_at: datetime | None = None,
        requested_by: str = "",
    ) -> int:
        body, report_text = await self._prepare_usage_report(
            report_date,
            end_at=end_at,
            requested_by=requested_by,
        )
        recipients = [
            str(user_id).strip()
            for user_id in body.get("report_user_ids", [])
            if str(user_id).strip().isdigit()
        ]
        if not recipients:
            logger.warning("每日用量日报未发送：LONGTU_QQ_USAGE_REPORT_USERS 为空")
            return 0
        return await self._send_usage_report_text(report_text, recipients)

    async def _prepare_usage_report(
        self,
        report_date,
        *,
        end_at: datetime | None = None,
        requested_by: str = "",
    ) -> tuple[dict, str]:
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
            raise PermissionError("只有超级管理员可以查询用量日报")
        header_suffix = ""
        if end_at:
            header_suffix = f"｜截至 {end_at.astimezone(REPORT_TIMEZONE):%H:%M}"
        report_text = await self._format_usage_report(
            body,
            report_date,
            header_suffix,
        )
        return body, report_text

    async def _send_usage_report_text(
        self,
        report_text: str,
        recipients: list[str],
    ) -> int:
        platform = self._qq_platform()
        if not platform:
            raise RuntimeError("未找到已启用的 aiocqhttp 平台")
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

    async def _send_requested_usage_report(
        self,
        report_date,
        requested_by: str,
        *,
        end_at: datetime | None = None,
    ) -> int:
        _body, report_text = await self._prepare_usage_report(
            report_date,
            end_at=end_at,
            requested_by=requested_by,
        )
        # 指定日期的回捞只发给发令超管，不把群用量和费用暴露给当前群成员，
        # 也不依赖日报收件人列表是否配置。
        return await self._send_usage_report_text(
            report_text,
            [str(requested_by).strip()],
        )

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

    def _media_group_enabled(self, event: AstrMessageEvent) -> bool:
        """Return whether external video-share parsing is enabled for this chat."""
        if event.is_private_chat():
            return True
        configured = (
            os.getenv("QQ_MEDIA_EXCLUDED_GROUPS")
            or self.config.get("media_excluded_groups")
            or ""
        )
        excluded_groups = {
            group_id.strip()
            for group_id in str(configured).split(",")
            if group_id.strip()
        }
        return str(event.get_group_id() or "").strip() not in excluded_groups

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
    def _rich_segments_from_components(components: list) -> list[dict]:
        result = []
        for component in components or []:
            component_type = str(getattr(component, "type", "") or "").lower()
            if component_type == "video" or isinstance(component, getattr(Comp, "Video", ())):
                url = str(getattr(component, "url", "") or getattr(component, "file", "") or "").strip()
                if url.startswith(("http://", "https://")):
                    result.append({"type": "video", "data": {"url": url}})
                continue
            if component_type not in {"json", "xml"} and not isinstance(
                component,
                (Comp.Json, getattr(Comp, "Xml", Comp.Json)),
            ):
                continue
            data = getattr(component, "data", None)
            if isinstance(data, (dict, str)) and len(str(data)) <= 256 * 1024:
                item = {"type": component_type or "json", "data": data}
                if item not in result:
                    result.append(item)
        return result

    @classmethod
    def _rich_segments(
        cls,
        event: AstrMessageEvent,
        extra_components: list | None = None,
    ) -> list[dict]:
        """保留 OneBot json/xml 卡片原文；卡片正文通常不在 Plain 组件里。"""
        raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
        segments = raw_message.get("message") if isinstance(raw_message, dict) else None
        result = []
        if isinstance(segments, list):
            for segment in segments:
                if not isinstance(segment, dict) or str(segment.get("type") or "").lower() not in {"json", "xml"}:
                    continue
                data = segment.get("data")
                if not isinstance(data, dict):
                    continue
                # QQ 卡片的真实 jumpurl/qqdocurl 常位于 data/content 的更深层，
                # 不能只保留少数展示字段，否则会把完整地址降级成标题里的“it…”。
                if len(str(data)) <= 256 * 1024:
                    result.append({"type": str(segment.get("type")).lower(), "data": data})
        # AstrBot 4.x often converts OneBot JSON cards into Comp.Json before
        # exposing the event. In that path raw_message can be empty. Quoted
        # messages use the same component path after get_msg backfill.
        for item in cls._rich_segments_from_components([
            *(event.get_messages() or []),
            *(extra_components or []),
        ]):
            if item not in result:
                result.append(item)
        return result[:8]

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
        return cls._usage_report_command_argument(event) is not None

    @classmethod
    def _usage_report_command_argument(cls, event: AstrMessageEvent) -> str | None:
        raw_text = (cls._raw_text(event) or event.message_str or "").strip()
        matched = re.fullmatch(
            r"/usage-report(?:\s+(.*?))?\s*",
            raw_text,
            re.IGNORECASE,
        )
        return None if not matched else str(matched.group(1) or "").strip()

    @staticmethod
    def _usage_report_period(argument: str, now: datetime | None = None):
        current = now or datetime.now(REPORT_TIMEZONE)
        normalized = str(argument or "").strip()
        if not normalized:
            return current.date(), current + timedelta(milliseconds=1)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
            raise ValueError(
                "日期格式无效，请使用 /usage-report YYYY-MM-DD（例如 /usage-report 2026-08-30）。",
            )
        try:
            report_date = datetime.strptime(normalized, "%Y-%m-%d").date()
        except ValueError as error:
            raise ValueError("日期无效，请检查月份和日期。") from error
        if report_date > current.date():
            raise ValueError("不能查询未来日期。")
        end_at = (
            current + timedelta(milliseconds=1)
            if report_date == current.date()
            else None
        )
        return report_date, end_at

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
        # 分享卡/平台短链需要主动送入媒体解析链路；Node 侧只返回视频或
        # 静默，不会因为普通卡片触发 LLM。这样群友无需额外 @ 机器人。
        if self._rich_segments(event) or MEDIA_SHARE_PATTERN.search(
            self._raw_text(event) or event.message_str or "",
        ):
            return True
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
        reply_parts = []
        plain_parts = []
        for component in components:
            if isinstance(component, Comp.Reply):
                message_str = str(getattr(component, "message_str", "") or "").strip()
                if message_str:
                    reply_parts.append(message_str)
            if isinstance(component, Comp.Plain):
                text = str(getattr(component, "text", "") or "").strip()
                if text:
                    plain_parts.append(text)
        # 回捞成功时 Plain 组件能保留每一层正文；适配器未提供 chain 时，
        # 再退回 Reply.message_str，避免引用文本完全丢失。
        return " ".join(plain_parts or reply_parts).strip()

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
    def _components_from_raw_message(segments) -> list:
        """把 OneBot get_msg 返回的原始消息段转换成 AstrBot 组件。"""
        if not isinstance(segments, list):
            return []
        components = []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            segment_type = str(segment.get("type") or "").lower()
            data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
            if segment_type == "forward":
                forward_id = str(
                    data.get("id") or data.get("message_id") or "",
                ).strip()
                if forward_id:
                    components.append(Comp.Forward(id=forward_id))
            elif segment_type == "reply":
                reply_id = str(
                    data.get("id") or data.get("message_id") or "",
                ).strip()
                if reply_id:
                    components.append(Comp.Reply(id=reply_id))
            elif segment_type == "image":
                reference = str(
                    data.get("url") or data.get("file") or data.get("file_id") or "",
                ).strip()
                if reference:
                    components.append(Comp.Image(file=reference))
            elif segment_type == "text":
                text = str(data.get("text") or "")
                if text:
                    components.append(Comp.Plain(text))
            elif segment_type in {"json", "xml"}:
                card = data.get("data") or data.get("content") or data
                try:
                    components.append(Comp.Json(card if isinstance(card, dict) else str(card)))
                except Exception:
                    logger.debug("引用卡片组件转换失败")
        return components

    async def _quoted_message_chain(
        self,
        event: AstrMessageEvent,
        reply_component,
        chain: list,
        depth: int = 0,
    ) -> list:
        """引用链被适配器压缩成占位符时，从 OneBot 回捞完整消息段。"""
        current_chain = list(chain or [])
        if depth >= MAX_QUOTED_REPLY_DEPTH:
            return current_chain
        expanded_current_chain = []
        for component in current_chain:
            if isinstance(component, Comp.Reply):
                expanded_current_chain.extend(await self._quoted_message_chain(
                    event,
                    component,
                    getattr(component, "chain", None) or [],
                    depth + 1,
                ))
            else:
                expanded_current_chain.append(component)
        current_chain = expanded_current_chain
        has_rich_content = any(
            isinstance(component, (Comp.Forward, Comp.Image))
            for component in current_chain
        )
        existing_user_id, existing_name = self._quoted_author(reply_component)
        reply_id = str(getattr(reply_component, "id", "") or "").strip()
        bot = getattr(event, "bot", None)
        if (
            not reply_id
            or (has_rich_content and (existing_user_id or existing_name))
            or not bot
            or not callable(getattr(bot, "call_action", None))
        ):
            return current_chain
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        try:
            result = await asyncio.wait_for(
                bot.call_action(
                    action="get_msg",
                    message_id=reply_id,
                    **routing_params,
                ),
                timeout=15,
            )
        except Exception as error:
            logger.debug(f"引用消息 {reply_id} 回捞失败：{type(error).__name__}")
            return current_chain
        action_data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(action_data, dict):
            action_data = result if isinstance(result, dict) else {}
        sender = action_data.get("sender")
        if isinstance(sender, dict):
            fetched_user_id = str(
                sender.get("user_id")
                or sender.get("userid")
                or sender.get("sender_id")
                or ""
            ).strip()
            fetched_name = str(
                sender.get("nickname")
                or sender.get("name")
                or sender.get("card")
                or ""
            ).strip()
            # AstrBot 不同适配器版本暴露的 Reply 字段不一致；把 OneBot
            # get_msg 回捞到的作者暂存到组件上，后续统一由 _quoted_author 读取。
            for attribute, value in (
                ("_longtu_quoted_user_id", fetched_user_id),
                ("_longtu_quoted_sender_name", fetched_name),
            ):
                if value:
                    try:
                        setattr(reply_component, attribute, value)
                    except Exception:
                        pass
        raw_segments = action_data.get("message")
        fetched_chain = self._components_from_raw_message(raw_segments)
        if fetched_chain:
            expanded_chain = []
            for component in fetched_chain:
                if isinstance(component, Comp.Reply):
                    nested_chain = await self._quoted_message_chain(
                        event,
                        component,
                        getattr(component, "chain", None) or [],
                        depth + 1,
                    )
                    expanded_chain.extend(nested_chain)
                else:
                    expanded_chain.append(component)
            logger.info(
                f"已从 OneBot 回捞引用消息 {reply_id} 的完整组件，"
                f"其中图片 {sum(isinstance(item, Comp.Image) for item in expanded_chain)} 张、"
                f"转发 {sum(isinstance(item, Comp.Forward) for item in expanded_chain)} 条、"
                f"引用深度不超过 {MAX_QUOTED_REPLY_DEPTH} 层",
            )
            # get_msg 是该层引用的权威消息体；不用适配器已有的精简 chain 与
            # 回捞结果拼接，否则同一句正文或同一张图可能被重复送入模型。
            return expanded_chain
        return current_chain

    @staticmethod
    def _recent_image_cache_key(event: AstrMessageEvent) -> str:
        if event.is_private_chat():
            return f"private:{event.get_sender_id()}"
        return f"group:{event.get_group_id()}"

    def _cache_recent_images(
        self,
        event: AstrMessageEvent,
        images: list[str],
    ) -> None:
        if not images:
            return
        selected = []
        total_characters = 0
        for image in images:
            normalized = str(image or "").strip()
            if not normalized or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", normalized):
                continue
            if total_characters + len(normalized) > RECENT_IMAGE_CACHE_MAX_BASE64_CHARACTERS:
                break
            selected.append(normalized)
            total_characters += len(normalized)
            if len(selected) >= MAX_IMAGE_COMPONENTS:
                break
        if not selected:
            return
        key = self._recent_image_cache_key(event)
        self.recent_image_cache[key] = (time.monotonic(), selected)
        if len(self.recent_image_cache) > RECENT_IMAGE_CACHE_MAX_ENTRIES:
            oldest_key = min(
                self.recent_image_cache,
                key=lambda cache_key: self.recent_image_cache[cache_key][0],
            )
            self.recent_image_cache.pop(oldest_key, None)

    def _recent_images_for_reference(
        self,
        event: AstrMessageEvent,
        text: str,
    ) -> list[str]:
        if not RECENT_IMAGE_REFERENCE_PATTERN.search(str(text or "")):
            return []
        key = self._recent_image_cache_key(event)
        cached = self.recent_image_cache.get(key)
        if not cached:
            return []
        created_at, images = cached
        if time.monotonic() - created_at > RECENT_IMAGE_CACHE_TTL_SECONDS:
            self.recent_image_cache.pop(key, None)
            return []
        return list(images)

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

    @staticmethod
    def _normalize_forward_image_base64(value: object) -> str:
        normalized = str(value or "").strip()
        if normalized.startswith("base64://"):
            normalized = normalized.removeprefix("base64://")
        match = re.match(
            r"^data:image/[a-z0-9.+-]+;base64,(.+)$",
            normalized,
            re.IGNORECASE,
        )
        if match:
            normalized = match.group(1)
        if len(normalized) > (MAX_FORWARD_IMAGE_BYTES * 4 // 3 + 4):
            return ""
        return normalized if re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", normalized) else ""

    async def _download_forward_image(self, value: object) -> str:
        reference = str(value or "").strip()
        if not reference:
            return ""
        inline = self._normalize_forward_image_base64(reference)
        if inline:
            return inline
        if reference.startswith(("http://", "https://")):
            if not self.session or self.session.closed:
                return ""
            try:
                async with self.session.get(
                    reference,
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as response:
                    if response.status != 200:
                        return ""
                    body = await response.content.read(MAX_FORWARD_IMAGE_BYTES + 1)
                    if len(body) > MAX_FORWARD_IMAGE_BYTES:
                        logger.warning("合并转发图片超过 32 MiB，已跳过")
                        return ""
                    return base64.b64encode(body).decode("ascii")
            except Exception as error:
                logger.warning(f"合并转发图片下载失败：{type(error).__name__}")
                return ""
        if not os.path.isfile(reference):
            return ""

        def read_local_file() -> bytes:
            with open(reference, "rb") as stream:
                return stream.read(MAX_FORWARD_IMAGE_BYTES + 1)

        try:
            body = await asyncio.to_thread(read_local_file)
        except Exception:
            return ""
        if len(body) > MAX_FORWARD_IMAGE_BYTES:
            logger.warning("合并转发图片超过 32 MiB，已跳过")
            return ""
        return base64.b64encode(body).decode("ascii")

    async def _forward_image_base64(
        self,
        event: AstrMessageEvent,
        data: dict,
    ) -> str:
        # 合并转发里的 url/file 有时只是 QQ 生成的低清预览。只要存在
        # file/file_id，优先调用 get_image 让 NapCat 返回原图；API 失败后
        # 再回退到直接下载，兼容没有 file_id 的旧格式。
        file_ref = str(data.get("file_id") or data.get("file") or "").strip()
        bot = getattr(event, "bot", None)
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        candidates = []

        async def collect(value: object) -> None:
            image = await self._download_forward_image(value)
            if image:
                candidates.append(image)

        if (file_ref
                and not file_ref.startswith(("http://", "https://", "base64://", "data:"))
                and bot
                and callable(getattr(bot, "call_action", None))):
            try:
                result = await asyncio.wait_for(
                    bot.call_action(
                        action="get_image",
                        file=file_ref,
                        **routing_params,
                    ),
                    timeout=20,
                )
            except Exception as error:
                logger.debug(f"合并转发原图 API 读取失败，回退直接下载：{type(error).__name__}")
            else:
                if isinstance(result, dict):
                    for key in ("base64", "file", "url"):
                        await collect(result.get(key))

        # NapCat/OneBot 也可能直接给 URL 或内联 base64。
        for key in ("url", "file", "file_id"):
            await collect(data.get(key))
        # 同一图片可能同时提供缩略图 URL 和原图 file_id；选择体积最大的
        # 候选，避免先命中的低清预览遮蔽后续原图。
        return max(candidates, key=len, default="")

    async def _fetch_forward_nodes(
        self,
        event: AstrMessageEvent,
        forward_id: str,
    ) -> list:
        normalized_id = str(forward_id or "").strip()
        if not normalized_id:
            return []
        now = time.monotonic()
        cached = self.forward_nodes_cache.get(normalized_id)
        if cached and now - cached[0] <= FORWARD_CACHE_TTL_SECONDS:
            return cached[1]

        bot = getattr(event, "bot", None)
        if not bot or not callable(getattr(bot, "call_action", None)):
            logger.warning("当前 QQ 事件没有可用的 OneBot API 客户端，无法展开合并转发")
            return []
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
            return []

        nodes = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(nodes, list):
            logger.warning("合并转发 API 未返回可解析的消息节点")
            return []
        self.forward_nodes_cache[normalized_id] = (now, nodes)
        if len(self.forward_nodes_cache) > FORWARD_CACHE_MAX_ENTRIES:
            oldest_id = min(
                self.forward_nodes_cache,
                key=lambda key: self.forward_nodes_cache[key][0],
            )
            self.forward_nodes_cache.pop(oldest_id, None)
        return nodes

    async def _collect_forward_images(
        self,
        event: AstrMessageEvent,
        nodes: list,
        depth: int = 0,
        budget: dict | None = None,
        seen_forward_ids: set | None = None,
    ) -> list[str]:
        if not isinstance(nodes, list) or depth > MAX_FORWARD_DEPTH:
            return []
        budget = budget or {"images": 0}
        seen_forward_ids = seen_forward_ids or set()
        images = []
        for node in nodes:
            if budget["images"] >= MAX_IMAGE_COMPONENTS or not isinstance(node, dict):
                break
            node_data = node.get("data") if isinstance(node.get("data"), dict) else {}
            segments = (
                node_data.get("message")
                or node_data.get("content")
                or node.get("message")
                or node.get("content")
                or []
            )
            if not isinstance(segments, list):
                segments = []
            for segment in segments:
                if budget["images"] >= MAX_IMAGE_COMPONENTS or not isinstance(segment, dict):
                    break
                segment_type = str(segment.get("type") or "").lower()
                data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
                if segment_type == "image":
                    image = await self._forward_image_base64(event, data)
                    if image:
                        images.append(image)
                        budget["images"] += 1
                        logger.info(
                            f"合并转发图片已读取：第 {budget['images']} 张，"
                            f"约 {len(image) * 3 / 4 / 1024 / 1024:.2f} MiB",
                        )
                elif segment_type in {"node", "nodes"}:
                    nested = data.get("content") or data.get("message") or data.get("messages")
                    images.extend(await self._collect_forward_images(
                        event,
                        nested if isinstance(nested, list) else [],
                        depth + 1,
                        budget,
                        seen_forward_ids,
                    ))
                elif segment_type == "forward":
                    nested = data.get("content")
                    nested_id = str(data.get("id") or data.get("message_id") or "").strip()
                    if isinstance(nested, list):
                        images.extend(await self._collect_forward_images(
                            event,
                            nested,
                            depth + 1,
                            budget,
                            seen_forward_ids,
                        ))
                    elif nested_id and depth < MAX_FORWARD_DEPTH and nested_id not in seen_forward_ids:
                        seen_forward_ids.add(nested_id)
                        nested_nodes = await self._fetch_forward_nodes(event, nested_id)
                        images.extend(await self._collect_forward_images(
                            event,
                            nested_nodes,
                            depth + 1,
                            budget,
                            seen_forward_ids,
                        ))
        return images[:MAX_IMAGE_COMPONENTS]

    async def _fetch_forward_content(
        self,
        event: AstrMessageEvent,
        forward_id: str,
        include_images: bool = True,
    ) -> tuple[str, list[str]]:
        normalized_id = str(forward_id or "").strip()
        if not normalized_id:
            return "", []
        cached = self.forward_cache.get(normalized_id)
        now = time.monotonic()
        if cached and now - cached[0] <= FORWARD_CACHE_TTL_SECONDS:
            nodes = await self._fetch_forward_nodes(event, normalized_id)
            images = await self._collect_forward_images(
                event,
                nodes,
                seen_forward_ids={normalized_id},
            ) if include_images else []
            return cached[1], images
        nodes = await self._fetch_forward_nodes(event, normalized_id)
        if not nodes:
            return "", []
        formatted = self._format_forward_nodes(nodes)
        images = await self._collect_forward_images(
            event,
            nodes,
            seen_forward_ids={normalized_id},
        ) if include_images else []
        if not formatted and not images:
            logger.warning("合并转发 API 未返回可解析的消息节点")
            return "", []
        self.forward_cache[normalized_id] = (now, formatted)
        if len(self.forward_cache) > FORWARD_CACHE_MAX_ENTRIES:
            oldest_id = min(
                self.forward_cache,
                key=lambda key: self.forward_cache[key][0],
            )
            self.forward_cache.pop(oldest_id, None)
        logger.info(
            f"已展开合并转发内容，共 {formatted.count(chr(10)) + 1 if formatted else 0} 行，"
            f"读取图片 {len(images)} 张",
        )
        return formatted, images

    async def _fetch_forward_text(
        self,
        event: AstrMessageEvent,
        forward_id: str,
    ) -> str:
        text, _ = await self._fetch_forward_content(
            event,
            forward_id,
            include_images=False,
        )
        return text

    async def _forwarded_content(
        self,
        event: AstrMessageEvent,
        components: list,
    ) -> tuple[str, list[str]]:
        texts = []
        images = []
        seen = set()
        for component in self._forward_components(components):
            forward_id = str(getattr(component, "id", "") or "").strip()
            if not forward_id or forward_id in seen:
                continue
            seen.add(forward_id)
            text, nested_images = await self._fetch_forward_content(event, forward_id)
            if text:
                texts.append(text)
            for image in nested_images:
                if len(images) >= MAX_IMAGE_COMPONENTS:
                    break
                images.append(image)
        return "\n\n".join(texts)[:MAX_FORWARD_CHARACTERS], images

    async def _forwarded_text(
        self,
        event: AstrMessageEvent,
        components: list,
    ) -> str:
        text, _ = await self._forwarded_content(event, components)
        return text

    @staticmethod
    def _quoted_author(reply_component) -> tuple[str, str]:
        if not reply_component:
            return "", ""
        sender = getattr(reply_component, "sender", None)

        def sender_value(*keys):
            for key in keys:
                if isinstance(sender, dict):
                    value = sender.get(key)
                else:
                    value = getattr(sender, key, None) if sender is not None else None
                if value:
                    return value
            return ""

        user_id = str(
            getattr(reply_component, "_longtu_quoted_user_id", "")
            or getattr(reply_component, "sender_id", "")
            or getattr(reply_component, "user_id", "")
            or getattr(reply_component, "userid", "")
            or getattr(reply_component, "quoted_user_id", "")
            or sender_value("user_id", "userid", "sender_id")
            or ""
        ).strip()
        name = str(
            getattr(reply_component, "_longtu_quoted_sender_name", "")
            or getattr(reply_component, "sender_nickname", "")
            or getattr(reply_component, "sender_name", "")
            or getattr(reply_component, "nickname", "")
            or getattr(reply_component, "name", "")
            or sender_value("nickname", "name", "card")
            or ""
        ).strip()
        return user_id, name

    @staticmethod
    async def _image_base64(image_component) -> str:
        if not image_component:
            return ""
        converted = await image_component.convert_to_base64()
        candidates = [converted] if isinstance(converted, str) else []
        candidates.extend(
            str(getattr(converted, attribute, "") or "")
            for attribute in ("base64", "file")
        )
        for value in candidates:
            normalized = str(value or "").strip()
            if normalized.startswith("base64://"):
                normalized = normalized.removeprefix("base64://")
            match = re.match(r"^data:image/[a-z0-9.+-]+;base64,(.+)$", normalized, re.IGNORECASE)
            if match:
                normalized = match.group(1)
            if normalized and re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", normalized):
                return normalized
        return ""

    @classmethod
    async def _image_base64s(cls, components: list, limit: int = MAX_IMAGE_COMPONENTS) -> list[str]:
        images = []
        for component in components:
            if isinstance(component, Comp.Image):
                image = await cls._image_base64(component)
                if image:
                    images.append(image)
                if len(images) >= limit:
                    break
        return images

    @classmethod
    async def _quoted_image_base64s(cls, reply_component) -> list[str]:
        chain = getattr(reply_component, "chain", None) or []
        return await cls._image_base64s(chain)

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
            elif message_type == "video" and message.get("url"):
                # OneBot accepts an HTTPS URL for video; keep it out of the
                # JSON bridge body as base64 because videos exceed API limits.
                video_url = str(message["url"])
                try:
                    reply_chain.append(Comp.Video(file=video_url))
                except TypeError:
                    reply_chain.append(Comp.Plain(video_url))
        return reply_chain

    async def _send_forward_from_backend(self, event: AstrMessageEvent, response: dict) -> bool:
        message = next((item for item in response.get("messages", []) if item.get("type") == "forward"), None)
        if not message or event.is_private_chat():
            return False
        bot = getattr(event, "bot", None)
        call_action = getattr(bot, "call_action", None)
        if not callable(call_action):
            return False
        title = str(message.get("title") or "小红书图文")[:200]
        description = str(message.get("description") or "")[:4000]
        images = [str(url) for url in message.get("images", []) if str(url).startswith(("http://", "https://"))][:18]
        if not images:
            return False
        sender_id = str(event.get_self_id() or "2170902293")
        sender_name = str(getattr(getattr(event, "message_obj", None), "self_id", "") or "龙玉涛")
        text = title + (("\n\n" + description) if description else "")
        nodes = [{
            "type": "node", "data": {"uin": sender_id, "name": sender_name,
            "content": [{"type": "text", "data": {"text": text}}]},
        }]
        nodes.extend({
            "type": "node", "data": {"uin": sender_id, "name": sender_name,
            "content": [{"type": "image", "data": {"file": url}}]},
        } for url in images)
        await call_action("send_group_forward_msg", group_id=int(event.get_group_id()), messages=nodes)
        logger.info(f"小红书图文合并转发已发送：group={event.get_group_id()} images={len(images)}")
        return True

    def _pure_mention_payload(
        self,
        event: AstrMessageEvent,
        group_info: dict[str, int] | None = None,
    ) -> dict:
        components = event.get_messages()
        return {
            "message_id": str(event.message_obj.message_id or ""),
            "message_type": "private" if event.is_private_chat() else "group",
            "group_id": event.get_group_id(),
            "group_member_count": (group_info or {}).get("group_member_count"),
            "group_member_limit": (group_info or {}).get("group_member_limit"),
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
            "forward_image_base64s": [],
            "quoted_forward_image_base64s": [],
            "rich_segments": self._rich_segments(event),
            "media_share": bool(self._rich_segments(event)),
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
            group_info = await self._group_info(event.get_group_id())
            response = await self._request_backend(
                self._pure_mention_payload(event, group_info),
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
        # OneBot normally does not echo this account's own outbound messages,
        # but some NapCat versions do. Never feed our own messages back into
        # the media pipeline.
        if str(event.get_sender_id() or "").strip() == str(event.get_self_id() or "").strip():
            return
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
                usage_report_argument = self._usage_report_command_argument(event)
                if usage_report_argument is not None:
                    requested_by = str(event.get_sender_id() or "")
                    try:
                        if usage_report_argument:
                            report_date, end_at = self._usage_report_period(
                                usage_report_argument,
                            )
                            recipient_count = await self._send_requested_usage_report(
                                report_date,
                                requested_by,
                                end_at=end_at,
                            )
                        else:
                            recipient_count = await self._send_current_usage_report(
                                requested_by,
                            )
                    except PermissionError:
                        yield event.plain_result("只有超级管理员可以查询用量日报。")
                    except ValueError as error:
                        yield event.plain_result(str(error))
                    except Exception as error:
                        logger.error(f"手动查询用量日报失败：{error}")
                        yield event.plain_result("用量日报查询失败，请检查服务日志。")
                    else:
                        logger.info(
                            f"手动用量日报查询完成：已发送给 "
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
            reply_component = self._reply_component(components)
            quoted_chain = getattr(reply_component, "chain", None) or []
            if should_reply and reply_component:
                quoted_chain = await self._quoted_message_chain(
                    event,
                    reply_component,
                    quoted_chain,
                )
            has_image = any(
                isinstance(component, Comp.Image)
                for component in components
            ) or any(
                isinstance(component, Comp.Image)
                for component in quoted_chain
            )
            has_forward = bool(
                self._forward_components(components)
                or self._forward_components(quoted_chain)
            )
            rich_segments = self._rich_segments(event, quoted_chain)
            has_rich = bool(rich_segments)
            media_group_enabled = self._media_group_enabled(event)
            raw_media_text = self._raw_text(event) or event.message_str or ""
            if (
                not media_group_enabled
                and (
                    has_rich
                    or MEDIA_SHARE_PATTERN.search(raw_media_text)
                )
            ):
                logger.info(
                    f"群 {event.get_group_id()} 已禁用外部视频分享解析，保持静默",
                )
                return
            media_signal_text = " ".join(
                [
                    raw_media_text,
                    str(rich_segments),
                ],
            )
            has_media_signal = bool(MEDIA_ACK_PATTERN.search(media_signal_text))
            has_media_payload = has_rich or bool(
                MEDIA_SHARE_PATTERN.search(
                    self._raw_text(event) or event.message_str or "",
                ),
            )

            # Send a lightweight acknowledgement before the potentially slow
            # yt-dlp request. Keep one acknowledgement per message id so a
            # duplicate OneBot delivery cannot produce duplicate notices.
            if should_reply and has_media_signal:
                ack_key = str(getattr(event.message_obj, "message_id", "") or "").strip()
                if not ack_key:
                    ack_key = f"{event.get_group_id()}:{event.get_sender_id()}:{hash(str(rich_segments))}"
                now = time.monotonic()
                previous_ack = self.media_status_cache.get(ack_key)
                if previous_ack is None or now - previous_ack > 600:
                    self.media_status_cache[ack_key] = now
                    if len(self.media_status_cache) > 2000:
                        oldest_key = min(self.media_status_cache, key=self.media_status_cache.get)
                        self.media_status_cache.pop(oldest_key, None)
                    try:
                        # 直接挂在原分享消息上的 QQ 原生表情回应；不发送任何
                        # 可见的普通消息，因此不会在群里产生“收到分享”的废话。
                        if media_group_enabled:
                            await self._react_media_share(event)
                    except Exception as error:
                        logger.debug(f"QQ 原生媒体回应失败：{type(error).__name__}")

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
            if not text and not has_image and not has_forward and not has_rich:
                return
            if (
                should_reply
                and bool(self.config.get("send_processing_hint", False))
                and text
            ):
                yield event.plain_result("正在翻龙图小本本……")

            quoted_user_id, quoted_sender_name = self._quoted_author(reply_component)
            quoted_text = self._quoted_text(quoted_chain)
            if not quoted_text and reply_component:
                quoted_text = str(
                    getattr(reply_component, "message_str", "") or "",
                ).strip()
            observed_forward_images = []
            observed_quoted_forward_images = []
            if should_reply:
                forwarded_text, forward_image_base64s = await self._forwarded_content(
                    event,
                    components,
                )
                quoted_forwarded_text, quoted_forward_image_base64s = await self._forwarded_content(
                    event,
                    quoted_chain,
                )
            else:
                # 旁观消息仍不把图片上传给 Node，但先提取并缓存合并转发中的
                # 图片，方便下一条消息明确询问“上面的聊天记录/图片”。
                forwarded_text, observed_forward_images = await self._forwarded_content(
                    event,
                    components,
                )
                quoted_forwarded_text, observed_quoted_forward_images = await self._forwarded_content(
                    event,
                    quoted_chain,
                )
                forward_image_base64s = []
                quoted_forward_image_base64s = []
            image_base64s = []
            quoted_image_base64s = []
            # 被动旁观消息不调用 Node/模型，但把最近一批图片短暂缓存在
            # AstrBot 插件内，支持“先发图、下一条再 @ 机器人评价”的消息习惯。
            # 缓存有严格的群数、图片数、总字节和 TTL 上限，不会进入旁观用量统计。
            if has_image:
                try:
                    image_base64s = await self._image_base64s(components)
                    quoted_image_base64s = await self._image_base64s(quoted_chain)
                except Exception as error:
                    logger.warning(f"QQ 图片读取失败：{type(error).__name__}")

            cached_images = [
                *image_base64s,
                *quoted_image_base64s,
                *forward_image_base64s,
                *quoted_forward_image_base64s,
                *observed_forward_images,
                *observed_quoted_forward_images,
            ]
            self._cache_recent_images(event, cached_images)

            # QQ 中常见的“上一条先发图，下一条再 @ 机器人”不会携带引用组件；
            # 用户明确指向上文图片时，把短时缓存的图片带入本轮视觉请求。
            if should_reply and not (
                image_base64s
                or quoted_image_base64s
                or forward_image_base64s
                or quoted_forward_image_base64s
            ):
                recent_images = self._recent_images_for_reference(event, text)
                if recent_images:
                    image_base64s = recent_images
                    has_image = True
                    logger.info(
                        f"已将最近缓存的 {len(recent_images)} 张图片带入本轮 QQ 视觉请求",
                    )

            bot_user_id = str(event.get_self_id() or "").strip()
            group_info = (
                await self._group_info(event.get_group_id())
                if not event.is_private_chat()
                else {}
            )

            payload = {
                "message_id": str(event.message_obj.message_id or ""),
                "message_type": "private" if event.is_private_chat() else "group",
                "group_id": event.get_group_id(),
                "group_member_count": group_info.get("group_member_count"),
                "group_member_limit": group_info.get("group_member_limit"),
                "user_id": event.get_sender_id(),
                "sender_name": event.get_sender_name(),
                "text": text,
                "quoted_text": quoted_text,
                "forwarded_text": forwarded_text,
                "quoted_forwarded_text": quoted_forwarded_text,
                "quoted_user_id": quoted_user_id,
                "quoted_sender_name": quoted_sender_name,
                "mentions": self._mentions(components),
                "bot_user_id": bot_user_id,
                "has_image": has_image,
                "pure_bot_mention": pure_bot_mention,
                "image_base64s": image_base64s,
                "quoted_image_base64s": quoted_image_base64s,
                "forward_image_base64s": forward_image_base64s,
                "quoted_forward_image_base64s": quoted_forward_image_base64s,
            "rich_segments": rich_segments,
                "video_urls": [
                    str(item.get("data", {}).get("url"))
                    for item in rich_segments
                    if item.get("type") == "video"
                    and str(item.get("data", {}).get("url", "")).startswith(("http://", "https://"))
                ][:4],
                "media_share": media_group_enabled and (
                    has_media_payload
                    or bool(MEDIA_SHARE_PATTERN.search(text or ""))
                ),
                # 保留旧字段，便于旧版 Node 服务平滑升级。
                "image_base64": image_base64s[0] if image_base64s else "",
                "quoted_image_base64": quoted_image_base64s[0] if quoted_image_base64s else "",
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

            if await self._send_forward_from_backend(event, response):
                return

            reply_chain = self._reply_chain_from_backend(response)

            # AstrBot only consumes one result from this handler in the normal
            # response pipeline. Keep text and the attached meme in one chain so
            # the image is not dropped after the text response has been sent.
            if reply_chain:
                # 主动插话应该像群友自己发言，不挂在触发它的普通消息下面；明确
                # @、引用和私聊等被动问答仍保留原有引用/送达前缀。
                # 媒体结果直接发成可播放视频，不再挂引用；普通对话继续保留
                # 原有引用和 @ 送达前缀。
                if not bool(response.get("active_reply")):
                    reply_chain = self._reply_prefix(event, components) + reply_chain
                    if response.get("mode") == "media":
                        reply_chain = reply_chain[len(self._reply_prefix(event, components)):]
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
        if self.internal_send_runner:
            await self.internal_send_runner.cleanup()
