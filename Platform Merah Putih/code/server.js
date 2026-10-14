'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const OTP_VALIDITY_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 15 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ---------- Penyimpanan data (file JSON di folder data/) ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function save(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const db = {
  students: load('students.json', {}),
  exams: load('exams.json', {}),
  results: load('results.json', []),
  sessions: load('sessions.json', {}),
  logs: load('logs.json', [])
};

const adminTokens = new Map(); // token -> waktu kedaluwarsa
const loginAttempts = new Map(); // ip -> { count, resetAt }

/* ---------- Helper umum ---------- */

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const newToken = () => crypto.randomBytes(24).toString('hex');
const qType = (q) => (q.type === 'essay' ? 'essay' : 'multiple_choice');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

const fail = (res, status, message, extra = {}) => sendJson(res, status, { success: false, message, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function tooManyAttempts(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 1000 };
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count > 15;
}

function log(event, detail = {}) {
  db.logs.push({ timestamp: new Date().toISOString(), event, ...detail });
  if (db.logs.length > 500) db.logs = db.logs.slice(-500);
  save('logs.json', db.logs);
}

const saveSessions = () => save('sessions.json', db.sessions);

/* ---------- Sesi ujian ---------- */

function createSession(student, exam) {
  const qOrder = exam.questions.map((_, i) => i);
  if (exam.shuffleQuestions) shuffle(qOrder);

  const optionOrders = {};
  exam.questions.forEach((q, i) => {
    if (qType(q) === 'multiple_choice' && exam.shuffleOptions) {
      optionOrders[i] = shuffle(q.options.map((o) => o.id));
    }
  });

  const session = {
    id: crypto.randomBytes(6).toString('hex'),
    token: null,
    studentId: student.id,
    examId: exam.id,
    startedAt: Date.now(),
    status: 'active', // active | locked | finished
    answers: {},
    qOrder,
    optionOrders,
    violations: [],
    otp: null,
    lockReason: null,
    lockedAt: null,
    clipboardAttempts: 0,
    lastSeen: Date.now(),
    finishedAt: null,
    summary: null
  };
  db.sessions[session.id] = session;
  log('EXAM_START', { studentId: student.id, studentName: student.name, examId: exam.id });
  return session;
}

function remainingSeconds(session, exam) {
  const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
  return Math.max(0, exam.durationMinutes * 60 - elapsed);
}

function issueOTP(session) {
  session.otp = {
    code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
    expiresAt: Date.now() + OTP_VALIDITY_MS,
    attempts: 0
  };
}

function hasValidOTP(session) {
  return !!(session.otp && Date.now() < session.otp.expiresAt && session.otp.attempts < OTP_MAX_ATTEMPTS);
}

function recordViolation(session, type, message) {
  const student = db.students[session.studentId] || {};
  if (session.status !== 'active') {
    // Sudah terkunci: cukup dicatat di log, tidak membuat OTP baru atau menambah hitungan
    log('VIOLATION_WHILE_LOCKED', { studentId: session.studentId, studentName: student.name, type, message });
    return;
  }
  session.violations.push({ type, message, timestamp: new Date().toISOString() });
  session.status = 'locked';
  session.lockReason = message;
  session.lockedAt = Date.now();
  issueOTP(session);
  log('VIOLATION_LOCK', { studentId: session.studentId, studentName: student.name, type, message });
}

const optText = (q, id) => {
  const o = (q.options || []).find((x) => x.id === id);
  return o ? o.text : '';
};

function grade(session, exam) {
  let correct = 0, wrong = 0, empty = 0, essayCount = 0;
  const details = [];

  session.qOrder.forEach((qi) => {
    const q = exam.questions[qi];
    if (!q) return;
    const answer = session.answers[qi];

    if (qType(q) === 'essay') {
      essayCount++;
      const text = String(answer || '').trim();
      if (!text) empty++;
      details.push({
        qid: qi,
        type: 'essay',
        questionText: q.text,
        answer: text,
        wordCount: text ? text.split(/\s+/).length : 0,
        keywords: q.keywords || [],
        keywordsFound: (q.keywords || []).filter((k) => text.toLowerCase().includes(String(k).toLowerCase())),
        sampleAnswer: q.sampleAnswer || '',
        maxWords: q.maxWords || null,
        minWords: q.minWords || null,
        needsGrading: true
      });
      return;
    }

    let isCorrect = null;
    if (answer === undefined || answer === '') {
      empty++;
    } else if (answer === q.correctAnswer) {
      correct++;
      isCorrect = true;
    } else {
      wrong++;
      isCorrect = false;
    }
    details.push({
      qid: qi,
      type: 'multiple_choice',
      questionText: q.text,
      answer: answer ?? null,
      answerText: answer ? optText(q, answer) : '',
      correctAnswer: q.correctAnswer,
      correctText: optText(q, q.correctAnswer),
      isCorrect
    });
  });

  const total = session.qOrder.length;
  const gradedTotal = total - essayCount;
  const percent = gradedTotal > 0 ? Math.round((correct / gradedTotal) * 100) : 0;
  return { summary: { correct, wrong, empty, essayCount, percent, total }, details };
}

/* ---------- Penilaian oleh pengawas ---------- */

function essayProgress(r) {
  const essays = (r.details || []).filter((d) => d.type === 'essay');
  const scores = (r.grading && r.grading.scores) || {};
  const graded = essays.filter((d) => typeof scores[d.qid] === 'number').length;
  return { essays: essays.length, graded };
}

// Nilai akhir = (jumlah benar PG + jumlah nilai esai/100) / jumlah soal x 100. Null bila masih ada esai belum dinilai.
function finalScore(r) {
  const { essays, graded } = essayProgress(r);
  if (graded < essays || !r.total) return null;
  const scores = (r.grading && r.grading.scores) || {};
  const essayPoints = (r.details || []).filter((d) => d.type === 'essay').reduce((sum, d) => sum + scores[d.qid] / 100, 0);
  return Math.round(((r.correct + essayPoints) / r.total) * 1000) / 10;
}

function resultRow(r) {
  const { essays, graded } = essayProgress(r);
  return {
    id: r.sessionId,
    studentId: r.studentId,
    studentName: r.studentName,
    class: r.class,
    examId: r.examId,
    examTitle: r.examTitle,
    submittedAt: r.submittedAt,
    endReason: r.endReason,
    correct: r.correct,
    wrong: r.wrong,
    empty: r.empty,
    total: r.total,
    essayCount: essays,
    essayGraded: graded,
    finalScore: finalScore(r),
    violations: (r.violations || []).length,
    clipboardAttempts: r.clipboardAttempts || 0
  };
}

function finishSession(session, reason) {
  if (session.status === 'finished') return;
  const exam = db.exams[session.examId];
  const student = db.students[session.studentId] || {};
  const g = exam ? grade(session, exam) : { summary: { correct: 0, wrong: 0, empty: 0, essayCount: 0, percent: 0, total: 0 }, details: [] };

  session.status = 'finished';
  session.finishedAt = Date.now();
  session.otp = null;
  session.summary = { ...g.summary, endReason: reason, violations: session.violations };

  db.results.push({
    sessionId: session.id,
    studentId: session.studentId,
    studentName: student.name || session.studentId,
    class: student.class || '',
    examId: session.examId,
    examTitle: exam ? exam.title : session.examId,
    startedAt: new Date(session.startedAt).toISOString(),
    submittedAt: new Date(session.finishedAt).toISOString(),
    durationSeconds: Math.floor((session.finishedAt - session.startedAt) / 1000),
    endReason: reason,
    ...g.summary,
    violations: session.violations,
    clipboardAttempts: session.clipboardAttempts || 0,
    grading: null,
    finalScore: null,
    details: g.details
  });
  const saved = db.results[db.results.length - 1];
  saved.finalScore = finalScore(saved);
  save('results.json', db.results);
  log('EXAM_FINISH', { studentId: session.studentId, studentName: student.name, examId: session.examId, reason, percent: g.summary.percent });
}

function expireIfTimeUp(session) {
  if (session.status === 'finished') return;
  const exam = db.exams[session.examId];
  if (!exam || remainingSeconds(session, exam) <= 0) {
    finishSession(session, 'timeout');
  }
}

function buildQuestions(session, exam) {
  return session.qOrder
    .map((qi) => {
      const q = exam.questions[qi];
      if (!q) return null;
      const type = qType(q);
      const item = { qid: qi, text: q.text, type };
      if (type === 'essay') {
        item.maxWords = q.maxWords;
        item.minWords = q.minWords;
      } else {
        const order = session.optionOrders[qi] || q.options.map((o) => o.id);
        item.options = order
          .map((id) => q.options.find((o) => o.id === id))
          .filter(Boolean)
          .map((o) => ({ id: o.id, text: o.text }));
      }
      return item;
    })
    .filter(Boolean);
}

// Data sesi yang aman dikirim ke student (tanpa kunci jawaban dan tanpa kode OTP)
function studentState(session) {
  const exam = db.exams[session.examId];
  const student = db.students[session.studentId] || {};
  const state = {
    status: session.status,
    student: { id: student.id, name: student.name, class: student.class },
    exam: exam ? { id: exam.id, title: exam.title, durationMinutes: exam.durationMinutes } : null,
    remainingSeconds: exam ? remainingSeconds(session, exam) : 0,
    violationCount: session.violations.length
  };

  if (session.status === 'finished') {
    state.summary = session.summary;
  } else if (session.status === 'locked') {
    state.lock = {
      reason: session.lockReason,
      hasValidOtp: hasValidOTP(session),
      otpExpiresAt: session.otp ? session.otp.expiresAt : null,
      attemptsLeft: session.otp ? Math.max(0, OTP_MAX_ATTEMPTS - session.otp.attempts) : 0
    };
  } else if (exam) {
    state.questions = buildQuestions(session, exam);
    state.answers = session.answers;
  }
  return state;
}

/* ---------- API siswa ---------- */

function findSessionByToken(token) {
  if (!token) return null;
  return Object.values(db.sessions).find((s) => s.token && s.token === token) || null;
}

async function studentLogin(req, res) {
  if (tooManyAttempts(req)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi sebentar lagi.');
  const body = await readBody(req);
  const studentId = String(body.studentId || '').trim();
  const examCode = String(body.examCode || '').trim().toUpperCase();

  const student = has(db.students, studentId) ? db.students[studentId] : null;
  if (!student) return fail(res, 404, 'ID Peserta tidak ditemukan!');
  const exam = has(db.exams, examCode) ? db.exams[examCode] : null;
  if (!exam) return fail(res, 404, 'Kode Ujian tidak valid!');
  if (!exam.questions || exam.questions.length === 0) return fail(res, 400, 'Ujian ini belum memiliki soal.');

  let session = Object.values(db.sessions).find((s) => s.studentId === student.id && s.examId === exam.id);
  let resumed = false;
  if (session) {
    expireIfTimeUp(session);
    if (session.status === 'finished') {
      return fail(res, 409, 'Anda sudah menyelesaikan ujian ini. Hubungi pengawas jika perlu mengulang.');
    }
    resumed = true;
  } else {
    session = createSession(student, exam);
  }

  session.token = newToken(); // login baru membatalkan token lama (perangkat lain)
  session.lastSeen = Date.now();

  if (resumed && session.status === 'active') {
    recordViolation(session, 'session_resume', 'Masuk kembali ke ujian yang sedang berjalan');
  }
  saveSessions();
  sendJson(res, 200, { success: true, token: session.token, state: studentState(session) });
}

async function studentApi(req, res, pathname) {
  const session = findSessionByToken(bearer(req));
  if (!session) return fail(res, 401, 'Sesi tidak valid. Silakan login kembali.');
  expireIfTimeUp(session);
  session.lastSeen = Date.now();
  const exam = db.exams[session.examId];

  if (req.method === 'GET' && pathname === '/api/student/session') {
    saveSessions();
    return sendJson(res, 200, { success: true, state: studentState(session) });
  }

  if (req.method !== 'POST') return fail(res, 405, 'Method tidak diizinkan');
  const body = await readBody(req);

  if (pathname === '/api/student/event') {
    if (session.status === 'active') {
      session.clipboardAttempts = (session.clipboardAttempts || 0) + 1;
      if (session.clipboardAttempts <= 20) {
        const student = db.students[session.studentId] || {};
        log('COPY_PASTE_BLOCKED', {
          studentId: session.studentId,
          studentName: student.name,
          type: String(body.type || 'unknown').slice(0, 30),
          message: `Percobaan copy/paste diblokir (ke-${session.clipboardAttempts})`
        });
      }
      saveSessions();
    }
    return sendJson(res, 200, { success: true });
  }

  if (pathname === '/api/student/violation') {
    if (session.status === 'finished') return sendJson(res, 200, { success: true, state: studentState(session) });
    const type = String(body.type || 'unknown').slice(0, 40);
    const message = String(body.message || 'Pelanggaran terdeteksi').slice(0, 200);
    recordViolation(session, type, message);
    saveSessions();
    return sendJson(res, 200, { success: true, state: studentState(session) });
  }

  if (pathname === '/api/student/otp/request') {
    if (session.status !== 'locked') return fail(res, 400, 'Ujian tidak sedang terkunci.');
    if (hasValidOTP(session)) return fail(res, 400, 'Kode OTP sebelumnya masih berlaku. Minta pengawas membacakannya.');
    issueOTP(session);
    log('OTP_REISSUED', { studentId: session.studentId, studentName: (db.students[session.studentId] || {}).name, by: 'student-request' });
    saveSessions();
    return sendJson(res, 200, { success: true, message: 'Kode baru dibuat. Minta pengawas membacakannya.', state: studentState(session) });
  }

  if (pathname === '/api/student/otp/verify') {
    const student = db.students[session.studentId] || {};
    if (session.status === 'active') return sendJson(res, 200, { success: true, message: 'Ujian sudah aktif.' });
    if (session.status !== 'locked') return fail(res, 400, 'Ujian sudah selesai.');

    const otp = session.otp;
    if (!otp || Date.now() >= otp.expiresAt || otp.attempts >= OTP_MAX_ATTEMPTS) {
      return sendJson(res, 200, { success: false, needNewCode: true, message: 'Kode OTP kedaluwarsa atau habis percobaan. Tekan "Minta Kode Baru".' });
    }

    otp.attempts++;
    if (safeEqual(String(body.code || '').trim(), otp.code)) {
      session.status = 'active';
      session.otp = null;
      session.lockReason = null;
      log('OTP_VERIFIED', { studentId: session.studentId, studentName: student.name });
      saveSessions();
      return sendJson(res, 200, { success: true, message: 'Verifikasi berhasil' });
    }

    log('OTP_WRONG', { studentId: session.studentId, studentName: student.name, attempts: otp.attempts });
    saveSessions();
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      return sendJson(res, 200, { success: false, needNewCode: true, message: 'Percobaan melebihi batas. Tekan "Minta Kode Baru".' });
    }
    return sendJson(res, 200, { success: false, message: `Kode salah. Sisa percobaan: ${OTP_MAX_ATTEMPTS - otp.attempts}` });
  }

  if (pathname === '/api/student/answer') {
    if (session.status !== 'active') return fail(res, 423, 'Ujian sedang terkunci atau sudah selesai.');
    const qid = Number(body.qid);
    if (!Number.isInteger(qid) || !session.qOrder.includes(qid) || !exam || !exam.questions[qid]) {
      return fail(res, 400, 'Soal tidak valid');
    }
    const q = exam.questions[qid];
    if (qType(q) === 'essay') {
      session.answers[qid] = String(body.answer || '').slice(0, 10000);
    } else {
      const optId = String(body.answer || '');
      if (!q.options.some((o) => o.id === optId)) return fail(res, 400, 'Opsi tidak valid');
      session.answers[qid] = optId;
    }
    saveSessions();
    return sendJson(res, 200, { success: true });
  }

  if (pathname === '/api/student/submit') {
    if (session.status === 'locked') return fail(res, 423, 'Ujian sedang terkunci. Masukkan kode OTP dari pengawas.');
    finishSession(session, 'submitted');
    saveSessions();
    return sendJson(res, 200, { success: true, state: studentState(session) });
  }

  return fail(res, 404, 'Endpoint tidak ditemukan');
}

/* ---------- API admin ---------- */

async function adminLogin(req, res) {
  if (tooManyAttempts(req)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi sebentar lagi.');
  const body = await readBody(req);
  if (!safeEqual(body.password || '', ADMIN_PASSWORD)) {
    log('ADMIN_LOGIN_FAILED', { ip: req.socket.remoteAddress });
    return fail(res, 401, 'Password pengawas salah!');
  }
  const token = newToken();
  adminTokens.set(token, Date.now() + ADMIN_TTL_MS);
  log('ADMIN_LOGIN', {});
  sendJson(res, 200, { success: true, token });
}

function isAdmin(req) {
  const token = bearer(req);
  const expiry = adminTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function sessionRow(s) {
  const exam = db.exams[s.examId];
  const student = db.students[s.studentId] || {};
  const now = Date.now();
  const row = {
    id: s.id,
    studentId: s.studentId,
    studentName: student.name || s.studentId,
    class: student.class || '',
    examId: s.examId,
    examTitle: exam ? exam.title : s.examId,
    status: s.status,
    violations: s.violations.length,
    clipboardAttempts: s.clipboardAttempts || 0,
    lastViolation: s.violations.length ? s.violations[s.violations.length - 1].message : '',
    answered: Object.keys(s.answers).length,
    total: s.qOrder.length,
    online: now - s.lastSeen < ONLINE_WINDOW_MS,
    startedAt: s.startedAt,
    remainingSeconds: exam && s.status !== 'finished' ? remainingSeconds(s, exam) : 0,
    percent: s.summary ? s.summary.percent : null,
    endReason: s.summary ? s.summary.endReason : null
  };
  if (s.status === 'locked') {
    row.lockReason = s.lockReason;
    row.lockedAt = s.lockedAt;
    row.otp = s.otp
      ? {
          code: s.otp.code,
          expiresAt: s.otp.expiresAt,
          attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - s.otp.attempts),
          expired: now >= s.otp.expiresAt,
          exhausted: s.otp.attempts >= OTP_MAX_ATTEMPTS
        }
      : null;
  }
  return row;
}

function validateQuestion(body) {
  const text = String(body.text || '').trim();
  if (!text) return { error: 'Teks pertanyaan wajib diisi' };

  if (body.type === 'essay') {
    const q = { text, type: 'essay' };
    const maxWords = parseInt(body.maxWords, 10);
    const minWords = parseInt(body.minWords, 10);
    if (maxWords > 0) q.maxWords = maxWords;
    if (minWords > 0) q.minWords = minWords;
    if (Array.isArray(body.keywords) && body.keywords.length) q.keywords = body.keywords.map(String).filter(Boolean);
    if (body.sampleAnswer) q.sampleAnswer = String(body.sampleAnswer);
    return { question: q };
  }

  const options = Array.isArray(body.options)
    ? body.options.map((o) => ({ id: String(o.id || '').trim(), text: String(o.text || '').trim() })).filter((o) => o.id && o.text)
    : [];
  if (options.length < 2) return { error: 'Minimal 2 opsi untuk pilihan ganda' };
  if (new Set(options.map((o) => o.id)).size !== options.length) return { error: 'ID opsi harus unik' };
  const correctAnswer = String(body.correctAnswer || '');
  if (!options.some((o) => o.id === correctAnswer)) return { error: 'Jawaban benar harus salah satu opsi yang diisi' };
  return { question: { text, type: 'multiple_choice', options, correctAnswer } };
}

async function adminApi(req, res, pathname) {
  if (!isAdmin(req)) return fail(res, 401, 'Sesi pengawas tidak valid. Silakan login kembali.');
  const method = req.method;
  let m;

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const sessions = Object.values(db.sessions).map(sessionRow).sort((a, b) => b.startedAt - a.startedAt);
    const otpRequests = sessions.filter((s) => s.status === 'locked').sort((a, b) => b.lockedAt - a.lockedAt);
    const pendingGrading = db.results.filter((r) => {
      const p = essayProgress(r);
      return p.graded < p.essays;
    }).length;
    return sendJson(res, 200, { success: true, sessions, otpRequests, pendingGrading, logs: db.logs.slice(-100).reverse(), serverTime: Date.now() });
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]+)\/(otp|force-submit)$/))) {
    const session = db.sessions[m[1]];
    if (!session) return fail(res, 404, 'Sesi tidak ditemukan');
    const student = db.students[session.studentId] || {};
    if (m[2] === 'otp') {
      if (session.status !== 'locked') return fail(res, 400, 'Siswa tidak sedang terkunci');
      issueOTP(session);
      log('OTP_REISSUED', { studentId: session.studentId, studentName: student.name, by: 'admin' });
    } else {
      if (session.status === 'finished') return fail(res, 400, 'Ujian sudah selesai');
      finishSession(session, 'forced');
      log('FORCE_SUBMIT', { studentId: session.studentId, studentName: student.name, by: 'admin' });
    }
    saveSessions();
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/sessions\/([a-f0-9]+)$/))) {
    const session = db.sessions[m[1]];
    if (!session) return fail(res, 404, 'Sesi tidak ditemukan');
    if (session.status !== 'finished') return fail(res, 400, 'Hanya sesi yang sudah selesai yang bisa direset');
    delete db.sessions[m[1]];
    log('SESSION_RESET', { studentId: session.studentId, examId: session.examId, by: 'admin' });
    saveSessions();
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && pathname === '/api/admin/results') {
    const rows = db.results.map(resultRow).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    return sendJson(res, 200, { success: true, results: rows });
  }

  if (method === 'GET' && (m = pathname.match(/^\/api\/admin\/results\/([a-f0-9]+)$/))) {
    const r = db.results.find((x) => x.sessionId === m[1]);
    if (!r) return fail(res, 404, 'Hasil tidak ditemukan');
    return sendJson(res, 200, { success: true, result: { ...r, finalScore: finalScore(r) } });
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/results\/([a-f0-9]+)\/grade$/))) {
    const r = db.results.find((x) => x.sessionId === m[1]);
    if (!r) return fail(res, 404, 'Hasil tidak ditemukan');
    const body = await readBody(req);
    const inScores = body.scores && typeof body.scores === 'object' ? body.scores : {};
    const inComments = body.comments && typeof body.comments === 'object' ? body.comments : {};
    const scores = {};
    const comments = {};

    for (const d of r.details.filter((x) => x.type === 'essay')) {
      const raw = inScores[d.qid];
      if (raw !== undefined && raw !== null && raw !== '') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) return fail(res, 400, 'Nilai esai harus antara 0 sampai 100');
        scores[d.qid] = Math.round(n * 10) / 10;
      }
      const c = String(inComments[d.qid] || '').trim().slice(0, 1000);
      if (c) comments[d.qid] = c;
    }

    r.grading = { scores, comments, gradedAt: new Date().toISOString() };
    r.finalScore = finalScore(r);
    save('results.json', db.results);
    log('GRADED', { studentId: r.studentId, studentName: r.studentName, message: `Nilai akhir: ${r.finalScore === null ? 'belum lengkap' : r.finalScore}`, by: 'admin' });
    return sendJson(res, 200, { success: true, finalScore: r.finalScore, row: resultRow(r) });
  }

  if (method === 'GET' && pathname === '/api/admin/students') {
    return sendJson(res, 200, { success: true, students: db.students });
  }

  if (method === 'POST' && pathname === '/api/admin/students') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    const name = String(body.name || '').trim();
    const className = String(body.class || '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return fail(res, 400, 'ID hanya boleh huruf, angka, - dan _ (maks 32 karakter)');
    if (!name || !className) return fail(res, 400, 'ID, Nama, dan Kelas wajib diisi!');
    if (has(db.students, id)) return fail(res, 409, 'ID Peserta sudah ada!');
    db.students[id] = { id, name, class: className, email: String(body.email || '').trim() };
    save('students.json', db.students);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/students\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (!has(db.students, id)) return fail(res, 404, 'Peserta tidak ditemukan');
    if (Object.values(db.sessions).some((s) => s.studentId === id && s.status !== 'finished')) {
      return fail(res, 400, 'Peserta sedang mengerjakan ujian');
    }
    delete db.students[id];
    save('students.json', db.students);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && pathname === '/api/admin/exams') {
    return sendJson(res, 200, { success: true, exams: db.exams });
  }

  if (method === 'POST' && pathname === '/api/admin/exams') {
    const body = await readBody(req);
    const id = String(body.id || '').trim().toUpperCase();
    const title = String(body.title || '').trim();
    const duration = parseInt(body.durationMinutes, 10);
    if (!/^[A-Z0-9_-]{1,32}$/.test(id)) return fail(res, 400, 'Kode ujian hanya boleh huruf, angka, - dan _');
    if (!title || !(duration >= 1 && duration <= 300)) return fail(res, 400, 'Judul dan durasi (1-300 menit) wajib diisi!');
    if (has(db.exams, id)) return fail(res, 409, 'Kode Ujian sudah ada!');
    db.exams[id] = { id, title, durationMinutes: duration, shuffleQuestions: !!body.shuffleQuestions, shuffleOptions: !!body.shuffleOptions, questions: [] };
    save('exams.json', db.exams);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/exams\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (!has(db.exams, id)) return fail(res, 404, 'Ujian tidak ditemukan');
    if (Object.values(db.sessions).some((s) => s.examId === id && s.status !== 'finished')) {
      return fail(res, 400, 'Masih ada siswa yang mengerjakan ujian ini');
    }
    delete db.exams[id];
    save('exams.json', db.exams);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/exams\/([^/]+)\/questions$/))) {
    const id = decodeURIComponent(m[1]);
    if (!has(db.exams, id)) return fail(res, 404, 'Ujian tidak ditemukan');
    const { question, error } = validateQuestion(await readBody(req));
    if (error) return fail(res, 400, error);
    db.exams[id].questions.push(question);
    save('exams.json', db.exams);
    return sendJson(res, 200, { success: true });
  }

  return fail(res, 404, 'Endpoint tidak ditemukan');
}

/* ---------- File statis (hanya dari folder public/) ---------- */

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }
  let filePath;
  try {
    const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad Request');
  }
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

/* ---------- Server ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname === '/api/student/login' && req.method === 'POST') return await studentLogin(req, res);
    if (pathname === '/api/admin/login' && req.method === 'POST') return await adminLogin(req, res);
    if (pathname.startsWith('/api/student/')) return await studentApi(req, res, pathname);
    if (pathname.startsWith('/api/admin/')) return await adminApi(req, res, pathname);
    if (pathname.startsWith('/api/')) return fail(res, 404, 'Endpoint tidak ditemukan');
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('Error:', e);
    if (!res.headersSent) fail(res, 400, e.message || 'Permintaan tidak valid');
  }
});

server.listen(PORT, () => {
  console.log(`Quiz Server berjalan di http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('PERINGATAN: memakai password pengawas default "admin123". Set env ADMIN_PASSWORD sebelum dipakai sungguhan.');
  }
});
