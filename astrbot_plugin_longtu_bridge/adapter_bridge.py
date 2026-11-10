from __future__ import annotations
"""Opt-in transport orchestration. Legacy implementation remains the default.

Only changed methods live here; shared business rules remain in main.py.
Loaded lazily after the registered plugin class is defined.
"""
from .main import *
from .adapters import Target, DeliveryError, LegacyOneBotAdapter, transport_for, select_platform
from .adapters.codec import OneBotCodec
from .adapter_group_context import fetch_recent_group_context


class AdapterBridge(LongtuQqBridge):
    _raw_text = staticmethod(OneBotCodec._raw_text)
    _rich_segments_from_components = staticmethod(OneBotCodec._rich_segments_from_components)
    _rich_segments = classmethod(OneBotCodec._rich_segments.__func__)
    _components_from_raw_message = staticmethod(OneBotCodec._components_from_raw_message)

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
            sent = await transport_for(self).send_session(self.context,
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
        if not self._media_group_enabled(event):
            return False
        message_id = str(
            getattr(getattr(event, "message_obj", None), "message_id", "") or "",
        ).strip()
        bot = getattr(event, "bot", None)
        adapter = transport_for(self, bot=bot)
        if not message_id or not adapter.available:
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
        await adapter.react(str(numeric_message_id), emoji_id)
        return True

    async def _react_media_result(self, event: AstrMessageEvent, success: bool) -> bool:
        """给发分享链接那条消息挂上成功/失败对应的原生表情回应。"""
        emoji_id = self._media_result_emoji_id(event, success)
        if not emoji_id:
            return False
        bot = getattr(event, 'bot', None)
        adapter = transport_for(self, bot=bot)
        if not adapter.available:
            return False
        message_id = str(getattr(getattr(event, 'message_obj', None), 'message_id', '') or '').strip()
        if not message_id:
            logger.debug('媒体结果回应：缺少分享消息 message_id')
            return False
        try:
            numeric_message_id = int(message_id)
        except ValueError:
            numeric_message_id = message_id
        await adapter.react(str(numeric_message_id), emoji_id)
        logger.info(
            f'媒体结果回应：success={success} emoji={emoji_id} message_id={numeric_message_id}',
        )
        return True

    async def _call_video_send(self, bot, action: str, destination: dict, video_url: str):
        adapter = transport_for(self, bot=bot)
        return await adapter.send_video(adapter.target(destination), video_url)

    async def _call_video_forward(self, bot, destination: dict, message_id):
        adapter = transport_for(self, bot=bot)
        return await adapter.forward_video(adapter.target(destination), message_id)

    async def _send_video_from_backend(
        self,
        event: AstrMessageEvent,
        message: dict,
        *,
        react_result: bool = True,
        send_failure_notice: bool = True,
    ) -> bool:
        """Send one video directly: RespondStage swallows errors after a yield.

        Multi-video shares use this as a fallback after trying one native
        forward record.  In that path reactions and failure notices are sent
        once for the whole bundle by the caller.
        """
        private = event.is_private_chat()
        action = 'send_private_msg' if private else 'send_group_msg'
        destination = ({'user_id': int(event.get_sender_id())} if private
                       else {'group_id': int(event.get_group_id())})
        source_id = str(getattr(getattr(event, 'message_obj', None), 'message_id', '') or '')
        started = time.monotonic()
        logger.info(f'视频发送开始：target={destination} source_message_id={source_id}')
        try:
            video_url = str(message.get('url') or '')
            if not video_url:
                raise RuntimeError('视频地址缺失')
            account = str(getattr(getattr(event, 'message_obj', None), 'self_id', '') or '')
            if callable(getattr(event, 'get_self_id', None)):
                account = str(event.get_self_id() or account)
            if not private and account and message.get('provider') in {
                'bilibili', 'xiaohongshu', 'douyin', 'kuaishou',
            }:
                if not getattr(self, 'video_delivery_cache', None):
                    self.video_delivery_cache = VideoDeliveryCache(logger=logger)
                receipt = await asyncio.wait_for(self.video_delivery_cache.deliver(
                    transport_for(self, event=event).cache_account(event, account), str(message.get('mediaCacheKey') or video_url),
                    lambda: self._call_video_send(event.bot, action, destination, video_url),
                    lambda source: self._call_video_forward(event.bot, destination, source),
                ), timeout=VIDEO_SEND_TIMEOUT_SECONDS)
            else:
                receipt = await self._call_video_send(event.bot, action, destination, video_url)
        except Exception as error:
            timed_out = isinstance(error, asyncio.TimeoutError) or bool(
                re.search(r'timeout|timed out|超时', str(error), re.IGNORECASE))
            logger.warning(
                f'视频发送未成功：target={destination} source_message_id={source_id} '
                f'duration_ms={int((time.monotonic() - started) * 1000)} '
                f'error={type(error).__name__}: {error}',
            )
            if react_result:
                with contextlib.suppress(Exception):
                    await self._react_media_result(event, False)
            # A client-side timeout does not cancel an upload already accepted
            # by QQ. Do not retry blindly or falsely claim it was interrupted.
            notice = ('视频发送等待超时，暂未收到 QQ 成功回执，可能仍在发送。建议点击分享前往平台观看。'
                      if timed_out else '视频发送失败，未收到 QQ 成功回执。请稍后重试，或点击分享前往平台观看。')
            if send_failure_notice:
                try:
                    segments = [{'type': 'text', 'data': {'text': notice}}]
                    if source_id:
                        segments.insert(0, {'type': 'reply', 'data': {'id': source_id}})
                    await asyncio.wait_for(transport_for(self, event=event).send(
                        Target.from_event(event), segments,
                    ), timeout=15)
                except Exception as notice_error:
                    logger.warning(f'视频发送失败提示也未送达：{notice_error}')
            return False
        logger.info(
            f'视频发送成功：target={destination} source_message_id={source_id} '
            f'message_id={receipt.get("message_id", "")} '
            f'delivery={receipt.get("delivery", "upload")} reused_from={receipt.get("reused_message_id", "")} '
            f'duration_ms={int((time.monotonic() - started) * 1000)}',
        )
        if react_result:
            with contextlib.suppress(Exception):
                await self._react_media_result(event, True)
        return True

    async def _send_video_bundle_from_backend(self, event: AstrMessageEvent, messages: list[dict]) -> bool:
        """Send several videos as one QQ merged-forward record.

        NapCat accepts video components in forward nodes.  If a particular
        OneBot build rejects remote video nodes, the caller falls back to the
        normal per-video upload path, preserving delivery instead of dropping
        the whole share.
        """
        videos = [item for item in messages
                  if isinstance(item, dict) and str(item.get('url') or '').startswith(('http://', 'https://'))]
        if len(videos) < 2:
            return False
        bot = getattr(event, 'bot', None)
        adapter = transport_for(self, bot=bot)
        if not adapter.available:
            return False
        private = event.is_private_chat()
        destination = ({'user_id': int(event.get_sender_id())} if private
                        else {'group_id': int(event.get_group_id())})
        action = 'send_private_forward_msg' if private else 'send_group_forward_msg'
        sender_id = str(event.get_self_id() or '2170902293')
        sender_name = str(getattr(getattr(event, 'message_obj', None), 'self_id', '') or '龙玉涛')
        nodes = [{
            'type': 'node',
            'data': {
                'uin': sender_id,
                'name': sender_name,
                'content': [{'type': 'video', 'data': {'file': str(item['url'])}}],
            },
        } for item in videos]
        try:
            result = await asyncio.wait_for(adapter.send_forward(Target.from_event(event), nodes), timeout=VIDEO_SEND_TIMEOUT_SECONDS)
            if isinstance(result, dict) and (
                result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None)
            ):
                raise RuntimeError('QQ 多视频合并转发接口返回失败')
            logger.info(
                f'多视频合并转发已发送：target={destination} videos={len(videos)} result={result!r}',
            )
            return True
        except asyncio.TimeoutError as error:
            raise DeliveryError('send_forward', 'unknown', 'timeout') from error
        except Exception as error:
            if isinstance(error, DeliveryError) and error.outcome == 'unknown':
                raise
            logger.warning(
                f'多视频合并转发失败，将逐条发送：target={destination} '
                f'videos={len(videos)} error={error}',
            )
            return False

    async def _deliver_learning_results(self) -> int:
        platform = self._qq_platform()
        bot = getattr(platform, "bot", None) if platform else None
        token = self._api_token()
        if not bot or not token or not self.session or self.session.closed:
            return 0
        headers = {"Authorization": f"Bearer {token}"}
        async with self.session.get(
            self._learning_api_url("deliveries"),
            params={"limit": 10, "lease_ms": 60_000},
            headers=headers,
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"学习投递接口返回 HTTP {response.status}")
            body = await response.json(content_type=None)
        sent_count = 0
        for delivery in body.get("deliveries") or []:
            sent, error = False, ""
            official_result = None
            if getattr(self, 'config', {}).get('official_trial_enabled', False):
                from .official_trial import mirror_learning
                official_result = await mirror_learning(self, delivery.get("payload") or {})
            planned = learning_delivery_message(delivery.get("payload") or {})
            if official_result is not None:
                sent, error = official_result, "" if official_result else "官方投递未确认"
            elif not planned:
                error = "投递目标无效"
            else:
                action, destination, message = planned
                try:
                    # Queue leases/retries belong to the existing backend contract.
                    # Preserve its receipt semantics until it supports an
                    # explicit durable unknown state; do not claim exactly-once.
                    result = await LegacyOneBotAdapter(bot).send(
                        Target("group" if "group_id" in destination else "private",
                               next(iter(destination.values()))), message)
                    failed = isinstance(result, dict) and (
                        result.get("status") == "failed" or result.get("retcode", 0) not in (0, None)
                    )
                    sent, error = (not failed), ("OneBot 发送失败" if failed else "")
                except Exception as send_error:
                    error = str(send_error)[:300]
            logger.info(
                f"视频学梗投递：kind={delivery.get('kind')} target={planned[1] if planned else '-'} "
                f"sent={sent}{' error=' + error if error else ''}",
            )
            async with self.session.post(
                self._learning_api_url("receipts"),
                json={"delivery_id": delivery.get("deliveryId"), "sent": sent, "error": error},
                headers=headers,
            ) as receipt:
                if receipt.status != 200:
                    logger.warning(f"视频学梗回执失败：HTTP {receipt.status}")
            sent_count += int(sent)
        return sent_count

    async def _send_crazy_thursday(self, target_date) -> int:
        platform = self._qq_platform()
        bot = getattr(platform, "bot", None) if platform else None
        if not bot:
            raise RuntimeError("未找到已启用的 aiocqhttp 平台")
        # 定时推送按用户要求覆盖机器人当前加入的全部群；不继承允许群或
        # crazy_thursday_groups 的旧筛选，避免新增群静默漏收。每个时点只
        # 生成一条，再复用给所有群，控制模型调用次数。
        groups = set((await self._group_catalog()).keys())
        if not groups:
            logger.warning("疯狂星期四未发送：没有可用 QQ 群目标")
            return 0
        platform_id = platform.meta().id
        text = await self._generate_crazy_thursday_text(target_date, scheduled=True)
        sent_count = 0
        for group_id in sorted(groups):
            try:
                sent = await transport_for(self).send_session(self.context,
                    f"{platform_id}:GroupMessage:{group_id}",
                    MessageChain(chain=[Comp.Plain(text)]),
                )
                if sent:
                    sent_count += 1
                else:
                    logger.warning(f"疯狂星期四发送失败：group={group_id}")
            except Exception as error:
                logger.warning(f"疯狂星期四发送失败：group={group_id} error={error}")
        logger.info(
            f"疯狂星期四已推送：date={target_date} groups={sent_count}/{len(groups)}",
        )
        return sent_count

    def _qq_platform(self):
        return select_platform(self.context)

    async def _group_catalog(self) -> dict[str, str]:
        platform = self._qq_platform()
        bot = getattr(platform, "bot", None)
        if not bot:
            return {}
        try:
            groups = await asyncio.wait_for(
                transport_for(self, bot=bot).groups(),
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
        names = {}
        if getattr(self, 'config', {}).get('official_trial_enabled', False):
            from .official_trial import official_group_names
            names.update(await official_group_names(self, group_ids))
        if not bot:
            return names
        for group_id in group_ids[:20]:
            if not str(group_id).isdigit():
                continue
            try:
                info = await asyncio.wait_for(
                    transport_for(self, bot=bot).group(group_id),
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
                transport_for(self, bot=bot).group(normalized_group_id),
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

    async def _send_usage_report(self, body: dict, report_text: str, recipients: list[str]) -> int:
        platform = self._qq_platform()
        if not platform:
            raise RuntimeError("未找到已启用的 aiocqhttp 平台")
        try:
            report = body["report"]
            names = await self._group_catalog()
            missing = [str(row["groupId"]) for row in report.get("groups", [])
                       if str(row["groupId"]) not in names]
            names = {**names, **(await self._group_names(missing))}
            pngs = await asyncio.to_thread(render_usage_report, report, names)
            if not pngs:
                raise RuntimeError("日报未生成图片")
            images = [base64.b64encode(png).decode("ascii") for png in pngs]
        except Exception as error:
            logger.warning(f"日报图片生成失败，回退文字：{error}")
            return await self._send_usage_report_text(report_text, recipients)
        delivered = 0
        for recipient in recipients:
            try:
                complete = True
                for encoded in images:
                    sent = await transport_for(self).send_session(self.context,
                        f"{platform.meta().id}:FriendMessage:{recipient}",
                        MessageChain(chain=[Comp.Image.fromBase64(encoded)]),
                    )
                    if not sent:
                        complete = False
                        break
                if complete:
                    delivered += 1
                    continue
                logger.warning(f"日报图片未全部送达：{recipient}")
            except Exception as error:
                logger.warning(f"日报图片发送失败：{recipient}：{error}")
            # Some accounts reject image transfer ("rich media transfer
            # failed"); the text report still reaches them.
            try:
                sent = await transport_for(self).send_session(self.context,
                    f"{platform.meta().id}:FriendMessage:{recipient}",
                    MessageChain(chain=[Comp.Plain(report_text)]),
                )
                if sent:
                    delivered += 1
                    logger.info(f"日报已改用文字发送：{recipient}")
                else:
                    logger.warning(f"日报文字回退也未送达：{recipient}")
            except Exception as error:
                logger.warning(f"日报文字回退发送失败：{recipient}：{error}")
        logger.info(f"日报已推送给 {delivered}/{len(recipients)} 个收件账号")
        return delivered

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
            sent = await transport_for(self).send_session(self.context,
                f"{platform_id}:FriendMessage:{recipient_id}",
                MessageChain(chain=[Comp.Plain(report_text)]),
            )
            if not sent:
                logger.warning(f"每日用量日报发送失败：{recipient_id}")
        logger.info(f"每日用量日报已推送给 {len(recipients)} 个收件账号")
        return len(recipients)

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
        bot_user_id = str(event.get_self_id() or "").strip()
        # 机器人自己的引用可能已经带有图片和作者，适配器却丢掉了
        # OneBot image.sub_type。此时仍回捞一次 get_msg，才能区分龙图
        # 表情（sub_type=1）与需要解释的普通分享卡。
        needs_bot_image_metadata = bool(
            bot_user_id
            and existing_user_id == bot_user_id
            and any(isinstance(component, Comp.Image) for component in current_chain)
        )
        reply_id = str(getattr(reply_component, "id", "") or "").strip()
        bot = getattr(event, "bot", None)
        if (
            not reply_id
            or (
                has_rich_content
                and (existing_user_id or existing_name)
                and not needs_bot_image_metadata
            )
            or not bot
            or not transport_for(self, bot=bot).available
        ):
            return current_chain
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        try:
            result = await asyncio.wait_for(
                transport_for(self, bot=bot).read_message(
                    reply_id,
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
            # 动态字段在部分 AstrBot 版本上可能被组件模型拒绝。保留一份
            # 与图片顺序对应的原始 sub_type，供 _quoted_visual_chain 过滤
            # QQ 龙图表情而不误删普通机器人图片。
            quoted_image_sub_types = []
            for segment in raw_segments if isinstance(raw_segments, list) else []:
                if not isinstance(segment, dict) or str(segment.get("type") or "").lower() != "image":
                    continue
                data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
                quoted_image_sub_types.append(str(data.get("sub_type") or "0"))
            try:
                setattr(reply_component, "_longtu_quoted_image_sub_types", quoted_image_sub_types)
            except Exception:
                pass
            # get_msg 是该层引用的权威消息体；不用适配器已有的精简 chain 与
            # 回捞结果拼接，否则同一句正文或同一张图可能被重复送入模型。
            return expanded_chain
        return current_chain

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

        # 原消息的 CDN URL 通常就是原图。完整读取成功后无需逐张等待
        # 不可用的 get_image；过期时再由 API 提供有效地址。
        await collect(data.get("url"))
        expected_size = int(data.get("file_size") or 0) if str(data.get("file_size") or "0").isdigit() else 0
        if candidates and (not expected_size or len(base64.b64decode(candidates[0])) >= expected_size):
            return candidates[0]

        if (file_ref
                and not file_ref.startswith(("http://", "https://", "base64://", "data:"))
                and bot
                and transport_for(self, bot=bot).available
                and not self._get_image_circuit_open()):
            try:
                result = await asyncio.wait_for(
                    transport_for(self, bot=bot).read_image(
                        file_ref,
                        **routing_params,
                    ),
                    timeout=GET_IMAGE_TIMEOUT_SECONDS,
                )
            except Exception as error:
                self._note_get_image_failure(error)
            else:
                self.get_image_failures = 0
                if isinstance(result, dict):
                    result = result.get("data") if isinstance(result.get("data"), dict) else result
                    for key in ("base64", "file", "url"):
                        await collect(result.get(key))

        # NapCat/OneBot 也可能直接给 URL 或内联 base64。
        for key in ("url", "file", "file_id"):
            if key == "url":
                continue
            await collect(data.get(key))
        # 同一图片可能同时提供缩略图 URL 和原图 file_id；选择体积最大的
        # 候选，避免先命中的低清预览遮蔽后续原图。
        return max(candidates, key=len, default="")

    async def _fetch_forward_nodes(
        self,
        event: AstrMessageEvent,
        forward_id: str,
        refresh: bool = False,
    ) -> list:
        normalized_id = str(forward_id or "").strip()
        if not normalized_id:
            return []
        now = time.monotonic()
        cached = self.forward_nodes_cache.get(normalized_id)
        if not refresh and cached and now - cached[0] <= FORWARD_CACHE_TTL_SECONDS:
            return cached[1]

        bot = getattr(event, "bot", None)
        if not bot or not transport_for(self, bot=bot).available:
            logger.warning("当前 QQ 事件没有可用的 OneBot API 客户端，无法展开合并转发")
            return []
        routing_params = {}
        self_id = str(getattr(event.message_obj, "self_id", "") or "").strip()
        if self_id:
            routing_params["self_id"] = self_id
        try:
            result = await asyncio.wait_for(
                transport_for(self, bot=bot).read_forward(
                    normalized_id,
                    **routing_params,
                ),
                timeout=20,
            )
        except Exception as error:
            logger.warning(f"合并转发内容展开失败：{type(error).__name__}")
            return cached[1] if cached else []

        if isinstance(result, dict) and isinstance(result.get("data"), dict):
            result = result["data"]
        nodes = result.get("messages") if isinstance(result, dict) else None
        if not isinstance(nodes, list):
            logger.warning("合并转发 API 未返回可解析的消息节点")
            return cached[1] if cached else []
        self.forward_nodes_cache[normalized_id] = (now, nodes)
        if len(self.forward_nodes_cache) > FORWARD_CACHE_MAX_ENTRIES:
            oldest_id = min(
                self.forward_nodes_cache,
                key=lambda key: self.forward_nodes_cache[key][0],
            )
            self.forward_nodes_cache.pop(oldest_id, None)
        return nodes

    async def _send_media_limit_card(self, event: AstrMessageEvent, response: dict) -> bool:
        """Send a source cover before a size/duration limit explanation.

        The resolver deliberately refuses to register long media, so this
        path cannot use the regular video card delivery branch. Cover delivery
        remains independent and best effort: a CDN failure must not hide the
        precise limit message.
        """
        message = next((item for item in response.get("messages", [])
                        if item.get("type") == "media-limit"), None)
        if not message or not message.get("coverUrl"):
            return False
        try:
            card = await asyncio.wait_for(self._video_card(message), timeout=12)
            if not card:
                return False
            bot = getattr(event, "bot", None)
            adapter = transport_for(self, bot=bot)
            if not adapter.available:
                return False
            private = event.is_private_chat()
            action = "send_private_msg" if private else "send_group_msg"
            destination = ({"user_id": int(event.get_sender_id())} if private
                            else {"group_id": int(event.get_group_id())})
            result = await adapter.send(
                Target.from_event(event), [{"type": "image", "data": {"file": f"base64://{card}"}}],
            )
            if isinstance(result, dict) and (result.get("status") == "failed"
                                              or result.get("retcode", 0) not in (0, None)):
                return False
            remember_outbound = getattr(self, '_remember_outbound_image', None)
            if callable(remember_outbound):
                remember_outbound(event, result, str(card))
            logger.info(f"媒体限制卡片：独立封面已发送 target={destination} result={result!r}")
            return True
        except Exception as error:
            logger.warning(f"媒体限制卡片发送失败（继续发送限制提示）：{error}")
            return False

    async def _deliver_reply_chains(self, event, reply_chains, prefix):
        """Keep text in AstrBot; deliver standalone QQ stickers via OneBot.

        RespondStage validates exact component classes, so a custom sticker
        alone is considered empty even though the OneBot serializer supports it.
        Send it directly with an acknowledgement instead of yielding that chain.
        """
        for index, original_chain in enumerate(reply_chains):
            chain = prefix + original_chain if index == 0 and prefix else original_chain
            if any(isinstance(component, QqSticker) for component in chain):
                private = event.is_private_chat()
                action = "send_private_msg" if private else "send_group_msg"
                destination = ({"user_id": int(event.get_sender_id())} if private
                               else {"group_id": int(event.get_group_id())})
                try:
                    result = await transport_for(self, event=event).send(
                        Target.from_event(event), [component.toDict() for component in chain],
                    )
                    if not isinstance(result, dict) or result.get("status") == "failed" or result.get("retcode", 0) not in (0, None):
                        raise RuntimeError("OneBot 未确认龙图发送成功")
                    data = result.get("data") if isinstance(result.get("data"), dict) else result
                    message_id = data.get("message_id")
                    if message_id is None:
                        raise RuntimeError("OneBot 龙图发送缺少 message_id 回执")
                    logger.info(f"龙图表情发送成功：target={destination} message_id={message_id}")
                except Exception as error:
                    # A timeout may already have delivered the sticker. Do not
                    # blindly resend and duplicate it; surface the failed send.
                    logger.warning(f"龙图表情发送失败：target={destination} error={error}")
                    raise
            else:
                yield transport_for(self, event=event).reply_result(event, chain)
            if index + 1 < len(reply_chains):
                await asyncio.sleep(0.12)

    async def _send_forward_from_backend(self, event: AstrMessageEvent, response: dict) -> bool:
        message = next((item for item in response.get("messages", []) if item.get("type") == "forward"), None)
        if not message:
            return False
        bot = getattr(event, "bot", None)
        adapter = transport_for(self, bot=bot)
        if not adapter.available:
            return False
        private = event.is_private_chat()
        destination = {"user_id": int(event.get_sender_id())} if private else {"group_id": int(event.get_group_id())}
        forward_action = "send_private_forward_msg" if private else "send_group_forward_msg"
        image_action = "send_private_msg" if private else "send_group_msg"
        images = [str(url) for url in message.get("images", []) if str(url).startswith(("http://", "https://"))][:18]
        if not images:
            return False
        # The introduction is a separate image. Forward nodes contain only the
        # original gallery, including its first image, in source order.
        try:
            card = await self._video_card({**message, "coverUrl": images[0]})
            if card:
                result = await adapter.send(Target.from_event(event),
                    [{"type": "image", "data": {"file": f"base64://{card}"}}])
                if isinstance(result, dict) and (result.get("status") == "failed" or result.get("retcode", 0) not in (0, None)):
                    raise RuntimeError("QQ 简介卡片接口返回失败")
                remember_outbound = getattr(self, '_remember_outbound_image', None)
                if callable(remember_outbound):
                    remember_outbound(event, result, str(card))
                logger.info(f"图文简介卡片：独立图片消息已发送 target={destination} result={result!r}")
        except Exception as error:
            logger.warning(f"图文简介卡片发送失败：{error}")
        sender_id = str(event.get_self_id() or "2170902293")
        sender_name = str(getattr(getattr(event, "message_obj", None), "self_id", "") or "龙玉涛")
        nodes = [{
            "type": "node", "data": {"uin": sender_id, "name": sender_name,
            "content": [{"type": "image", "data": {"file": url}}]},
        } for url in images]
        try:
            # Only an explicit rejection can safely fall back to individual
            # images. Missing receipts and connection errors may mean QQ has
            # already accepted the forward; never retry them automatically.
            result = await adapter.send_forward(Target.from_event(event), nodes)
            logger.info(f"小红书图文合并转发已发送：target={destination} images={len(images)} result={result!r}")
            return True
        except Exception as error:
            if isinstance(error, DeliveryError) and error.outcome == 'unknown':
                raise
            logger.warning(f"小红书图文合并转发失败，改为逐图发送：group={event.get_group_id()} error={error}")
            sent = 0
            for url in images:
                try:
                    result = await adapter.send(Target.from_event(event), [{"type": "image", "data": {"file": url}}])
                    if isinstance(result, dict) and (result.get("status") == "failed" or result.get("retcode", 0) not in (0, None)):
                        raise RuntimeError("QQ 图片接口返回失败")
                    sent += 1
                except Exception as image_error:
                    logger.warning(f"小红书图片发送失败：group={event.get_group_id()} error={image_error}")
            return sent > 0

    async def _recent_group_context(self, event: AstrMessageEvent, payload: dict) -> dict:
        if (event.is_private_chat() or payload.get("observe_only")
                or payload.get("media_share")
                or self._reply_component(event.get_messages()) is not None
                or not self._is_explicitly_at_bot(event)):
            return {}
        try:
            context = await fetch_recent_group_context(
                event, self._forward_image_base64,
                text=self._raw_text(event),
                pure_mention=bool(payload.get("pure_bot_mention")),
                include_images=not payload.get("has_image"),
                transport=transport_for(self, event=event),
            )
            logger.info(
                f"QQ 艾特回看群聊：group={event.get_group_id()} "
                f"messages={len(context.get('messages', []))} images={len(context.get('images', []))}",
            )
            return context
        except Exception as error:
            logger.warning(f"QQ 群聊回看暂不可用，沿用已有语境：{type(error).__name__}")
            return {}

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
            payload = self._pure_mention_payload(event, group_info)
            payload["recent_group_context"] = await self._recent_group_context(event, payload)
            response = await self._request_backend(payload)
        except Exception as error:
            logger.error(f"纯 At 前置兜底请求失败，保持静默以避免默认客服回复：{error}")
            event.stop_event()
            return

        reply_chain = self._reply_chain_from_backend(response)
        if reply_chain:
            await self._sleep_before_reply(event, response)
            reply_chain = self._reply_prefix(event, event.get_messages()) + reply_chain
            await transport_for(self, event=event).send_event(event, MessageChain(chain=reply_chain))
            event.set_extra("longtu_pure_mention_sent", True)
            logger.info(
                "纯 At 未进入 Adapter handler，已在默认 LLM 前改走 Node 人格回复",
            )
        else:
            logger.info("纯 At 前置兜底被 Node 判定为静默")
        event.stop_event()

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
                entry_command, entry_value = self._crazy_thursday_entry_command(event)
                if entry_command:
                    # 文案收集只允许超管私聊，群里静默忽略，避免把管理命令
                    # 和长文案刷进群聊；实际权限和内容校验仍由 Node 再做一次。
                    if not event.is_private_chat():
                        return
                    requested_by = str(event.get_sender_id() or "").strip()
                    entry_payload = {
                        "message_id": str(event.message_obj.message_id or ""),
                        "message_type": "private",
                        "group_id": event.get_group_id(),
                        "user_id": requested_by,
                        "sender_name": event.get_sender_name(),
                        "text": "",
                        "crazy_thursday_request": True,
                        "crazy_thursday_add": entry_command == "add",
                        "crazy_thursday_list": entry_command == "list",
                        "crazy_thursday_delete": entry_value if entry_command == "delete" else "",
                        "crazy_thursday_entry": entry_value if entry_command == "add" else "",
                    }
                    try:
                        response = await self._request_backend(entry_payload)
                        texts = [
                            str(item.get("text") or "").strip()
                            for item in response.get("messages", [])
                            if isinstance(item, dict) and item.get("type") == "text"
                        ]
                        if texts:
                            for generated in texts:
                                yield event.plain_result(generated)
                        else:
                            yield event.plain_result("文案管理没有返回结果，请检查 QQ Bot 服务日志。")
                    except Exception as error:
                        logger.error(f"疯狂星期四文案管理失败：{error}")
                        yield event.plain_result("疯狂星期四文案管理失败，请检查服务日志。")
                    return
                if self._crazy_thursday_command(event):
                    # /crazy-thursday 是超管私聊调试入口；群聊只保留定时推送，
                    # 不回权限提示，避免把测试命令本身刷进群里。
                    if not event.is_private_chat():
                        return
                    requested_by = str(event.get_sender_id() or "").strip()
                    target_date = datetime.now(REPORT_TIMEZONE).date()
                    test_payload = {
                        "message_id": str(event.message_obj.message_id or ""),
                        "message_type": "private" if event.is_private_chat() else "group",
                        "group_id": event.get_group_id(),
                        "user_id": requested_by,
                        "sender_name": event.get_sender_name(),
                        "text": "",
                        "crazy_thursday_request": True,
                        "crazy_thursday_test": True,
                        "crazy_thursday_date": target_date.isoformat(),
                        "crazy_thursday_holiday_context": nearby_holiday_context(target_date),
                    }
                    try:
                        response = await self._request_backend(test_payload)
                        texts = [
                            str(item.get("text") or "").strip()
                            for item in response.get("messages", [])
                            if isinstance(item, dict) and item.get("type") == "text"
                        ]
                        if texts:
                            for generated in texts:
                                yield event.plain_result(generated)
                        else:
                            yield event.plain_result("没有生成文案，请检查 QQ Bot 服务日志。")
                    except Exception as error:
                        logger.error(f"手动测试疯狂星期四失败：{error}")
                        yield event.plain_result("疯狂星期四测试失败，请检查服务日志。")
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
            import_lookup = getattr(self, '_relation_import_active', None)
            importing = bool(callable(import_lookup) and import_lookup(event))
            if importing and (event.is_private_chat() or self._group_is_allowed(event)):
                should_reply = True
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
            import_images = importing or bool(re.match(r"^/rel-import(?:\s|$)", text, re.IGNORECASE))
            reply_component = self._reply_component(components)
            quoted_chain = getattr(reply_component, "chain", None) or []
            if should_reply and reply_component:
                quoted_chain = await self._quoted_message_chain(
                    event,
                    reply_component,
                    quoted_chain,
                )
            quoted_visual_chain = self._quoted_visual_chain(event, reply_component, quoted_chain, '/rel-import' if import_images else text)
            outbound_quote_lookup = getattr(self, '_outbound_images_for_quote', None)
            cached_outbound_quote_images = (
                outbound_quote_lookup(reply_component)
                if should_reply and reply_component and callable(outbound_quote_lookup)
                else []
            )
            # 回捞成功时也保留这个标记：短时回执缓存不仅用于补回图片字节，
            # 还用于告诉 Node 这不是用户图片，而是 Bot 自己发出的分享卡。
            bot_generated_image_reference = bool(cached_outbound_quote_images)
            bot_generated_image_reference_from_recent = False
            has_image = any(
                isinstance(component, Comp.Image)
                for component in components
            ) or any(
                isinstance(component, Comp.Image)
                for component in quoted_visual_chain
            )
            has_forward = bool(
                self._forward_components(components)
                or self._forward_components(quoted_chain)
            )
            rich_segments = self._rich_segments(event, quoted_chain)
            has_rich = bool(rich_segments)
            raw_media_text = self._raw_text(event) or event.message_str or ""
            # 平台白名单要看链接才能判断，分享地址可能只在富段卡片里。
            media_group_enabled = self._media_group_enabled(
                event, " ".join([raw_media_text, str(rich_segments)]),
            )
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
            # 外部分享可能由 QQ 表示为 video/json/xml 富段；纯原生视频没有
            # 分享链接或卡片元数据时才跳过媒体解析。
            has_media_payload = any(
                isinstance(item, dict)
                and item.get("type") in {"json", "xml"}
                for item in rich_segments
            ) or any(
                isinstance(item, dict)
                and item.get("type") == "video"
                and isinstance(item.get("data"), dict)
                and not NATIVE_QQ_VIDEO_PATTERN.search(
                    str(item["data"].get("url") or ""),
                )
                for item in rich_segments
            ) or bool(
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
                    refresh=True,
                )
                quoted_forwarded_text, quoted_forward_image_base64s = await self._forwarded_content(
                    event,
                    quoted_chain,
                    refresh=True,
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
            quoted_image_sub_types = []
            import_image_notice = ""
            # 被动旁观消息不调用 Node/模型，但把最近一批图片短暂缓存在
            # AstrBot 插件内，支持“先发图、下一条再 @ 机器人评价”的消息习惯。
            # 缓存有严格的群数、图片数、总字节和 TTL 上限，不会进入旁观用量统计。
            if has_image:
                try:
                    if import_images:
                        image_base64s = await self._image_base64s(components, limit=MAX_FORWARD_IMAGE_COMPONENTS)
                        quoted_image_base64s = await self._image_base64s(quoted_visual_chain, limit=MAX_FORWARD_IMAGE_COMPONENTS)
                        expected_images = sum(isinstance(item, Comp.Image) for item in [*components, *quoted_visual_chain])
                        if expected_images > len(image_base64s) + len(quoted_image_base64s):
                            import_image_notice = "部分图片读取失败或超过单次 24 张上限，请分批重发未导入图片。"
                    else:
                        image_base64s = await self._image_base64s(components)
                        quoted_image_base64s = await self._image_base64s(quoted_visual_chain)
                except Exception as error:
                    logger.warning(f"QQ 图片读取失败：{type(error).__name__}")
                    if import_images:
                        import_image_notice = "部分图片读取失败，请分批重发未导入图片。"

            # NapCat 回捞不到机器人自己刚发的普通图片时，使用发送回执对应
            # 的短时副本。龙图表情从不写入此缓存，因此仍保持静默。
            if should_reply and cached_outbound_quote_images and not quoted_image_base64s:
                quoted_image_base64s = cached_outbound_quote_images
                quoted_image_sub_types = ["0"] * len(quoted_image_base64s)
                has_image = True
                logger.info(
                    f"已从机器人发送回执缓存恢复 {len(quoted_image_base64s)} 张引用图片",
                )

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
            if should_reply and not import_images and reply_component is None and not (
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
                else:
                    outbound_reference_lookup = getattr(self, '_outbound_images_for_reference', None)
                    outbound_images = (
                        outbound_reference_lookup(event, text)
                        if callable(outbound_reference_lookup)
                        else []
                    )
                    if outbound_images:
                        image_base64s = outbound_images
                        has_image = True
                        bot_generated_image_reference = True
                        bot_generated_image_reference_from_recent = True
                        logger.info(
                            f"已将最近发送的 {len(outbound_images)} 张分享卡带入本轮 QQ 视觉请求",
                        )

            bot_user_id = str(event.get_self_id() or "").strip()
            group_info = (
                await self._group_info(event.get_group_id())
                if not event.is_private_chat()
                else {}
            )
            bot_generated_image_only = bot_generated_image_reference and (
                bot_generated_image_reference_from_recent
                or not any((
                    image_base64s,
                    quoted_forward_image_base64s,
                    forward_image_base64s,
                    observed_forward_images,
                    observed_quoted_forward_images,
                ))
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
                "quoted_message_id": str(getattr(reply_component, "id", "") or ""),
                "forwarded_text": forwarded_text,
                "quoted_forwarded_text": quoted_forwarded_text,
                "quoted_user_id": quoted_user_id,
                "quoted_sender_name": quoted_sender_name,
                "mentions": self._mentions(components),
                "bot_user_id": bot_user_id,
                "has_image": has_image,
                "pure_bot_mention": pure_bot_mention,
                "image_base64s": image_base64s,
                "image_input_notice": import_image_notice,
                "quoted_image_base64s": quoted_image_base64s,
                "forward_image_base64s": forward_image_base64s,
                "quoted_forward_image_base64s": quoted_forward_image_base64s,
                # _quoted_visual_chain 已过滤明确的 sub_type=1 龙图表情；
                # 发送显式的普通图片标记，让 Node 不再按旧版兼容逻辑把
                # 机器人引用消息里的所有图片一并清空。
                "quoted_image_sub_types": quoted_image_sub_types or ["0"] * len(quoted_image_base64s),
                "quoted_bot_generated_image": bot_generated_image_reference,
                "bot_generated_image_only": bot_generated_image_only,
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
                    or bool(MEDIA_ACK_PATTERN.search(str(rich_segments)))
                ),
                # 保留旧字段，便于旧版 Node 服务平滑升级。
                "image_base64": image_base64s[0] if image_base64s else "",
                "quoted_image_base64": quoted_image_base64s[0] if quoted_image_base64s else "",
                "observe_only": observe_only,
            }

            try:
                payload["recent_group_context"] = await self._recent_group_context(event, payload)
                response = await self._request_backend(payload)
                import_update = getattr(self, '_update_relation_import', None)
                if callable(import_update):
                    import_update(event, response)
            except Exception as error:
                logger.error(f"龙图 QQ Bridge 请求失败：{error}")
                if has_media_signal:
                    with contextlib.suppress(Exception):
                        await self._react_media_result(event, False)
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

            await self._sleep_before_reply(event, response)

            if response.get("mode") == "media-unavailable":
                with contextlib.suppress(Exception):
                    await self._react_media_result(event, False)
                # A known cover is still useful when the video is rejected by
                # the size/duration guard. Send it before the textual reason;
                # failures here must not suppress that reason.
                with contextlib.suppress(Exception):
                    await self._send_media_limit_card(event, response)

            # 图文分享（小红书图集）在这里就把结果发完了，和视频一样要给出
            # 结果回应。判据用 _send_forward_from_backend 的返回值：它是照
            # OneBot 回执得出的，比 yield 有没有抛异常可靠——RespondStage
            # 发送失败只记日志、不会让 yield 抛出。
            gallery_mode = response.get("mode") == "media-gallery"
            if await self._send_forward_from_backend(event, response):
                if gallery_mode:
                    with contextlib.suppress(Exception):
                        await self._react_media_result(event, True)
                return
            if gallery_mode:
                # 合并转发和逐图发送都被 QQ 拒了。下面的原生图片链是最后一次
                # 尝试，但它走同一个接口发同一批地址，成功概率很低。
                with contextlib.suppress(Exception):
                    await self._react_media_result(event, False)

            reply_chains = self._reply_chains_from_backend(response)

            # Send each backend part in order. This lets a complete answer read
            # like a short group conversation and keeps the optional meme last.
            if reply_chains:
                if response.get("mode") == "media":
                    video_messages = [item for item in response.get("messages", [])
                                      if item.get("type") == "video" and item.get("url")]
                    video_message = video_messages[0] if video_messages else {}
                    # Card identity belongs to the source video author.
                    video_message = dict(video_message)
                    logger.info(
                        f"视频分享数据：title={str(video_message.get('title') or '')[:80]} "
                        f"cover={'yes' if video_message.get('coverUrl') else 'no'} "
                        f"videos={len(video_messages)} previews={len(video_message.get('images') or [])}",
                    )
                    # Keep the card separate: a cover failure must not cancel
                    # video delivery, and neither result proves video success.
                    async def _deliver_card() -> bool:
                        try:
                            card = await self._video_card(video_message)
                            logger.info(f"视频分享卡片：{'generated' if card else 'fallback'}")
                            if not card:
                                return
                            bot = getattr(event, "bot", None)
                            adapter = transport_for(self, bot=bot)
                            private = event.is_private_chat()
                            action = "send_private_msg" if private else "send_group_msg"
                            destination = {"user_id": int(event.get_sender_id())} if private else {"group_id": int(event.get_group_id())}
                            if not adapter.available:
                                raise RuntimeError("QQ Bot API 不支持 call_action")
                            result = await adapter.send(
                                Target.from_event(event), [{"type": "image", "data": {"file": f"base64://{card}"}}],
                            )
                            if isinstance(result, dict) and (result.get("status") == "failed" or result.get("retcode", 0) not in (0, None)):
                                raise RuntimeError(f"QQ 图片接口返回失败：{result!r}")
                            remember_outbound = getattr(self, '_remember_outbound_image', None)
                            if callable(remember_outbound):
                                remember_outbound(event, result, str(card))
                            logger.info(f"视频分享卡片：OneBot 图片回执={result!r}")
                            logger.info("视频分享卡片：独立图片消息已发送")
                            return True
                        except Exception as error:
                            logger.warning(f"视频分享卡片发送失败（不影响视频）：{error}")
                            return False
                    # Keep the visible order consistent with XHS: card first,
                    # then video. Card delivery is bounded and best effort; a
                    # failed/slow cover must still fall through to the video.
                    try:
                        await asyncio.wait_for(_deliver_card(), timeout=12)
                    except Exception as error:
                        logger.warning(f"视频分享卡片等待失败（继续发送视频）：{error}")
                    if len(video_messages) > 1:
                        # Prefer a single QQ merged-forward record so a
                        # multi-video share remains one coherent chat item.
                        if await self._send_video_bundle_from_backend(event, video_messages):
                            with contextlib.suppress(Exception):
                                await self._react_media_result(event, True)
                            return
                        delivered = 0
                        for item in video_messages:
                            if await self._send_video_from_backend(
                                event, item, react_result=False, send_failure_notice=False,
                            ):
                                delivered += 1
                        with contextlib.suppress(Exception):
                            await self._react_media_result(event, delivered == len(video_messages))
                        if delivered != len(video_messages) and delivered == 0:
                            source_id = str(getattr(getattr(event, 'message_obj', None), 'message_id', '') or '')
                            notice = '多视频分享发送失败，未收到 QQ 成功回执。请稍后重试，或点击分享前往平台观看。'
                            with contextlib.suppress(Exception):
                                segments = [{'type': 'text', 'data': {'text': notice}}]
                                if source_id:
                                    segments.insert(0, {'type': 'reply', 'data': {'id': source_id}})
                                await asyncio.wait_for(transport_for(self, event=event).send(Target.from_event(event), segments), timeout=15)
                    else:
                        await self._send_video_from_backend(event, video_message)
                    return
                # 主动插话应该像群友自己发言，不挂在触发它的普通消息下面；明确
                # @、引用和私聊等被动问答仍保留原有引用/送达前缀。
                # 媒体结果直接发成可播放视频，不再挂引用；普通对话继续保留
                # 原有引用和 @ 送达前缀。
                prefix = [] if bool(response.get("active_reply")) else self._reply_prefix(event, components)
                async for result in self._deliver_reply_chains(event, reply_chains, prefix):
                    yield result
        finally:
            event.stop_event()
