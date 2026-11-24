import { CodexClient } from './client.mjs';
import { Conversation } from '../../conversation.mjs';

// Provider boundary: the manager operates on a conversation lifecycle, not RPC methods.
export function createCodexSession({cwd,writable}) {
  let conversation;
  const client = new CodexClient({serverRequest: request => conversation.requestApproval(request)});
  conversation = new Conversation({client,cwd,writable});
  return {conversation,close:()=>client.close()};
}
