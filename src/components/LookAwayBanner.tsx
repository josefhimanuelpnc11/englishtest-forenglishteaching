import type { GazeStatus } from "../services/proctoring/GazeMonitor";

interface LookAwayBannerProps {
  status: GazeStatus | null;
}

/**
 * Early-warning banner for sustained look-away.
 *
 * Appears after the first positive gaze cycle
 * (~1.1s) — before the LOOK_AWAY violation fires
 * (~3.3s) — and hides when the student looks back.
 * Amber (not red): gaze is warning-grade by design.
 * Shown only while a face is present; face absence
 * belongs to the red no-face banner, so the two
 * never stack.
 */
export function LookAwayBanner({
  status,
}: LookAwayBannerProps) {
  const visible =
    status != null &&
    status.faceCount === 1 &&
    status.lookingAway;

  if (!visible) {
    return null;
  }

  return (
    <div
      className="lookaway-banner"
      role="alert"
    >
      <strong>
        ⚠ Kembali fokus ke layar ujian!
      </strong>

      <p>
        Pandanganmu tidak ke layar. Kembali
        fokus — pelanggaran akan dicatat
        jika berlanjut.
      </p>
    </div>
  );
}
