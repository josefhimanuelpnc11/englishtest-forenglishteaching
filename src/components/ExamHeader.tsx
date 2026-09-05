interface ExamHeaderProps {
  title: string;
  formattedTime: string;
  answeredCount: number;
  totalQuestions: number;
}

export function ExamHeader({
  title,
  formattedTime,
  answeredCount,
  totalQuestions,
}: ExamHeaderProps) {
  const isDanger =
    formattedTime === "00:00" ||
    Number(formattedTime.split(":")[0]) < 1;

  return (
    <header className="exam-header">
      <div>
        <h1>{title}</h1>

        <p>
          {answeredCount} / {totalQuestions} soal
          terjawab
        </p>
      </div>

      <div
        className={`timer ${
          isDanger ? "timer-danger" : ""
        }`}
      >
        {formattedTime}
      </div>
    </header>
  );
}