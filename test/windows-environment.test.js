import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeEnvironment } from '../scripts/windows/environment.mjs';

test('native launcher preserves personality, search, cache and learning settings without mutating Linux env', () => {
  const saved = Object.freeze({
    QQ_API_TOKEN: 'test-token', QQ_API_HOST: '0.0.0.0',
    QQ_PERSONA_DATABASE_FILE: '/app/data/qq-persona.sqlite',
    LLM_SYSTEM_PROMPT_FILE: 'config/system-prompt.md',
    LLM_BASE_URL: 'https://llm.example', LLM_API_KEY: 'private-test-value',
    QQ_MEDIA_RESOLVE_CACHE_TTL_SECONDS: '600', QQ_TOPIC_MEMORY_ENABLED: 'true',
    WEB_SEARCH_CURRENT_CACHE_TTL_MS: '30000', QQ_GROUP_STYLE_ENABLED: 'true',
    DOUYIN_PROFILE: '/data/profile',
  });
  const env = nativeEnvironment('C:\\longtu-qq-bot', saved);
  for (const key of ['LLM_SYSTEM_PROMPT_FILE', 'LLM_BASE_URL', 'LLM_API_KEY', 'QQ_MEDIA_RESOLVE_CACHE_TTL_SECONDS', 'QQ_TOPIC_MEMORY_ENABLED', 'WEB_SEARCH_CURRENT_CACHE_TTL_MS', 'QQ_GROUP_STYLE_ENABLED']) {
    assert.equal(env[key], saved[key]);
  }
  assert.equal(saved.QQ_API_HOST, '0.0.0.0');
  assert.equal(env.QQ_API_HOST, '127.0.0.1');
  assert.equal(env.LONGTU_QQ_API_TOKEN, saved.QQ_API_TOKEN);
  assert.equal(env.QQ_PERSONA_DATABASE_FILE, 'C:\\longtu-qq-bot\\data\\qq-persona.sqlite');
  assert.equal(env.DOUYIN_PROFILE, 'C:\\longtu-qq-bot\\data\\windows\\douyin-profile');
  assert.equal(env.QQ_MEDIA_PUBLIC_BASE_URL, 'http://127.0.0.1:8787');
});

test('Windows overrides win without discarding inherited system variables', () => {
  const env = nativeEnvironment('C:\\bot', { QQ_API_TOKEN: 'old' },
    { QQ_API_TOKEN: 'new', QQ_MEDIA_FFMPEG_COMMAND: 'D:/ffmpeg.exe' }, { SystemRoot: 'C:\\Windows' });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.LONGTU_QQ_API_TOKEN, 'new');
  assert.equal(env.QQ_MEDIA_FFMPEG_COMMAND, 'D:/ffmpeg.exe');
});
