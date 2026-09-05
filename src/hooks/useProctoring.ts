import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  Exam,
  ViolationEvent,
  ViolationType,
} from "../types/exam";

import type { FaceMonitorStatus } from "../services/proctoring/types";

import { BrowserMonitor } from "../services/proctoring/BrowserMonitor.ts";

import { OnnxAudioMonitor } from "../services/proctoring/OnnxAudioMonitor";

import { OnnxFaceMonitor } from "../services/proctoring/OnnxFaceMonitor";

import { ViolationEngine } from "../services/proctoring/ViolationEngine.ts";

/**
 * Recovery window after a working stream
 * disappears before it counts as CAMERA_DISABLED.
 *
 * Covers the start-page -> exam camera handover
 * (old tracks stop, replacement stream arrives
 * ~1s later) and brief device hiccups. A stream
 * that stays gone past this window is treated as
 * a genuine camera kill.
 */
const STREAM_LOST_GRACE_MS = 3000;

interface UseProctoringProps {
  exam: Exam;
  enabled: boolean;
  mediaStream: MediaStream | null;

  onAutoSubmit?: (
    violations: ViolationEvent[],
    score: number,
  ) => void;
}

export function useProctoring({
  exam,
  enabled,
  mediaStream,
  onAutoSubmit,
}: UseProctoringProps) {
  const [violations, setViolations] =
    useState<ViolationEvent[]>([]);

  const [violationScore, setViolationScore] =
    useState(0);

  const [faceStatus, setFaceStatus] =
    useState<FaceMonitorStatus | null>(null);

  /**
   * Face-monitor startup failure, shown in the UI.
   *
   * Previously this only went to the console, so a
   * broken detector looked identical to a clean
   * exam session.
   */
  const [faceError, setFaceError] =
    useState<string | null>(null);

  const engineRef =
    useRef<ViolationEngine | null>(null);

  const monitorRef =
    useRef<BrowserMonitor | null>(null);

  const faceMonitorRef =
    useRef<OnnxFaceMonitor | null>(null);

  const audioMonitorRef =
    useRef<OnnxAudioMonitor | null>(null);

  const autoSubmitTriggeredRef =
    useRef(false);

  const lastViolationAtRef =
    useRef<Record<string, number>>({});

  /**
   * Latest onAutoSubmit without destabilizing
   * registerViolation.
   *
   * The parent re-renders every second (exam timer)
   * and passes a new onAutoSubmit closure each time.
   * If registerViolation depended on it directly,
   * every monitor effect would tear down and rebuild
   * every second — the face monitor would never
   * survive long enough to accumulate evidence, so
   * NO_FACE / MULTIPLE_FACE could never fire.
   */
  const onAutoSubmitRef =
    useRef(onAutoSubmit);

  useEffect(() => {
    onAutoSubmitRef.current = onAutoSubmit;
  }, [onAutoSubmit]);

  const hadStreamRef = useRef(false);

  const cameraDeniedReportedRef =
    useRef(false);

  const cameraGraceTimerRef =
    useRef<number | null>(null);

  /**
   * Stream object of the latest render.
   *
   * Lets async callbacks (track-ended, timers)
   * tell a stale stream generation apart from the
   * currently active one.
   */
  const latestStreamRef =
    useRef<MediaStream | null>(null);

  const streamLostTimerRef =
    useRef<number | null>(null);

  /**
   * Keep the latest-stream guard fresh.
   */
  useEffect(() => {
    latestStreamRef.current = mediaStream;
  }, [mediaStream]);

  /**
   * Live face-detection snapshot for the UI.
   * Stable reference so the face monitor effect
   * does not restart when violations change.
   */
  const handleFaceStatus = useCallback(
    (status: FaceMonitorStatus) => {
      setFaceStatus(status);
    },
    [],
  );

  const registerViolation = useCallback(
    (
      type: ViolationType,
      metadata?: Record<string, unknown>,
    ) => {
      if (!engineRef.current) return;

      const now = Date.now();
      const cooldownByType: Record<ViolationType, number> = {
        AUDIO_ACTIVITY: 4000,
        NO_FACE: 5000,
        MULTIPLE_FACE: 3000,
        TAB_SWITCH: 1000,
        FULLSCREEN_EXIT: 1000,
        WINDOW_BLUR: 1000,
        COPY: 1000,
        PASTE: 1000,
        CUT: 1000,
        SHORTCUT: 1000,
        CONTEXT_MENU: 1000,
        CAMERA_DISABLED: 0,
      };

      const lastViolationAt =
        lastViolationAtRef.current[type];
      const cooldown = cooldownByType[type];

      if (
        lastViolationAt != null &&
        now - lastViolationAt < cooldown
      ) {
        return;
      }

      lastViolationAtRef.current[type] = now;

      const violation =
        engineRef.current.register(
          type,
          metadata,
        );

      const newScore =
        engineRef.current.getScore();

      const newViolations =
        engineRef.current.getViolations();

      setViolations(newViolations);

      setViolationScore(newScore);

      const critical =
        engineRef.current.isCritical(type);

      const maxScore =
        exam.rules.maxViolationScore;

      if (
        !autoSubmitTriggeredRef.current &&
        exam.rules.autoSubmitOnViolation &&
        (critical || newScore >= maxScore)
      ) {
        autoSubmitTriggeredRef.current = true;

        onAutoSubmitRef.current?.(
          newViolations,
          newScore,
        );
      }

      console.log(
        "[PROCTORING]",
        violation,
      );
    },
    [exam.rules],
  );

  /**
   * Violation engine lifecycle.
   *
   * independent of the camera stream so that
   * browser-level violations (tab switch,
   * fullscreen, copy/paste, shortcuts) are
   * tracked even while camera permission is
   * still pending, and so that CAMERA_DISABLED
   * itself can be registered.
   */
  useEffect(() => {
    if (!enabled) {
      autoSubmitTriggeredRef.current = false;
      engineRef.current = null;
      return;
    }

    engineRef.current =
      new ViolationEngine(exam.rules);

    return () => {
      engineRef.current = null;
    };
  }, [enabled, exam.rules]);

  /**
   * Browser-level monitoring (tab, fullscreen,
   * clipboard, shortcuts, context menu, blur).
   *
   * Runs for the whole exam session, independent
   * of camera availability.
   */
  useEffect(() => {
    if (!enabled) {
      return;
    }

    monitorRef.current =
      new BrowserMonitor(
        registerViolation,
      );

    monitorRef.current.start();

    return () => {
      monitorRef.current?.stop();
      monitorRef.current = null;
    };
  }, [enabled, registerViolation]);

  /**
   * Webcam-based monitoring (face detection).
   *
   * Requires an active camera stream. Also watches
   * for the video track being killed mid-exam
   * (user disabling the camera), which is a
   * CRITICAL violation.
   */
  useEffect(() => {
    if (!enabled || !mediaStream) {
      faceMonitorRef.current?.stop();
      faceMonitorRef.current = null;

      audioMonitorRef.current?.stop();
      audioMonitorRef.current = null;

      setFaceStatus(null);
      setFaceError(null);

      return;
    }

    setFaceError(null);

    /**
     * Camera track killed mid-exam (user disabled
     * the camera from the OS/browser UI).
     * This is a CRITICAL violation.
     */
    const videoTracks =
      mediaStream.getVideoTracks();

    const attachedStream = mediaStream;

    const handleTrackEnded = (
      event: Event,
    ) => {
      /**
       * Stale attachment guard.
       *
       * During the start-page -> exam transition the
       * previous preview stops its tracks while this
       * listener generation may still be registered.
       * Only the currently active stream can report
       * a genuine camera kill.
       */
      if (
        latestStreamRef.current !==
        attachedStream
      ) {
        return;
      }

      const target = event.target;

      if (
        !(target instanceof MediaStreamTrack) ||
        !videoTracks.includes(target)
      ) {
        return;
      }

      registerViolation(
        "CAMERA_DISABLED",
        { reason: "track-ended" },
      );
    };

    for (const track of videoTracks) {
      track.addEventListener(
        "ended",
        handleTrackEnded,
      );
    }

    faceMonitorRef.current =
    new OnnxFaceMonitor(
        mediaStream,
        registerViolation,
        { onStatus: handleFaceStatus },
    );

    // TEMPORARILY DISABLE AUDIO MONITOR
    audioMonitorRef.current = null;

    faceMonitorRef.current
    .start()
    .then(() => {
        console.log(
        "[PROCTORING] Face monitor started successfully",
        );
    })
    .catch((error) => {
        console.error(
        "[PROCTORING] Face monitor startup failed:",
        error,
        );

        setFaceError(
          "Deteksi wajah gagal dimulai. " +
          "Pelanggaran wajah tidak aktif. " +
          "Lihat console browser untuk detail.",
        );
    });

    return () => {
      for (const track of videoTracks) {
        track.removeEventListener(
          "ended",
          handleTrackEnded,
        );
      }

      faceMonitorRef.current?.stop();
      faceMonitorRef.current = null;

      audioMonitorRef.current?.stop();
      audioMonitorRef.current = null;
    };
  }, [
    enabled,
    mediaStream,
    registerViolation,
    handleFaceStatus,
  ]);

  /**
   * Camera availability watchdog.
   *
   * - If the stream never appears within the grace
   *   period after the exam starts, the camera was
   *   denied or is unavailable -> CRITICAL.
   * - If a previously available stream disappears,
   *   a short recovery window is allowed first.
   *   This covers the start-page -> exam camera
   *   handover and brief device hiccups. Only a
   *   stream that stays gone is CRITICAL.
   */
  useEffect(() => {
    const clearLostTimer = () => {
      if (
        streamLostTimerRef.current !== null
      ) {
        window.clearTimeout(
          streamLostTimerRef.current,
        );
        streamLostTimerRef.current = null;
      }
    };

    if (!enabled) {
      hadStreamRef.current = false;
      cameraDeniedReportedRef.current = false;

      if (
        cameraGraceTimerRef.current !== null
      ) {
        window.clearTimeout(
          cameraGraceTimerRef.current,
        );
        cameraGraceTimerRef.current = null;
      }

      clearLostTimer();

      return;
    }

    if (mediaStream) {
      hadStreamRef.current = true;
      cameraDeniedReportedRef.current = false;

      if (
        cameraGraceTimerRef.current !== null
      ) {
        window.clearTimeout(
          cameraGraceTimerRef.current,
        );
        cameraGraceTimerRef.current = null;
      }

      clearLostTimer();

      return;
    }

    // Previously-working stream is gone. Wait out
    // the handover window before calling it a
    // critical violation — a replacement stream
    // cancels the timer via the branch above.
    if (
      hadStreamRef.current &&
      !cameraDeniedReportedRef.current &&
      streamLostTimerRef.current === null
    ) {
      streamLostTimerRef.current =
        window.setTimeout(() => {
          streamLostTimerRef.current = null;

          if (
            latestStreamRef.current ===
              null &&
            !cameraDeniedReportedRef.current
          ) {
            cameraDeniedReportedRef.current =
              true;

            registerViolation(
              "CAMERA_DISABLED",
              { reason: "stream-lost" },
            );
          }
        }, STREAM_LOST_GRACE_MS);

      return;
    }

    // No stream yet — give the browser permission
    // prompt time to resolve before penalizing.
    if (
      !hadStreamRef.current &&
      !cameraDeniedReportedRef.current &&
      cameraGraceTimerRef.current === null
    ) {
      cameraGraceTimerRef.current =
        window.setTimeout(() => {
          cameraGraceTimerRef.current = null;

          if (
            !hadStreamRef.current &&
            !cameraDeniedReportedRef.current
          ) {
            cameraDeniedReportedRef.current =
              true;

            registerViolation(
              "CAMERA_DISABLED",
              { reason: "stream-unavailable" },
            );
          }
        }, 15000);
    }

    return () => {
      if (
        cameraGraceTimerRef.current !== null
      ) {
        window.clearTimeout(
          cameraGraceTimerRef.current,
        );
        cameraGraceTimerRef.current = null;
      }

      if (
        streamLostTimerRef.current !== null
      ) {
        window.clearTimeout(
          streamLostTimerRef.current,
        );
        streamLostTimerRef.current = null;
      }
    };
  }, [enabled, mediaStream, registerViolation]);

  return {
    violations,
    violationScore,
    faceStatus,
    faceError,
    registerViolation,
  };
}