// OTPInput: mengelola 6 kotak input kode OTP (hanya UI; kode dibuat dan diverifikasi di server)
class OTPInput {
  constructor(ids) {
    this.inputs = ids.map((id) => document.getElementById(id)).filter(Boolean);
    this.onComplete = null;
    this.bind();
  }

  bind() {
    const last = this.inputs.length - 1;
    this.inputs.forEach((input, i) => {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 1);
        input.classList.toggle('filled', !!input.value);
        if (input.value && i < last) this.inputs[i + 1].focus();
        if (this.value.length === this.inputs.length && this.onComplete) this.onComplete(this.value);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && i > 0) {
          const prev = this.inputs[i - 1];
          prev.value = '';
          prev.classList.remove('filled');
          prev.focus();
        } else if (e.key === 'ArrowLeft' && i > 0) {
          this.inputs[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < last) {
          this.inputs[i + 1].focus();
        }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, this.inputs.length).split('');
        digits.forEach((d, idx) => {
          this.inputs[idx].value = d;
          this.inputs[idx].classList.add('filled');
        });
        if (digits.length === this.inputs.length) {
          if (this.onComplete) this.onComplete(this.value);
        } else if (digits.length > 0) {
          this.inputs[digits.length].focus();
        }
      });
    });
  }

  get value() {
    return this.inputs.map((i) => i.value).join('');
  }

  clear() {
    this.inputs.forEach((i) => {
      i.value = '';
      i.classList.remove('filled');
    });
    if (this.inputs[0]) this.inputs[0].focus();
  }
}

window.OTPInput = OTPInput;
