// QuizManager: menampilkan soal dan mengirim jawaban ke server.
// Penilaian dilakukan di server; kunci jawaban tidak pernah dikirim ke browser.
class QuizManager {
  constructor(opts) {
    this.opts = opts; // { onAnswer(qid, answer), onSubmit(), onTimeUp(), confirm(message) }
    this.questions = [];
    this.answers = {};
    this.dirty = new Set(); // qid yang belum tersimpan di server
    this.index = 0;
    this.exam = null;
    this.student = null;
    this.endsAt = 0;
    this.timerInterval = null;
    this.timeUpFired = false;
    this.essayTimer = null;
    this.saveChain = Promise.resolve(); // simpan jawaban berurutan agar jawaban terakhir yang menang

    document.getElementById('prev-btn').addEventListener('click', () => this.go(this.index - 1));
    document.getElementById('next-btn').addEventListener('click', () => {
      if (this.index === this.questions.length - 1) this.requestSubmit();
      else this.go(this.index + 1);
    });
  }

  load(state) {
    this.exam = state.exam;
    this.student = state.student;
    this.questions = state.questions || [];

    // Jawaban yang belum tersimpan di server (mis. saat terkunci) tidak boleh hilang
    const merged = { ...(state.answers || {}) };
    this.dirty.forEach((qid) => {
      if (this.answers[qid] !== undefined) merged[qid] = this.answers[qid];
    });
    this.answers = merged;

    if (this.index >= this.questions.length) this.index = 0;
    this.timeUpFired = false;
    this.syncRemaining(state.remainingSeconds);

    document.getElementById('exam-title').textContent = this.exam ? this.exam.title : 'Ujian';
    document.getElementById('student-name').textContent = this.student ? `${this.student.id} - ${this.student.name}` : '';

    this.buildDots();
    this.render();
    this.startTimer();
  }

  current() {
    return this.questions[this.index];
  }

  isAnswered(q) {
    const v = this.answers[q.qid];
    return v !== undefined && String(v).trim() !== '';
  }

  answeredCount() {
    return this.questions.filter((q) => this.isAnswered(q)).length;
  }

  /* ---------- Navigasi ---------- */

  go(i) {
    if (i < 0 || i >= this.questions.length || i === this.index) return;
    this.commitEssay();
    this.index = i;
    this.render();
  }

  buildDots() {
    const box = document.getElementById('question-dots');
    box.innerHTML = '';
    this.questions.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = 'question-dot';
      dot.setAttribute('aria-label', `Soal ${i + 1}`);
      dot.addEventListener('click', () => this.go(i));
      box.appendChild(dot);
    });
  }

  updateChrome() {
    document.querySelectorAll('.question-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === this.index);
      dot.classList.toggle('answered', !!this.questions[i] && this.isAnswered(this.questions[i]));
    });

    const total = this.questions.length;
    const answered = this.answeredCount();
    document.getElementById('progress-fill').style.width = `${total ? (answered / total) * 100 : 0}%`;
    document.getElementById('progress-text').textContent = `Soal ${this.index + 1} dari ${total} | Terjawab: ${answered}/${total}`;

    document.getElementById('prev-btn').disabled = this.index === 0;
    document.getElementById('next-btn').textContent = this.index === total - 1 ? 'Selesai' : 'Selanjutnya';
  }

  /* ---------- Render soal ---------- */

  render() {
    const container = document.getElementById('question-container');
    const q = this.current();
    if (!q) {
      container.innerHTML = '';
      return;
    }

    if (q.type === 'essay') this.renderEssay(container, q);
    else this.renderChoice(container, q);
    this.updateChrome();
  }

  renderChoice(container, q) {
    const selected = this.answers[q.qid];
    container.innerHTML = `
      <div class="question-card">
        <div class="question-header">
          <div class="question-number">${this.index + 1}</div>
          <div class="question-text">${this.escapeHtml(q.text)}</div>
          <span class="question-type-badge mc">Pilihan Ganda</span>
        </div>
        <div class="question-options">
          ${q.options.map((opt, i) => `
            <label class="option ${selected === opt.id ? 'selected' : ''}" data-id="${this.escapeHtml(opt.id)}">
              <span class="option-letter">${String.fromCharCode(65 + i)}</span>
              <span class="option-label">${this.escapeHtml(opt.text)}</span>
              <div class="option-marker"></div>
              <input type="radio" name="q${q.qid}" value="${this.escapeHtml(opt.id)}" ${selected === opt.id ? 'checked' : ''}>
            </label>`).join('')}
        </div>
      </div>`;

    container.querySelectorAll('.option').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.selectChoice(q, el.dataset.id);
      });
    });
  }

  // Jawaban pilihan ganda boleh diganti kapan saja sampai ujian dikumpulkan
  selectChoice(q, optionId) {
    if (this.answers[q.qid] === optionId) return;
    this.answers[q.qid] = optionId;
    this.dirty.add(q.qid);
    this.render();
    this.save(q.qid);
  }

  renderEssay(container, q) {
    const value = this.answers[q.qid] || '';
    container.innerHTML = `
      <div class="question-card">
        <div class="question-header">
          <div class="question-number">${this.index + 1}</div>
          <div class="question-text">${this.escapeHtml(q.text)}</div>
          <span class="question-type-badge essay">Esai</span>
        </div>
        <div class="essay-container">
          <textarea id="essay-input" class="essay-textarea" placeholder="Tulis jawaban Anda di sini..." rows="8"
            spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-gramm="false"
            maxlength="${q.maxWords ? q.maxWords * 8 : 5000}">${this.escapeHtml(value)}</textarea>
          <p class="paste-notice">🚫 Copy, cut, dan paste dinonaktifkan selama ujian.</p>
          <div class="essay-info">
            <span id="word-count">0</span> / ${q.maxWords || '∞'} kata
            ${q.minWords ? `<span class="min-words">Minimal: ${q.minWords} kata</span>` : ''}
          </div>
        </div>
      </div>`;

    const textarea = document.getElementById('essay-input');
    const counter = document.getElementById('word-count');
    const updateCount = () => {
      const text = textarea.value.trim();
      const count = text ? text.split(/\s+/).length : 0;
      counter.textContent = count;
      counter.style.color = q.maxWords && count > q.maxWords ? 'var(--danger)' : 'var(--text-muted)';
    };
    updateCount();

    // Lapisan cadangan: tambahan teks besar sekaligus (mis. dari ekstensi/alat tempel otomatis) dibatalkan
    let lastValue = textarea.value;
    textarea.addEventListener('input', (e) => {
      const added = textarea.value.length - lastValue.length;
      if (added > 40 && !e.isComposing && e.inputType !== 'insertCompositionText') {
        textarea.value = lastValue;
        if (this.opts.onBlockedInput) this.opts.onBlockedInput('bulk_input');
        updateCount();
        return;
      }
      lastValue = textarea.value;
      updateCount();
      this.answers[q.qid] = textarea.value;
      this.dirty.add(q.qid);
      clearTimeout(this.essayTimer);
      this.essayTimer = setTimeout(() => this.save(q.qid), 800);
      this.updateChrome();
    });
    textarea.addEventListener('blur', () => this.commitEssay());
  }

  /* ---------- Simpan jawaban ke server ---------- */

  commitEssay() {
    clearTimeout(this.essayTimer);
    const q = this.current();
    const textarea = document.getElementById('essay-input');
    if (!q || q.type !== 'essay' || !textarea) return Promise.resolve();
    this.answers[q.qid] = textarea.value;
    this.dirty.add(q.qid);
    return this.save(q.qid);
  }

  save(qid) {
    this.dirty.add(qid);
    this.saveChain = this.saveChain.then(() => this.sendAnswer(qid));
    return this.saveChain;
  }

  async sendAnswer(qid) {
    try {
      await this.opts.onAnswer(qid, this.answers[qid]);
      this.dirty.delete(qid);
    } catch (e) {
      // 400: ditolak server (data tidak valid), jangan dicoba lagi.
      // 423 (terkunci) atau gangguan jaringan: tetap ditandai belum tersimpan dan dikirim ulang nanti.
      if (e.status === 400) this.dirty.delete(qid);
    }
  }

  async flushDirty() {
    for (const qid of [...this.dirty]) await this.save(qid);
  }

  /* ---------- Timer ---------- */

  syncRemaining(seconds) {
    this.endsAt = performance.now() + seconds * 1000;
  }

  startTimer() {
    this.stopTimer();
    this.tick();
    this.timerInterval = setInterval(() => this.tick(), 1000);
  }

  stopTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = null;
  }

  tick() {
    const remaining = Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
    const display = document.getElementById('timer-display');
    const timer = document.getElementById('quiz-timer');
    const h = String(Math.floor(remaining / 3600)).padStart(2, '0');
    const m = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    display.textContent = `${h}:${m}:${s}`;
    display.style.color = remaining <= 60 ? 'var(--danger)' : remaining <= 300 ? 'var(--warning)' : '';
    timer.classList.toggle('warning', remaining <= 300);

    if (remaining <= 0 && !this.timeUpFired) {
      this.timeUpFired = true;
      this.opts.onTimeUp();
    }
  }

  /* ---------- Kumpulkan ---------- */

  async requestSubmit() {
    const total = this.questions.length;
    const unanswered = total - this.answeredCount();
    let message = `Yakin ingin mengumpulkan ujian?\n\nTerjawab: ${total - unanswered}/${total}`;
    if (unanswered > 0) message += `\nBelum dijawab: ${unanswered} soal`;
    if (await this.opts.confirm(message)) this.opts.onSubmit();
  }

  pause() {
    this.stopTimer();
  }

  destroy() {
    this.stopTimer();
    clearTimeout(this.essayTimer);
    this.questions = [];
    this.answers = {};
    this.dirty.clear();
  }

  escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}

window.QuizManager = QuizManager;
