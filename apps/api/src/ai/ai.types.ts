export interface AiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export type AiSpeechAction =
  | { type: "speak"; content: string }
  | { type: "skip" };

export type AiVoteAction = {
  type: "vote";
  targetPlayerId: string;
  reason?: string;
};

export interface ChatMessageInput {
  playerName: string;
  content: string;
  isSelf: boolean;
}

export interface GameContext {
  roundNo: number;
  phase: string;
  remainingTimeMs: number;
  myName: string;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  myLastSpeech: string | null;
  currentVoteCounts: Record<string, number>;
}
