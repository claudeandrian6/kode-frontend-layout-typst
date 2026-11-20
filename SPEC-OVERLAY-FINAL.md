# Arsitektur Server-Side PDF.js + Interactive Overlay Final

Dokumen spesifikasi final arsitektur layout editor jurnal otomatis berbasis **Server-Side PDF.js + Interactive Overlay**.

---

## 1. Latar Belakang & Keputusan Arsitektur

- **Penghentian Typst WASM**: Pendekatan Typst WASM dihentikan sepenuhnya dan dihapus bersih dari frontend karena ketidakcocokan versi kompiler WASM dengan Typst 0.15.1 di server.
- **Arsitektur Final (Server-Side PDF.js + Interactive Overlay)**:
  - **Kompilasi Server 100%**: PDF dikompilasi 100% oleh **Typst 0.15.1 + `build.py` / `qa_cepat.py` di server**, menjamin kualitas visual PDF identik 100% dengan standar produksi jurnal.
  - **Rendering Canvas PDF.js**: Browser merender `hasil.pdf` dari server ke dalam `<canvas class="pdf-page-canvas">` per halaman A4 (`595.28pt × 841.89pt`) menggunakan **PDF.js v3.11.174**.
  - **Interactive Overlay Layer**: Di atas setiap kanvas PDF halaman, fungsi `buildInteractiveOverlay(pageEl, pageNum)` merender layer interaktif absolut (`.wasm-overlay-layer`) berisi:
    - Kotak objek (`.wasm-box`) untuk gambar, tabel, dan paragraf penanda `#pm(n)`.
    - 8 titik resize handle (`.handle`) untuk manipulasi visual langsung.
    - Bilah batas bawah kolom (`.col-handle-bar`) untuk penyesuaian footer/kaki kolom.
    - Semua koordinat objek diposisikan secara presisi berdasarkan data dari `build.kueri_posisi` server.

---

## 2. Alur Interaksi Pengguna (Drag-and-Release -> Server Patch -> Live PDF.js Refresh)

1. **Manipulasi Visual Bebas (`pointermove`)**:
   - Saat pengguna menarik handle gambar (resize skala), memindahkan kotak gambar/tabel, menarik handle vertikal paragraf (`#colbreak()` / spasi `#v()`), atau menggeser `.col-handle-bar` (`#kaki-naik`), elemen bergerak bebas secara visual di layar tanpa latency server.
2. **Commit saat Mouse Dilepas (`pointerup`) / Panel Properti**:
   - Ketika mouse dilepas (`pointerup`) atau input diubah melalui `#panel-properti`:
     1. **Indikator Loading**: UI menampilkan overlay loading `#server-loading-overlay` (`"⏳ Memproses di Server..."`).
     2. **Kirim Permintaan**: Browser mengirim permintaan `POST JSON` ke `api.php?action=patch_layout`.
     3. **Patch & QA di Server**: Server memodifikasi `body.typ` (menyimpan cadangan di `_riwayat`), mengeksekusi kompilasi cepat `qa_cepat.py --tanpa-gambar` (Typst 0.15.1 + pemeriksaan QA `build.py`), lalu mengembalikan JSON state terbaru (`versi`, `halaman`, `objek`, `paragraf`, `kaki_naik`, `status`, `masalah`).
     4. **Live PDF.js Refresh**: Browser memuat ulang dokumen PDF dari `api.php?action=get_preview&id=<id>&v=<versi>` via PDF.js, memperbarui kanvas halaman, dan merekonstruksi `buildInteractiveOverlay` secara mulus tanpa me-reload halaman web.

---

## 3. Spesifikasi Endpoint `api.php`

### A. `GET api.php?action=get_state&id=<id>`
- **Deskripsi**: Mengambil seluruh status dan metadata layout artikel terkini.
- **Payload Response**: `{ ok: true, articleId, versi, halaman, halaman_awal, objek, paragraf, kaki_naik, masalah, status, riwayat }`.

### B. `GET api.php?action=get_preview&id=<id>&v=<versi>[&download=1]`
- **Deskripsi**: Mengirim stream biner file PDF `kerja/<id>/hasil.pdf`.
- **Header**: `Content-Type: application/pdf` dengan header `inline` (render PDF.js) atau `attachment` (`download=1` saat unduh PDF final).

### C. `POST api.php?action=patch_layout`
- **Payload Request**: `{ articleId: "<id>", op: "<operasi>", ...params }`
- **Operasi yang Didukung**:
  1. `skala`: Ubah `skala` (`0.50`–`1.30`) dan boolean `penuh` (`true`/`false`) pada `#gambar(..., nomor: N)`.
  2. `posisi`: Ubah `keputusan` (`tempat | atas | bawah | apung`) dan opsional memindahkan urutan kemunculan sebelum `#pm(targetPm)` pada `#gambar` / `#tabel`.
  3. `pindah_kolom`: Sisip atau hapus sintaks `#colbreak()` persis sebelum `#pm(N);`.
  4. `spasi_paragraf`: Sisip, ubah, atau hapus sintaks `#v(Xpt, weak: true) // ed:pm-N` sebelum `#pm(N);`.
  5. `kaki`: Sisip, perbarui, atau hapus pemanggilan `#kaki-naik(hal, X.0pt)`.
  6. `undo` / `redo`: Mengembalikan atau memulihkan versi `body.typ` dari direktori `_riwayat`.

---

## 4. Pohon File & Larangan

- **Larangan Pustaka WASM**: Dilarang memuat pustaka `@myriaddreamin/typst.ts`, compiler/renderer WASM, atau worker WASM pada frontend (`index.php`, `app.js`, `gaya.css`). Frontend sepenuhnya mengandalkan PDF.js v3.11.174.
- **Pembersihan Editor Kode**: Panel "Kode body.typ Live" (`#typst-source-editor`) dihapus total dari `#panel-properti`. Editing kode dilakukan terisolasi melalui API patch di sisi server.
- **Integritas File Frontend**:
  - `index.php`: Shell UI, container canvas PDF, toolbar aksi, dan `#panel-properti`.
  - `app.js`: Logika interaksi kanvas PDF.js, overlay interaktif, event pointer drag-and-drop, serta komunikasi REST API.
  - `gaya.css`: Styling visual canvas, bounding box overlay (`.wasm-box`), resize handle (`.handle`), dan status UI.
