import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  Exam,
  ExamResult,
  ViolationEvent,
} from "../types/exam";

interface UseExamProps {
  exam: Exam;
  studentId: string;
  studentName: string;
  attemptId?: string;
  onSubmit?: (result: ExamResult) => void;
}

export function useExam({
  exam,
  studentId,
  studentName,
  attemptId,
  onSubmit,
}: UseExamProps) {
  const [currentQuestionIndex, setCurrentQuestionIndex] =
    useState(0);

  const [answers, setAnswers] =
    useState<Record<string, string>>({});

  const [remainingSeconds, setRemainingSeconds] =
    useState(exam.rules.durationMinutes * 60);

  const [isSubmitted, setIsSubmitted] =
    useState(false);

  const [submitReason, setSubmitReason] =
    useState<ExamResult["submittedReason"] | null>(null);

  const currentQuestion =
    exam.questions[currentQuestionIndex];

  const answeredCount = useMemo(() => {
    return Object.keys(answers).length;
  }, [answers]);

  const setAnswer = useCallback(
    (questionId: string, answer: string) => {
      if (isSubmitted) return;

      setAnswers((previous) => ({
        ...previous,
        [questionId]: answer,
      }));
    },
    [isSubmitted],
  );

  const goNext = useCallback(() => {
    setCurrentQuestionIndex((previous) =>
      Math.min(
        previous + 1,
        exam.questions.length - 1,
      ),
    );
  }, [exam.questions.length]);

  const goPrevious = useCallback(() => {
    setCurrentQuestionIndex((previous) =>
      Math.max(previous - 1, 0),
    );
  }, []);

  const goToQuestion = useCallback(
    (index: number) => {
      if (
        index < 0 ||
        index >= exam.questions.length
      ) {
        return;
      }

      setCurrentQuestionIndex(index);
    },
    [exam.questions.length],
  );

  const calculateScore = useCallback(() => {
    let score = 0;

    for (const question of exam.questions) {
      const userAnswer = answers[question.id];

      if (
        userAnswer &&
        userAnswer === question.correctAnswer
      ) {
        score += question.points;
      }
    }

    return score;
  }, [answers, exam.questions]);

  const submitExam = useCallback(
    (
      reason: ExamResult["submittedReason"] = "MANUAL",
      violationScore = 0,
      violations: ViolationEvent[] = [],
    ) => {
      if (isSubmitted) return;

      const criticalViolationDetected =
        exam.rules.zeroOnCriticalViolation &&
        violations.some(
          (violation) =>
            violation.severity === "CRITICAL",
        );

      const finalScore = criticalViolationDetected
        ? 0
        : calculateScore();

      const result: ExamResult = {
        attemptId:
          attemptId ?? crypto.randomUUID(),

        examId: exam.id,

        studentId,

        studentName,

        answers,

        score: finalScore,

        violationScore,

        violations,

        submittedAt: Date.now(),

        submittedReason: reason,
      };

      setIsSubmitted(true);
      setSubmitReason(reason);

      onSubmit?.(result);
    },
    [
      answers,
      attemptId,
      calculateScore,
      exam.id,
      exam.rules.zeroOnCriticalViolation,
      isSubmitted,
      onSubmit,
      studentId,
      studentName,
    ],
  );

  useEffect(() => {
    if (isSubmitted) {
      return;
    }

    if (remainingSeconds <= 0) {
      submitExam("TIMEOUT");
      return;
    }

    const timer = window.setInterval(() => {
      setRemainingSeconds((previous) =>
        Math.max(previous - 1, 0),
      );
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    isSubmitted,
    remainingSeconds,
    submitExam,
  ]);

  const formattedTime = useMemo(() => {
    const minutes = Math.floor(
      remainingSeconds / 60,
    );

    const seconds = remainingSeconds % 60;

    return `${minutes
      .toString()
      .padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }, [remainingSeconds]);

  return {
    currentQuestion,
    currentQuestionIndex,

    answers,

    answeredCount,

    remainingSeconds,
    formattedTime,

    isSubmitted,
    submitReason,

    setAnswer,

    goNext,
    goPrevious,
    goToQuestion,

    submitExam,

    calculateScore,
  };
}