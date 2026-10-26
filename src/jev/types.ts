// Wire types for the Jev System One API (POST {baseUrl}/systemone).
// Shapes follow the TypeSafe / LiteLLM / Zuplo docs (Sept–Oct 2026).

export type JevState = string | Record<string, unknown> | Array<string | Record<string, unknown>>;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key -> description (null allowed). 1..255 options. */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered rubric, 2..10 self-contained level descriptions. */
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevRequest {
  model: string;
  state: JevState;
  questions: JevQuestions;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number> | number[];
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Maps a question dict to its typed answer dict. */
export type AnswersFor<Q extends JevQuestions> = {
  [K in keyof Q]: Q[K] extends NoulQuestion
    ? NoulAnswer
    : Q[K] extends ChoiceQuestion
      ? ChoiceAnswer<Extract<keyof Q[K]['criteria'], string>>
      : Q[K] extends ScoreQuestion
        ? ScoreAnswer
        : JevAnswer;
};

export interface JevResponse<Q extends JevQuestions = JevQuestions> {
  model: string;
  answers: AnswersFor<Q>;
  usage?: { input_tokens: number; output_tokens: number };
}
