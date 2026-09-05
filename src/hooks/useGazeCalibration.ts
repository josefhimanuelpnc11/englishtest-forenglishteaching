import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FaceLandmarkMonitor } from "../services/gaze/FaceLandmarkMonitor";

import type { LandmarkStatus } from "../services/gaze/FaceLandmarkMonitor";

import {
  CALIBRATION_DOTS,
  fitCalibration,
  isStableBatch,
  mapGaze,
} from "../services/gaze/gazeMath";

import type {
  CalibrationSample,
  EyeGazeRatio,
  GazePoint,
  GazeReferences,
} from "../services/gaze/gazeMath";

export type GazeCalibrationPhase =
  | "loading"
  | "sampling"
  | "done"
  | "error";

/**
 * Exact pacing per dot, identical on every device.
 * Dots advance on this clock — never on inference
 * arrival, so a fast desktop and a slow phone show
 * the same rhythm. Keep in sync with the
 * `gaze-progress-fill` CSS animation duration.
 */
const DOT_WINDOW_MS = 2200;

/**
 * Samples inside this window after a dot switch
 * are discarded: the eyes are still travelling.
 */
const SACCADE_IGNORE_MS = 600;

/**
 * Stability is only provable with 2+ samples; a
 * lone sample on a slow device is accepted as-is
 * (the spread gate at fit time still guards
 * degenerate calibrations).
 */
const MIN_STABLE_SAMPLES = 2;
const MAX_SAMPLE_VARIANCE = 0.002;
const MAX_DOT_RETRIES = 2;

/**
 * Time allowed for the model pipeline to produce
 * its first usable frame before giving up.
 */
const FIRST_FRAME_TIMEOUT_MS = 20000;

interface UseGazeCalibrationResult {
  phase: GazeCalibrationPhase;
  dotOrder: number[];
  dotIndex: number;
  dotsTotal: number;
  samplesInDot: number;
  retriesInDot: number;
  error: string | null;
  references: GazeReferences | null;

  /**
   * Live mapped gaze point (after calibration),
   * for the Phase 1 debug view.
   */
  livePoint: GazePoint | null;
  liveStatus: LandmarkStatus | null;
}

function shuffledDots(count: number): number[] {
  const order = Array.from(
    { length: count },
    (_, index) => index,
  );

  // Center dot (index 0) always first — it anchors
  // the personal references everything maps to.
  const rest = order.slice(1);

  for (
    let i = rest.length - 1;
    i > 0;
    i -= 1
  ) {
    const j = Math.floor(
      Math.random() * (i + 1),
    );

    const left = rest[i] ?? 1;
    rest[i] = rest[j] ?? 1;
    rest[j] = left;
  }

  return [0, ...rest];
}

/**
 * Pre-exam gaze calibration (Phase 1: sensor only).
 *
 * Each dot owns an exact DOT_WINDOW_MS time slice;
 * samples inside the first SACCADE_IGNORE_MS are
 * discarded (eyes travelling). At the window end the
 * dot is accepted, or retried on empty/shaky data.
 * Never registers violations. No skip path exists —
 * only a technical failure lets the exam proceed
 * without gaze, and that is reported, not chosen.
 */
export function useGazeCalibration(
  mediaStream: MediaStream | null,
  enabled: boolean,
  onComplete: (
    references: GazeReferences | null,
  ) => void,
): UseGazeCalibrationResult {
  const [phase, setPhase] =
    useState<GazeCalibrationPhase>(
      "loading",
    );

  const [dotIndex, setDotIndex] =
    useState(0);

  const [samplesInDot, setSamplesInDot] =
    useState(0);

  const [retriesInDot, setRetriesInDot] =
    useState(0);

  const [error, setError] =
    useState<string | null>(null);

  const [references, setReferences] =
    useState<GazeReferences | null>(null);

  const [liveStatus, setLiveStatus] =
    useState<LandmarkStatus | null>(null);

  const monitorRef =
    useRef<FaceLandmarkMonitor | null>(null);

  const samplesRef = useRef<
    CalibrationSample[]
  >([]);

  const dotStartRef = useRef(0);
  const dotIndexRef = useRef(0);
  const retriesRef = useRef(0);
  const phaseRef = useRef(phase);

  const windowTimerRef =
    useRef<number | null>(null);

  const prepTimerRef =
    useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const dotsTotal = CALIBRATION_DOTS.length;

  const dotOrder = useMemo(
    () => shuffledDots(dotsTotal),
    [dotsTotal],
  );

  const clearDotWindow = useCallback(() => {
    if (windowTimerRef.current !== null) {
      window.clearTimeout(
        windowTimerRef.current,
      );

      windowTimerRef.current = null;
    }
  }, []);

  const clearPrepTimer = useCallback(() => {
    if (prepTimerRef.current !== null) {
      window.clearTimeout(
        prepTimerRef.current,
      );

      prepTimerRef.current = null;
    }
  }, []);

  const finishWithError = useCallback(
    (message: string) => {
      clearDotWindow();
      clearPrepTimer();
      setError(message);
      setPhase("error");
      onCompleteRef.current(null);
    },
    [clearDotWindow, clearPrepTimer],
  );

  const finishDone = useCallback(
    (allSamples: CalibrationSample[]) => {
      clearDotWindow();
      clearPrepTimer();

      const refs = fitCalibration(
        allSamples,
      );

      if (!refs) {
        finishWithError(
          "Kalibrasi gagal dihitung. " +
            "Deteksi mata dilewati.",
        );
        return;
      }

      console.log(
        "[GAZE] Calibration complete:",
        refs,
      );

      setReferences(refs);
      setPhase("done");
      onCompleteRef.current(refs);
    },
    [
      clearDotWindow,
      clearPrepTimer,
      finishWithError,
    ],
  );

  /**
   * Latest dot evaluator for the window timer.
   * Indirection through a ref keeps declaration
   * order acyclic (the scheduler is defined before
   * the retry/advance steps that use it).
   */
  const evaluateRef = useRef<() => void>(
    () => undefined,
  );

  const scheduleDotWindow: () => void =
    useCallback(() => {
      clearDotWindow();

      windowTimerRef.current =
        window.setTimeout(() => {
          evaluateRef.current();
        }, DOT_WINDOW_MS);
    }, [clearDotWindow]);

  const retryCurrentDot: () => void = useCallback(() => {
    const currentDot = dotIndexRef.current;

    samplesRef.current =
      samplesRef.current.filter(
        (sample) =>
          sample.dotIndex !== currentDot,
      );

    retriesRef.current += 1;
    setRetriesInDot(retriesRef.current);

    if (
      retriesRef.current > MAX_DOT_RETRIES
    ) {
      finishWithError(
        "Kalibrasi gagal — pandangan " +
          "tidak stabil. Deteksi mata " +
          "dilewati.",
      );

      return;
    }

    console.warn(
      "[GAZE] Dot failed, retrying:",
      currentDot,
    );

    setSamplesInDot(0);
    dotStartRef.current = Date.now();
    scheduleDotWindow();
  }, [finishWithError, scheduleDotWindow]);

  const advanceFromDot: () => void = useCallback(() => {
    const nextDot = dotIndexRef.current + 1;

    if (nextDot >= dotsTotal) {
      finishDone(samplesRef.current);
      return;
    }

    dotIndexRef.current = nextDot;
    retriesRef.current = 0;

    setDotIndex(nextDot);
    setSamplesInDot(0);
    setRetriesInDot(0);
    dotStartRef.current = Date.now();

    scheduleDotWindow();
  }, [
    dotsTotal,
    finishDone,
    scheduleDotWindow,
  ]);

  const evaluateCurrentDot: () => void =
    useCallback(() => {
      windowTimerRef.current = null;

      if (phaseRef.current !== "sampling") {
        return;
      }

      const currentDot = dotIndexRef.current;

      const dotSamples = samplesRef.current
        .filter(
          (sample) =>
            sample.dotIndex === currentDot,
        )
        .map(
          (sample): EyeGazeRatio =>
            sample.ratio,
        );

      // Nothing usable in the whole window.
      if (dotSamples.length === 0) {
        retryCurrentDot();
        return;
      }

      // Lone sample on a slow device: accepted
      // as-is (the spread gate still guards the fit).
      const stable =
        dotSamples.length >=
          MIN_STABLE_SAMPLES &&
        isStableBatch(
          dotSamples,
          MAX_SAMPLE_VARIANCE,
        );

      if (
        dotSamples.length === 1 ||
        stable
      ) {
        advanceFromDot();
        return;
      }

      retryCurrentDot();
    }, [advanceFromDot, retryCurrentDot]);

  useEffect(() => {
    evaluateRef.current = evaluateCurrentDot;
  }, [evaluateCurrentDot]);

  const handleStatus = useCallback(
    (status: LandmarkStatus) => {
      setLiveStatus(status);

      if (phaseRef.current !== "sampling") {
        return;
      }

      // First producing frame starts dot 0's clock
      // (model load time must not eat the window).
      if (dotStartRef.current === 0) {
        if (
          status.inferenceCount === 0 ||
          status.consecutiveErrors > 0
        ) {
          return;
        }

        dotStartRef.current = Date.now();
        clearPrepTimer();
        scheduleDotWindow();

        return;
      }

      // Saccade window: eyes still travelling.
      if (
        Date.now() - dotStartRef.current <
        SACCADE_IGNORE_MS
      ) {
        return;
      }

      // Only clean single-face frames become
      // calibration samples.
      if (
        status.faceCount !== 1 ||
        !status.gaze ||
        status.consecutiveErrors > 0
      ) {
        return;
      }

      const currentDot = dotIndexRef.current;

      samplesRef.current.push({
        dotIndex: currentDot,
        ratio: status.gaze,
      });

      setSamplesInDot(
        samplesRef.current.filter(
          (sample) =>
            sample.dotIndex === currentDot,
        ).length,
      );
    },
    [
      clearPrepTimer,
      scheduleDotWindow,
    ],
  );

  // Live debug point once references exist.
  // Derived (not state) so every status render
  // maps through the latest references.
  const livePoint = useMemo(() => {
    if (
      !references ||
      !liveStatus ||
      liveStatus.faceCount !== 1 ||
      !liveStatus.gaze
    ) {
      return null;
    }

    return mapGaze(
      liveStatus.gaze,
      references,
    );
  }, [references, liveStatus]);

  useEffect(() => {
    if (!enabled || !mediaStream) {
      monitorRef.current?.stop();
      monitorRef.current = null;

      clearDotWindow();
      clearPrepTimer();

      return;
    }

    samplesRef.current = [];
    dotIndexRef.current = 0;
    retriesRef.current = 0;
    dotStartRef.current = 0;

    setPhase("sampling");
    setDotIndex(0);
    setSamplesInDot(0);
    setRetriesInDot(0);
    setError(null);
    setReferences(null);

    // Model pipeline dead on arrival: fail loudly
    // instead of hanging on dot 0 forever.
    prepTimerRef.current =
      window.setTimeout(() => {
        prepTimerRef.current = null;

        if (
          phaseRef.current === "sampling" &&
          dotStartRef.current === 0
        ) {
          finishWithError(
            "Model mata tidak merespons. " +
              "Periksa koneksi lalu refresh, " +
              "atau lanjutkan tanpa " +
              "deteksi mata.",
          );
        }
      }, FIRST_FRAME_TIMEOUT_MS);

    const monitor = new FaceLandmarkMonitor(
      mediaStream,
      handleStatus,
    );

    monitorRef.current = monitor;

    monitor.start().catch(() => {
      finishWithError(
        "Deteksi mata gagal dimulai. " +
          "Periksa koneksi lalu refresh, atau " +
          "lanjutkan tanpa deteksi mata.",
      );
    });

    return () => {
      clearDotWindow();
      clearPrepTimer();
      monitor.stop();
      monitorRef.current = null;
    };
  }, [
    enabled,
    mediaStream,
    handleStatus,
    finishWithError,
    clearDotWindow,
    clearPrepTimer,
  ]);

  return {
    phase,
    dotOrder,
    dotIndex,
    dotsTotal,
    samplesInDot,
    retriesInDot,
    error,
    references,
    livePoint,
    liveStatus,
  };
}
