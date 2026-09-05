import type {
  ExamRules,
  ViolationEvent,
  ViolationSeverity,
  ViolationType,
} from "../../types/exam";

interface ViolationDefinition {
  score: number;
  severity: ViolationSeverity;
  critical?: boolean;
}

export class ViolationEngine {
  private totalScore = 0;

  private violations: ViolationEvent[] = [];

  private readonly rules: Record<
    ViolationType,
    ViolationDefinition
  >;

  constructor(examRules: ExamRules) {
    this.rules = {
      TAB_SWITCH: {
        score: examRules.rules.TAB_SWITCH,
        severity: "MEDIUM",
      },

      FULLSCREEN_EXIT: {
        score:
          examRules.rules.FULLSCREEN_EXIT,
        severity: "MEDIUM",
      },

      COPY: {
        score: examRules.rules.COPY,
        severity: "LOW",
      },

      PASTE: {
        score: examRules.rules.PASTE,
        severity: "MEDIUM",
      },

      CUT: {
        score: examRules.rules.CUT,
        severity: "LOW",
      },

      AUDIO_ACTIVITY: {
        score: examRules.rules.AUDIO_ACTIVITY,
        severity: "MEDIUM",
      },

      MULTIPLE_FACE: {
        score:
          examRules.rules.MULTIPLE_FACE,
        severity: "HIGH",
      },

      NO_FACE: {
        score: examRules.rules.NO_FACE,
        severity: "MEDIUM",
      },

      CAMERA_DISABLED: {
        score:
          examRules.rules.CAMERA_DISABLED,
        severity: "CRITICAL",
        critical: true,
      },

      WINDOW_BLUR: {
        score:
          examRules.rules.WINDOW_BLUR,
        severity: "MEDIUM",
      },

      SHORTCUT: {
        score:
          examRules.rules.SHORTCUT,
        severity: "MEDIUM",
      },

      CONTEXT_MENU: {
        score:
          examRules.rules.CONTEXT_MENU,
        severity: "LOW",
      },

      /**
       * Warning-grade by design: gaze is coarse,
       * so it costs points but can never be
       * critical or end an exam on its own.
       */
      LOOK_AWAY: {
        score:
          examRules.rules.LOOK_AWAY,
        severity: "LOW",
      },
    };
  }

  register(
    type: ViolationType,
    metadata?: Record<string, unknown>,
  ): ViolationEvent {
    const rule = this.rules[type];

    const violation: ViolationEvent = {
      id: crypto.randomUUID(),

      type,

      severity: rule.severity,

      timestamp: Date.now(),

      score: rule.score,

      metadata,
    };

    this.totalScore += rule.score;

    this.violations.push(violation);

    return violation;
  }

  getScore() {
    return this.totalScore;
  }

  getViolations() {
    return [...this.violations];
  }

  isCritical(type: ViolationType) {
    return Boolean(this.rules[type].critical);
  }
}