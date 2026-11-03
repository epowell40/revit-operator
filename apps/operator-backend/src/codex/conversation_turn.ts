import {withSerializedProviderTurn} from '../provider_turn_queue.js';

/** Serialize a conversation without conflating it with the outer desktop relay. */
export function withCodexConversationTurn<T>(args: {
  workspace: string; sessionId: string; signal?: AbortSignal; onWait?: () => void;
}, run: () => Promise<T>): Promise<T> {
  return withSerializedProviderTurn({...args,namespace:'codex-conversation'},run);
}