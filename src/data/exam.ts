import type { Exam } from "../types/exam";

export const demoExam: Exam = {
  id: "EXAM-001",

  title: "Ujian Informatika Dasar",

  description:
    "Ujian simulasi untuk menguji kemampuan dasar informatika.",

  rules: {
    durationMinutes: 15,

    maxViolationScore: 7,

    autoSubmitOnViolation: true,

    zeroOnCriticalViolation: true,

    rules: {
      TAB_SWITCH: 1,
      FULLSCREEN_EXIT: 1,
      COPY: 1,
      PASTE: 2,
      CUT: 1,
      AUDIO_ACTIVITY: 1,
      MULTIPLE_FACE: 3,
      NO_FACE: 3,
      CAMERA_DISABLED: 5,
      WINDOW_BLUR: 1,
      SHORTCUT: 1,
      CONTEXT_MENU: 1,
      LOOK_AWAY: 1,
    },
  },

  questions: [
    {
      id: "Q1",
      number: 1,
      text: "Apa kepanjangan dari HTML?",

      type: "multiple-choice",

      options: [
        {
          id: "A",
          text: "Hyper Text Markup Language",
        },
        {
          id: "B",
          text: "High Text Machine Language",
        },
        {
          id: "C",
          text: "Hyperlink Text Management Language",
        },
        {
          id: "D",
          text: "Home Tool Markup Language",
        },
      ],

      correctAnswer: "A",
      points: 10,
    },

    {
      id: "Q2",
      number: 2,
      text: "JavaScript dapat berjalan di browser.",

      type: "true-false",

      options: [
        {
          id: "A",
          text: "Benar",
        },
        {
          id: "B",
          text: "Salah",
        },
      ],

      correctAnswer: "A",
      points: 10,
    },

    {
      id: "Q3",
      number: 3,
      text: "Database digunakan untuk menyimpan data secara terstruktur.",

      type: "true-false",

      options: [
        {
          id: "A",
          text: "Benar",
        },
        {
          id: "B",
          text: "Salah",
        },
      ],

      correctAnswer: "A",
      points: 10,
    },

    {
      id: "Q4",
      number: 4,
      text: "Bahasa yang umum digunakan untuk styling halaman web adalah?",

      type: "multiple-choice",

      options: [
        {
          id: "A",
          text: "HTML",
        },
        {
          id: "B",
          text: "CSS",
        },
        {
          id: "C",
          text: "SQL",
        },
        {
          id: "D",
          text: "JSON",
        },
      ],

      correctAnswer: "B",
      points: 10,
    },
  ],
};