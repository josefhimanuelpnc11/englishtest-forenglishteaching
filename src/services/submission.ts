import type {
  Exam,
  ExamResult,
  ViolationEvent,
} from "../types/exam";

export type SubmitStatus =
  | "idle"
  | "sending"
  | "sent"
  | "local-only"
  | "error";

export interface LoginAttempt {
  attemptId: string;
  token: string;
  studentId: string;
  studentName: string;
  examTitle: string;
}

interface LoginResponse {
  status?: unknown;
  attemptId?: unknown;
  token?: unknown;
  studentId?: unknown;
  studentName?: unknown;
  examTitle?: unknown;
  message?: unknown;
}

interface OutboxEntry {
  action: "submit_result" | "log_violations";
  payload: Record<string, unknown>;
  savedAt: number;
  attempts: number;
}

const OUTBOX_KEY =
  "exam-proctoring-outbox-v1";

const RESULT_BACKUP_PREFIX =
  "exam-proctoring-result-";

function getEndpoint(): string {
  return (
    import.meta.env.VITE_GAS_ENDPOINT as
      | string
      | undefined
  )?.trim() ?? "";
}

function getSecret(): string {
  return (
    (import.meta.env.VITE_GAS_SECRET as
      | string
      | undefined) ?? ""
  ).trim();
}

export function isBackendConfigured(): boolean {
  return getEndpoint().length > 0;
}

/**
 * Ping the Apps Script backend (its doGet health
 * check) to see whether results can be delivered.
 *
 * Used by the pre-exam readiness check. A `false`
 * result never blocks the exam — the app is
 * designed to work in local-only mode with the
 * outbox as backstop — it only switches the UI
 * between "Server terhubung" and "Mode lokal".
 */
export async function checkBackend(): Promise<boolean> {
  const endpoint = getEndpoint();

  if (!endpoint) {
    return false;
  }

  try {
    const controller =
      new AbortController();

    const timer = window.setTimeout(
      () => controller.abort(),
      8000,
    );

    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });

    window.clearTimeout(timer);

    if (!response.ok) {
      return false;
    }

    const data: unknown =
      await response.json();

    return (
      typeof data === "object" &&
      data !== null &&
      (data as { status?: unknown })
        .status === "ok"
    );
  } catch {
    return false;
  }
}

function readOutbox(): OutboxEntry[] {
  try {
    const raw =
      localStorage.getItem(OUTBOX_KEY);

    if (!raw) return [];

    const parsed: unknown =
      JSON.parse(raw);

    return Array.isArray(parsed)
      ? (parsed as OutboxEntry[])
      : [];
  } catch {
    return [];
  }
}

function writeOutbox(
  entries: OutboxEntry[],
): void {
  try {
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify(entries),
    );
  } catch {
    // Storage full or unavailable — the in-memory
    // send attempt below is still tried.
  }
}

function enqueue(entry: OutboxEntry): void {
  const outbox = readOutbox();

  // Cap the outbox so a pathological session
  // cannot grow storage without bound.
  if (outbox.length >= 50) {
    outbox.shift();
  }

  outbox.push(entry);
  writeOutbox(outbox);
}

/**
 * POST a JSON payload to the Apps Script endpoint.
 *
 * Uses `Content-Type: text/plain` + `no-cors` so the
 * request stays a CORS "simple request" (no preflight)
 * against the Google endpoint. The response is opaque
 * and cannot be read — delivery is fire-and-forget at
 * the network level, with a localStorage outbox as
 * the durability backstop.
 */
async function postToBackend(
  body: Record<string, unknown>,
): Promise<void> {
  const endpoint = getEndpoint();

  if (!endpoint) {
    throw new Error(
      "Backend endpoint is not configured.",
    );
  }

  const secret = getSecret();

  await fetch(endpoint, {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain",
    },
    body: JSON.stringify(
      secret
        ? { ...body, secret }
        : body,
    ),
  });
}

/**
 * POST and READ the JSON response.
 *
 * Works when the Apps Script deployment allows the
 * response to be read cross-origin. Returns null
 * when the read is blocked (CORS) or fails at the
 * network level — callers fall back to `postToBackend`
 * or an equivalent best-effort path.
 */
async function postReadable(
  body: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = getEndpoint();

  if (!endpoint) {
    throw new Error(
      "Backend endpoint is not configured.",
    );
  }

  const secret = getSecret();

  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain",
    },
    body: JSON.stringify(
      secret
        ? { ...body, secret }
        : body,
    ),
  });

  if (!response.ok) {
    throw new Error(
      `Backend responded HTTP ${response.status}.`,
    );
  }

  return response.json();
}

function readLoginResponse(
  data: unknown,
): LoginAttempt {
  if (
    typeof data !== "object" ||
    data === null
  ) {
    throw new Error(
      "Respons server tidak valid.",
    );
  }

  const res = data as LoginResponse;

  if (res.status !== "ok") {
    throw new Error(
      typeof res.message === "string" &&
        res.message.length > 0
        ? res.message
        : "Login gagal.",
    );
  }

  if (
    typeof res.attemptId !== "string" ||
    typeof res.token !== "string" ||
    typeof res.studentId !== "string" ||
    typeof res.studentName !== "string"
  ) {
    throw new Error(
      "Respons server tidak valid.",
    );
  }

  return {
    attemptId: res.attemptId,
    token: res.token,
    studentId: res.studentId,
    studentName: res.studentName,
    examTitle:
      typeof res.examTitle === "string"
        ? res.examTitle
        : "",
  };
}

/**
 * JSONP login fallback for browsers where reading
 * the POST response cross-origin is blocked.
 * The exam PIN travels in the query string here —
 * acceptable because it is shared with the whole
 * class, unlike tokens (which never use this path).
 */
function loginViaJsonp(
  examId: string,
  nis: string,
  pin: string,
): Promise<LoginAttempt> {
  return new Promise((resolve, reject) => {
    const endpoint = getEndpoint();

    const callbackName =
      "__exam_login_cb_" +
      Date.now().toString(36) +
      Math.floor(
        Math.random() * 1000000,
      ).toString(36);

    const cleanup = () => {
      window.clearTimeout(timer);

      document
        .getElementById(callbackName)
        ?.remove();

      delete (
        window as unknown as Record<
          string,
          unknown
        >
      )[callbackName];
    };

    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Server tidak merespons. Coba lagi.",
        ),
      );
    }, 15000);

    (
      window as unknown as Record<
        string,
        unknown
      >
    )[callbackName] = (data: unknown) => {
      cleanup();

      try {
        resolve(readLoginResponse(data));
      } catch (error) {
        reject(error);
      }
    };

    const query = new URLSearchParams({
      action: "login",
      examId,
      nis,
      pin,
      callback: callbackName,
    });

    const script = document.createElement(
      "script",
    );

    script.id = callbackName;

    script.onerror = () => {
      cleanup();
      reject(
        new Error(
          "Tidak dapat menghubungi server. Periksa koneksi internet.",
        ),
      );
    };

    script.src =
      endpoint +
      (endpoint.includes("?") ? "&" : "?") +
      query.toString();

    document.head.appendChild(script);
  });
}

/**
 * Student login: validates exam PIN + roster NIS
 * server-side and returns an attempt token.
 * Throws an Error with an Indonesian message
 * suitable for showing directly in the UI.
 */
export async function loginAttempt(
  examId: string,
  nis: string,
  pin: string,
): Promise<LoginAttempt> {
  const cleanNis = nis.trim();
  const cleanPin = pin;

  if (!cleanNis || !cleanPin) {
    throw new Error(
      "Isi NIS dan PIN ujian.",
    );
  }

  if (!isBackendConfigured()) {
    throw new Error(
      "Server belum dikonfigurasi. Hubungi guru.",
    );
  }

  // Preferred path: readable POST. A parsed
  // response — including a server-side rejection
  // (wrong PIN/NIS) — is final and never retried
  // through the fallback.
  let transportFailed = false;
  let data: unknown = null;

  try {
    data = await postReadable({
      action: "login",
      examId,
      nis: cleanNis,
      pin: cleanPin,
    });
  } catch {
    transportFailed = true;
  }

  if (!transportFailed) {
    return readLoginResponse(data);
  }

  // Fallback: JSONP login.
  return loginViaJsonp(
    examId,
    cleanNis,
    cleanPin,
  );
}

/**
 * Retry any payloads left in the outbox from
 * previous sessions. Safe to call on app startup.
 *
 * Prefers a readable post: any logical answer from
 * the server (accepted or rejected) settles the
 * entry. Only transport failures keep it queued.
 */
export async function flushOutbox(): Promise<void> {
  const outbox = readOutbox();

  if (outbox.length === 0) return;
  if (!isBackendConfigured()) return;
  if (!navigator.onLine) return;

  const remaining: OutboxEntry[] = [];

  for (const entry of outbox) {
    let settled = false;

    try {
      await postReadable(entry.payload);
      settled = true;
    } catch {
      settled = false;
    }

    if (settled) {
      continue;
    }

    try {
      await postToBackend(entry.payload);
    } catch {
      remaining.push({
        ...entry,
        attempts: entry.attempts + 1,
      });
    }
  }

  writeOutbox(remaining);
}

/**
 * Send the final exam result (answers, score,
 * violations, metadata) to Google Sheets.
 *
 * The attempt token authorizes the call; identity
 * is resolved server-side and never trusted from
 * the request. Prefers confirmed delivery, falls
 * back to opaque fire-and-forget.
 *
 * Never throws: on failure the payload stays in the
 * outbox and a permanent local backup is kept, so no
 * student work is ever lost because of network issues.
 */
export async function submitExamResult(
  exam: Exam,
  result: ExamResult,
  token: string,
): Promise<SubmitStatus> {
  const maxScore = exam.questions.reduce(
    (total, question) =>
      total + question.points,
    0,
  );

  const payload = {
    action: "submit_result",
    attemptId: result.attemptId,
    token,
    result: {
      ...result,
      maxScore,
      userAgent: navigator.userAgent,
    },
  };

  // Permanent local backup, independent of network.
  try {
    localStorage.setItem(
      `${RESULT_BACKUP_PREFIX}${result.attemptId}`,
      JSON.stringify(payload.result),
    );
  } catch {
    // Backup is best-effort; the send is still tried.
  }

  if (!isBackendConfigured()) {
    enqueue({
      action: "submit_result",
      payload,
      savedAt: Date.now(),
      attempts: 0,
    });

    return "local-only";
  }

  enqueue({
    action: "submit_result",
    payload,
    savedAt: Date.now(),
    attempts: 0,
  });

  // Confirmed delivery first.
  try {
    const data = await postReadable(payload);

    if (
      typeof data === "object" &&
      data !== null &&
      (data as { status?: unknown })
        .status === "ok"
    ) {
      await flushOutbox();

      return "sent";
    }

    return "error";
  } catch {
    // Transport failed — opaque fallback below.
  }

  try {
    await postToBackend(payload);
    await flushOutbox();

    return "sent";
  } catch {
    return "error";
  }
}

/**
 * Best-effort delivery of new violation events while
 * the exam is running. Failures are silent by design —
 * the full violation list is always included in the
 * final submission, so nothing is lost.
 */
export async function sendViolationEvents(
  attemptId: string,
  token: string,
  violations: ViolationEvent[],
): Promise<void> {
  if (violations.length === 0) return;
  if (!isBackendConfigured()) return;
  if (!navigator.onLine) return;

  try {
    await postToBackend({
      action: "log_violations",
      attemptId,
      token,
      violations,
    });
  } catch {
    // Intentionally silent — final submit is
    // the source of truth.
  }
}
