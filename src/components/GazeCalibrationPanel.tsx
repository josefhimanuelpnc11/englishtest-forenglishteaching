import { useGazeCalibration } from "../hooks/useGazeCalibration";

import { CALIBRATION_DOTS } from "../services/gaze/gazeMath";

import type { GazeReferences } from "../services/gaze/gazeMath";

interface GazeCalibrationPanelProps {
  mediaStream: MediaStream | null;
  enabled: boolean;
  onComplete: (
    references: GazeReferences | null,
  ) => void;
  onSkip: () => void;
}

/**
 * Pre-exam gaze calibration UI (Phase 1).
 *
 * Active calibration runs as a FULLSCREEN overlay:
 * dots at true viewport corners + center, so the
 * measured ratio range matches real screen looking.
 * (Calibrating inside a small box compressed the
 * range and misread fullscreen gaze.)
 *
 * After completion it collapses to an inline card
 * with the live debug map. Failing or skipping
 * never blocks the exam.
 */
export function GazeCalibrationPanel({
  mediaStream,
  enabled,
  onComplete,
  onSkip,
}: GazeCalibrationPanelProps) {
  const {
    phase,
    dotOrder,
    dotIndex,
    dotsTotal,
    error,
    livePoint,
    liveStatus,
  } = useGazeCalibration(
    mediaStream,
    enabled,
    onComplete,
  );

  if (phase === "loading" || phase === "sampling") {
    const modelReady =
      liveStatus != null &&
      liveStatus.inferenceCount > 0;

    return (
      <div
        className="gaze-overlay"
        role="dialog"
        aria-label="Kalibrasi mata"
      >
        <p className="gaze-overlay-title">
          Kalibrasi Mata
        </p>

        <p className="gaze-overlay-hint">
          {!modelReady
            ? "Menyiapkan kamera dan model mata..."
            : `Lihat titik merah ${Math.min(
                dotIndex + 1,
                dotsTotal,
              )}/${dotsTotal} — tahan pandangan, jangan gerak`}
        </p>

        {CALIBRATION_DOTS.map(
          (dot, index) => {
            const sequencePosition =
              dotOrder.indexOf(index);

            const isDone =
              sequencePosition < dotIndex;

            const isActive =
              sequencePosition === dotIndex;

            return (
              <span
                key={index}
                className={[
                  "gaze-dot",
                  isActive ? "active" : "",
                  isDone ? "done" : "",
                ].join(" ")}
                style={{
                  left: `${dot.x * 100}%`,
                  top: `${dot.y * 100}%`,
                }}
              />
            );
          },
        )}

        <button
          className="gaze-overlay-skip"
          onClick={onSkip}
        >
          Lewati kalibrasi
        </button>
      </div>
    );
  }

  // Sampling Done/error collapse back to the
  // inline card: success map or fail-open note.
  return (
    <div className="gaze-panel">
      <strong>Kalibrasi Mata</strong>

      {phase === "error" && (
        <p className="gaze-error">
          {error ??
            "Kalibrasi gagal."}{" "}
          Ujian bisa dilanjut tanpa deteksi
          mata.
        </p>
      )}

      {phase === "done" && (
        <>
          <p className="gaze-success">
            ● Kalibrasi selesai — titik di
            bawah mengikuti pandanganmu.
            Gerakkan matamu untuk menguji.
          </p>

          <div className="gaze-map">
            {livePoint && (
              <span
                className="gaze-map-dot"
                style={{
                  left: `${
                    ((livePoint.nx + 1) /
                      2) *
                    100
                  }%`,
                  top: `${
                    ((livePoint.ny + 1) /
                      2) *
                    100
                  }%`,
                }}
              />
            )}

            {(!livePoint ||
              (liveStatus &&
                liveStatus.faceCount !==
                  1)) && (
              <span className="gaze-map-empty">
                {!liveStatus ||
                liveStatus.faceCount === 0
                  ? "tidak ada wajah"
                  : `${liveStatus.faceCount} wajah — butuh tepat 1`}
              </span>
            )}
          </div>

          {livePoint && (
            <p className="gaze-readout">
              x: {livePoint.nx.toFixed(2)} y:{" "}
              {livePoint.ny.toFixed(2)}
            </p>
          )}

          <p className="gaze-debug-line">
            Lihat titik tengah = (0.00,
            0.00). Lihat sudut = mendekati
            ±1.00.
          </p>
        </>
      )}
    </div>
  );
}
