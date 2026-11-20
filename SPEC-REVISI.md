# SPESIFIKASI TEKNIS REVISI — VISUAL LAYOUT EDITOR (SPEC-REVISI.md)

Dokumen ini memperbarui dan melengkapi `SPEC.md` pasca uji coba pengguna dan audit teknis. Berkas `SPEC.md` asli tetap dipertahankan.

## 4-Rev. Pembaruan Daftar Fungsi Publik `app.js`
Selain fungsi dasar di `SPEC.md` §4, daftar fungsi publik diperbarui sebagai berikut:
| Fungsi | Parameter | Return | Deskripsi 1 Baris |
|---|---|---|---|
| `renderLivePreview` | `(immediate = false)` | `void` | Render snapshot DOM `#kanvas-kertas` secara live (debounced 180ms) ke `.preview-live-canvas` tanpa klik Simpan. |
| `togglePreviewMode` | `(mode)` | `Promise<void>` | Beralih mode panel preview antara 'live' (render kanvas HTML) dan 'typst' (`preview.pdf` via PDF.js). |
| `exportPdfVector` | `()` | `void` | Jalur utama tombol "Cetak PDF": panggil `window.print()` dengan `@media print` & `@page` untuk menghasilkan PDF Vektor. |
| `exportPdfRaster` | `()` | `Promise<void>` | Jalur sekunder tombol "Unduh sebagai gambar PDF (raster)" via `html2pdf.js` tanpa halaman kosong di akhir. |
| `exportPdfHtml2Pdf` | `()` | `Promise<void>` | Alias kompatibilitas yang memanggil `exportPdfRaster()`. |
| `exportPdfPrintFallback` | `()` | `void` | Alias kompatibilitas yang memanggil `exportPdfVector()`. |
| `loadReferencePdf` | `(url)` | `Promise<void>` | (Mode opsional 'typst') Muat `preview.pdf` via PDF.js hanya ketika mode perbandingan Typst diaktifkan. |
| `renderPdfPage` | `(pageNum)` | `Promise<void>` | (Mode opsional 'typst') Render halaman `pageNum` dari `preview.pdf` ke `#pdf-ref-canvas`. |
| `loadTestFixture` | `()` | `void` | Muat fixture pengujian §13 (2+ halaman, 1 tabel lebar, 1 gambar penuh-kolom, 1 paragraf >100 kata). |

## 5-Rev. Pembaruan Daftar Class CSS Wajib di `gaya.css`
Tambahan class CSS wajib di luar `SPEC.md` §5:
- `.preview-live-canvas`: Kontainer/kanvas pratinjau live yang menampilkan salinan identik lembaran `.sheet-page` dari `#kanvas-kertas`.
- `.preview-mode-toggle`: Bilah tombol pemilih mode pada panel preview (`Preview Live` vs `Bandingkan dengan Typst`).
- `.btn-export-vector`: Class tombol utama "Cetak PDF" (menghasilkan PDF vektor via `window.print()`).
- `.btn-export-raster`: Class tombol sekunder "Unduh sebagai gambar PDF (raster)" (via `html2pdf.js`).
- `.column-height-warning`: Banner/badge informasi UX ("Tinggi kolom berlaku untuk kedua kolom halaman ini") saat mengatur tinggi kolom.

## 10. Arsitektur Panel Preview Live
1. **Keputusan Metode Render**: Menggunakan **Live DOM Mirroring (`cloneNode(true)`) terskala di dalam `.preview-live-canvas` dengan debounce `180ms`** sebagai tampilan utama panel preview, serta **PDF.js v3.11.174** sebagai mode toggle opsional (`"Bandingkan dengan Typst"`).
   - **Alasan**: Karena ekspor utama (§11) adalah `window.print()` + `@media print`, kloning DOM `.sheet-page` (dengan menghapus class `.show-frames`, `.el-selected`, dan `.column-bottom-handle`) menggunakan mesin layout CSS multi-column yang 100% sama dengan kanvas utama dan hasil cetak vektor, sehingga deviasi bounding box adalah `0px` (< 2px toleransi) dan waktu pembaruan `< 20ms` (otomatis terpicu setiap drag handle kolom, resize elemen, atau edit teks tanpa perlu klik Simpan).
2. **Visibilitas Default Panel**: Sesuai permintaan pengguna, baik **Panel Preview (`#panel-referensi`)** maupun **Panel Properti Elemen (`#panel-properti`)** berstatus **hidden secara default** (`hidden` attribute). Pengguna membuka/menutup keduanya melalui tombol toolbar `#btn-toggle-ref` ("Panel Preview") dan `#btn-toggle-prop` ("Properti Elemen"). Kanvas utama `#kanvas-kertas` merender tampilan halaman yang 100% identik dengan PDF.
3. **Daftar Library + URL CDN + Versi Persis**:
   - PDF.js v3.11.174 (mode opsional pembanding Typst):
     - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`
     - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`
   - html2pdf.js v0.10.1 (bundel mencakup html2canvas v1.4.1 & jsPDF untuk ekspor sekunder raster):
     - `https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js`
4. **Signature API Persis**:
```javascript
// 1. Live Preview DOM Mirror (debounced 180ms)
const srcCanvas = document.getElementById('kanvas-kertas');
const liveContainer = document.getElementById('preview-live-canvas');
const clone = srcCanvas.cloneNode(true);
clone.removeAttribute('id');
clone.classList.remove('show-frames');
clone.querySelectorAll('.column-bottom-handle, .column-guide-line').forEach(n => n.remove());
clone.querySelectorAll('.el-selected').forEach(n => n.classList.remove('el-selected'));
liveContainer.replaceChildren(clone);

// 2. Ekspor PDF Vektor Utama
window.print();

// 3. Ekspor PDF Raster Sekunder (html2pdf.js 0.10.1 tanpa halaman kosong akhir)
kanvas.style.transform = 'none';
kanvas.style.gap = '0px';
pages.forEach(p => {
  p.style.minHeight = '296.5mm';
  p.style.height = '296.5mm';
  p.style.pageBreakAfter = 'auto';
  p.style.breakAfter = 'auto';
});
const opt = {
  margin: [0, 0, 0, 0],
  filename: `${articleId}-raster.pdf`,
  image: { type: 'jpeg', quality: 0.98 },
  html2canvas: { scale: 2, useCORS: true, logging: false },
  jsPDF: { unit: 'mm', format: [210, 297], orientation: 'portrait' },
  pagebreak: { mode: ['css'], avoid: ['.el-table', '.el-image', '.el-heading'] }
};
await window.html2pdf().set(opt).from(kanvas).save();
```

## 11. Prioritas Ekspor Baru (Vektor Primer vs Raster Sekunder)
1. **Jalur Utama — `exportPdfVector()` (`.btn-export-vector` / `#btn-cetak-pdf`)**:
   - **Label Tombol**: `"Cetak PDF"`
   - **Tooltip**: `"Cetak PDF Vektor berkualitas jurnal (teks dapat dicari/Ctrl+F, disalin, dan siap untuk OJS/Crossref)"`
   - **Mekanisme**: Memanggil `window.print()` dengan aturan `@page { size: 210mm 297mm; margin: 0; }` dan `@media print`. Menghasilkan PDF vektor murni di mana seluruh teks abstrak, body, dan tabel dapat dicari (`Ctrl+F`) dan diekstrak metadatanya.
2. **Jalur Sekunder — `exportPdfRaster()` (`.btn-export-raster` / `#btn-export-raster`)**:
   - **Label Tombol**: `"Unduh sebagai gambar PDF (raster)"`
   - **Tooltip**: `"Unduh PDF berbasis gambar raster via html2pdf.js (teks tidak dapat dicari)"`
   - **Perbaikan Halaman Kosong Akhir**: Mengatur sementara `#kanvas-kertas` dengan `gap: 0px` dan setiap `.sheet-page` dengan `minHeight: 296.5mm`, `height: 296.5mm`, serta `pageBreakAfter = breakAfter = 'auto'` selama konversi agar pembulatan piksel `html2canvas` (`min-height: 297mm` = 1122.52px > 1122px) dan jarak `gap: 28px` antar halaman tidak memicu halaman kosong tambahan di tengah maupun di akhir PDF.

## 12. Batasan Handle Kolom
1. **Keputusan Arsitektur**: Memilih **Opsi (a)** — mempertahankan CSS Multi-Column (`column-count: 2`, `column-fill: auto`) di mana `.column-bottom-handle` mengatur tinggi area kolom (`columnHeightMm`) untuk kedua kolom secara seimbang pada halaman tersebut.
2. **Alasan**: Standar tata letak jurnal ilmiah mewajibkan batas bawah kolom kiri dan kolom kanan pada halaman yang sama sejajar di atas garis footer, serta menghindari kompleksitas fragmen DOM yang rawan merusak urutan baca kalimat.
3. **Catatan UX Wajib di UI**: Menampilkan elemen `.column-height-warning` dengan teks persis: `"Tinggi kolom berlaku untuk kedua kolom halaman ini"` pada bagian bawah halaman/kanvas dan saat pengguna mengarahkan kursor atau menarik `.column-bottom-handle`.

## 13. Fixture Pengujian (Acceptance Criteria)
Artikel uji standar (`fixture-uji` / fungsi `loadTestFixture()`) WAJIB mencakup minimal:
1. **2+ Halaman A4** (`pages.length >= 2`, `columnHeightMm: 135` di halaman 1 dan `225` di halaman 2).
2. **1 Tabel Lebar** (`id: "tbl-fix-1"`, `type: "table"`, `columnSpan: "all"`, `widthMm: 156`, 4 kolom × 4 baris data).
3. **1 Gambar Penuh-Kolom Tinggi** (`id: "fig-fix-1"`, `type: "image"`, `columnSpan: "none"`, `widthMm: 74`, `heightMm: 95`).
4. **Minimal 1 Paragraf Panjang > 100 Kata** (`id: "p-fix-long"`, 130+ kata bahasa Inggris ilmiah di bagian Abstract/Introduction) ditambah beberapa paragraf pendamping agar aliran teks melintasi halaman 1 ke halaman 2.
5. **Kriteria Lulus**: Saat `.column-bottom-handle` halaman 1 ditarik naik (mis. ke `80mm`) lalu ditarik turun kembali (ke `150mm`), tabel tidak pernah terbelah (`break-inside: avoid`), tidak ada teks yang hilang di batas halaman, tidak ada kata yang terpotong di tengah (`hyphens: none; word-break: normal`), dan `.preview-live-canvas` terupdate otomatis dalam `< 300ms`.
