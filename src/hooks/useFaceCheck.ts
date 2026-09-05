import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { OnnxFaceMonitor } from "../services/proctoring/OnnxFaceMonitor";

import type { FaceMonitorStatus } from "../services/proctoring/types";

/**
 * Minimum face confidence counted as "present"
 * during the pre-exam check.
 */
const MIN_CHECK_SCORE = 0.5;

/**
 * Consecutive good cycles required before the
 * check passes, so a single flickering frame
 * cannot green-light a bad setup.
 */
const REQUIRED_STEADY_CYCLES = 3;

interface UseFaceCheckResult {
  faceStatus: FaceMonitorStatus | null;
  faceError: string | null;
  steadyCount: number;
  faceReady: boolean;
}

/**
 * Pre-exam camera/face readiness sensor.
 *
 * Runs the same ONNX face detector as the exam,
 * but purely as a sensor: violations are discarded
 * (no-op callback) and only the live status is
 * exposed. The exam's own proctoring takes over
 * after start; this monitor is stopped then.
 */
export function useFaceCheck(
  mediaStream: MediaStream | null,
  enabled: boolean,
): UseFaceCheckResult {
  const [faceStatus, setFaceStatus] =
    useState<FaceMonitorStatus | null>(null);

  const [faceError, setFaceError] =
    useState<string | null>(null);

  const [steadyCount, setSteadyCount] =
    useState(0);

  const monitorRef =
    useRef<OnnxFaceMonitor | null>(null);

  const handleStatus = useCallback(
    (status: FaceMonitorStatus) => {
      setFaceStatus(status);

      const good =
        status.inferenceCount > 0 &&
        status.consecutiveInferenceErrors ===
          0 &&
        status.faceCount === 1 &&
        status.topScore >= MIN_CHECK_SCORE;

      setSteadyCount((previous) =>
        good
          ? Math.min(
              previous + 1,
              REQUIRED_STEADY_CYCLES,
            )
          : 0,
      );
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !mediaStream) {
      monitorRef.current?.stop();
      monitorRef.current = null;

      setFaceStatus(null);
      setSteadyCount(0);

      if (!enabled) {
        setFaceError(null);
      }

      return;
    }

    setFaceError(null);
    setSteadyCount(0);

    const monitor = new OnnxFaceMonitor(
      mediaStream,
      () => undefined,
      { onStatus: handleStatus },
    );

    monitorRef.current = monitor;

    monitor
      .start()
      .catch(() => {
        setFaceError(
          "Deteksi wajah gagal dimulai. " +
            "Periksa koneksi internet lalu " +
            "refresh halaman ini.",
        );
      });

    return () => {
      monitor.stop();
      monitorRef.current = null;
    };
  }, [enabled, mediaStream, handleStatus]);

  return {
    faceStatus,
    faceError,
    steadyCount,
    faceReady:
      steadyCount >= REQUIRED_STEADY_CYCLES,
  };
}
