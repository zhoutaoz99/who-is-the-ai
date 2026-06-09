export type SimulatedHumanIntensity = "normal" | "high";

export const SIMULATED_HUMAN_INTENSITY_ENV = "SIMULATED_HUMAN_INTENSITY";
export const DEFAULT_SIMULATED_HUMAN_INTENSITY: SimulatedHumanIntensity = "normal";

export function getSimulatedHumanIntensity(): SimulatedHumanIntensity {
  const raw = process.env[SIMULATED_HUMAN_INTENSITY_ENV]?.trim().toLowerCase();
  return raw === "high" || raw === "normal"
    ? raw
    : DEFAULT_SIMULATED_HUMAN_INTENSITY;
}

export function getSimulatedHumanSpeechPromptFilename(
  intensity: SimulatedHumanIntensity = getSimulatedHumanIntensity(),
): string {
  return intensity === "high"
    ? "sim-human/system-sim-human-speech-high.txt"
    : "sim-human/system-sim-human-speech.txt";
}

export function getSimulatedHumanVotePromptFilename(
  intensity: SimulatedHumanIntensity = getSimulatedHumanIntensity(),
): string {
  return intensity === "high"
    ? "sim-human/system-sim-human-vote-high.txt"
    : "sim-human/system-sim-human-vote.txt";
}
