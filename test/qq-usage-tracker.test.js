import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongtuWebSearch } from '../src/web-search.js';
import {
  QqUsageLimitError,
  QqUsageTracker,
} from '../src/qq-usage-tracker.js';

function createTracker(options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qq-usage-'));
  const tracker = new QqUsageTracker({
    databaseFilePath: path.join(directory, 'usage.sqlite'),
    now: () => Date.UTC(2026, 7, 25, 4),
    adaptiveLimitsEnabled: false,
    ...options,
  });
  return {
    tracker,
    close() {
      tracker.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('按群记录真实 LLM Token、缓存命中和折算配额', async () => {
  const fixture = createTracker({ cachedTokenWeightPercent: 10 });
  const client = fixture.tracker.wrapChatClient({
    model: 'test-model',
    isConfigured: true,
    async complete(_history, _content, options) {
      options.onUsage({
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        },
      });
      return 'ok';
    },
  });

  try {
    await fixture.tracker.runWithContext({
      groupId: 'group-1',
      userId: 'user-1',
      messageType: 'group',
      largeGroup: true,
    }, () => client.complete([], 'hello', { usageSource: 'conversation-reply' }));
    const report = fixture.tracker.getReport();

    assert.equal(report.groups[0].groupId, 'group-1');
    assert.equal(report.groups[0].largeGroup, true);
    assert.equal(report.groups[0].inputTokens, 1_000);
    assert.equal(report.groups[0].outputTokens, 100);
    assert.equal(report.groups[0].cachedInputTokens, 800);
    assert.equal(report.groups[0].quotaTokens, 380);
    assert.equal(report.sources[0].source, 'conversation-reply');
    assert.equal(report.dataAvailableFrom, Date.UTC(2026, 7, 25, 4));
  } finally {
    fixture.close();
  }
});

test('所有群按近期开口人数和消息活跃度动态获得配额', async () => {
  let now = Date.UTC(2026, 7, 25, 4);
  const fixture = createTracker({
    now: () => now,
    adaptiveLimitsEnabled: true,
    activityLookbackDays: 7,
    activityProfileCacheMs: 1,
    activityMessageThresholds: [2, 4, 6, 8],
    activityUserThresholds: [2, 3, 4, 5],
    activityLimitPercentages: [50, 60, 70, 80, 100],
    maxGroupLlmCallsPerHour: 10,
    maxLargeGroupLlmCallsPerHour: 4,
    maxGroupLlmTokensPerDay: 1_000,
    maxGroupSearchCallsPerDay: 20,
    groupLlmLimits: new Map([['fixed-group', 6]]),
  });

  try {
    fixture.tracker.recordRequest({
      groupId: 'adaptive-group', userId: 'user-1', messageType: 'group',
    });
    assert.deepEqual(
      fixture.tracker.getGroupActivityProfile('adaptive-group'),
      {
        tier: 'quiet',
        limitPercent: 50,
        messagesPerDay: 1,
        activeUsersPerDay: 1,
        lookbackDays: 7,
      },
    );
    assert.equal(fixture.tracker.groupLlmCallLimit({
      groupId: 'adaptive-group', largeGroup: false,
    }), 5);
    assert.equal(fixture.tracker.groupLlmTokenLimit({
      groupId: 'adaptive-group', largeGroup: false,
    }), 500);
    assert.equal(fixture.tracker.groupSearchLimit({
      groupId: 'adaptive-group', largeGroup: false,
    }), 10);

    now += 2;
    fixture.tracker.recordRequest({
      groupId: 'adaptive-group', userId: 'user-2', messageType: 'group',
    });
    assert.equal(
      fixture.tracker.getGroupActivityProfile('adaptive-group').tier,
      'light',
    );
    assert.equal(fixture.tracker.groupLlmCallLimit({
      groupId: 'adaptive-group', largeGroup: false,
    }), 6);
    assert.equal(fixture.tracker.groupLlmCallLimit({
      groupId: 'adaptive-group', largeGroup: true,
    }), 3);

    now += 2;
    fixture.tracker.recordRequest({
      groupId: 'fixed-group', userId: 'user-1', messageType: 'group',
    });
    assert.equal(fixture.tracker.groupLlmCallLimit({
      groupId: 'fixed-group', largeGroup: false,
    }), 3);

    const report = fixture.tracker.getReport();
    const adaptive = report.groups.find((group) => (
      group.groupId === 'adaptive-group'
    ));
    assert.equal(report.adaptiveLimitsEnabled, true);
    assert.equal(adaptive.activityTier, 'light');
    assert.equal(adaptive.activityLimitPercent, 60);
    assert.equal(adaptive.llmCallHardLimitPerHour, 10);
    assert.equal(adaptive.llmCallLimitPerHour, 6);
  } finally {
    fixture.close();
  }
});

test('大型群和单群覆盖会在每次真实 LLM 调用前执行', async () => {
  const fixture = createTracker({
    maxGroupLlmCallsPerHour: 3,
    maxLargeGroupLlmCallsPerHour: 1,
    groupLlmLimits: new Map([['special-group', 1]]),
  });
  const client = fixture.tracker.wrapChatClient({
    model: 'test-model',
    isConfigured: true,
    async complete() { return 'ok'; },
  });

  try {
    await fixture.tracker.runWithContext({
      groupId: 'large-group', largeGroup: true,
    }, () => client.complete([], 'first'));
    await assert.rejects(
      fixture.tracker.runWithContext({
        groupId: 'large-group', largeGroup: true,
      }, () => client.complete([], 'second')),
      (error) => error instanceof QqUsageLimitError
        && error.metric === 'llm-calls'
        && error.limit === 1,
    );

    await fixture.tracker.runWithContext({ groupId: 'special-group' }, () => (
      client.complete([], 'first')
    ));
    await assert.rejects(
      fixture.tracker.runWithContext({ groupId: 'special-group' }, () => (
        client.complete([], 'second')
      )),
      QqUsageLimitError,
    );
  } finally {
    fixture.close();
  }
});

test('每日 Token 保护使用低权重缓存 Token，超额后才阻止后续调用', async () => {
  const fixture = createTracker({
    maxGroupLlmTokensPerDay: 100,
    cachedTokenWeightPercent: 10,
  });
  const client = fixture.tracker.wrapChatClient({
    model: 'test-model',
    isConfigured: true,
    async complete(_history, _content, options) {
      options.onUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 20,
          prompt_cache_miss_tokens: 80,
        },
      });
      return 'ok';
    },
  });

  try {
    await fixture.tracker.runWithContext({ groupId: 'group-token' }, () => (
      client.complete([], 'first')
    ));
    await assert.rejects(
      fixture.tracker.runWithContext({ groupId: 'group-token' }, () => (
        client.complete([], 'second')
      )),
      (error) => error instanceof QqUsageLimitError
        && error.metric === 'llm-tokens'
        && error.limit === 100,
    );
  } finally {
    fixture.close();
  }
});

test('后台用量到预留线后静默收紧，明确请求仍可使用保留配额', async () => {
  const fixture = createTracker({
    maxGroupLlmTokensPerDay: 100,
    passiveTokenBudgetPercent: 70,
  });
  const client = fixture.tracker.wrapChatClient({
    model: 'test-model',
    isConfigured: true,
    async complete(_history, _content, options) {
      options.onUsage({
        usage: { prompt_tokens: 70, completion_tokens: 10 },
      });
      return 'ok';
    },
  });

  try {
    await fixture.tracker.runWithContext({
      groupId: 'reserved-group', source: 'direct-message',
    }, () => client.complete([], 'direct'));
    await assert.rejects(
      fixture.tracker.runWithContext({
        groupId: 'reserved-group', source: 'observed-message',
      }, () => client.complete([], 'passive', {
        usageSource: 'active-reply-decision',
      })),
      (error) => error instanceof QqUsageLimitError
        && error.metric === 'llm-passive-tokens',
    );
    assert.equal(
      await fixture.tracker.runWithContext({
        groupId: 'reserved-group', source: 'direct-message',
      }, () => client.complete([], 'direct-again')),
      'ok',
    );
  } finally {
    fixture.close();
  }
});

test('Exa 复合检索按真实上游请求计数，缓存命中不重复算 API 调用', async () => {
  const fixture = createTracker();
  const queries = [];
  const search = fixture.tracker.wrapWebSearch(new LongtuWebSearch({
    provider: 'exa',
    exaApiKey: 'test-key',
    fallbackEndpoint: null,
    fetchImpl: async (_url, options) => {
      const query = JSON.parse(options.body).query;
      queries.push(query);
      const subject = query === '玄武之声' ? '玄武之声' : '竹知了';
      return new Response(JSON.stringify({
        results: [{
          title: `${subject}资料`,
          url: `https://example.com/${subject}`,
          text: `${subject}的公开网页正文。`,
        }],
      }), { status: 200 });
    },
  }));

  try {
    const task = () => search.search('竹知了和玄武之声到底是什么梗', {
      mode: 'general',
      usageSource: 'web-search-general',
    });
    await fixture.tracker.runWithContext({ groupId: 'search-group' }, task);
    await fixture.tracker.runWithContext({ groupId: 'search-group' }, task);
    const report = fixture.tracker.getReport();

    assert.deepEqual(queries, ['竹知了和玄武之声到底是什么梗', '玄武之声']);
    assert.equal(report.groups[0].searchCalls, 2);
    assert.equal(report.groups[0].searchCacheHits, 1);
  } finally {
    fixture.close();
  }
});

test('联网搜索达到单群日上限后只跳过上游请求', async () => {
  const fixture = createTracker({ maxGroupSearchCallsPerDay: 1 });
  let upstreamCalls = 0;
  const search = fixture.tracker.wrapWebSearch(new LongtuWebSearch({
    provider: 'exa',
    exaApiKey: 'test-key',
    fallbackEndpoint: null,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  }));

  try {
    await fixture.tracker.runWithContext({ groupId: 'search-limited' }, () => (
      search.search('第一个问题', { mode: 'general' })
    ));
    await assert.rejects(
      fixture.tracker.runWithContext({ groupId: 'search-limited' }, () => (
        search.search('第二个问题', { mode: 'general' })
      )),
      (error) => error instanceof QqUsageLimitError
        && error.metric === 'search-calls',
    );
    const report = fixture.tracker.getReport();
    assert.equal(upstreamCalls, 1);
    assert.equal(report.groups[0].searchCalls, 1);
    assert.equal(report.groups[0].blockedSearchCalls, 1);
  } finally {
    fixture.close();
  }
});
