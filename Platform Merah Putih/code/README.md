# Platform Merah Putih - Sistem Ujian Online dengan Keamanan Ketat

Ujian online dengan **fullscreen wajib**, **deteksi keluar tab/Esc**, dan **kode OTP dari pengawas**.
Ada dua sesi di halaman login: **Siswa** dan **Pengawas**.

## Cara Menjalankan

```bash
cd quiz
ADMIN_PASSWORD=passwordkuat npm start      # Linux/Mac
# Windows (PowerShell): $env:ADMIN_PASSWORD="passwordkuat"; npm start
```

- Buka `http://localhost:3000` (siswa dan pengawas memakai alamat yang sama, pilih tab di halaman login)
- Jika `ADMIN_PASSWORD` tidak diset, password pengawas default adalah `admin123` (**ganti sebelum dipakai sungguhan**)
- Tidak ada dependensi npm; cukup Node.js

## Alur Ujian

1. **Siswa** memilih tab *Siswa*, memasukkan ID Peserta dan Kode Ujian, lalu mengaktifkan fullscreen.
2. Jika siswa **keluar tab, Alt+Tab, keluar fullscreen, atau menekan Esc**, layar ujian langsung terkunci
   dan server membuat OTP 6 digit.
3. **Pengawas** membuka tab *Pengawas* (login dengan password), lalu melihat kode OTP siswa di tab **Permintaan OTP**
   (ada badge angka jika ada siswa yang terkunci).
4. Pengawas membacakan kode ke siswa; siswa memasukkannya di layar kunci. Kode berlaku 5 menit, maksimal 3 percobaan.
   Jika kode habis/kedaluwarsa, siswa menekan *Minta Kode Baru* atau pengawas menekan *Buat Ulang Kode*.
5. OTP benar -> siswa kembali ke ujian (setelah mengaktifkan fullscreen lagi bila perlu).

Kode OTP **tidak pernah dikirim ke browser siswa**; hanya tampil di panel pengawas.

## Fitur Panel Pengawas

- **Ujian Aktif**: status tiap siswa (Mengerjakan / Terkunci / Selesai), progres jawaban, jumlah pelanggaran, *Paksa Kumpulkan*, *Reset* (agar siswa bisa mengulang)
- **Permintaan OTP**: kode OTP aktif, alasan pelanggaran, *Buat Ulang Kode*, *Akhiri Ujian*
- **Hasil & Nilai**: daftar ujian yang sudah dikumpulkan. Klik *Periksa* untuk melihat jawaban siswa (PG beserta kunci,
  esai lengkap dengan kata kunci dan contoh jawaban), memberi nilai 0-100 tiap esai, dan menulis komentar.
  Nilai akhir = (jumlah PG benar + jumlah nilai esai/100) / jumlah soal x 100, muncul setelah semua esai dinilai.
  Tombol *Unduh CSV* mengekspor rekap nilai (bisa dibuka di Excel). Badge angka menunjukkan hasil yang belum dinilai
- **Log Keamanan**: pelanggaran, OTP, percobaan copy/paste, penilaian, login pengawas, dll
- **Kelola Data**: tambah/hapus peserta dan ujian, tambah soal (pilihan ganda/esai)

## Struktur

```
quiz/
├── server.js        # Backend: sesi, OTP, penilaian, API admin
├── public/          # Satu-satunya folder yang bisa diakses browser
│   ├── index.html
│   ├── styles.css
│   ├── app.js       # Controller (login, kunci OTP, panel admin)
│   ├── quiz.js      # Tampilan soal & timer
│   ├── security.js  # Deteksi pelanggaran
│   └── otp.js       # Kotak input OTP
└── data/            # Disimpan server (tidak bisa diakses browser)
    ├── exams.json   students.json   results.json
    └── sessions.json   logs.json    # dibuat otomatis
```

## Perubahan Keamanan Penting

- Kunci jawaban, OTP, dan data siswa tidak lagi bisa diunduh lewat URL (`/exams.json`, dll)
- Penilaian dilakukan di server; browser siswa tidak menerima kunci jawaban
- Soal diacak per siswa di server; sisa waktu dihitung server (tidak bisa diubah dari browser)
- Jawaban ditolak server selama sesi terkunci
- Memuat ulang halaman atau login ulang saat ujian berjalan dianggap pelanggaran (memicu OTP)
- Jawaban pilihan ganda maupun esai bisa diganti kapan saja sampai ujian dikumpulkan (selama tidak sedang terkunci)
- **Anti copy-paste**: copy, cut, paste, drag-drop, klik kanan, dan pintasan (Ctrl+C/X/V/A, Ctrl/Shift+Insert, Shift+Delete)
  diblokir di soal maupun kolom esai; teks soal tidak bisa diseleksi. Tambahan teks besar sekaligus (>40 karakter) di
  esai dibatalkan sebagai lapisan cadangan. Setiap percobaan dicatat dan tampil di panel pengawas (tidak mengunci ujian)

## Batasan

Anti copy-paste hanya melindungi di dalam halaman ujian: foto layar, mengetik ulang soal, atau perangkat kedua tidak bisa dicegah.
Deteksi di browser tidak 100% kebal (mesin virtual, perangkat kedua, dsb). Untuk ujian penting,
kombinasikan dengan pengawasan fisik atau Safe Exam Browser. Browser tidak bisa mendeteksi Alt+Tab secara langsung;
yang terdeteksi adalah jendela kehilangan fokus (`blur`) dan perpindahan tab (`visibilitychange`).
Gunakan HTTPS atau `localhost` agar Fullscreen API berfungsi.
