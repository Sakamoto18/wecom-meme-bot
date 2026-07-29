import {
  buildAttackPrompt,
  buildAttackRetryPrompt,
  buildNormalReplyPrompt,
  buildSeriousReplyRetryPrompt,
  isThinSeriousReply,
  removeLiteralLatinMa,
  reviewAttackReply,
  selectAttackScene,
  shouldSearchLongtuKnowledge,
  shouldUseThinking,
  shouldUseAttackStyle,
} from './response-style.js';

function emptySearchResult() {
  return {
    context: '',
    query: '',
    resultCount: 0,
    results: [],
    fromCache: false,
  };
}

export async function generateConversationReply(options) {
  const {
    content,
    modelInput,
    history = [],
    chatClient,
    webSearch,
    webSearchEnabled = true,
    knowledgeContext = '',
  } = options;

  if (!chatClient?.isConfigured) {
    throw new Error('普通对话服务还没配好');
  }

  if (shouldUseAttackStyle(content, history)) {
    const firstScene = selectAttackScene(history);
    const firstDraft = await chatClient.complete(history, modelInput, {
      additionalSystemPrompt: buildAttackPrompt(content, {
        history,
        attackScene: firstScene,
      }),
      maxTokens: 220,
      thinking: { type: 'disabled' },
    });
    const firstReview = reviewAttackReply(firstDraft, { history });
    let answer = firstDraft;
    let review = firstReview;
    let attempts = 1;

    if (!firstReview.valid) {
      const retryScene = selectAttackScene(history, {
        excludeIds: [firstScene.id],
      });
      const secondDraft = await chatClient.complete(history, modelInput, {
        additionalSystemPrompt: buildAttackRetryPrompt(
          content,
          firstDraft,
          firstReview.issues,
          { history, attackScene: retryScene },
        ),
        maxTokens: 220,
        thinking: { type: 'disabled' },
      });
      const secondReview = reviewAttackReply(secondDraft, { history });
      attempts = 2;

      if (secondReview.issues.length <= firstReview.issues.length) {
        answer = secondDraft;
        review = secondReview;
      }
    }

    answer = removeLiteralLatinMa(answer);
    review = reviewAttackReply(answer, { history });

    return {
      answer,
      mode: 'generated-attack',
      references: [],
      review,
      attempts,
      searchResult: emptySearchResult(),
      searchError: null,
      searchAttempted: false,
      usedModel: true,
    };
  }

  const searchAttempted = Boolean(
    webSearchEnabled
    && webSearch
    && shouldSearchLongtuKnowledge(content),
  );
  let searchResult = emptySearchResult();
  let searchError = null;

  if (searchAttempted) {
    try {
      searchResult = await webSearch.search(content);
    } catch (error) {
      searchError = error;
    }
  }

  const useLongtuKnowledge = shouldSearchLongtuKnowledge(content);
  const thinkingEnabled = shouldUseThinking(content);
  const additionalSystemPrompt = [
    buildNormalReplyPrompt({ thinkingEnabled }),
    useLongtuKnowledge ? knowledgeContext : '',
    searchResult.context,
  ].filter(Boolean).join('\n\n');
  let answer;
  let thinkingFallback = false;
  let seriousAnswerExpanded = false;
  let attempts = 1;
  try {
    answer = await chatClient.complete(history, modelInput, {
      additionalSystemPrompt,
      maxTokens: thinkingEnabled ? 20_000 : 5_000,
      timeoutMs: thinkingEnabled ? 120_000 : 60_000,
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
    });
  } catch (error) {
    if (!thinkingEnabled || !/空内容/.test(error.message)) throw error;
    thinkingFallback = true;
    answer = await chatClient.complete(history, modelInput, {
      additionalSystemPrompt,
      maxTokens: 8_000,
      timeoutMs: 60_000,
      thinking: { type: 'disabled' },
    });
  }

  if (thinkingEnabled && !thinkingFallback && isThinSeriousReply(answer)) {
    try {
      const expandedAnswer = await chatClient.complete(history, modelInput, {
        additionalSystemPrompt: [
          additionalSystemPrompt,
          buildSeriousReplyRetryPrompt(content, answer),
        ].join('\n\n'),
        maxTokens: 20_000,
        timeoutMs: 180_000,
        thinking: { type: 'enabled' },
      });
      attempts += 1;
      seriousAnswerExpanded = true;
      if (String(expandedAnswer ?? '').trim().length >= String(answer ?? '').trim().length) {
        answer = expandedAnswer;
      }
    } catch {
      // 完整性复核失败时保留已有答案，避免整轮对话无回复。
    }
  }

  return {
    answer: String(answer ?? '').trim(),
    mode: useLongtuKnowledge ? 'longtu-knowledge' : 'model',
    references: [],
    review: null,
    attempts,
    searchResult,
    searchError,
    searchAttempted,
    thinkingEnabled,
    thinkingFallback,
    seriousAnswerExpanded,
    usedModel: true,
  };
}
