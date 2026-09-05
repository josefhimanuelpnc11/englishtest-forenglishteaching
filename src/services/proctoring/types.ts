import type {
  ViolationEvent,
  ViolationSeverity,
  ViolationType,
} from "../../types/exam";

export interface DetectorState {
  faceCount: number;
  cameraAvailable: boolean;
}

/**
 * Per-inference-cycle snapshot emitted by
 * OnnxFaceMonitor.
 *
 * Rendered live in the exam UI so testers and
 * participants can see exactly what the model
 * currently detects — no DevTools needed.
 */
export interface FaceMonitorStatus {
  faceCount: number;

  topScore: number;

  noFaceEvidence: number;

  noFaceEvidenceThreshold: number;

  multipleFaceEvidence: number;

  multipleFaceEvidenceThreshold: number;

  consecutiveInferenceErrors: number;

  inferenceCount: number;
}

export interface ProctoringCallbacks {
  onViolation: (
    violation: ViolationEvent,
  ) => void;

  onDetectorStateChange?: (
    state: DetectorState,
  ) => void;
}

export interface ViolationRule {
  type: ViolationType;

  score: number;

  severity: ViolationSeverity;

  critical?: boolean;
}