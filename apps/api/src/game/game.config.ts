export const MAX_HUMAN_PLAYERS = 5;
export const AI_PLAYER_COUNT = 2;
export const DEBUG_AUTO_AI_PLAYER_COUNT = 3;
export const ACTIVE_ICEBREAKER_PERSONA_ID = "active_icebreaker";
export const MAX_ROUNDS = 4;
export const REWARD_POOL = 2000;
export const DEFAULT_DISCUSSION_DURATION_MS = Number(
  process.env.ROUND_DURATION_MS ?? 300_000,
);
export const MIN_DISCUSSION_DURATION_MS = 60_000;
export const VOTE_DURATION_MS = Number(process.env.VOTE_DURATION_MS ?? 60_000);
export const SPEAK_COOLDOWN_MS = 15_000;
export const MESSAGE_LIMIT = 240;
export const DISCONNECT_GRACE_MS = 30_000;
export const NEXT_ROUND_DELAY_MS = 3_000;
export const AI_SPEECH_INITIAL_CHECK_MS = 10_000;
export const AI_SPEECH_NEXT_CHECK_MIN_MS = 1_000;
export const AI_SPEECH_NEXT_CHECK_MAX_MS = 30_000;
export const AI_SPEECH_RESPONSE_DELAY_MIN_MS = 800;
export const AI_SPEECH_RESPONSE_DELAY_MAX_MS = 20_000;
export const AI_SPEECH_STALE_RETRY_MIN_MS = 500;
export const AI_SPEECH_STALE_RETRY_MAX_MS = 1_500;
export const AI_VOTE_DELAY_MS = 1_500;
export const AI_VOTE_STAGGER_MS = 1_200;
export const AUTO_RESOLVE_DELAY_MS = 500;

export const DEBUG = process.env.DEBUG === "true";

export const AI_NAMES = [
  "林舟",
  "陈默",
  "许知",
  "赵晨",
  "周言",
  "沈星",
  "陆白",
  "江野",
];
