# SPESIFIKASI TEKNIS VISUAL LAYOUT EDITOR (SPEC.md)

## 1. Pohon File Final
```text
/var/www/layout-editor/
├── SPEC.md          # Dokumen Spesifikasi Teknis Arsitektur Visual Editor
├── index.php        # Shell HTML5, Autentikasi Sesi, Toolbar, Kanvas Multi-Kolom, Panel PDF.js
├── gaya.css         # Stylesheet UI, Kanvas A4, CSS Multi-Column, Bounding Box 8-Handle, @media print
├── app.js           # State window.EditorState, Renderer HTML/CSS, Direct Manipulation, Linked Frames, Ekspor PDF
├── api.php          # Backend endpoint existing + endpoint baru: get_content, get_preview, save_layout
└── config.php       # Konfigurasi path mesin /opt/typst_editor (existing, tidak diubah)
```

## 2. Daftar Library + URL CDN + Versi Persis
1. **PDF.js v3.11.174** (Hanya untuk panel referensi `preview.pdf` read-only):
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`
2. **html2pdf.js v0.10.1** (Konversi kanvas HTML `#kanvas-kertas` ke PDF di browser):
   - `https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js`

## 3. Signature API Persis Library
```javascript
// PDF.js 3.11.174
window.pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const loadingTask = window.pdfjsLib.getDocument({ url: pdfUrl, withCredentials: true });
const pdfDoc = await loadingTask.promise;
const pdfPage = await pdfDoc.getPage(pageNumber);
const viewport = pdfPage.getViewport({ scale: 1.2 });
const canvas = document.getElementById('pdf-ref-canvas');
const ctx = canvas.getContext('2d');
canvas.width = Math.floor(viewport.width);
canvas.height = Math.floor(viewport.height);
await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;

// html2pdf.js 0.10.1
const opt = {
  margin: [0, 0, 0, 0],
  filename: `${articleId}.pdf`,
  image: { type: 'jpeg', quality: 0.98 },
  html2canvas: { scale: 2, useCORS: true, logging: false },
  jsPDF: { unit: 'mm', format: [210, 297], orientation: 'portrait' },
  pagebreak: { mode: ['css', 'legacy'], after: '.sheet-page' }
};
await window.html2pdf().set(opt).from(containerElement).save();
```

## 4. Daftar Fungsi Publik `app.js`
| Fungsi | Parameter | Return | Deskripsi 1 Baris |
|---|---|---|---|
| `initEditor` | `()` | `Promise<void>` | Inisialisasi `window.EditorState`, listener global, sesi login, dan daftar artikel. |
| `apiFetch` | `(action, params = {}, bodyObj = null)` | `Promise<Object>` | Panggil `api.php` via `fetch` untuk GET atau POST JSON/FormData. |
| `loadArticleList` | `()` | `Promise<void>` | Ambil daftar artikel dari server dan render ke sidebar kiri. |
| `loadArticle` | `(articleId)` | `Promise<void>` | Muat `content.json` via `get_content` (atau `localStorage`) dan `preview.pdf` via `get_preview`. |
| `saveToLocal` | `()` | `void` | Autosave `EditorState.content` dan `EditorState.layout` ke `localStorage`. |
| `loadFromLocal` | `(articleId)` | `Object|null` | Baca state draft artikel dari `localStorage` jika ada. |
| `pushUndo` | `(label)` | `void` | Simpan snapshot state ke `EditorState.undoStack` dan kosongkan `redoStack`. |
| `undo` | `()` | `void` | Kembalikan state sebelumnya dari `undoStack` dan render ulang kanvas. |
| `redo` | `()` | `void` | Terapkan kembali state dari `redoStack` dan render ulang kanvas. |
| `saveLayoutToServer` | `()` | `Promise<void>` | Kirim payload `save_layout` via POST JSON ke `api.php?action=save_layout`. |
| `renderCanvas` | `()` | `void` | Render seluruh halaman `.sheet-page` dengan CSS multi-column dari `EditorState`. |
| `createPageElement` | `(pageCfg, pageIndex)` | `HTMLElement` | Bangun elemen DOM halaman A4 beserta `.page-columns` dan `.column-bottom-handle`. |
| `renderElementHTML` | `(el)` | `HTMLElement` | Buat elemen DOM `.el-item` (`heading`, `paragraph`, `image`, `table`, `meta`). |
| `redistributeOverflowPages` | `()` | `void` | Alirkan elemen secara otomatis ke halaman berikutnya saat kolom meluap. |
| `initColumnResizeHandles` | `()` | `void` | Pasang listener drag pada `.column-bottom-handle` di tiap halaman. |
| `onColumnHandleDown` | `(e, pageIdx)` | `void` | Mulai drag vertikal untuk mengubah tinggi kolom pada halaman `pageIdx`. |
| `updateColumnHeight` | `(pageIdx, heightMm)` | `void` | Perbarui tinggi kolom (mm) di `EditorState.layout` dan reflow teks instan. |
| `toggleFrameOverlay` | `(forceState)` | `void` | Toggle class `.show-frames` untuk menampilkan/menyembunyikan border 1px per elemen. |
| `selectElement` | `(elId)` | `void` | Pilih elemen di kanvas, tampilkan `.bbox-overlay` + 8 `.handle`, dan isi inspector. |
| `clearSelection` | `()` | `void` | Bersihkan seleksi aktif dan sembunyikan `.bbox-overlay`. |
| `renderSelectionOverlay` | `(elId)` | `void` | Hitung dan posisikan `.bbox-overlay` serta 8 titik `.handle` pada elemen terpilih. |
| `onElementPointerDown` | `(e, elId)` | `void` | Mulai drag-move posisi elemen dengan pointer capture. |
| `onHandlePointerDown` | `(e, elId, dir)` | `void` | Mulai resize proporsional (4 sudut) atau resize tepi (4 sisi) pada elemen. |
| `onPointerMove` | `(e)` | `void` | Proses pergerakan pointer untuk drag elemen, resize 8-handle, atau tinggi kolom. |
| `onPointerUp` | `(e)` | `void` | Akhiri interaksi pointer, simpan undo snapshot + `saveToLocal()`. |
| `applyElementGeometry` | `(elId, patch)` | `void` | Terapkan perubahan koordinat/ukuran/gaya elemen ke `EditorState`. |
| `enableInlineEdit` | `(elId)` | `void` | Aktifkan suntingan teks langsung (`contenteditable`) saat elemen didobel-klik. |
| `loadReferencePdf` | `(url)` | `Promise<void>` | Muat dokumen `preview.pdf` menggunakan PDF.js di panel referensi kanan. |
| `renderPdfPage` | `(pageNum)` | `Promise<void>` | Render halaman `pageNum` dari `preview.pdf` ke `<canvas id="pdf-ref-canvas">`. |
| `exportPdfHtml2Pdf` | `()` | `Promise<void>` | Konversi `#kanvas-kertas` menjadi file PDF ukuran A4 via `html2pdf.js`. |
| `exportPdfPrintFallback` | `()` | `void` | Jalankan fallback cetak PDF via `window.print()` dan `@media print`. |
| `bindToolbarEvents` | `()` | `void` | Pasang semua event klik/input pada tombol bilah alat dan pintasan keyboard. |

## 5. Daftar Class CSS Wajib di `gaya.css`
- `.app-shell`: Layout grid utama 3 kolom (sidebar daftar artikel, kanvas utama, panel samping).
- `.top-toolbar`: Bilah kontrol atas (simpan, undo/redo, frame toggle, kolom, cetak PDF, zoom).
- `.workspace-split`: Kontainer pembagi area kanvas HTML dan panel referensi PDF.js.
- `.canvas-viewport`: Area gulir kanvas dengan latar belakang abu-abu kontras.
- `#kanvas-kertas`: Kontainer lembaran halaman jurnal yang diekspor ke PDF.
- `.sheet-page`: Lembaran halaman fisik A4 (`210mm` x `297mm`) dengan margin jurnal.
- `.page-header-running`: Header halaman jurnal (nama jurnal, ISSN, nomor halaman cetak).
- `.page-frontmatter`: Blok metadata halaman pertama (judul, penulis, afiliasi, abstrak, kata kunci).
- `.page-columns`: Kontainer CSS multi-column (`column-count: 2`, `column-gap: 6.35mm`, `column-rule: 1px solid #cbd5e1`).
- `.column-bottom-handle`: Handle horizontal di bawah tiap area kolom untuk mengubah tinggi kolom (Linked Text Frames).
- `.column-guide-line`: Garis indikator horizontal saat tinggi kolom sedang di-drag.
- `.show-frames`: Class aktif pada `#kanvas-kertas` yang menampilkan border tipis `1px` berbeda warna per jenis elemen.
- `.el-item`: Class dasar setiap blok konten di dalam kanvas.
- `.el-heading`: Blok judul bab/subbab (border `1px solid #7c3aed` saat `.show-frames` aktif).
- `.el-paragraph`: Blok paragraf teks (border `1px solid #2563eb` saat `.show-frames` aktif).
- `.el-image`: Blok gambar/figure (border `1px solid #059669` saat `.show-frames` aktif).
- `.el-table`: Blok tabel ilmiah (border `1px solid #d97706` saat `.show-frames` aktif).
- `.el-meta`: Blok metadata halaman 1 (border `1px dashed #64748b` saat `.show-frames` aktif).
- `.el-selected`: State visual elemen yang sedang dipilih.
- `.el-floating`: Elemen dengan posisi absolut atau rentang penuh (`column-span: all`).
- `.bbox-overlay`: Kotak biru semi-transparan di atas elemen yang dipilih.
- `.handle`: Titik pegangan resize (`9px x 9px`) pada `.bbox-overlay`.
- `.handle-nw`, `.handle-ne`, `.handle-se`, `.handle-sw`: 4 handle sudut untuk resize proporsional.
- `.handle-n`, `.handle-e`, `.handle-s`, `.handle-w`: 4 handle sisi untuk resize tepi.
- `.ref-panel`: Panel samping pembanding visual `preview.pdf` (PDF.js).
- `.ref-canvas-wrap`: Kontainer `<canvas id="pdf-ref-canvas">`.
- `.status-badge`: Indikator status simpan (`Tersimpan`, `Draft Lokal`, `Menyimpan...`).

## 6. Skema `content.json` Final & `window.EditorState`
```json
{
  "ok": true,
  "version": 1,
  "articleId": "591uji",
  "journal": {
    "id": "bsscd",
    "name": "Bulletin of Social Studies and Community Development",
    "shortHeader": "Bull. Soc. Stud. Commun. Dev.",
    "issn": "3025-6798",
    "doiPrefix": "10.61436/bsscd"
  },
  "meta": {
    "title": "Community Empowerment Strategy Through Local Wisdom",
    "authors": "Ahmad Fauzi (1)*, Siti Rahmawati (2)",
    "affiliations": "1 Universitas Sriwijaya, Indonesia\n2 Universitas Andalas, Indonesia",
    "abstract": "This study investigates community empowerment programs...",
    "keywords": "community empowerment; local wisdom; sustainable development",
    "received": "10 January 2026",
    "accepted": "18 February 2026",
    "published": "30 March 2026",
    "email": "fauzi@unsri.ac.id",
    "volume": "3",
    "issue": "1",
    "year": "2026",
    "startPage": 667
  },
  "layout": {
    "pageWidthMm": 210,
    "pageHeightMm": 297,
    "marginTopMm": 36.1,
    "marginBottomMm": 27.9,
    "marginLeftMm": 27.0,
    "marginRightMm": 27.0,
    "columnCount": 2,
    "columnGapMm": 6.35,
    "fontFamily": "\"Times New Roman\", Times, serif",
    "fontSizePt": 11,
    "lineHeight": 1.15,
    "pages": [
      { "pageNumber": 1, "columnHeightMm": 135.0 },
      { "pageNumber": 2, "columnHeightMm": 225.0 }
    ]
  },
  "elements": [
    {
      "id": "h-001",
      "type": "heading",
      "level": 1,
      "pageIndex": 0,
      "text": "1. INTRODUCTION",
      "style": {
        "fontSizePt": 11,
        "fontWeight": "bold",
        "marginTopMm": 3.5,
        "marginBottomMm": 1.5,
        "columnSpan": "none",
        "floatMode": "flow",
        "xMm": 0,
        "yMm": 0,
        "widthMm": null,
        "heightMm": null
      }
    },
    {
      "id": "p-001",
      "type": "paragraph",
      "pageIndex": 0,
      "text": "Community development requires active participation from local stakeholders...",
      "style": {
        "fontSizePt": 11,
        "textAlign": "justify",
        "textIndentMm": 5.0,
        "marginTopMm": 0,
        "marginBottomMm": 1.2,
        "columnSpan": "none",
        "floatMode": "flow",
        "xMm": 0,
        "yMm": 0,
        "widthMm": null,
        "heightMm": null
      }
    },
    {
      "id": "fig-001",
      "type": "image",
      "pageIndex": 1,
      "src": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "caption": "Figure 1. Conceptual framework of the study",
      "style": {
        "widthMm": 75.0,
        "heightMm": 48.0,
        "aspectRatio": 1.5625,
        "columnSpan": "none",
        "floatMode": "flow",
        "xMm": 0,
        "yMm": 0,
        "marginTopMm": 2.5,
        "marginBottomMm": 2.5
      }
    },
    {
      "id": "tbl-001",
      "type": "table",
      "pageIndex": 1,
      "caption": "Table 1. Demographic characteristics of respondents",
      "headers": ["Category", "Frequency", "Percentage (%)"],
      "rows": [
        ["Male", "45", "56.25"],
        ["Female", "35", "43.75"]
      ],
      "style": {
        "fontSizePt": 9.5,
        "widthMm": 156.0,
        "heightMm": null,
        "columnSpan": "all",
        "floatMode": "flow",
        "xMm": 0,
        "yMm": 0,
        "marginTopMm": 2.5,
        "marginBottomMm": 2.5
      }
    }
  ]
}
```

## 7. Skema Payload `save_layout`
```json
{
  "action": "save_layout",
  "articleId": "591uji",
  "savedAt": "2026-11-10T15:00:00.000Z",
  "content": {
    "version": 1,
    "articleId": "591uji",
    "journal": {
      "id": "bsscd",
      "name": "Bulletin of Social Studies and Community Development",
      "shortHeader": "Bull. Soc. Stud. Commun. Dev.",
      "issn": "3025-6798",
      "doiPrefix": "10.61436/bsscd"
    },
    "meta": {
      "title": "Community Empowerment Strategy Through Local Wisdom",
      "authors": "Ahmad Fauzi (1)*, Siti Rahmawati (2)",
      "affiliations": "1 Universitas Sriwijaya, Indonesia\n2 Universitas Andalas, Indonesia",
      "abstract": "This study investigates community empowerment programs...",
      "keywords": "community empowerment; local wisdom; sustainable development",
      "received": "10 January 2026",
      "accepted": "18 February 2026",
      "published": "30 March 2026",
      "email": "fauzi@unsri.ac.id",
      "volume": "3",
      "issue": "1",
      "year": "2026",
      "startPage": 667
    },
    "layout": {
      "pageWidthMm": 210,
      "pageHeightMm": 297,
      "marginTopMm": 36.1,
      "marginBottomMm": 27.9,
      "marginLeftMm": 27.0,
      "marginRightMm": 27.0,
      "columnCount": 2,
      "columnGapMm": 6.35,
      "fontFamily": "\"Times New Roman\", Times, serif",
      "fontSizePt": 11,
      "lineHeight": 1.15,
      "pages": [
        { "pageNumber": 1, "columnHeightMm": 135.0 },
        { "pageNumber": 2, "columnHeightMm": 225.0 }
      ]
    },
    "elements": []
  }
}
```

## 8. Ukuran Halaman Final (`@page`) & Tipografi Body
- Ukuran Kertas (`@page`): **A4 Portrait** — Lebar `210mm`, Tinggi `297mm`
- Margin Halaman: Atas `36.1mm` (`102.4pt`), Bawah `27.9mm` (`79.0pt`), Kiri `27.0mm` (`76.5pt`), Kanan `27.0mm` (`76.5pt`)
- Lebar Area Teks: `156.0mm` (`442.2pt`), Lebar Kolom Tunggal: `74.825mm` (`212.1pt`), Jarak Antar Kolom (`column-gap`): `6.35mm` (`18pt`)
- Font Body: `"Times New Roman", Times, serif`, ukuran `11pt`, `line-height: 1.15`, perataan `justify`.

## 9. Urutan Chunk Implementasi (Maksimal 300 Baris per Chunk)
- **CHUNK-1 (`/var/www/layout-editor/api.php`)**: Tambah dukungan parameter `action` dan 3 endpoint baru (`get_content`, `get_preview`, `save_layout`) tanpa mengubah endpoint lama (≤ 150 baris tambahan).
- **CHUNK-2 (`/var/www/layout-editor/index.php`)**: Dokumen HTML/PHP utama memuat CDN PDF.js 3.11.174 & html2pdf.js 0.10.1, layar login, sidebar artikel, toolbar editor, kanvas multi-kolom `#kanvas-kertas`, dan panel referensi `#panel-referensi` (≤ 180 baris).
- **CHUNK-3 (`/var/www/layout-editor/gaya.css` Bagian 1)**: Variabel tema, `.app-shell`, `.top-toolbar`, `.workspace-split`, `.canvas-viewport`, `#kanvas-kertas`, `.sheet-page`, `.page-header-running`, `.page-frontmatter`, `.page-columns`, `.column-bottom-handle`, `.column-guide-line` (≤ 220 baris).
- **CHUNK-4 (`/var/www/layout-editor/gaya.css` Bagian 2)**: `.show-frames`, `.el-item`, `.el-heading`, `.el-paragraph`, `.el-image`, `.el-table`, `.el-meta`, `.el-selected`, `.el-floating`, `.bbox-overlay`, `.handle` (8 arah), `.ref-panel`, `.ref-canvas-wrap`, `.status-badge`, dan aturan `@media print` / `@page` (≤ 200 baris).
- **CHUNK-5 (`/var/www/layout-editor/app.js` Bagian 1)**: Definisi `window.EditorState`, `initEditor`, `apiFetch`, `loadArticleList`, `loadArticle`, `saveToLocal`, `loadFromLocal`, `pushUndo`, `undo`, `redo`, `saveLayoutToServer` (≤ 240 baris).
- **CHUNK-6 (`/var/www/layout-editor/app.js` Bagian 2)**: Fungsi `renderCanvas`, `createPageElement`, `renderElementHTML`, `redistributeOverflowPages`, `initColumnResizeHandles`, `onColumnHandleDown`, `updateColumnHeight`, `toggleFrameOverlay` (≤ 250 baris).
- **CHUNK-7 (`/var/www/layout-editor/app.js` Bagian 3)**: Fungsi `selectElement`, `clearSelection`, `renderSelectionOverlay`, `onElementPointerDown`, `onHandlePointerDown`, `onPointerMove`, `onPointerUp`, `applyElementGeometry`, `enableInlineEdit` (≤ 250 baris).
- **CHUNK-8 (`/var/www/layout-editor/app.js` Bagian 4)**: Fungsi `loadReferencePdf`, `renderPdfPage`, `exportPdfHtml2Pdf`, `exportPdfPrintFallback`, `bindToolbarEvents`, dan bootstrap `DOMContentLoaded` (≤ 220 baris).
