import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReplyTurnPlanner,
  buildTurnPlanPrompt,
  isConcretePlannerQuery,
  normalizeTurnPlan,
  parseTurnPlan,
} from '../src/reply-turn-planner.js';

test('解析合法战术卡并保留具体检索词', () => {
  const plan = parseTurnPlan(JSON.stringify({
    mode: 'culture',
    answer_required: true,
    first_beat: 'anchor_meme',
    confidence: 0.86,
    attack: {
      decision: 'content',
      target: 'content',
      angle: 'absurdity',
      intensity: 0.4,
      timing: 'after_answer',
      reason: '锐评漏洞本身，不攻击发图者',
    },
    search: {
      fact_needed: true,
      culture_needed: true,
      freshness: 'current',
      fact_queries: ['PHP2Shell CVE-2025-12345 RCE'],
      culture_queries: ['PHP2Shell 漏洞 梗'],
    },
    meme: {
      anchor: 'PHP2Shell 未认证远程代码执行漏洞',
      claim: '把补丁和笑话错位',
      mechanism: '反差',
      information_kind: 'news',
    },
  }));
  assert.equal(plan.mode, 'culture');
  assert.equal(plan.firstBeat, 'anchor_meme');
  assert.equal(plan.answerRequired, true);
  assert.equal(plan.attack.decision, 'content');
  assert.equal(plan.attack.target, 'content');
  assert.equal(plan.search.freshness, 'current');
  assert.deepEqual(plan.search.factQueries, ['PHP2Shell CVE-2025-12345 RCE']);
  assert.equal(plan.meme.informationKind, 'news');
  assert.match(buildTurnPlanPrompt(plan), /首句必须把具体现实主体\/规则和接梗判断放在同一句/);
});

test('战术卡保留群聊说话动作并在非法值时回落', () => {
  const plan = normalizeTurnPlan({
    mode: 'explanation',
    speech_act: 'correction_with_banter',
  });
  assert.equal(plan.speechAct, 'correction_with_banter');
  assert.match(buildTurnPlanPrompt(plan), /本轮说话动作：直接给修正后的事实/);
  assert.equal(normalizeTurnPlan({ speech_act: 'essay' }).speechAct, 'reaction');
});

test('规划保留当前任务与换题关系，旧主题不能接管新问题', () => {
  const plan = normalizeTurnPlan({ current_task: '给晚饭建议', topic_relation: 'switch', speech_act: 'follow_up' });
  assert.equal(plan.currentTask, '给晚饭建议');
  assert.equal(plan.topicRelation, 'switch');
  const prompt = buildTurnPlanPrompt(plan);
  assert.match(prompt, /本轮要完成的事：给晚饭建议/);
  assert.match(prompt, /不把旧主题、旧答案或旧包袱带回来/);
  assert.match(buildTurnPlanPrompt(normalizeTurnPlan({ topic_relation: 'correction' })), /不能继续维护旧答案/);
  assert.equal(normalizeTurnPlan({ topic_relation: 'made_up' }).topicRelation, 'continue');
});

test('非法枚举回落到安全默认值', () => {
  const plan = normalizeTurnPlan({
    mode: 'unsupported-mode',
    first_beat: 'bad-beat',
    attack: {
      decision: 'murder',
      target: 'everyone',
      angle: 'nonsense',
      timing: 'later',
      intensity: 4,
    },
    search: {
      freshness: 'forever',
      fact_queries: 'not-an-array',
      culture_queries: [],
    },
    meme: { information_kind: 'gossip' },
  });
  assert.equal(plan.mode, 'banter');
  assert.equal(plan.firstBeat, 'reaction');
  assert.equal(plan.attack.decision, 'none');
  assert.equal(plan.attack.target, 'none');
  assert.equal(plan.attack.angle, 'none');
  assert.equal(plan.attack.timing, 'none');
  assert.equal(plan.attack.intensity, 0);
  assert.equal(plan.search.freshness, 'none');
  assert.deepEqual(plan.search.factQueries, []);
  assert.equal(plan.meme.informationKind, 'unknown');
});

test('泛词不能成为检索词，具体专名、CVE、数字和独特原句可以', () => {
  for (const query of ['新闻', '这个事件什么意思', '图片', '评价一下', '怎么回事']) {
    assert.equal(isConcretePlannerQuery(query), false, query);
  }
  for (const query of ['PHP2Shell CVE-2025-12345', '昨天的 PHP 漏洞', 'ECDSA 私钥 4 合法', '“不是，你不能解释一下”']) {
    assert.equal(isConcretePlannerQuery(query), true, query);
  }
  const plan = normalizeTurnPlan({
    search: {
      fact_needed: true,
      culture_needed: true,
      fact_queries: ['新闻', '这个事件什么意思', 'PHP2Shell'],
      culture_queries: ['梗', 'PHP2Shell 漏洞 梗'],
    },
  });
  assert.deepEqual(plan.search.factQueries, ['PHP2Shell']);
  assert.deepEqual(plan.search.cultureQueries, ['PHP2Shell 漏洞 梗']);

  const genericOnly = normalizeTurnPlan({
    search: { fact_needed: true, culture_needed: true, fact_queries: ['新闻'], culture_queries: ['梗'] },
  });
  assert.equal(genericOnly.search.factNeeded, true);
  assert.equal(genericOnly.search.cultureNeeded, true);
});

test('保留没有具体查询词的语义检索决定，交给回复链路回退当前消息', () => {
  const plan = normalizeTurnPlan({
    search: {
      fact_needed: true,
      culture_needed: true,
      fact_queries: ['新闻'],
      culture_queries: ['什么梗'],
    },
  });
  assert.equal(plan.search.factNeeded, true);
  assert.equal(plan.search.cultureNeeded, true);
  assert.deepEqual(plan.search.factQueries, []);
  assert.deepEqual(plan.search.cultureQueries, []);
});

test('有现实锚点默认先接梗，明确求证默认先给判断', () => {
  const anchor = normalizeTurnPlan({
    meme: { anchor: '某公司发布会把价格写错' },
  });
  assert.equal(anchor.firstBeat, 'anchor_meme');

  const verdict = normalizeTurnPlan({
    mode: 'verification',
    first_beat: 'unknown',
  });
  assert.equal(verdict.firstBeat, 'verdict');
  assert.match(buildTurnPlanPrompt(verdict), /先给真\/假\/无法确认/);
});

test('规划上下文把昨天换算成绝对日期，并要求证据日期对得上', async () => {
  let captured = null;
  const planner = new ReplyTurnPlanner({
    chatClient: {
      isConfigured: true,
      async complete(_history, _input, options) {
        captured = options;
        return JSON.stringify({
          mode: 'explanation',
          answer_required: true,
          first_beat: 'answer',
          search: {
            fact_needed: true,
            freshness: 'current',
            fact_queries: ['PHP 漏洞 2026-10-21'],
          },
          meme: { anchor: 'PHP 漏洞', information_kind: 'news' },
        });
      },
    },
    logger: { debug() {} },
  });
  const plan = await planner.plan({
    content: '昨天的 PHP 漏洞怎么回事',
    now: Date.parse('2026-10-22T12:00:00+08:00'),
  });
  assert.ok(plan);
  assert.match(captured.sharedContext, /当前北京时间：2026-10-22/);
  assert.match(captured.sharedContext, /相对时间换算：2026-10-21 北京时间/);
  assert.match(captured.systemPrompt, /相对时间规则/);
  assert.match(
    buildTurnPlanPrompt(plan, { recentDateHint: '2026-10-21 北京时间' }),
    /不能把旧闻、旧公告或旧版本更新写成昨天发生/,
  );
});

test('攻击目标缺省跟随决策，但不凭空升级', () => {
  assert.equal(normalizeTurnPlan({
    mode: 'attack',
    attack: { decision: 'reply' },
  }).attack.target, 'current_speaker');
  assert.equal(normalizeTurnPlan({
    attack: { decision: 'target' },
  }).attack.target, 'mentioned_member');
  assert.equal(normalizeTurnPlan({
    attack: { decision: 'none' },
  }).attack.target, 'none');
});

test('规划超时、异常或非法 JSON 时静默降级', async () => {
  const planner = new ReplyTurnPlanner({
    chatClient: {
      isConfigured: true,
      async complete() {
        throw new Error('timeout');
      },
    },
    logger: { debug() {} },
  });
  assert.equal(await planner.plan({ content: '昨天的 PHP 漏洞' }), null);

  const invalid = new ReplyTurnPlanner({
    chatClient: {
      isConfigured: true,
      async complete() {
        return 'not json';
      },
    },
    logger: { debug() {} },
  });
  assert.equal(await invalid.plan({ content: '你好' }), null);
});
