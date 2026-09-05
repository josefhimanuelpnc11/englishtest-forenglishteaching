import type {
  ViolationEvent,
} from "../types/exam";

interface ViolationPanelProps {
  violations: ViolationEvent[];
  violationScore: number;
  maxViolationScore: number;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString(
    "id-ID",
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  );
}

export function ViolationPanel({
  violations,
  violationScore,
  maxViolationScore,
}: ViolationPanelProps) {
  return (
    <aside className="violation-panel">
      <div className="violation-header">
        <div>
          <strong>Pelanggaran</strong>

          <div className="violation-count">
            {violations.length} event
          </div>
        </div>

        <strong>
          {violationScore} / {maxViolationScore}
        </strong>
      </div>

      {violations.length === 0 ? (
        <p className="no-violation">
          Belum ada pelanggaran.
        </p>
      ) : (
        <div className="violation-list">
          {[...violations]
            .reverse()
            .map((violation) => (
              <div
                key={violation.id}
                className={`violation-item violation-${violation.severity.toLowerCase()}`}
              >
                <div className="violation-info">
                  <strong>
                    {violation.type}
                  </strong>

                  <small>
                    {formatTime(
                      violation.timestamp,
                    )}
                  </small>
                </div>

                <span className="violation-score">
                  +{violation.score}
                </span>
              </div>
            ))}
        </div>
      )}
    </aside>
  );
}