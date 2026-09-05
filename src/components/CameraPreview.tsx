import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { FaceMonitorStatus } from "../services/proctoring/types";

interface CameraPreviewProps {
  enabled: boolean;

  faceStatus?: FaceMonitorStatus | null;

  faceError?: string | null;

  onCameraError?: (
    error: string,
  ) => void;

  onReady?: (
    stream: MediaStream,
  ) => void;

  onStopped?: () => void;
}

function formatFaceStatus(
  status: FaceMonitorStatus,
): string {
  if (
    status.consecutiveInferenceErrors > 0
  ) {
    return `⚠ Deteksi wajah error (${status.consecutiveInferenceErrors}x)`;
  }

  if (status.inferenceCount === 0) {
    return "○ Deteksi wajah starting...";
  }

  if (status.faceCount === 0) {
    return (
      `○ Tidak ada wajah ` +
      `(bukti ${status.noFaceEvidence}/` +
      `${status.noFaceEvidenceThreshold})`
    );
  }

  return (
    `● ${status.faceCount} wajah ` +
    `(${status.topScore.toFixed(2)})`
  );
}

export function CameraPreview({
  enabled,
  faceStatus,
  faceError,
  onCameraError,
  onReady,
  onStopped,
}: CameraPreviewProps) {
  const videoRef =
    useRef<HTMLVideoElement | null>(null);

  const streamRef =
    useRef<MediaStream | null>(null);

  const [
    cameraReady,
    setCameraReady,
  ] = useState(false);

  const [
    microphoneReady,
    setMicrophoneReady,
  ] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function startDevices() {
      try {
        if (
          !navigator.mediaDevices ||
          !navigator.mediaDevices
            .getUserMedia
        ) {
          throw new Error(
            "Browser tidak mendukung akses kamera/mikrofon.",
          );
        }

        const stream =
          await navigator.mediaDevices.getUserMedia(
            {
              video: {
                width: {
                  ideal: 640,
                },

                height: {
                  ideal: 480,
                },

                facingMode: "user",
              },

              audio: true,
            },
          );

        if (cancelled) {
          stream
            .getTracks()
            .forEach((track) =>
              track.stop(),
            );

          return;
        }

        streamRef.current = stream;

        const videoTracks =
          stream.getVideoTracks();

        const audioTracks =
          stream.getAudioTracks();

        setCameraReady(
          videoTracks.length > 0 &&
            videoTracks[0].readyState ===
              "live",
        );

        setMicrophoneReady(
          audioTracks.length > 0 &&
            audioTracks[0].readyState ===
              "live",
        );

        if (videoRef.current) {
          videoRef.current.srcObject =
            stream;

          await videoRef.current.play();
        }

        onReady?.(stream);
      } catch (error) {
        console.error(
          "Media device error:",
          error,
        );

        setCameraReady(false);

        setMicrophoneReady(false);

        onCameraError?.(
          "Kamera atau mikrofon tidak dapat diakses. Periksa permission browser dan perangkat Anda.",
        );
      }
    }

    startDevices();

    return () => {
      cancelled = true;

      streamRef.current
        ?.getTracks()
        .forEach((track) =>
          track.stop(),
        );

      streamRef.current = null;

      setCameraReady(false);

      setMicrophoneReady(false);

      onStopped?.();
    };
  }, [
    enabled,
    onCameraError,
    onReady,
    onStopped,
  ]);

  return (
    <div className="camera-container">
      <video
        ref={videoRef}
        muted
        playsInline
        className="camera-video"
      />

      <div className="camera-status">
        <div>
          {cameraReady
            ? "● Kamera aktif"
            : "○ Kamera belum aktif"}
        </div>

        <div>
          {microphoneReady
            ? "● Mikrofon aktif"
            : "○ Mikrofon belum aktif"}
        </div>

        {faceStatus && (
          <div>
            {formatFaceStatus(faceStatus)}
          </div>
        )}

        {faceError && (
          <div>{faceError}</div>
        )}
      </div>
    </div>
  );
}