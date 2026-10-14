const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class QuizApp {
  constructor() {
    this.security = new SecurityManager();
    this.otpInput = new OTPInput([1, 2, 3, 4, 5, 6].map((n) => `otp-input-${n}`));
    this.quiz = new QuizManager({
      onAnswer: (qid, answer) => this.api('/api/student/answer', { method: 'POST', token: this.studentToken, body: { qid, answer } }),
      onSubmit: () => this.submitExam(false),
      onTimeUp: () => this.submitExam(true),
      confirm: (message) => this.confirmDialog(message),
      onBlockedInput: (kind) => this.handleBlockedAttempt(kind)
    });

    this.studentToken = sessionStorage.getItem('quiz_student_token');
    this.adminToken = sessionStorage.getItem('quiz_admin_token');
    this.currentScreen = 'loading-screen';
    this.pollTimer = null;
    this.adminTimer = null;
    this.polling = false;
    this.locking = false;
    this.lockConfirmed = false;
    this.verifying = false;
    this.submitting = false;
    this.ended = false;
    this.mgmtExams = {};
    this.resultRows = [];
    this.openResultData = null;
    this.toastTimer = null;

    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.security.init({
      onViolation: (v) => this.reportViolation(v),
      onAttempt: (kind) => this.handleBlockedAttempt(kind)
    });

    const steps = ['Memuat sistem ujian...', 'Menyiapkan keamanan...', 'Siap dimulai!'];
    for (const step of steps) {
      $('loading-status').textContent = step;
      await sleep(250);
    }
    await this.restoreSession();
  }

  async restoreSession() {
    if (this.adminToken) {
      try {
        await this.refreshAdmin(true);
        this.showAdmin();
        return;
      } catch (e) {
        this.clearAdminSession();
      }
    }
    if (this.studentToken) {
      try {
        const { state } = await this.api('/api/student/session', { token: this.studentToken });
        await this.enterSession(state, { reload: true });
        return;
      } catch (e) {
        this.clearStudentSession();
      }
    }
    this.showScreen('login-screen');
  }

  /* ---------- Util ---------- */

  async api(path, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* kosong */ }
    if (!res.ok) {
      const err = new Error(data.message || 'Terjadi kesalahan pada server');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    this.currentScreen = id;
  }

  confirmDialog(message, { okOnly = false } = {}) {
    return new Promise((resolve) => {
      $('confirm-message').textContent = message;
      $('confirm-cancel').classList.toggle('hidden', okOnly);
      $('confirm-modal').classList.remove('hidden');
      const done = (value) => {
        $('confirm-modal').classList.add('hidden');
        $('confirm-ok').onclick = null;
        $('confirm-cancel').onclick = null;
        resolve(value);
      };
      $('confirm-ok').onclick = () => done(true);
      $('confirm-cancel').onclick = () => done(false);
    });
  }

  showLoginError(message) {
    const el = $('login-error');
    el.textContent = message;
    el.classList.toggle('hidden', !message);
  }

  fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('id-ID');
  }

  /* ---------- Event ---------- */

  setupEventListeners() {
    document.querySelectorAll('.role-tab').forEach((btn) => btn.addEventListener('click', () => this.switchRole(btn.dataset.role)));
    $('login-form').addEventListener('submit', (e) => this.handleStudentLogin(e));
    $('admin-login-form').addEventListener('submit', (e) => this.handleAdminLogin(e));
    $('enter-fs-btn').addEventListener('click', () => this.enterFullscreen());
    $('otp-verify-form').addEventListener('submit', (e) => { e.preventDefault(); this.verifyOtp(); });
    this.otpInput.onComplete = () => this.verifyOtp();
    $('request-otp-btn').addEventListener('click', () => this.requestNewOtp());
    $('exit-btn').addEventListener('click', () => window.location.reload());

    // Admin
    $('admin-logout-btn').addEventListener('click', () => this.adminLogout());
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => this.switchAdminTab(btn.dataset.tab)));
    $('admin-screen').addEventListener('click', (e) => this.handleAdminClick(e));
    $('export-csv-btn').addEventListener('click', () => this.exportCsv());
    $('result-modal').addEventListener('click', (e) => this.handleResultModalClick(e));
    $('result-modal').addEventListener('input', (e) => {
      if (e.target.classList.contains('grade-input')) this.updateLiveScore();
    });
    $('add-student-form').addEventListener('submit', (e) => this.handleAddStudent(e));
    $('add-exam-form').addEventListener('submit', (e) => this.handleAddExam(e));
    $('add-question-form').addEventListener('submit', (e) => this.handleAddQuestion(e));
    $('mgmt-question-type').addEventListener('change', (e) => this.toggleQuestionType(e.target.value));

    window.addEventListener('beforeunload', (e) => {
      if (this.currentScreen === 'quiz-screen' && !this.ended) {
        e.preventDefault();
        e.returnValue = 'Ujian belum selesai. Yakin ingin keluar?';
        return e.returnValue;
      }
    });
  }

  switchRole(role) {
    document.querySelectorAll('.role-tab').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
    $('login-form').classList.toggle('hidden', role !== 'student');
    $('student-rules').classList.toggle('hidden', role !== 'student');
    $('admin-login-form').classList.toggle('hidden', role !== 'admin');
    this.showLoginError('');
    (role === 'student' ? $('student-id') : $('admin-password')).focus();
  }

  /* =====================================================
     SESI SISWA
     ===================================================== */

  async handleStudentLogin(e) {
    e.preventDefault();
    this.showLoginError('');
    const btn = $('login-btn');
    btn.disabled = true;
    try {
      const data = await this.api('/api/student/login', {
        method: 'POST',
        body: { studentId: $('student-id').value.trim(), examCode: $('exam-code').value.trim() }
      });
      this.studentToken = data.token;
      sessionStorage.setItem('quiz_student_token', data.token);
      await this.enterSession(data.state);
    } catch (err) {
      this.showLoginError(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async enterSession(state, { reload = false } = {}) {
    this.ended = false;
    if (state.status === 'finished') return this.showResult(state.summary);

    this.startPolling();
    if (state.status === 'locked') return this.showLock(state.lock, true);

    if (reload) {
      // Halaman dimuat ulang/ditutup saat ujian berjalan dianggap keluar dari ujian
      await this.reportViolation({ type: 'page_reload', message: 'Memuat ulang atau membuka kembali halaman ujian' });
      return;
    }
    this.showFullscreenPrompt(false);
  }

  showFullscreenPrompt(isResume) {
    this.security.suspend();
    $('fs-message').textContent = isResume
      ? 'Verifikasi berhasil. Aktifkan kembali mode layar penuh untuk melanjutkan ujian.'
      : 'Untuk keamanan ujian, browser harus dalam mode layar penuh.';
    $('enter-fs-btn').textContent = isResume ? 'Lanjutkan Ujian' : 'Aktifkan Fullscreen';
    this.showScreen('fullscreen-prompt');
  }

  async enterFullscreen() {
    let ok = await this.security.requestFullscreen();
    if (!ok && this.security.isFullscreen()) ok = true; // sudah fullscreen lewat F11
    if (!ok) {
      $('fs-message').textContent = 'Gagal memasuki mode fullscreen. Coba lagi atau tekan F11 secara manual.';
      return;
    }
    await this.resumeQuiz();
  }

  async resumeQuiz() {
    try {
      const { state } = await this.api('/api/student/session', { token: this.studentToken });
      if (state.status === 'finished') return this.showResult(state.summary);
      if (state.status === 'locked') return this.showLock(state.lock, true);

      this.quiz.load(state);
      this.quiz.flushDirty();
      this.showScreen('quiz-screen');
      if (!this.security.monitoring) this.security.start();
      this.security.resume();
      this.locking = false;
    } catch (e) {
      if (e.status === 401) return this.forceLogout(e.message);
      $('fs-message').textContent = `Tidak dapat memuat ujian: ${e.message}`;
      this.showScreen('fullscreen-prompt');
    }
  }

  /* ---------- Copy/paste diblokir ---------- */

  handleBlockedAttempt(kind) {
    this.showToast('Copy, cut, dan paste dinonaktifkan selama ujian.');
    if (!this.studentToken) return;
    this.api('/api/student/event', { method: 'POST', token: this.studentToken, body: { type: kind } }).catch(() => {});
  }

  showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
  }

  /* ---------- Pelanggaran dan layar kunci ---------- */

  async reportViolation(v) {
    if (this.locking || this.ended) return;
    this.locking = true;
    this.security.suspend();
    this.quiz.pause();
    this.showLock({ reason: v.message, hasValidOtp: true }, false); // kunci layar dulu, tidak menunggu server

    while (!this.ended) {
      try {
        const { state } = await this.api('/api/student/violation', {
          method: 'POST',
          token: this.studentToken,
          body: { type: v.type, message: v.message }
        });
        this.applyServerState(state);
        break;
      } catch (e) {
        if (e.status === 401) { this.forceLogout(e.message); break; }
        await sleep(2000); // gangguan jaringan: coba lagi
      }
    }
    this.locking = false;
  }

  applyServerState(state) {
    if (state.status === 'finished') this.showResult(state.summary);
    else if (state.status === 'locked') this.showLock(state.lock, true);
  }

  showLock(lock, confirmed) {
    this.security.suspend();
    this.quiz.pause();
    this.lockConfirmed = confirmed;
    const firstTime = this.currentScreen !== 'otp-verification-screen';

    $('lock-reason').textContent = `Pelanggaran terdeteksi: ${lock.reason || 'keluar dari mode ujian'}`;
    this.updateLockInfo(lock);
    this.showScreen('otp-verification-screen');
    if (firstTime) {
      $('verify-error').classList.add('hidden');
      this.otpInput.clear();
    }
  }

  updateLockInfo(lock) {
    // Tombol minta kode baru hanya muncul bila kode lama sudah tidak bisa dipakai
    $('request-otp-btn').classList.toggle('hidden', lock.hasValidOtp !== false);
  }

  async verifyOtp() {
    if (this.verifying) return;
    const code = this.otpInput.value;
    if (code.length !== 6) return;
    if (!this.lockConfirmed) return this.showVerifyError('Menunggu konfirmasi server, coba lagi sebentar...');

    this.verifying = true;
    $('verify-btn').disabled = true;
    $('verify-error').classList.add('hidden');
    $('verify-info').classList.add('hidden');
    try {
      const res = await this.api('/api/student/otp/verify', { method: 'POST', token: this.studentToken, body: { code } });
      if (res.success) {
        this.otpInput.clear();
        const ok = (await this.security.requestFullscreen()) || this.security.isFullscreen();
        if (ok) await this.resumeQuiz();
        else this.showFullscreenPrompt(true);
      } else {
        this.showVerifyError(res.message);
        this.otpInput.clear();
        if (res.needNewCode) $('request-otp-btn').classList.remove('hidden');
      }
    } catch (e) {
      if (e.status === 401) this.forceLogout(e.message);
      else this.showVerifyError(e.message);
    } finally {
      this.verifying = false;
      $('verify-btn').disabled = false;
    }
  }

  showVerifyError(message) {
    const el = $('verify-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  async requestNewOtp() {
    $('verify-error').classList.add('hidden');
    try {
      const res = await this.api('/api/student/otp/request', { method: 'POST', token: this.studentToken, body: {} });
      $('verify-info').textContent = res.message;
      $('verify-info').classList.remove('hidden');
      $('request-otp-btn').classList.add('hidden');
    } catch (e) {
      if (e.status === 401) this.forceLogout(e.message);
      else this.showVerifyError(e.message);
    }
  }

  /* ---------- Polling status sesi ---------- */

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.poll(), 3000);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    if (this.polling || this.ended || this.locking || !this.studentToken) return;
    this.polling = true;
    try {
      const { state } = await this.api('/api/student/session', { token: this.studentToken });
      if (state.status === 'finished') {
        this.showResult(state.summary);
      } else if (state.status === 'locked') {
        if (this.currentScreen === 'otp-verification-screen') this.updateLockInfo(state.lock);
        else this.showLock(state.lock, true);
      } else if (this.currentScreen === 'quiz-screen') {
        this.quiz.syncRemaining(state.remainingSeconds);
      }
    } catch (e) {
      if (e.status === 401) this.forceLogout(e.message);
    } finally {
      this.polling = false;
    }
  }

  /* ---------- Kumpulkan dan hasil ---------- */

  async submitExam(auto) {
    if (this.submitting || this.ended) return;
    this.submitting = true;
    try {
      await this.quiz.commitEssay();
      await this.quiz.flushDirty();
      const { state } = await this.api('/api/student/submit', { method: 'POST', token: this.studentToken, body: {} });
      this.showResult(state.summary);
    } catch (e) {
      if (e.status === 401) this.forceLogout(e.message);
      else if (!auto || e.status !== 423) await this.confirmDialog(`Gagal mengumpulkan ujian: ${e.message}`, { okOnly: true });
    } finally {
      this.submitting = false;
    }
  }

  showResult(summary) {
    this.ended = true;
    this.stopPolling();
    this.quiz.destroy();
    this.security.stop();
    this.security.exitFullscreen();
    this.clearStudentSession();

    const s = summary || { correct: 0, wrong: 0, empty: 0, essayCount: 0, percent: 0, endReason: 'submitted', violations: [] };
    const deg = (s.percent / 100) * 360;
    $('score-circle').style.background = `conic-gradient(var(--success) ${deg}deg, var(--bg) ${deg}deg)`;
    $('score-percent').textContent = `${s.percent}%`;
    $('correct-count').textContent = s.correct;
    $('wrong-count').textContent = s.wrong;
    $('empty-count').textContent = s.empty;
    $('essay-count').textContent = s.essayCount || 0;
    $('essay-count-item').style.display = s.essayCount ? 'flex' : 'none';

    const reasonText = {
      submitted: ['Ujian Selesai', 'Terima kasih telah mengikuti ujian'],
      timeout: ['Waktu Habis', 'Ujian dikumpulkan otomatis karena waktu habis'],
      forced: ['Ujian Dihentikan', 'Ujian dihentikan oleh pengawas']
    }[s.endReason] || ['Ujian Selesai', 'Terima kasih telah mengikuti ujian'];
    const passed = s.endReason === 'submitted' && s.percent >= 70;
    $('result-icon').textContent = passed ? '🎉' : s.endReason === 'forced' ? '⛔' : '📝';
    $('result-title').textContent = passed ? 'Selamat! Anda Lulus' : reasonText[0];
    $('result-message').textContent = s.essayCount ? `${reasonText[1]}. Soal esai dinilai manual oleh pengawas.` : reasonText[1];

    const violations = s.violations || [];
    $('violation-summary').hidden = violations.length === 0;
    $('violation-list').innerHTML = violations.map((v) => `<li>${this.fmtTime(v.timestamp)} - ${esc(v.message)}</li>`).join('');

    this.showScreen('result-screen');
  }

  clearStudentSession() {
    this.studentToken = null;
    sessionStorage.removeItem('quiz_student_token');
  }

  forceLogout(message) {
    this.ended = true;
    this.stopPolling();
    this.quiz.destroy();
    this.security.stop();
    this.security.exitFullscreen();
    this.clearStudentSession();
    this.showScreen('login-screen');
    this.showLoginError(message || 'Sesi berakhir. Silakan login kembali.');
  }

  /* =====================================================
     SESI PENGAWAS (ADMIN)
     ===================================================== */

  async handleAdminLogin(e) {
    e.preventDefault();
    this.showLoginError('');
    const btn = $('admin-login-btn');
    btn.disabled = true;
    try {
      const data = await this.api('/api/admin/login', { method: 'POST', body: { password: $('admin-password').value } });
      this.adminToken = data.token;
      sessionStorage.setItem('quiz_admin_token', data.token);
      $('admin-password').value = '';
      await this.refreshAdmin(true);
      this.showAdmin();
    } catch (err) {
      this.showLoginError(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  showAdmin() {
    this.showScreen('admin-screen');
    clearInterval(this.adminTimer);
    this.adminTimer = setInterval(() => this.refreshAdmin(), 2000);
  }

  clearAdminSession() {
    this.adminToken = null;
    sessionStorage.removeItem('quiz_admin_token');
  }

  adminLogout() {
    clearInterval(this.adminTimer);
    this.clearAdminSession();
    this.showScreen('login-screen');
    this.switchRole('admin');
  }

  async refreshAdmin(throwOnError = false) {
    try {
      const data = await this.api('/api/admin/overview', { token: this.adminToken });
      this.renderAdmin(data);
    } catch (e) {
      if (throwOnError) throw e;
      if (e.status === 401) {
        this.adminLogout();
        this.showLoginError(e.message);
      }
    }
  }

  switchAdminTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === tabId));
    if (tabId === 'management') this.loadManagement();
    if (tabId === 'results') this.loadResults();
  }

  renderAdmin(data) {
    // Ujian aktif
    $('exams-table').querySelector('tbody').innerHTML = data.sessions.length
      ? data.sessions.map((s) => `
        <tr>
          <td>${esc(s.studentId)}</td>
          <td>${esc(s.studentName)}</td>
          <td>${esc(s.examTitle)}<br><small class="muted">${s.answered}/${s.total} terjawab</small></td>
          <td>${this.statusBadge(s)}</td>
          <td>${s.violations}${s.lastViolation ? `<br><small class="muted">${esc(s.lastViolation)}</small>` : ''}${s.clipboardAttempts ? `<br><small class="flag-warn">${s.clipboardAttempts}x copy/paste diblokir</small>` : ''}</td>
          <td>${s.status === 'finished'
            ? `<button class="btn btn-sm btn-secondary" data-action="reset-session" data-id="${s.id}">Reset</button>`
            : `<button class="btn btn-sm btn-danger" data-action="force-submit" data-id="${s.id}">Paksa Kumpulkan</button>`}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-row">Belum ada siswa yang memulai ujian.</td></tr>';

    // Permintaan OTP (kode hanya terlihat di sini)
    $('otp-table').querySelector('tbody').innerHTML = data.otpRequests.length
      ? data.otpRequests.map((s) => {
          let code = '<span class="muted">Belum ada kode</span>';
          if (s.otp) {
            if (s.otp.exhausted) code = '<span class="muted">Habis percobaan</span>';
            else if (s.otp.expired) code = '<span class="muted">Kedaluwarsa</span>';
            else code = `<span class="otp-code">${s.otp.code.slice(0, 3)} ${s.otp.code.slice(3)}</span><br><small class="muted">berlaku s/d ${this.fmtTime(s.otp.expiresAt)} · sisa ${s.otp.attemptsLeft}x coba</small>`;
          }
          return `
          <tr>
            <td>${esc(s.studentId)}</td>
            <td>${esc(s.studentName)}</td>
            <td>${code}</td>
            <td>${this.fmtTime(s.lockedAt)}</td>
            <td>${esc(s.lockReason)}</td>
            <td>
              <button class="btn btn-sm btn-primary" data-action="regen-otp" data-id="${s.id}">Buat Ulang Kode</button>
              <button class="btn btn-sm btn-danger" data-action="force-submit" data-id="${s.id}">Akhiri Ujian</button>
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6" class="empty-row">Tidak ada siswa yang sedang terkunci.</td></tr>';

    const badge = $('otp-badge');
    badge.textContent = data.otpRequests.length;
    badge.classList.toggle('hidden', data.otpRequests.length === 0);
    const rb = $('results-badge');
    rb.textContent = data.pendingGrading || 0;
    rb.classList.toggle('hidden', !data.pendingGrading);
    if ($('results').classList.contains('active') && $('result-modal').classList.contains('hidden')) this.loadResults();

    document.title = data.otpRequests.length ? `(${data.otpRequests.length}) Panel Pengawas - Platform Merah Putih` : 'Platform Merah Putih';

    // Log
    $('logs-content').innerHTML = data.logs.map((l) => {
      const detail = [l.studentName || l.studentId, l.message || l.reason || l.type, l.by ? `oleh ${l.by}` : '']
        .filter(Boolean).join(' - ');
      return `<div class="log-entry"><span class="log-time">${new Date(l.timestamp).toLocaleString('id-ID')}</span> <span class="log-event">[${esc(l.event)}]</span> <span class="log-detail">${esc(detail)}</span></div>`;
    }).join('') || '<p class="muted">Belum ada log.</p>';
  }

  statusBadge(s) {
    if (s.status === 'locked') return '<span class="status-badge status-violation">Terkunci</span>';
    if (s.status === 'finished') {
      const label = { forced: 'Dihentikan', timeout: 'Waktu habis' }[s.endReason] || 'Selesai';
      return `<span class="status-badge status-finished">${label} (${s.percent}%)</span>`;
    }
    return `<span class="status-badge status-active">Mengerjakan</span>${s.online ? '' : '<br><small class="muted">terputus</small>'}`;
  }

  async handleAdminClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    try {
      if (action === 'open-result') {
        return this.openResult(id);
      } else if (action === 'regen-otp') {
        await this.api(`/api/admin/sessions/${id}/otp`, { method: 'POST', token: this.adminToken, body: {} });
      } else if (action === 'force-submit') {
        if (!confirm('Paksa kumpulkan / akhiri ujian siswa ini?')) return;
        await this.api(`/api/admin/sessions/${id}/force-submit`, { method: 'POST', token: this.adminToken, body: {} });
      } else if (action === 'reset-session') {
        if (!confirm('Reset sesi ini? Siswa bisa mengerjakan ujian lagi (hasil lama tetap tersimpan).')) return;
        await this.api(`/api/admin/sessions/${id}`, { method: 'DELETE', token: this.adminToken });
      } else if (action === 'delete-student') {
        if (!confirm(`Hapus peserta ${id}?`)) return;
        await this.api(`/api/admin/students/${encodeURIComponent(id)}`, { method: 'DELETE', token: this.adminToken });
        await this.loadManagement();
      } else if (action === 'delete-exam') {
        if (!confirm(`Hapus ujian ${id}? Semua soal akan terhapus.`)) return;
        await this.api(`/api/admin/exams/${encodeURIComponent(id)}`, { method: 'DELETE', token: this.adminToken });
        await this.loadManagement();
      }
      this.refreshAdmin();
    } catch (err) {
      alert(err.message);
    }
  }

  /* ---------- Hasil, koreksi, dan penilaian ---------- */

  async loadResults() {
    try {
      const { results } = await this.api('/api/admin/results', { token: this.adminToken });
      this.resultRows = results;
      this.renderResults();
    } catch (e) {
      if (e.status === 401) this.adminLogout();
    }
  }

  gradingBadge(r) {
    if (r.essayCount === 0) return '<span class="status-badge status-finished">Otomatis</span>';
    if (r.finalScore !== null) return '<span class="status-badge status-active">Sudah dinilai</span>';
    return `<span class="status-badge status-otp">Perlu dinilai (${r.essayGraded}/${r.essayCount} esai)</span>`;
  }

  renderResults() {
    const tbody = $('results-table').querySelector('tbody');
    tbody.innerHTML = this.resultRows.length
      ? this.resultRows.map((r) => `
        <tr>
          <td>${esc(r.studentName)}<br><small class="muted">${esc(r.studentId)} · ${esc(r.class)}</small></td>
          <td>${esc(r.examTitle)}</td>
          <td>${new Date(r.submittedAt).toLocaleString('id-ID')}${r.endReason !== 'submitted' ? `<br><small class="muted">${r.endReason === 'timeout' ? 'waktu habis' : 'dihentikan pengawas'}</small>` : ''}</td>
          <td>${r.correct} / ${r.wrong} / ${r.empty}${r.essayCount ? `<br><small class="muted">+ ${r.essayCount} esai</small>` : ''}</td>
          <td>${this.gradingBadge(r)}</td>
          <td>${r.finalScore !== null ? `<strong>${r.finalScore}</strong>` : '<span class="muted">-</span>'}</td>
          <td>${r.violations || r.clipboardAttempts
            ? `<small class="flag-warn">${r.violations} pelanggaran${r.clipboardAttempts ? `<br>${r.clipboardAttempts}x copy/paste` : ''}</small>`
            : '<small class="muted">bersih</small>'}</td>
          <td><button class="btn btn-sm btn-primary" data-action="open-result" data-id="${r.id}">Periksa</button></td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="empty-row">Belum ada hasil ujian.</td></tr>';
  }

  async openResult(id) {
    try {
      const { result } = await this.api(`/api/admin/results/${id}`, { token: this.adminToken });
      this.openResultData = result;
      this.renderResultModal();
      $('result-modal').classList.remove('hidden');
    } catch (e) {
      alert(e.message);
    }
  }

  renderResultModal() {
    const r = this.openResultData;
    const scores = (r.grading && r.grading.scores) || {};
    const comments = (r.grading && r.grading.comments) || {};
    const reasons = { submitted: 'Dikumpulkan siswa', timeout: 'Waktu habis', forced: 'Dihentikan pengawas' };

    const questions = r.details.map((d, i) => {
      if (d.type === 'essay') {
        const found = new Set(d.keywordsFound || []);
        return `
        <div class="rq">
          <div class="rq-title"><span>${i + 1}. ${esc(d.questionText)}</span><span class="rq-badge empty">Esai</span></div>
          <div class="essay-answer">${d.answer ? esc(d.answer) : '<em class="muted">Tidak dijawab</em>'}</div>
          <div class="essay-meta"><span>${d.wordCount} kata</span>${d.minWords ? `<span>Min: ${d.minWords}</span>` : ''}${d.maxWords ? `<span>Maks: ${d.maxWords}</span>` : ''}</div>
          ${(d.keywords || []).length ? `<div class="essay-keywords"><strong>Kata kunci:</strong> ${d.keywords.map((k) => `<span class="keyword-tag ${found.has(k) ? 'found' : ''}">${esc(k)}</span>`).join('')}</div>` : ''}
          ${d.sampleAnswer ? `<p class="rq-line"><b>Contoh jawaban:</b> ${esc(d.sampleAnswer)}</p>` : ''}
          <div class="grade-row">
            <label for="grade-${d.qid}"><b>Nilai (0-100):</b></label>
            <input type="number" class="grade-input" id="grade-${d.qid}" data-qid="${d.qid}" min="0" max="100" step="0.5" value="${scores[d.qid] ?? ''}" placeholder="0-100">
          </div>
          <textarea class="grade-comment" data-qid="${d.qid}" rows="2" maxlength="1000" placeholder="Komentar untuk siswa (opsional)">${esc(comments[d.qid] || '')}</textarea>
        </div>`;
      }
      const badge = d.isCorrect === true ? '<span class="rq-badge ok">Benar</span>' : d.isCorrect === false ? '<span class="rq-badge bad">Salah</span>' : '<span class="rq-badge empty">Kosong</span>';
      return `
        <div class="rq">
          <div class="rq-title"><span>${i + 1}. ${esc(d.questionText)}</span>${badge}</div>
          <p class="rq-line"><b>Jawaban siswa:</b> ${d.answer ? esc(d.answerText || d.answer) : '<em>tidak dijawab</em>'}</p>
          <p class="rq-line"><b>Kunci jawaban:</b> ${esc(d.correctText || d.correctAnswer)}</p>
        </div>`;
    }).join('');

    const violations = (r.violations || []).map((v) => `<li>${this.fmtTime(v.timestamp)} - ${esc(v.message)}</li>`).join('');

    $('result-modal-body').innerHTML = `
      <div class="result-head">
        <h2>${esc(r.studentName)} <small class="muted">(${esc(r.studentId)} · ${esc(r.class)})</small><br><small class="muted">${esc(r.examTitle)}</small></h2>
        <button class="btn btn-secondary btn-sm" data-action="close-result">Tutup</button>
      </div>
      <div class="result-meta">
        <span>Dikumpulkan: ${new Date(r.submittedAt).toLocaleString('id-ID')}</span>
        <span>${reasons[r.endReason] || r.endReason}</span>
        <span>Durasi: ${Math.floor(r.durationSeconds / 60)} menit</span>
        <span class="${r.violations.length ? 'flag-warn' : ''}">Pelanggaran: ${r.violations.length}</span>
        <span class="${r.clipboardAttempts ? 'flag-warn' : ''}">Copy/paste diblokir: ${r.clipboardAttempts || 0}x</span>
      </div>
      ${violations ? `<ul class="muted" style="margin:0 0 1rem 1.2rem">${violations}</ul>` : ''}
      <div class="final-score"><span>Nilai akhir:</span><strong id="live-score">-</strong><small class="muted" id="live-score-note"></small></div>
      ${questions}
      <div class="modal-footer">
        <button class="btn btn-secondary" data-action="close-result">Tutup</button>
        <button class="btn btn-primary" data-action="save-grade">Simpan Nilai</button>
      </div>`;
    this.updateLiveScore();
  }

  collectGrades() {
    const scores = {};
    const comments = {};
    document.querySelectorAll('#result-modal .grade-input').forEach((i) => { scores[i.dataset.qid] = i.value; });
    document.querySelectorAll('#result-modal .grade-comment').forEach((i) => { comments[i.dataset.qid] = i.value; });
    return { scores, comments };
  }

  // Pratinjau nilai akhir sementara pengawas mengetik (rumus sama dengan server)
  updateLiveScore() {
    const r = this.openResultData;
    if (!r) return;
    const essays = r.details.filter((d) => d.type === 'essay');
    const { scores } = this.collectGrades();
    const filled = essays.filter((d) => scores[d.qid] !== '' && scores[d.qid] !== undefined);
    const out = $('live-score');
    const note = $('live-score-note');
    if (filled.length < essays.length) {
      out.textContent = '-';
      note.textContent = `${essays.length - filled.length} esai belum dinilai`;
      return;
    }
    const pts = essays.reduce((sum, d) => sum + Math.min(100, Math.max(0, Number(scores[d.qid]) || 0)) / 100, 0);
    out.textContent = Math.round(((r.correct + pts) / r.total) * 1000) / 10;
    note.textContent = `(${r.correct} benar PG${essays.length ? ` + ${Math.round(pts * 100) / 100} dari esai` : ''}) / ${r.total} soal`;
  }

  async handleResultModalClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (e.target.id === 'result-modal') this.closeResult();
      return;
    }
    if (btn.dataset.action === 'close-result') return this.closeResult();
    if (btn.dataset.action === 'save-grade') {
      try {
        const body = this.collectGrades();
        const res = await this.api(`/api/admin/results/${this.openResultData.sessionId}/grade`, { method: 'POST', token: this.adminToken, body });
        this.closeResult();
        await this.loadResults();
        this.refreshAdmin();
        alert(res.finalScore === null ? 'Tersimpan. Nilai akhir muncul setelah semua esai dinilai.' : `Tersimpan. Nilai akhir: ${res.finalScore}`);
      } catch (err) {
        alert(err.message);
      }
    }
  }

  closeResult() {
    $('result-modal').classList.add('hidden');
    this.openResultData = null;
  }

  exportCsv() {
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // cegah formula injection di Excel
      return `"${t.replace(/"/g, '""')}"`;
    };
    const head = ['NIS', 'Nama', 'Kelas', 'Ujian', 'Dikumpulkan', 'PG Benar', 'PG Salah', 'PG Kosong', 'Jumlah Esai', 'Esai Dinilai', 'Nilai Akhir', 'Pelanggaran', 'Copy/Paste Diblokir'];
    const rows = this.resultRows.map((r) => [r.studentId, r.studentName, r.class, r.examTitle, r.submittedAt, r.correct, r.wrong, r.empty, r.essayCount, r.essayGraded, r.finalScore ?? '', r.violations, r.clipboardAttempts]);
    const csv = '\uFEFF' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'hasil-ujian.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- Kelola data ---------- */

  async loadManagement() {
    try {
      const [{ students }, { exams }] = await Promise.all([
        this.api('/api/admin/students', { token: this.adminToken }),
        this.api('/api/admin/exams', { token: this.adminToken })
      ]);
      this.mgmtExams = exams;

      $('students-table').querySelector('tbody').innerHTML = Object.values(students).map((s) => `
        <tr>
          <td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.class)}</td><td>${esc(s.email || '-')}</td>
          <td><button class="btn btn-sm btn-danger" data-action="delete-student" data-id="${esc(s.id)}">Hapus</button></td>
        </tr>`).join('');

      $('exams-mgmt-table').querySelector('tbody').innerHTML = Object.values(exams).map((x) => {
        const essay = x.questions.filter((q) => q.type === 'essay').length;
        return `
        <tr>
          <td>${esc(x.id)}</td><td>${esc(x.title)}</td><td>${x.durationMinutes} menit</td><td>${x.questions.length}</td>
          <td>PG: ${x.questions.length - essay}, Esai: ${essay}</td>
          <td><button class="btn btn-sm btn-danger" data-action="delete-exam" data-id="${esc(x.id)}">Hapus</button></td>
        </tr>`;
      }).join('');

      const select = $('mgmt-question-exam');
      const selected = select.value;
      select.innerHTML = '<option value="">Pilih Ujian</option>' +
        Object.values(exams).map((x) => `<option value="${esc(x.id)}">${esc(x.id)} - ${esc(x.title)}</option>`).join('');
      select.value = selected;
    } catch (e) {
      if (e.status === 401) this.adminLogout();
      else alert(e.message);
    }
  }

  async handleAddStudent(e) {
    e.preventDefault();
    try {
      await this.api('/api/admin/students', {
        method: 'POST',
        token: this.adminToken,
        body: {
          id: $('mgmt-student-id').value,
          name: $('mgmt-student-name').value,
          class: $('mgmt-student-class').value,
          email: $('mgmt-student-email').value
        }
      });
      e.target.reset();
      await this.loadManagement();
    } catch (err) {
      alert(err.message);
    }
  }

  async handleAddExam(e) {
    e.preventDefault();
    try {
      await this.api('/api/admin/exams', {
        method: 'POST',
        token: this.adminToken,
        body: {
          id: $('mgmt-exam-id').value,
          title: $('mgmt-exam-title').value,
          durationMinutes: $('mgmt-exam-duration').value,
          shuffleQuestions: $('mgmt-shuffle-q').checked,
          shuffleOptions: $('mgmt-shuffle-o').checked
        }
      });
      e.target.reset();
      await this.loadManagement();
      alert('Ujian berhasil dibuat! Sekarang tambahkan soalnya.');
    } catch (err) {
      alert(err.message);
    }
  }

  async handleAddQuestion(e) {
    e.preventDefault();
    const examId = $('mgmt-question-exam').value;
    const type = $('mgmt-question-type').value;
    if (!examId) return alert('Pilih ujian terlebih dahulu!');

    const body = { type, text: $('mgmt-question-text').value };
    if (type === 'multiple_choice') {
      body.options = [...document.querySelectorAll('.opt-input')].map((i) => ({ id: i.dataset.opt, text: i.value }));
      body.correctAnswer = $('mgmt-correct-answer').value;
    } else {
      body.maxWords = $('mgmt-essay-max').value;
      body.minWords = $('mgmt-essay-min').value;
      body.keywords = $('mgmt-essay-keywords').value.split(',').map((k) => k.trim()).filter(Boolean);
      body.sampleAnswer = $('mgmt-essay-sample').value;
    }

    try {
      await this.api(`/api/admin/exams/${encodeURIComponent(examId)}/questions`, { method: 'POST', token: this.adminToken, body });
      const keep = examId;
      e.target.reset();
      this.toggleQuestionType('multiple_choice');
      await this.loadManagement();
      $('mgmt-question-exam').value = keep;
      alert('Soal berhasil ditambahkan!');
    } catch (err) {
      alert(err.message);
    }
  }

  toggleQuestionType(type) {
    $('mgmt-mc-options').classList.toggle('hidden', type !== 'multiple_choice');
    $('mgmt-essay-options').classList.toggle('hidden', type === 'multiple_choice');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new QuizApp();
});
