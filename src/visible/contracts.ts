export type ClientKind = "cli" | "app";
export type EntryKind = "codex" | "chatgpt";
export type NativeDeclaration = Record<string, unknown>;
export type NativeOutput = Record<string, unknown>;

export interface OwnerRef {
  launchId: string;
  threadId: string;
  turnId: string;
  epoch: string;
}

export interface BoundTurn extends OwnerRef {
  browserUrl: string;
  userMessageId: string;
  entry: EntryKind;
}

export interface HostContract {
  client: ClientKind;
  version: string;
  evidenceSha256: string;
  supported: boolean;
  blocker?: string;
  openThread(grant: string, requestId: string, signal: AbortSignal): Promise<{ threadId: string; writerId: string }>;
  startTurn(threadId: string, input: { text: string; browserMessageId: string }, signal: AbortSignal): Promise<OwnerRef>;
  cancelTurn(owner: OwnerRef): Promise<void>;
  resumeThread(threadId: string): Promise<{ threadId: string; writerId: string }>;
}

export interface BoundBrowserSource {
  url: string;
  messageId: string;
}
