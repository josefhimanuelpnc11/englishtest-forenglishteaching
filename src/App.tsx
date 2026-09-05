import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CameraPreview } from "./components/CameraPreview";

import { ExamHeader } from "./components/ExamHeader";

import { FaceWarningBanner } from "./components/FaceWarningBanner";

import { GazeCalibrationPanel } from "./components/GazeCalibrationPanel";

import { LookAwayBanner } from "./components/LookAwayBanner";

import { QuestionCard } from "./components/QuestionCard";

import { QuestionNavigator } from "./components/QuestionNavigator";

import { ViolationPanel } from "./components/ViolationPanel";

import { demoExam } from "./data/exam";

import { useExam } from "./hooks/useExam";

import { useFaceCheck } from "./hooks/useFaceCheck";

import { useProctoring } from "./hooks/useProctoring";

import {
  checkBackend,
  flushOutbox,
  loginAttempt,
  sendViolationEvents,
  submitExamResult,
} from "./services/submission";

import type { ExamResult } from "./types/exam";

import type { FaceMonitorStatus } from "./services/proctoring/types";

import type { GazeReferences } from "./services/gaze/gazeMath";

import type {
  LoginAttempt,
  SubmitStatus,
} from "./services/submission";

/**
 * Status line for the pre-exam face checklist.
 */
function getFaceCheckLine(
  cameraOk: boolean,
  faceError: string | null,
  status: FaceMonitorStatus | null,
  steadyCount: number,
  faceReady: boolean,
): string {
  if (faceError) {
    return "Deteksi wajah gagal dimulai";
  }

  if (!cameraOk) {
    return "Menunggu izin kamera...";
  }

  if (
    !status ||
    status.inferenceCount === 0
  ) {
    return (
      "Memuat model deteksi... " +
      "(pertama kali ~30 detik)"
    );
  }

  if (
    status.consecutiveInferenceErrors > 0
  ) {
    return "Deteksi wajah error";
  }

  if (faceReady) {
    return (
      `1 wajah terdeteksi ` +
      `(${status.topScore.toFixed(2)})`
    );
  }

  if (status.faceCount === 0) {
    return (
      "Belum ada wajah — posisikan wajah " +
      `di depan kamera (${steadyCount}/3)`
    );
  }

  return (
    `${status.faceCount} wajah terlihat — ` +
    `pastikan hanya 1 wajah (${steadyCount}/3)`
  );
}

function App() {
  const [started, setStarted] =
    useState(false);

  const [cameraStream, setCameraStream] =
    useState<MediaStream | null>(null);

  const [finalResult, setFinalResult] =
    useState<ExamResult | null>(null);

  const [cameraError, setCameraError] =
    useState<string | null>(null);

  const [nis, setNis] = useState("");

  const [pin, setPin] = useState("");

  const [attempt, setAttempt] =
    useState<LoginAttempt | null>(null);

  const [loginBusy, setLoginBusy] =
    useState(false);

  const [loginError, setLoginError] =
    useState<string | null>(null);

  const [submitStatus, setSubmitStatus] =
    useState<SubmitStatus>("idle");

  const [backendStatus, setBackendStatus] =
    useState<
      "checking" | "online" | "local"
    >("checking");

  /**
   * Phase 1 gaze calibration result.
   * gazePassed also becomes true when calibration
   * is skipped or fails — gaze never blocks exams.
   */
  const [gazeRefs, setGazeRefs] =
    useState<GazeReferences | null>(null);

  const [gazePassed, setGazePassed] =
    useState(false);

  const syncedViolationsRef = useRef(0);

  /**
   * Exam scope from the student link, e.g.
   * https://<site>/?exam=EXAM-001
   * Must match EXAM_ID in the Config tab.
   */
  const examIdParam = useMemo(() => {
    const fromUrl = new URLSearchParams(
      window.location.search,
    )
      .get("exam")
      ?.trim();

    return fromUrl && fromUrl.length > 0
      ? fromUrl
      : demoExam.id;
  }, []);

  const handleLogin = useCallback(async () => {
    if (loginBusy) return;

    setLoginBusy(true);
    setLoginError(null);

    try {
      const result = await loginAttempt(
        examIdParam,
        nis,
        pin,
      );

      setAttempt(result);
      setPin("");
      syncedViolationsRef.current = 0;
    } catch (error) {
      setLoginError(
        error instanceof Error
          ? error.message
          : "Login gagal. Coba lagi.",
      );
    } finally {
      setLoginBusy(false);
    }
  }, [examIdParam, loginBusy, nis, pin]);

  const handleLogout = useCallback(() => {
    setAttempt(null);
    setPin("");
    setLoginError(null);
  }, []);

  const handleGazeComplete = useCallback(
    (references: GazeReferences | null) => {
      console.log(
        "[GAZE] Calibration references:",
        references,
      );

      setGazeRefs(references);
      setGazePassed(true);
    },
    [],
  );

  const handleGazeSkip = useCallback(() => {
    console.log(
      "[GAZE] Calibration skipped by student.",
    );

    setGazeRefs(null);
    setGazePassed(true);
  }, []);

  const handleCameraReady = useCallback(
    (stream: MediaStream) => {
      setCameraStream(stream);
    },
    [],
  );

  const handleCameraStopped = useCallback(() => {
    setCameraStream(null);
  }, []);

  const handleStartExam = useCallback(async () => {
    if (!attempt) return;

    try {
      if (
        document.fullscreenElement == null &&
        document.documentElement.requestFullscreen
      ) {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn(
        "Fullscreen request failed:",
        error,
      );
    }

    syncedViolationsRef.current = 0;
    setStarted(true);
  }, [attempt]);

  const handleSubmit = useCallback(
    (result: ExamResult) => {
      console.log(
        "[EXAM RESULT]",
        result,
      );

      setFinalResult(result);
      setSubmitStatus("sending");

      if (!attempt) {
        setSubmitStatus("error");
        return;
      }

      // Best-effort delivery — the local backup is
      // always kept, so this never blocks the UI.
      submitExamResult(
        demoExam,
        result,
        attempt.token,
      )
        .then((status) => {
          setSubmitStatus(status);
        })
        .catch(() => {
          setSubmitStatus("error");
        });
    },
    [attempt],
  );

  const {
    currentQuestion,
    currentQuestionIndex,
    answers,
    answeredCount,
    formattedTime,
    isSubmitted,
    setAnswer,
    goNext,
    goPrevious,
    goToQuestion,
    submitExam,
  } = useExam({
    exam: demoExam,

    studentId: attempt?.studentId ?? "",

    studentName: attempt?.studentName ?? "",

    attemptId: attempt?.attemptId,

    onSubmit: handleSubmit,
  });

  const {
    violations,
    violationScore,
    faceStatus,
    faceError,
    gazeStatus,
  } = useProctoring({
    exam: demoExam,

    enabled:
      started && !isSubmitted,

    mediaStream: cameraStream,

    gazeReferences: gazeRefs,

    onAutoSubmit: (
      violations,
      score,
    ) => {
      submitExam(
        "AUTO_VIOLATION",
        score,
        violations,
      );
    },
  });

  // Retry any payloads left over from previous
  // sessions (offline submits, closed tabs, ...).
  useEffect(() => {
    void flushOutbox();
  }, []);

  // Ping the backend once so the start page can
  // show "Server terhubung" vs "Mode lokal".
  // Never blocks the exam either way.
  useEffect(() => {
    let cancelled = false;

    checkBackend().then((online) => {
      if (!cancelled) {
        setBackendStatus(
          online ? "online" : "local",
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Pre-exam readiness sensor.
   *
   * Runs face detection as a pure sensor (no
   * violations) while the start page is shown, so
   * the Start button can require a working camera
   * with exactly one steady face. Stops automatically
   * when the exam starts; exam proctoring takes over.
   */
  const {
    faceStatus: checkStatus,
    faceError: checkError,
    steadyCount,
    faceReady,
  } = useFaceCheck(
    cameraStream,
    !started && attempt != null,
  );

  // Stream new violation events to the backend as
  // they happen (best-effort — the final submission
  // always carries the complete list).
  useEffect(() => {
    if (!started || isSubmitted) return;
    if (!attempt) return;

    const newViolations =
      violations.slice(
        syncedViolationsRef.current,
      );

    if (newViolations.length === 0) return;

    syncedViolationsRef.current =
      violations.length;

    void sendViolationEvents(
      attempt.attemptId,
      attempt.token,
      newViolations,
    );
  }, [
    violations,
    started,
    isSubmitted,
    attempt,
  ]);

  const handleRetrySubmit = useCallback(() => {
    if (!finalResult) return;
    if (!attempt) return;

    setSubmitStatus("sending");

    submitExamResult(
      demoExam,
      finalResult,
      attempt.token,
    )
      .then((status) => {
        setSubmitStatus(status);
      })
      .catch(() => {
        setSubmitStatus("error");
      });
  }, [finalResult, attempt]);

  if (finalResult) {
    const hasCriticalViolation =
      finalResult.violations.some(
        (violation) =>
          violation.severity === "CRITICAL",
      );

    return (
      <main className="result-page">
        <div className="result-card">
          <h1>Ujian Selesai</h1>

          <p>
            Peserta:{" "}
            {finalResult.studentName} (
            {finalResult.studentId})
          </p>

          <div className="result-score">
            {finalResult.score}
          </div>

          {hasCriticalViolation && (
            <p className="result-zero-note">
              Nilai ditetapkan 0 karena
              pelanggaran kritis
              (kamera dimatikan).
            </p>
          )}

          <p>
            Violation Score:{" "}
            {finalResult.violationScore}
          </p>

          <p>
            Submit Reason:{" "}
            {finalResult.submittedReason}
          </p>

          <p className="submit-status">
            {submitStatus === "sending" &&
              "Mengirim hasil ke server..."}
            {submitStatus === "sent" &&
              "Hasil terkirim ke server."}
            {submitStatus ===
              "local-only" &&
              "Server belum dikonfigurasi — hasil tersimpan di perangkat ini."}
            {submitStatus === "error" && (
              <>
                Gagal mengirim hasil.
                Jawaban tetap tersimpan di
                perangkat ini.{" "}
                <button
                  className="link-button"
                  onClick={
                    handleRetrySubmit
                  }
                >
                  Coba lagi
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    );
  }


  const cameraOk =
    cameraStream != null &&
    cameraError == null;

  const faceLine = getFaceCheckLine(
    cameraOk,
    checkError,
    checkStatus,
    steadyCount,
    faceReady,
  );

  const backendLine =
    backendStatus === "checking"
      ? "○ Memeriksa koneksi server..."
      : backendStatus === "online"
        ? "● Server terhubung"
        : "○ Mode lokal — hasil tersimpan di perangkat ini";

  const canStart =
    attempt != null &&
    cameraOk &&
    faceReady &&
    gazePassed;

  if (!started) {
    return (
      <main className="start-page">
        <div className="start-card">
          <h1>{demoExam.title}</h1>

          <p>
            {demoExam.description}
          </p>

          {!attempt ? (
            <div className="identity-form">
              <label>
                NIS
                <input
                  type="text"
                  value={nis}
                  onChange={(event) =>
                    setNis(
                      event.target.value,
                    )
                  }
                  placeholder="cth. 20261"
                  autoComplete="off"
                  disabled={loginBusy}
                />
              </label>

              <label>
                PIN Ujian
                <input
                  type="password"
                  value={pin}
                  onChange={(event) =>
                    setPin(
                      event.target.value,
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter"
                    ) {
                      void handleLogin();
                    }
                  }}
                  placeholder="Minta ke guru"
                  autoComplete="off"
                  disabled={loginBusy}
                />
              </label>

              {loginError && (
                <div className="camera-error">
                  {loginError}
                </div>
              )}

              <button
                className="primary-button"
                onClick={() =>
                  void handleLogin()
                }
                disabled={
                  loginBusy ||
                  nis.trim().length === 0 ||
                  pin.length === 0
                }
              >
                {loginBusy
                  ? "Memeriksa..."
                  : "Masuk"}
              </button>
            </div>
          ) : (
            <>
              <div className="user-chip">
                <span>
                  Masuk sebagai{" "}
                  <strong>
                    {attempt.studentName}
                  </strong>{" "}
                  ({attempt.studentId})
                </span>

                <button
                  className="link-button"
                  onClick={handleLogout}
                >
                  Keluar
                </button>
              </div>

              <div className="precheck">
                <strong>
                  Pemeriksaan sebelum ujian:
                </strong>

                <div className="precheck-camera">
                  <CameraPreview
                    enabled={!started}
                    faceStatus={checkStatus}
                    faceError={checkError}
                    onReady={
                      handleCameraReady
                    }
                    onStopped={
                      handleCameraStopped
                    }
                    onCameraError={
                      setCameraError
                    }
                  />
                </div>

                {cameraError && (
                  <div className="camera-error">
                    {cameraError}
                  </div>
                )}

                <ul className="precheck-list">
                  <li className="ok">
                    ● Login berhasil
                  </li>

                  <li
                    className={
                      cameraOk ? "ok" : ""
                    }
                  >
                    {cameraOk ? "●" : "○"}{" "}
                    Kamera aktif
                  </li>

                  <li
                    className={
                      faceReady ? "ok" : ""
                    }
                  >
                    {faceReady ? "●" : "○"}{" "}
                    {faceLine}
                  </li>

                  <li
                    className={
                      gazePassed ? "ok" : ""
                    }
                  >
                    {gazePassed ? "●" : "○"}{" "}
                    {gazePassed
                      ? gazeRefs
                        ? "Kalibrasi mata selesai"
                        : "Kalibrasi mata dilewati"
                      : "Kalibrasi mata"}
                  </li>

                  <li className="info">
                    {backendLine}
                  </li>
                </ul>
              </div>
            </>
          )}

          {attempt && faceReady && (
            <GazeCalibrationPanel
              mediaStream={cameraStream}
              enabled={!started}
              onComplete={
                handleGazeComplete
              }
              onSkip={handleGazeSkip}
            />
          )}

          {attempt && (
            <>
              <div className="rules">
            <strong>
              Selama ujian:
            </strong>

            <ul>
              <li>
                Tetap di depan kamera.
              </li>

              <li>
                Jangan berpindah tab atau
                keluar fullscreen.
              </li>

              <li>
                Jangan melakukan copy/paste,
                klik kanan, atau shortcut
                mencurigakan.
              </li>

              <li>
                Pelanggaran berat
                mengakibatkan nilai 0 dan
                ujian dikumpulkan otomatis.
              </li>
            </ul>
          </div>

          <button
            className="primary-button"
            onClick={handleStartExam}
            disabled={!canStart}
          >
            Mulai Ujian
          </button>

          {!canStart && (
            <p className="form-hint">
              Lengkapi pemeriksaan di atas
              untuk memulai ujian.
            </p>
          )}
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="exam-page">
      <ExamHeader
        title={demoExam.title}
        formattedTime={formattedTime}
        answeredCount={answeredCount}
        totalQuestions={
          demoExam.questions.length
        }
      />

      <div className="exam-layout">
        <section className="exam-main">
          <FaceWarningBanner
            status={faceStatus}
          />

          <LookAwayBanner
            status={gazeStatus}
          />

          <QuestionCard
            question={currentQuestion}
            selectedAnswer={
              answers[currentQuestion.id]
            }
            onAnswer={setAnswer}
          />

          <div className="exam-controls">
            <button
              onClick={goPrevious}
              disabled={
                currentQuestionIndex === 0
              }
            >
              Sebelumnya
            </button>

            {currentQuestionIndex <
            demoExam.questions.length -
              1 ? (
              <button
                className="primary-button"
                onClick={goNext}
              >
                Berikutnya
              </button>
            ) : (
              <button
                className="submit-button"
                onClick={() =>
                  submitExam("MANUAL")
                }
              >
                Kumpulkan Ujian
              </button>
            )}
          </div>
        </section>

        <section className="exam-sidebar">
          <CameraPreview
            enabled={
              started && !isSubmitted
            }
            faceStatus={faceStatus}
            faceError={faceError}
            onReady={handleCameraReady}
            onStopped={handleCameraStopped}
            onCameraError={
              setCameraError
            }
          />

          {cameraError && (
            <div className="camera-error">
              {cameraError}
            </div>
          )}

          <QuestionNavigator
            totalQuestions={
              demoExam.questions.length
            }
            currentIndex={
              currentQuestionIndex
            }
            answers={answers}
            questionIds={demoExam.questions.map(
              (question) => question.id,
            )}
            onSelect={goToQuestion}
          />

          <ViolationPanel
            violations={violations}
            violationScore={
              violationScore
            }
            maxViolationScore={
              demoExam.rules
                .maxViolationScore
            }
          />
        </section>
      </div>
    </main>
  );
}

export default App;
