import { DatabaseSync } from 'node:sqlite';
import { MemeKnowledgeStore } from '../src/meme-knowledge.js';

// Reuse completed video evidence; never promote a candidate to verified facts.
const [learningPath, knowledgePath] = process.argv.slice(2);
if (!learningPath || !knowledgePath) throw new Error('Usage: node scripts/backfill-video-candidates.mjs LEARNING_DB KNOWLEDGE_DB');
const learning = new DatabaseSync(learningPath);
const knowledge = new MemeKnowledgeStore({ databaseFilePath: knowledgePath });
const accepted = new Set();
let written = 0;
try {
  for (const row of learning.prepare("SELECT task_key,result_json FROM video_learning_tasks WHERE status = 'completed' ORDER BY updated_at ASC").all()) {
    const result = JSON.parse(row.result_json);
    const merged = result.merged;
    if (!result.found || !result.entry || result.entry.verified !== false || merged?.confidence !== 'medium') continue;
    const entry = { ...result.entry, confidence: 'medium', verified: false, lookupSource: 'video',
      meaning: [merged.meaning, merged.mechanism ? `笑点：${merged.mechanism}` : '',
        merged.soundUnconfirmed ? '（声音因素未确认）' : ''].filter(Boolean).join(' ').slice(0, 500),
      lyrics: [], currentEvents: [], reception: {}, replyHooks: [] };
    if (knowledge.putCandidate(entry)) written++;
    const hit = knowledge.lookup(entry.term);
    if (hit?.confidence !== 'medium' && hit?.confidence !== 'high') continue;
    accepted.add(row.task_key);
    learning.prepare('UPDATE video_learning_tasks SET result_json = ? WHERE task_key = ?')
      .run(JSON.stringify({ ...result, entry }), row.task_key);
  }
  for (const row of learning.prepare('SELECT source_key,progress_json FROM video_learning_progress').all()) {
    const state = JSON.parse(row.progress_json);
    let changed = false;
    for (const item of state.run?.items || []) {
      if (!accepted.has(item.taskKey) || item.status !== 'failed') continue;
      const result = JSON.parse(learning.prepare('SELECT result_json FROM video_learning_tasks WHERE task_key = ?').get(item.taskKey).result_json);
      Object.assign(item, { status: 'candidate', meaning: result.entry.meaning, replyHooks: [],
        error: '已存全局候选记忆，可用于接梗；事实待核实' });
      state.failed = Math.max(0, (Number(state.failed) || 0) - 1);
      state.candidate = (Number(state.candidate) || 0) + 1;
      if (state.last?.bvid === item.bvid) state.last.status = 'candidate';
      changed = true;
    }
    if (changed) learning.prepare('UPDATE video_learning_progress SET progress_json = ? WHERE source_key = ?').run(JSON.stringify(state), row.source_key);
  }
  console.log(JSON.stringify({ written, usableTasks: accepted.size }));
} finally { learning.close(); knowledge.close(); }
