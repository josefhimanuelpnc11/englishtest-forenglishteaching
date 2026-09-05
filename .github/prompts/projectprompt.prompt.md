---
name: projectprompt
description: Describe when to use this prompt
---

<!-- Tip: Use /create-prompt in chat to generate content with agent assistance -->

# MASTER PROMPT — FREE ONLINE EXAM & PROCTORING SYSTEM

## 1. PROJECT OVERVIEW

Saya ingin membangun sebuah **Online Examination System dengan Client-Side Proctoring** yang digunakan untuk ujian siswa.

Sistem harus:

1. Menyediakan halaman ujian online.
2. Menampilkan soal pilihan ganda dan/atau tipe soal lain.
3. Memiliki timer ujian.
4. Meminta akses kamera peserta.
5. Melakukan monitoring peserta melalui webcam secara lokal di browser.
6. Mendeteksi aktivitas yang dianggap mencurigakan.
7. Mendeteksi ketika peserta berpindah tab atau meninggalkan halaman ujian.
8. Mendeteksi ketika fullscreen keluar.
9. Mendeteksi aktivitas copy/paste.
10. Menyimpan jawaban dan hasil ujian.
11. Menyimpan log pelanggaran.
12. Dapat melakukan auto-submit berdasarkan aturan pelanggaran.
13. Dapat memberikan nilai 0 apabila peserta melanggar aturan tertentu.
14. Memiliki biaya infrastructure dan maintenance seminimal mungkin, idealnya **Rp0**.

Sistem ditujukan untuk skala kecil sampai menengah, terutama untuk ujian siswa/kelas/les.

---

# 2. CORE PRINCIPLE

Sistem TIDAK boleh bergantung pada server yang mahal atau video streaming ke server.

Prinsip utama:

> **Computer Vision dan monitoring dilakukan di perangkat peserta (client-side / browser), sedangkan server hanya menerima event, jawaban, hasil ujian, dan metadata yang diperlukan.**

Jangan meng-upload video webcam secara terus-menerus ke server.

Arsitektur yang diinginkan:

```text
WEBCAM
   │
   ▼
BROWSER PESERTA
   │
   ├── Video Stream
   │
   ├── Face Detection
   ├── Multiple Face Detection
   ├── No Face Detection
   ├── Tab Switch Detection
   ├── Fullscreen Detection
   ├── Copy/Paste Detection
   ├── Keyboard Shortcut Detection
   └── Other Proctoring Events
           │
           ▼
      PROCTORING ENGINE
           │
           ▼
     EVENT / VIOLATION
           │
           ▼
    GOOGLE APPS SCRIPT
           │
           ▼
      GOOGLE SHEETS