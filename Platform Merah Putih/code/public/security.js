// SecurityManager: mendeteksi pelanggaran saat siswa mengerjakan ujian.
// Setiap pelanggaran hanya dilaporkan lewat callback onViolation; penguncian dan OTP diurus server.
class SecurityManager {
  constructor() {
    this.monitoring = false;
    this.suspended = false;
    this.ignoreUntil = 0;
    this.onViolation = null;
    this.onAttempt = null;
    this.lastAttempt = 0;
    this.devtoolsTimer = null;
    this.handlers = {
      visibility: () => {
        if (document.hidden) this.report('tab_hidden', 'Berpindah tab atau meminimalkan jendela');
      },
      blur: () => this.report('window_blur', 'Jendela kehilangan fokus (Alt+Tab, dll)'),
      fullscreen: () => {
        if (!this.isFullscreen()) this.report('fullscreen_exit', 'Keluar dari mode fullscreen (Esc/F11)');
      },
      keydown: (e) => this.handleKeydown(e),
      block: (e) => {
        const clipboardEvent = ['copy', 'cut', 'drop'].includes(e.type);
        if (this.isEditable(e.target)) {
          // Di area soal/esai, copy/cut/drop juga diblokir; kotak lain (mis. OTP) dibiarkan
          if (this.inQuestion(e.target) && clipboardEvent) {
            e.preventDefault();
            this.attempt(e.type);
          }
          return;
        }
        e.preventDefault();
        if (clipboardEvent) this.attempt(e.type);
      },
      paste: (e) => {
        if (this.inQuestion(e.target) || !this.isEditable(e.target)) {
          e.preventDefault();
          e.stopPropagation();
          this.attempt('paste');
        }
      },
      beforeinput: (e) => {
        const blocked = ['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank'];
        if (blocked.includes(e.inputType) && this.inQuestion(e.target)) {
          e.preventDefault();
          this.attempt(e.inputType);
        }
      },
      contextmenu: (e) => e.preventDefault(),
      beforeprint: () => this.report('print_attempt', 'Mencoba mencetak halaman ujian')
    };
  }

  init({ onViolation, onAttempt } = {}) {
    this.onViolation = onViolation || null;
    this.onAttempt = onAttempt || null;
  }

  isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  inQuestion(el) {
    return !!el && !!el.closest && !!el.closest('#question-container');
  }

  // Percobaan copy/paste: diblokir dan dicatat, tidak sampai mengunci ujian
  attempt(kind) {
    if (!this.monitoring || this.suspended) return;
    const now = Date.now();
    if (now - this.lastAttempt < 1000) return;
    this.lastAttempt = now;
    if (this.onAttempt) this.onAttempt(kind);
  }

  isEditable(el) {
    return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  }

  start() {
    if (this.monitoring) return;
    this.monitoring = true;
    this.suspended = false;
    this.ignoreUntil = Date.now() + 800;

    document.addEventListener('visibilitychange', this.handlers.visibility);
    window.addEventListener('blur', this.handlers.blur);
    document.addEventListener('fullscreenchange', this.handlers.fullscreen);
    document.addEventListener('webkitfullscreenchange', this.handlers.fullscreen);
    document.addEventListener('keydown', this.handlers.keydown, true);
    document.addEventListener('contextmenu', this.handlers.contextmenu);
    ['dragstart', 'drop', 'selectstart', 'copy', 'cut'].forEach((ev) => document.addEventListener(ev, this.handlers.block));
    document.addEventListener('paste', this.handlers.paste, true);
    document.addEventListener('beforeinput', this.handlers.beforeinput, true);
    window.addEventListener('beforeprint', this.handlers.beforeprint);

    document.body.classList.add('quiz-active');
    this.lockEscapeKey();
    this.devtoolsTimer = setInterval(() => this.checkDevTools(), 1000);
    this.updateIndicator('active');
  }

  stop() {
    if (!this.monitoring) return;
    this.monitoring = false;

    document.removeEventListener('visibilitychange', this.handlers.visibility);
    window.removeEventListener('blur', this.handlers.blur);
    document.removeEventListener('fullscreenchange', this.handlers.fullscreen);
    document.removeEventListener('webkitfullscreenchange', this.handlers.fullscreen);
    document.removeEventListener('keydown', this.handlers.keydown, true);
    document.removeEventListener('contextmenu', this.handlers.contextmenu);
    ['dragstart', 'drop', 'selectstart', 'copy', 'cut'].forEach((ev) => document.removeEventListener(ev, this.handlers.block));
    document.removeEventListener('paste', this.handlers.paste, true);
    document.removeEventListener('beforeinput', this.handlers.beforeinput, true);
    window.removeEventListener('beforeprint', this.handlers.beforeprint);

    document.body.classList.remove('quiz-active');
    clearInterval(this.devtoolsTimer);
    this.devtoolsTimer = null;
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  }

  // Berhenti melaporkan sementara (misalnya saat layar kunci OTP tampil)
  suspend() {
    this.suspended = true;
  }

  resume() {
    this.suspended = false;
    this.ignoreUntil = Date.now() + 800;
    this.updateIndicator('active');
  }

  report(type, message) {
    if (!this.monitoring || this.suspended || Date.now() < this.ignoreUntil) return;
    this.suspended = true; // satu pelanggaran per kunci; satu kejadian bisa memicu blur + visibility + fullscreen sekaligus
    this.updateIndicator('danger');
    if (this.onViolation) this.onViolation({ type, message, timestamp: new Date().toISOString() });
  }

  handleKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.report('esc_key', 'Menekan tombol Esc');
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const key = (e.key || '').toLowerCase();

    // Pintasan clipboard (Ctrl+C/X/V/A, Ctrl+Insert, Shift+Insert, Shift+Delete)
    const clipKey = (ctrl && ['c', 'x', 'v', 'a'].includes(key)) ||
      (ctrl && e.key === 'Insert') || (e.shiftKey && (e.key === 'Insert' || e.key === 'Delete'));
    if (clipKey && (this.inQuestion(e.target) || !this.isEditable(e.target))) {
      e.preventDefault();
      e.stopPropagation();
      if (key !== 'a') this.attempt('shortcut_' + key);
      return;
    }
    const devtools = e.key === 'F12' || (ctrl && e.shiftKey && ['i', 'j', 'c', 'k'].includes(key));
    const viewSource = ctrl && key === 'u';
    const print = ctrl && key === 'p';

    if (devtools || viewSource || print) {
      e.preventDefault();
      e.stopPropagation();
      this.report('blocked_shortcut', 'Mencoba membuka DevTools/lihat sumber/cetak');
      return;
    }

    // Diblokir tanpa dihitung pelanggaran (refresh, simpan, tab/jendela baru)
    if (e.key === 'F5' || (ctrl && ['r', 's', 'w', 't', 'n'].includes(key))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  checkDevTools() {
    // Hanya relevan saat fullscreen: di mode ini selisih outer/inner seharusnya 0
    if (!this.monitoring || !this.isFullscreen()) return;
    const threshold = 160;
    const open = window.outerWidth - window.innerWidth > threshold || window.outerHeight - window.innerHeight > threshold;
    if (open) this.report('devtools_open', 'Developer Tools terbuka');
  }

  // Chrome/Edge: dengan keyboard lock, Esc dikirim ke halaman sehingga tercatat sebagai pelanggaran
  lockEscapeKey() {
    try {
      if (navigator.keyboard && navigator.keyboard.lock && this.isFullscreen()) {
        navigator.keyboard.lock(['Escape']).catch(() => {});
      }
    } catch (e) { /* tidak didukung */ }
  }

  async requestFullscreen() {
    const elem = document.documentElement;
    try {
      if (elem.requestFullscreen) await elem.requestFullscreen();
      else if (elem.webkitRequestFullscreen) await elem.webkitRequestFullscreen();
      else return false;
      this.lockEscapeKey();
      return true;
    } catch (err) {
      console.error('Fullscreen request failed:', err);
      return false;
    }
  }

  exitFullscreen() {
    try {
      if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) { /* abaikan */ }
  }

  updateIndicator(status) {
    const indicator = document.getElementById('security-indicator');
    const dot = indicator && indicator.querySelector('.status-dot');
    const label = indicator && indicator.querySelector('span:last-child');
    if (!dot || !label) return;
    dot.className = 'status-dot' + (status === 'active' ? ' active' : status === 'danger' ? ' danger' : ' warning');
    label.textContent = status === 'active' ? 'Terlindungi' : status === 'danger' ? 'Terkunci' : 'Peringatan';
  }
}

window.SecurityManager = SecurityManager;
