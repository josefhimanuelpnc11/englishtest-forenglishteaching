interface QuestionNavigatorProps {
  totalQuestions: number;
  currentIndex: number;
  answers: Record<string, string>;
  questionIds: string[];
  onSelect: (index: number) => void;
}

export function QuestionNavigator({
  totalQuestions,
  currentIndex,
  answers,
  questionIds,
  onSelect,
}: QuestionNavigatorProps) {
  return (
    <aside className="question-navigator">
      <h3>Navigasi Soal</h3>

      <div className="question-grid">
        {Array.from(
          { length: totalQuestions },
          (_, index) => {
            const questionId =
              questionIds[index];

            const answered =
              Boolean(answers[questionId]);

            const active =
              currentIndex === index;

            return (
              <button
                key={questionId}
                className={[
                  "question-number-button",
                  active
                    ? "active"
                    : "",
                  answered
                    ? "answered"
                    : "",
                ].join(" ")}
                onClick={() =>
                  onSelect(index)
                }
              >
                {index + 1}
              </button>
            );
          },
        )}
      </div>
    </aside>
  );
}