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

const DWELL_MS_PER_DOT = 1500;
const MIN_SAMPLES_PER_DOT = 2;
const MAX_SAMPLE_VARIANCE = 0.002;
const MAX_DOT_RETRIES = 2;

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
 * Shows calibration dots in sequence, collects gaze
 * ratios per dot, rejects shaky dots, and fits
 * personal gaze references. Never registers
 * violations — the result only feeds the debug view
 * (Phase 1) and later the LOOK_AWAY detector.
 *
 * Fail-open by design: any failure surfaces an error
 * so the caller can skip gaze and let the exam
 * proceed without it.
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

  const finishWithError = useCallback(
    (message: string) => {
      setError(message);
      setPhase("error");
      onCompleteRef.current(null);
    },
    [],
  );

  const finishDone = useCallback(
    (allSamples: CalibrationSample[]) => {
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
    [finishWithError],
  );

  const handleStatus = useCallback(
    (status: LandmarkStatus) => {
      setLiveStatus(status);

      if (phaseRef.current !== "sampling") {
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

      if (
        Date.now() - dotStartRef.current <
        DWELL_MS_PER_DOT
      ) {
        return;
      }

      const dotSamples = samplesRef.current
        .filter(
          (sample) =>
            sample.dotIndex === currentDot,
        )
        .map(
          (sample): EyeGazeRatio =>
            sample.ratio,
        );

      const stable =
        dotSamples.length >=
          MIN_SAMPLES_PER_DOT &&
        isStableBatch(
          dotSamples,
          MAX_SAMPLE_VARIANCE,
        );

      if (!stable) {
        // Shaky dot (student moved) — retry it.
        samplesRef.current =
          samplesRef.current.filter(
            (sample) =>
              sample.dotIndex !== currentDot,
          );

        retriesRef.current += 1;
        setRetriesInDot(
          retriesRef.current,
        );

        if (
          retriesRef.current >
          MAX_DOT_RETRIES
        ) {
          finishWithError(
            "Kalibrasi gagal — pandangan " +
              "tidak stabil. Deteksi mata " +
              "dilewati.",
          );

          return;
        }

        setSamplesInDot(0);
        dotStartRef.current = Date.now();

        console.warn(
          "[GAZE] Unstable dot, retrying:",
          currentDot,
        );

        return;
      }

      const nextDot = currentDot + 1;

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
    },
    [dotsTotal, finishDone, finishWithError],
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
      return;
    }

    samplesRef.current = [];
    dotIndexRef.current = 0;
    retriesRef.current = 0;
    dotStartRef.current = Date.now();

    setPhase("sampling");
    setDotIndex(0);
    setSamplesInDot(0);
    setRetriesInDot(0);
    setError(null);
    setReferences(null);

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
      monitor.stop();
      monitorRef.current = null;
    };
  }, [
    enabled,
    mediaStream,
    handleStatus,
    finishWithError,
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
