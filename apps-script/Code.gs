/**
 * ============================================================================
 * ONLINE EXAM PROCTORING — Google Apps Script backend (Rp0 infrastructure)
 * ============================================================================
 *
 * WHAT THIS DOES
 * -----------
 * Login/identity + exam results + proctoring violation events for a static
 * exam site. Tabs in the bound spreadsheet:
 *
 *   1. "Config"     — key/value settings the teacher edits directly:
 *                      EXAM_ID, EXAM_TITLE, EXAM_PIN, TEACHER_KEY.
 *   2. "Students"   — roster: nis | name (teacher pastes rows here).
 *   3. "Attempts"   — login sessions created by action=login
 *                      (attemptId, token, expiry). Backend scratch space.
 *   4. "Results"    — one row per exam submission. Student identity is
 *                      resolved server-side from the attempt token, never
 *                      trusted from the request.
 *   5. "Violations" — one row per proctoring violation event.
 *
 * All tabs are created automatically with headers on first request.
 * No video is ever uploaded. The browser only sends small JSON payloads.
 *
 * TEACHER SETUP (one time)
 * ------------------------
 *  1. Create a new Google Sheet (e.g. "Ujian Online - Database").
 *  2. Extensions > Apps Script, delete starter code, paste this file.
 *  3. Deploy > New deployment > type "Web app":
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  4. Open the /exec URL once in a browser (creates all tabs),
 *     then open the spreadsheet:
 *       - Config tab: set EXAM_ID (must match ?exam= in the student
 *         link), EXAM_TITLE, EXAM_PIN (share with the class), and
 *         TEACHER_KEY (yours only — used by the teacher dashboard).
 *         Change EXAM_PIN/TEACHER_KEY from the defaults immediately.
 *       - Students tab: paste rows as  nis | name  (e.g. 20261 | Inara).
 *  5. Copy the /exec URL into the frontend `.env` as VITE_GAS_ENDPOINT.
 *  6. Student link format:
 *     https://<your-site>/?exam=EXAM-001
 *
 * IMPORTANT: after every code change here, Deploy > Manage deployments >
 * Edit > New version, otherwise the /exec URL keeps serving old code.
 *
 * ============================================================================
 */

var SHEET_RESULTS = 'Results';
var SHEET_VIOLATIONS = 'Violations';
var SHEET_CONFIG = 'Config';
var SHEET_STUDENTS = 'Students';
var SHEET_ATTEMPTS = 'Attempts';

// Optional shared secret. '' = disabled (accept all requests).
// If set, every request must include the same "secret" field.
var SHARED_SECRET = '';

var RESULTS_HEADERS = [
  'receivedAt',
  'attemptId',
  'examId',
  'studentId',
  'studentName',
  'score',
  'maxScore',
  'violationScore',
  'violationCount',
  'submittedReason',
  'submittedAt',
  'answersJson',
  'userAgent',
];

var VIOLATIONS_HEADERS = [
  'receivedAt',
  'attemptId',
  'examId',
  'studentId',
  'type',
  'severity',
  'score',
  'eventTimestamp',
  'metadataJson',
];

var CONFIG_HEADERS = ['key', 'value'];

var STUDENTS_HEADERS = ['nis', 'name'];

var ATTEMPTS_HEADERS = [
  'createdAt',
  'attemptId',
  'examId',
  'nis',
  'name',
  'token',
  'expiresAt',
  'status',
];

/**
 * Seeded into the Config tab on first run.
 * The teacher edits these cells directly — that is
 * the "editable PIN / editable teacher key".
 * Change EXAM_PIN and TEACHER_KEY immediately:
 * the defaults below are also visible to anyone
 * who can read the frontend repository.
 */
var DEFAULT_CONFIG_ROWS = [
  ['EXAM_ID', 'EXAM-001'],
  ['EXAM_TITLE', 'Ujian'],
  ['EXAM_PIN', 'UJIAN-001'],
  ['TEACHER_KEY', 'GANTI-DENGAN-KUNCI-RAHASIA'],
];

/**
 * How long a login session stays valid.
 */
var ATTEMPT_TTL_HOURS = 6;

/**
 * Health check — open the Web app URL in a browser.
 * Also bootstraps all tabs on first visit.
 */
function doGet(e) {
  ensureTabs();

  var params = (e && e.parameter) || {};

  // JSONP login fallback for browsers where the
  // CORS read of the POST response is blocked.
  // PINs in the query string are acceptable here:
  // the exam PIN is shared with the whole class.
  if (params.action === 'login') {
    var result = handleLogin(params);
    var callback = sanitizeCallback(params.callback);

    if (callback) {
      return ContentService.createTextOutput(
        callback +
          '(' +
          JSON.stringify(result) +
          ')'
      ).setMimeType(
        ContentService.MimeType.JAVASCRIPT
      );
    }

    return jsonResponse(result);
  }

  return jsonResponse({
    status: 'ok',
    service: 'online-exam-proctoring',
    time: new Date().toISOString(),
  });
}

/**
 * Main entry point for frontend POST requests.
 *
 * Accepted actions:
 *   { action: 'login', secret?, examId, nis, pin }
 *   { action: 'submit_result', secret?, attemptId, token, result: {...} }
 *   { action: 'log_violations', secret?, attemptId, token, violations: [...] }
 *
 * submit_result and log_violations REQUIRE a valid
 * attempt token. Identity (nis/name/examId) is always
 * resolved server-side from the Attempts tab — values
 * sent by the browser are ignored.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();

  try {
    // Serialize concurrent writes (whole class
    // submitting in the same minute).
    lock.waitLock(10000);

    var body = parseBody(e);

    if (
      SHARED_SECRET &&
      body.secret !== SHARED_SECRET
    ) {
      return jsonResponse({
        status: 'error',
        message: 'unauthorized',
      });
    }

    if (body.action === 'login') {
      return jsonResponse(
        handleLogin(body)
      );
    }

    var identity = validateAttempt(
      body.attemptId,
      body.token
    );

    if (!identity) {
      return jsonResponse({
        status: 'error',
        message:
          'Sesi tidak valid. Login ulang.',
      });
    }

    if (body.action === 'submit_result') {
      var resultId = appendResult(
        body.result || {},
        identity
      );
      return jsonResponse({
        status: 'ok',
        action: 'submit_result',
        row: resultId,
      });
    }

    if (body.action === 'log_violations') {
      var count = appendViolations(
        body,
        identity
      );
      return jsonResponse({
        status: 'ok',
        action: 'log_violations',
        count: count,
      });
    }

    return jsonResponse({
      status: 'error',
      message: 'unknown action: ' + body.action,
    });
  } catch (error) {
    return jsonResponse({
      status: 'error',
      message: String(error),
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (ignored) {
      // Lock already released or expired.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function appendResult(result, identity) {
  var sheet = getOrCreateSheet(
    SHEET_RESULTS,
    RESULTS_HEADERS
  );

  var answers = result.answers || {};
  var violations = result.violations || [];

  var now = new Date();

  var attemptId = String(result.attemptId || '');
  var examId = identity.examId;
  var studentId = identity.nis;
  var studentName = identity.name;

  sheet.appendRow([
    now,
    attemptId,
    examId,
    studentId,
    studentName,
    Number(result.score || 0),
    Number(result.maxScore || 0),
    Number(result.violationScore || 0),
    violations.length,
    String(result.submittedReason || ''),
    result.submittedAt
      ? new Date(result.submittedAt)
      : now,
    JSON.stringify(answers),
    String(result.userAgent || '').slice(0, 500),
  ]);

  // Violations bundled with the final submission are
  // stored as individual rows for easy filtering.
  if (violations.length > 0) {
    appendViolationRows(
      attemptId,
      examId,
      studentId,
      violations
    );
  }

  return sheet.getLastRow();
}

function appendViolations(body, identity) {
  var violations = body.violations || [];

  if (violations.length === 0) {
    return 0;
  }

  appendViolationRows(
    String(body.attemptId || ''),
    identity.examId,
    identity.nis,
    violations
  );

  return violations.length;
}

function appendViolationRows(
  attemptId,
  examId,
  studentId,
  violations
) {
  var sheet = getOrCreateSheet(
    SHEET_VIOLATIONS,
    VIOLATIONS_HEADERS
  );

  var now = new Date();

  var rows = violations.map(function (v) {
    return [
      now,
      attemptId,
      examId,
      studentId,
      String(v.type || ''),
      String(v.severity || ''),
      Number(v.score || 0),
      v.timestamp ? new Date(v.timestamp) : now,
      JSON.stringify(v.metadata || {}),
    ];
  });

  sheet
    .getRange(
      sheet.getLastRow() + 1,
      1,
      rows.length,
      VIOLATIONS_HEADERS.length
    )
    .setValues(rows);
}

/* ------------------------------------------------------------------ */
/* Login & attempt tokens                                            */
/* ------------------------------------------------------------------ */

/**
 * Creates Config/Students/Attempts tabs on first run
 * and seeds the default Config keys (edited by the
 * teacher afterwards).
 */
function ensureTabs() {
  var config = getOrCreateSheet(
    SHEET_CONFIG,
    CONFIG_HEADERS
  );

  if (config.getLastRow() === 1) {
    config
      .getRange(
        2,
        1,
        DEFAULT_CONFIG_ROWS.length,
        2
      )
      .setValues(DEFAULT_CONFIG_ROWS);
  }

  getOrCreateSheet(
    SHEET_STUDENTS,
    STUDENTS_HEADERS
  );

  getOrCreateSheet(
    SHEET_ATTEMPTS,
    ATTEMPTS_HEADERS
  );
}

function getConfigMap() {
  ensureTabs();

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    SHEET_CONFIG
  );

  var values = sheet.getDataRange().getValues();
  var map = {};

  for (var i = 1; i < values.length; i += 1) {
    var key = String(
      values[i][0] || ''
    ).trim();

    if (key) {
      map[key] = String(values[i][1] || '');
    }
  }

  return map;
}

function findStudent(nis) {
  ensureTabs();

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    SHEET_STUDENTS
  );

  var values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i += 1) {
    if (
      String(values[i][0] || '').trim() ===
      String(nis).trim()
    ) {
      return String(values[i][1] || '').trim();
    }
  }

  return null;
}

/**
 * Student login: checks exam PIN + roster NIS,
 * then issues an attempt token. The token (not the
 * PIN) authorizes all later calls.
 */
function handleLogin(body) {
  var config = getConfigMap();

  var examId = String(
    (body && body.examId) || ''
  ).trim();

  var nis = String(
    (body && body.nis) || ''
  ).trim();

  var pin = String(
    (body && body.pin) || ''
  );

  if (!examId || !nis || !pin) {
    return {
      status: 'error',
      message: 'Data login belum lengkap.',
    };
  }

  if (
    examId !== String(config.EXAM_ID || '')
  ) {
    return {
      status: 'error',
      message: 'ID ujian tidak dikenal.',
    };
  }

  if (pin !== String(config.EXAM_PIN || '')) {
    return {
      status: 'error',
      message: 'PIN ujian salah.',
    };
  }

  var studentName = findStudent(nis);

  if (!studentName) {
    return {
      status: 'error',
      message:
        'NIS tidak terdaftar. Hubungi guru.',
    };
  }

  var attemptId = Utilities.getUuid();
  var token =
    Utilities.getUuid() +
    Utilities.getUuid();

  var now = new Date();

  var sheet = getOrCreateSheet(
    SHEET_ATTEMPTS,
    ATTEMPTS_HEADERS
  );

  sheet.appendRow([
    now,
    attemptId,
    examId,
    nis,
    studentName,
    token,
    new Date(
      now.getTime() +
        ATTEMPT_TTL_HOURS * 3600 * 1000
    ),
    'ACTIVE',
  ]);

  return {
    status: 'ok',
    attemptId: attemptId,
    token: token,
    studentId: nis,
    studentName: studentName,
    examTitle: String(
      config.EXAM_TITLE || ''
    ),
  };
}

/**
 * Validates an attempt token. Returns the
 * server-side identity { nis, name, examId }
 * or null. Identity for Results/Violations rows
 * always comes from here.
 */
function validateAttempt(attemptId, token) {
  if (!attemptId || !token) {
    return null;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    SHEET_ATTEMPTS
  );

  if (!sheet || sheet.getLastRow() < 2) {
    return null;
  }

  var values = sheet.getDataRange().getValues();

  for (
    var i = values.length - 1;
    i >= 1;
    i -= 1
  ) {
    if (
      String(values[i][1]) !==
      String(attemptId)
    ) {
      continue;
    }

    if (
      String(values[i][5]) !== String(token)
    ) {
      return null;
    }

    if (
      String(values[i][7]) === 'REVOKED'
    ) {
      return null;
    }

    var expires = values[i][6];
    var expiresAt =
      expires instanceof Date
        ? expires.getTime()
        : new Date(expires).getTime();

    if (expiresAt < Date.now()) {
      return null;
    }

    return {
      nis: String(values[i][3]),
      name: String(values[i][4]),
      examId: String(values[i][2]),
    };
  }

  return null;
}

function sanitizeCallback(callback) {
  var name = String(callback || '');

  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return '';
  }

  return name;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function parseBody(e) {
  if (e && e.postData && e.postData.contents) {
    return JSON.parse(e.postData.contents);
  }

  if (e && e.parameter && e.parameter.payload) {
    return JSON.parse(e.parameter.payload);
  }

  return {};
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(
    JSON.stringify(obj)
  ).setMimeType(ContentService.MimeType.JSON);
}
