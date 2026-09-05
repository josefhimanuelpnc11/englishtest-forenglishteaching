import type { FaceMonitorStatus } from "../services/proctoring/types";

interface FaceWarningBannerProps {
  status: FaceMonitorStatus | null;
}

/**
 * Large early-warning banner shown while the
 * participant's face is not visible.
 *
 * Appears after the first confirmed no-face cycle
 * (~0.9s) — before the NO_FACE violation itself
 * fires (~2.7s) — and stays up until the face
 * returns, so the participant has a fair chance
 * to correct before being penalized.
 */
export function FaceWarningBanner({
  status,
}: FaceWarningBannerProps) {
  if (!status) {
    return null;
  }

  if (status.inferenceCount === 0) {
    return null;
  }

  if (
    status.consecutiveInferenceErrors > 0
  ) {
    return null;
  }

  if (
    status.faceCount > 0 ||
    status.noFaceEvidence < 1
  ) {
    return null;
  }

  return (
    <div
      className="face-warning-banner"
      role="alert"
    >
      <strong>
        ⚠ Wajah tidak terdeteksi, tolong
        segera kembali!, atau tes akan gagal
      </strong>

      <p>
        Kembali ke depan kamera sekarang —
        pelanggaran akan dicatat jika wajah
        tetap tidak terlihat.
      </p>
    </div>
  );
}
