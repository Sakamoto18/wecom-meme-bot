import asyncio
from test import test_merchant_combined as combined
from test import test_merchant_alert as fixtures
from astrbot_plugin_longtu_bridge import merchant_alert as m
from astrbot_plugin_longtu_bridge import merchant_private as p

class ReminderTests(combined.CombinedTests):
    test_group_and_exact_two_private_targets_survive_restart_without_duplicates = None
    test_existing_private_receipts_do_not_suppress_group = None
    test_group_rejection_does_not_block_private_and_retry_does_not_repeat_private = None
    test_private_rejection_does_not_repeat_successful_group = None
    test_missing_private_targets_never_inherits_four_group_mentions = None

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.monitor.bridge.config['merchant_expiry_reminder_enabled'] = True
        self.monitor.mentions.append('1104886947')
        self.early = self.snap['start'] + 60
        self.due = self.snap['end'] - 1800

    async def tick_at(self, now):
        m.time.time.return_value = now
        return await self.monitor.tick(now)

    async def test_at_boundary_three_more_images_and_restart_dedup(self):
        await self.tick_at(self.early)
        await self.tick_at(self.due - 1)
        self.assertEqual(len(self.calls),3)
        await self.tick_at(self.due)
        self.assertEqual(len(self.calls),6)
        for name,args in self.calls[3:]:
            text=next(s['data']['text'] for s in args['message'] if s['type']=='text')
            self.assertIn('最后30分钟',text)
            self.assertTrue(any(s['type']=='image' for s in args['message']))
        group=self.calls[3][1]
        self.assertIn('1104886947',[s['data']['qq'] for s in group['message'] if s['type']=='at'])
        self.assertEqual(m.fetch_snapshot.await_count,2)
        self.assertEqual(p.render_merchant_card.call_count,2)
        path=self.monitor.state.db.execute('PRAGMA database_list').fetchone()[2]
        self.monitor.state.close();self.monitor.state=m.State(path)
        await self.tick_at(self.due+60)
        self.assertEqual(len(self.calls),6)
        self.monitor._tick_official.assert_not_awaited()

    async def test_poll_and_failure_backoff_land_on_reminder_boundary(self):
        self.assertEqual(m.poll_delay(self.due-2),2)
        self.assertEqual(m.retry_delay(self.due-2,5),2)
        self.assertEqual(m.poll_delay(self.due),300)

    async def test_fresh_selection_empty_prevents_expiry_alert(self):
        await self.tick_at(self.early)
        self.monitor.select.return_value=[]
        await self.tick_at(self.due)
        self.assertEqual(len(self.calls),3)
        self.assertEqual(m.fetch_snapshot.await_count,2)

    async def test_late_initial_send_does_not_double_notify(self):
        await self.tick_at(self.due+30)
        await self.tick_at(self.due+330)
        self.assertEqual(len(self.calls),3)

    async def test_disabled_and_expired_do_not_send_reminder(self):
        await self.tick_at(self.early)
        self.monitor.bridge.config['merchant_expiry_reminder_enabled']=False
        await self.tick_at(self.due)
        self.monitor.bridge.config['merchant_expiry_reminder_enabled']=True
        # In the next round our mocked snapshot is expired, so it must not send.
        await self.tick_at(self.snap['end'])
        self.assertEqual(len(self.calls),3)

    async def test_reminder_rejection_retries_only_unsent_private(self):
        await self.tick_at(self.early)
        self.fail='send_private_msg'
        with self.assertRaises(RuntimeError):await self.tick_at(self.due)
        self.fail=None
        await self.tick_at(self.due+30)
        self.assertEqual([n for n,_ in self.calls].count('send_group_msg'),2)
        self.assertEqual([n for n,_ in self.calls].count('send_private_msg'),6)

    async def test_uncertain_private_reminder_is_held_without_blocking_others(self):
        await self.tick_at(self.early)
        action=self.bot.call_action.side_effect
        async def timeout(name,**params):
            if name=='send_private_msg' and params['user_id']==1079175957:
                self.calls.append((name,params))
                raise asyncio.TimeoutError()
            return await action(name,**params)
        self.bot.call_action.side_effect=timeout
        with self.assertRaises(RuntimeError):await self.tick_at(self.due)
        await self.tick_at(self.due+60)
        self.assertEqual(len(self.calls),6)
        key=f'private:1079175957:{int(self.snap["start"])}:expiry30'
        self.assertEqual(self.monitor.state.get(key)[0],'uncertain')
