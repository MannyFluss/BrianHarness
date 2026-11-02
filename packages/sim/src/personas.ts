import type { QuestionStyle } from "@eeg/core";

export interface Persona {
  id: string;
  name: string;
  /** the hidden passion the Director must find */
  passion: string;
  likes: string[];
  dislikes: string[];
  /** hidden question-style preference */
  favoriteStyle: QuestionStyle;
  typing: { charsPerSec: number; baseLatencyMs: number; deleteRate: number };
  /** chance an open question gets an answer about the passion */
  openDrift: number;
}

export const PERSONAS: Persona[] = [
  {
    id: "stargazer",
    name: "Priya (quiet, loves astronomy)",
    passion: "space",
    likes: ["history", "nature"],
    dislikes: ["sports", "fitness"],
    favoriteStyle: "hypothetical",
    typing: { charsPerSec: 4.5, baseLatencyMs: 5000, deleteRate: 0.12 },
    openDrift: 0.35,
  },
  {
    id: "chef",
    name: "Marco (chatty, food obsessed)",
    passion: "cooking",
    likes: ["travel", "music"],
    dislikes: ["programming"],
    favoriteStyle: "personal-story",
    typing: { charsPerSec: 7, baseLatencyMs: 2500, deleteRate: 0.08 },
    openDrift: 0.6,
  },
  {
    id: "terse-dev",
    name: "Sam (terse, secretly into film)",
    passion: "film",
    likes: ["games", "programming"],
    dislikes: ["cooking", "travel"],
    favoriteStyle: "deep-dive",
    typing: { charsPerSec: 6, baseLatencyMs: 7000, deleteRate: 0.25 },
    openDrift: 0.2,
  },
];
