import { useEffect } from "react";

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
 *
 * Pinned to the viewport (not the page flow) so it
 * stays visible on phones no matter how far the
 * student has scrolled, plus a vibration pulse on
 * appearance for devices that support it.
 */
export function FaceWarningBanner({
  status,
}: FaceWarningBannerProps) {
  const visible =
    status != null &&
    status.inferenceCount > 0 &&
    status.consecutiveInferenceErrors ===
      0 &&
    status.faceCount === 0 &&
    status.noFaceEvidence >= 1;

  useEffect(() => {
    if (!visible) {
      return;
    }

    try {
      if (
        typeof navigator !== "undefined" &&
        "vibrate" in navigator
      ) {
        navigator.vibrate(400);
      }
    } catch {
      // Vibration unsupported — the visual
      // banner is enough.
    }
  }, [visible]);

  if (!visible) {
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
