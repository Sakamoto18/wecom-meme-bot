const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAICompatibleChatClient {
  constructor(options) {
    this.apiKey = options.apiKey?.trim();
    this.baseUrl = options.baseUrl?.trim().replace(/\/+$/, '');
    this.model = options.model?.trim();
    this.systemPrompt = options.systemPrompt?.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.temperature = options.temperature ?? 0.8;
    this.maxTokens = options.maxTokens ?? 800;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  async complete(history, userContent, options = {}) {
    if (!this.isConfigured) {
      throw new Error('普通对话服务尚未配置');
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...((options.systemPrompt ?? this.systemPrompt)
              ? [{ role: 'system', content: options.systemPrompt ?? this.systemPrompt }]
              : []),
            ...(options.additionalSystemPrompt
              ? [{ role: 'system', content: options.additionalSystemPrompt }]
              : []),
            ...history,
            { role: 'user', content: userContent },
          ],
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens ?? this.maxTokens,
          stream: false,
          ...(options.thinking ? { thinking: options.thinking } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body?.error?.message ? `：${body.error.message}` : '';
        } catch {
          // 非 JSON 错误页不写入日志，避免泄露上游信息。
        }
        throw new Error(`大模型请求失败（HTTP ${response.status}）${detail}`);
      }

      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('大模型返回了空内容');
      }
      return content;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`大模型请求超时（${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
