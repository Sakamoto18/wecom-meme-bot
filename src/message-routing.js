import { shouldUseAttackStyle } from './response-style.js';
import { isLongtuRequest } from './triggers.js';

export function shouldReplyOnlyWithLongtu(content, history = []) {
  return isLongtuRequest(content) && !shouldUseAttackStyle(content, history);
}
