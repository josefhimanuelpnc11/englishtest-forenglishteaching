import type { Question } from "../types/exam";

interface QuestionCardProps {
  question: Question;
  selectedAnswer?: string;
  onAnswer: (
    questionId: string,
    answer: string,
  ) => void;
}

export function QuestionCard({
  question,
  selectedAnswer,
  onAnswer,
}: QuestionCardProps) {
  return (
    <section className="question-card">
      <div className="question-number">
        Soal {question.number}
      </div>

      <h2>{question.text}</h2>

      <div className="options">
        {question.options.map((option) => {
          const checked =
            selectedAnswer === option.id;

          return (
            <label
              key={option.id}
              className={`option ${
                checked ? "option-selected" : ""
              }`}
            >
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={checked}
                onChange={() =>
                  onAnswer(
                    question.id,
                    option.id,
                  )
                }
              />

              <span className="option-letter">
                {option.id}
              </span>

              <span>{option.text}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}