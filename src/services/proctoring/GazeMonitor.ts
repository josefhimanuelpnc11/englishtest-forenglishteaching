import { FaceLandmarkMonitor } from "../gaze/FaceLandmarkMonitor";

import type { LandmarkStatus } from "../gaze/FaceLandmarkMonitor";

import {
  gazeDeviation,
  mapGaze,
} from "../gaze/gazeMath";

import type { GazeReferences } from "../gaze/gazeMath";

type GazeViolationCallback = (
  type: "LOOK_AWAY",
  metadata?: Record<string, unknown>,
) => void;

export interface GazeStatus {
  deviation: number;
  evidence: number;
  evidenceThreshold: number;
  faceCount: number;

  /**
   * True while a present face is looking away
   * (drives the early-warning banner).
   */
  lookingAway: boolean;
}

export interface GazeMonitorOptions {
  /**
   * Delay between gaze evaluations.
   * Default: 1100 ms (deliberately offset from the
   * 900 ms face cycle so both models never spike
   * the CPU in the same instant).
   */
  intervalMs?: number;

  /**
   * Normalized deviation (~[0, 1.2]) sustained
   * before it counts as looking away.
   * Conservative on purpose: normal screen
   * scanning must never trigger this.
   * Default: 0.70
   */
  deviationThreshold?: number;

  /**
   * Sustained positive cycles before LOOK_AWAY.
   * Default: 3 (~3.3 s).
   */
  evidenceThreshold?: number;

  evidenceIncrement?: number;
  recoveryDecrement?: number;

  onStatus?: (status: GazeStatus) => void;
}

/**
 * Phase 2 gaze violation detector.
 *
 * Wraps FaceLandmarkMonitor, maps live gaze through
 * the student's personal calibration references, and
 * accumulates temporal evidence exactly like the
 * face monitor: ~3 sustained cycles fire one
 * LOOK_AWAY (LOW severity — warning-grade, never
 * critical), with hysteresis before re-arming.
 *
 * Frames without exactly one measurable face freeze
 * the state machine (no accumulation, no recovery):
 * face absence belongs to the face monitor.
 */
export class GazeMonitor {
  private readonly callback: GazeViolationCallback;

  private readonly references: GazeReferences;

  private readonly options: Required<GazeMonitorOptions>;

  private readonly landmarkMonitor: FaceLandmarkMonitor;

  private evidence = 0;

  private reported = false;

  constructor(
    stream: MediaStream,
    callback: GazeViolationCallback,
    references: GazeReferences,
    options: GazeMonitorOptions = {},
  ) {
    this.callback = callback;
    this.references = references;

    this.options = {
      intervalMs:
        options.intervalMs ?? 1100,

      deviationThreshold:
        options.deviationThreshold ?? 0.7,

      evidenceThreshold:
        options.evidenceThreshold ?? 3,

      evidenceIncrement:
        options.evidenceIncrement ?? 1,

      recoveryDecrement:
        options.recoveryDecrement ?? 1,

      onStatus:
        options.onStatus ??
        (() => undefined),
    };

    this.landmarkMonitor =
      new FaceLandmarkMonitor(
        stream,
        (status) => {
          this.handleStatus(status);
        },
        { intervalMs: this.options.intervalMs },
      );

    console.log(
      "[GAZE] Violation monitor created.",
    );
  }

  async start(): Promise<void> {
    this.reset();

    await this.landmarkMonitor.start();

    console.log(
      "[GAZE] Violation monitor started.",
    );
  }

  stop(): void {
    this.landmarkMonitor.stop();
    this.reset();

    console.log("[GAZE] Violation monitor stopped.");
  }

  private reset(): void {
    this.evidence = 0;
    this.reported = false;
  }

  private handleStatus(
    status: LandmarkStatus,
  ): void {
    let deviation = 0;

    if (
      status.faceCount === 1 &&
      status.gaze &&
      status.consecutiveErrors === 0
    ) {
      deviation = gazeDeviation(
        mapGaze(
          status.gaze,
          this.references,
        ),
      );

      if (
        deviation >=
        this.options.deviationThreshold
      ) {
        this.evidence = Math.min(
          this.evidence +
            this.options.evidenceIncrement,
          this.options.evidenceThreshold,
        );
      } else {
        this.evidence = Math.max(
          this.evidence -
            this.options.recoveryDecrement,
          0,
        );

        if (
          this.evidence === 0 &&
          this.reported
        ) {
          this.reported = false;

          console.log(
            "[GAZE] Look-away recovered.",
          );
        }
      }

      if (
        !this.reported &&
        this.evidence >=
          this.options.evidenceThreshold
      ) {
        this.reported = true;

        console.warn(
          "[GAZE] LOOK_AWAY violation",
        );

        this.callback("LOOK_AWAY", {
          reason: "sustained-look-away",
          deviation: Number(
            deviation.toFixed(3),
          ),
          threshold:
            this.options
              .deviationThreshold,
          timestamp: Date.now(),
        });
      }
    }

    this.options.onStatus({
      deviation,
      evidence: this.evidence,
      evidenceThreshold:
        this.options.evidenceThreshold,
      faceCount: status.faceCount,
      lookingAway:
        status.faceCount === 1 &&
        this.evidence > 0,
    });
  }
}
