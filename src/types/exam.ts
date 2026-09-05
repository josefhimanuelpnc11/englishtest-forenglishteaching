export type QuestionType = "multiple-choice" | "true-false";

export interface Option {
  id: string;
  text: string;
}

export interface Question {
  id: string;
  number: number;
  text: string;
  type: QuestionType;
  options: Option[];
  correctAnswer: string;
  points: number;
}

export interface ExamRules {
  durationMinutes: number;

  maxViolationScore: number;

  autoSubmitOnViolation: boolean;

  zeroOnCriticalViolation: boolean;

  rules: {
    TAB_SWITCH: number;
    FULLSCREEN_EXIT: number;
    COPY: number;
    PASTE: number;
    CUT: number;
    AUDIO_ACTIVITY: number;
    MULTIPLE_FACE: number;
    NO_FACE: number;
    CAMERA_DISABLED: number;
    WINDOW_BLUR: number;
    SHORTCUT: number;
    CONTEXT_MENU: number;
  };
}

export interface Exam {
  id: string;
  title: string;
  description: string;
  questions: Question[];
  rules: ExamRules;
}

export type ViolationType =
  | "TAB_SWITCH"
  | "FULLSCREEN_EXIT"
  | "COPY"
  | "PASTE"
  | "CUT"
  | "AUDIO_ACTIVITY"
  | "MULTIPLE_FACE"
  | "NO_FACE"
  | "CAMERA_DISABLED"
  | "WINDOW_BLUR"
  | "SHORTCUT"
  | "CONTEXT_MENU";

export type ViolationSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ViolationEvent {
  id: string;
  type: ViolationType;
  severity: ViolationSeverity;
  timestamp: number;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface ExamResult {
  attemptId: string;
  examId: string;
  studentId: string;
  studentName: string;
  answers: Record<string, string>;
  score: number;
  violationScore: number;
  violations: ViolationEvent[];
  submittedAt: number;
  submittedReason: "MANUAL" | "TIMEOUT" | "AUTO_VIOLATION";
}