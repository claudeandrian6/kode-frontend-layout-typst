# SPESIFIKASI TEKNIS ARSITEKTUR TYPST WASM REAL-TIME EDITOR (SPEC-WASM.md)

## 1. Visi & Alur Kerja Arsitektur Baru
Arsitektur HTML/CSS Multi-Column lama DIBONGKAR TOTAL dan digantikan oleh **In-Browser Typst WASM Compiler Engine** agar pengguna mendapatkan pengalaman sekelas Adobe InDesign / Scribus:
1. Saat artikel dibuka, Web UI mengambil bundel sumber (`get_wasm_bundle`) satu kali dari `api.php`: `template_jurnal.typ`, `main.typ`, `body.typ`, `meta.json`, `jurnal/<id>/config.json`, serta seluruh aset gambar biner (`logo_jurnal.png`, `logo_penerbit.png`, `media/*`) dalam bentuk base64.
2. Browser menginisialisasi kompiler & renderer **Typst WASM** (`@myriaddreamin/typst.ts`) dan memuat seluruh teks `.typ`/`.json` serta byte gambar (`Uint8Array`) ke dalam memori virtual WASM (Virtual File System / VFS).
3. Typst WASM mengompilasi `main.typ` langsung di dalam browser menjadi halaman vektor presisi (SVG per halaman & PDF biner Typst asli) tanpa memanggil server.
4. Di atas setiap halaman kanvas WASM (`.wasm-page-sheet`), Web UI merender layer interaktif absolut (`.wasm-overlay-layer`) yang menampilkan bingkai objek (`.wasm-box` untuk gambar, tabel, paragraf `#pm(n)`) lengkap dengan 8 titik pegangan resize (`.handle`) serta pegangan batas kolom/kaki halaman (`.col-handle-bar`).
5. **Interaksi Sub-Detik (Reflow Instan)**: Saat pengguna menarik handle ukuran gambar, memindahkan posisi gambar/tabel, atau menarik handle batas kolom, JavaScript langsung memodifikasi parameter pada string `body.typ` di memori (`EditorState.bodyTyp`), memperbarui VFS WASM (`$typst.addSource`), dan dengan **debounce 50ms** memanggil kompilasi ulang WASM.
6. Kanvas ter-refresh dengan hasil kompilasi Typst asli dalam waktu **< 200ms** tanpa 1 pun panggilan jaringan ke backend.
7. Tombol **"Cetak PDF (Typst WASM)"** menghasilkan file PDF vektor asli langsung dari `$typst.pdf()` di browser, sedangkan **"Simpan ke Server"** mengirim `body.typ` dan `meta.json` final ke `api.php?action=save_typst`.

## 2. Pohon File Final
```text
/var/www/layout-editor/
├── SPEC-WASM.md     # Spesifikasi Teknis Arsitektur Typst WASM Real-Time Editor
├── index.php        # Shell UI Editor WASM, Kanvas #kanvas-wasm, Overlay Interaktif, Inspector .typ
├── gaya.css         # Stylesheet Kanvas WASM A4 (595.28pt x 841.89pt), Overlay Box 8-Handle, Drag Guides
├── app.js           # Mesin Typst WASM, VFS Loader, Mutator String .typ Programatik, Debounce 50ms Compiler
├── api.php          # Endpoint existing + get_wasm_bundle & save_typst
└── config.php       # Konfigurasi mesin /opt/typst_editor (tidak diubah)
```

## 3. Daftar Library WASM + URL CDN + Versi Persis
1. **@myriaddreamin/typst.ts v0.5.5-rc7** (All-in-One ESM Bundle + WebCompiler WASM + Renderer WASM, mendukung penuh sintaks Typst 0.11/0.12 termasuk `context` di `template_jurnal.typ`):
   - Bundle ESM: `https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.5.5-rc7/dist/esm/contrib/all-in-one-lite.bundle.js`
   - Compiler WASM: `https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.5.5-rc7/pkg/typst_ts_web_compiler_bg.wasm`
   - Renderer WASM: `https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.5.5-rc7/pkg/typst_ts_renderer_bg.wasm`
2. **PDF.js v3.11.174** (Fallback/pendukung render kanvas halaman PDF byte dari `$typst.pdf()` bila diperlukan):
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`
   - `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`

## 4. Signature API Persis Typst WASM & VFS Gambar
```javascript
// 1. Memuat modul ESM @myriaddreamin/typst.ts@0.5.5-rc7 dan menginisialisasi WASM
import 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst.ts@0.5.5-rc7/dist/esm/contrib/all-in-one-lite.bundle.js';

window.$typst.setCompilerInitOptions({
  beforeBuild: [],
  getModule: () =>
    'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.5.5-rc7/pkg/typst_ts_web_compiler_bg.wasm',
});
window.$typst.setRendererInitOptions({
  beforeBuild: [],
  getModule: () =>
    'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.5.5-rc7/pkg/typst_ts_renderer_bg.wasm',
});

// 2. Memuat berkas teks (.typ dan .json) ke Virtual File System (VFS) WASM
await window.$typst.addSource('/template_jurnal.typ', templateTypText);
await window.$typst.addSource(`/jurnal/${journalId}/config.json`, configJsonText);
await window.$typst.addSource(`/kerja/${articleId}/meta.json`, metaJsonText);
await window.$typst.addSource(`/kerja/${articleId}/body.typ`, bodyTypText);
await window.$typst.addSource(`/kerja/${articleId}/main.typ`, mainTypText);

// 3. Memuat aset gambar biner (base64 -> Uint8Array) ke VFS WASM
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
// Dipetakan ke path absolut (/kerja/<id>/media/...) dan path root (/media/...)
await window.$typst.mapShadow(`/kerja/${articleId}/${relPath}`, uint8Bytes);
await window.$typst.mapShadow(`/${relPath}`, uint8Bytes);

// 4. Kompilasi Inkremental di Memori (< 150ms) ke Vektor SVG & PDF Asli
const mainFilePath = `/kerja/${articleId}/main.typ`;
const svgOutput = await window.$typst.svg({ mainFilePath });
const pdfUint8Array = await window.$typst.pdf({ mainFilePath });
```

## 5. Manipulasi Programatik Teks `.typ` dari Interaksi UI (Drag/Resize)
Setiap aksi drag pada `.wasm-overlay-layer` langsung memodifikasi string `window.EditorState.bodyTyp` di memori, memanggil `window.$typst.addSource('/kerja/' + articleId + '/body.typ', window.EditorState.bodyTyp)`, dan menjadwalkan `scheduleWasmCompile()` (debounce `50ms`):
1. **`mutateFigureScale(nomor, skalaBaru, penuhBaru)`**:
   - Mencari baris `#gambar(..., nomor: <nomor>, ...)` di `bodyTyp`.
   - Mengubah/menyisipkan parameter `skala: <0.50..1.30>` dan `penuh: <true|false>` secara presisi.
2. **`mutateObjectPlacement(jenis, nomor, keputusanBaru, targetPm)`**:
   - Mengubah parameter `keputusan: "tempat" | "atas" | "bawah" | "apung"` pada `#gambar(..., nomor: <nomor>)` atau `#tabel(..., nomor: <nomor>)`.
   - Bila `targetPm` diberikan (hasil drag-and-drop objek ke posisi paragraf lain), memindahkan seluruh blok `#gambar(...)` atau `#tabel(...)[...]` ke tepat sebelum/sesudah baris `#pm(<targetPm>);`.
3. **`mutateColumnBreak(pm, aktif)`**:
   - Menyisipkan atau menghapus direktif `#colbreak()` tepat di atas paragraf `#pm(<pm>);` saat pengguna menarik handle pemotong kolom pada kanvas.
4. **`mutateFooterShift(hal, barisNaik)`**:
   - Mengubah atau menyisipkan direktif `#kaki-naik(<hal>, <barisNaik * 11>.0pt)` di bagian kepala `bodyTyp` saat pengguna menarik handle batas bawah kolom pada halaman `<hal>`.
5. **`mutateParagraphSpacing(pm, spacingAbovePt, spacingBelowPt)`**:
   - Menyisipkan/memperbarui `#v(<spacingAbovePt>pt, weak: true) // ed:pm-<pm>` di atas paragraf `#pm(<pm>);` untuk merapatkan atau merenggangkan aliran teks di kolom.

## 6. Daftar Fungsi Publik `app.js`
| Fungsi | Parameter | Return | Deskripsi 1 Baris |
|---|---|---|---|
| `initEditor` | `()` | `Promise<void>` | Inisialisasi state, autentikasi, daftar artikel, dan pemuatan awal modul Typst WASM. |
| `initTypstWasm` | `()` | `Promise<boolean>` | Muat bundle ESM `@myriaddreamin/typst.ts` dan inisialisasi modul compiler & renderer WASM. |
| `base64ToUint8Array` | `(b64)` | `Uint8Array` | Konversi string base64 aset gambar menjadi `Uint8Array` untuk `mapShadow` VFS WASM. |
| `loadArticle` | `(articleId)` | `Promise<void>` | Ambil bundel `.typ` & gambar via `get_wasm_bundle`, muat ke VFS WASM, dan render kanvas. |
| `loadBundleToVfs` | `(bundle)` | `Promise<void>` | Masukkan semua file `.typ`, `.json`, dan gambar biner ke dalam memori virtual WASM. |
| `scheduleWasmCompile` | `(delayMs = 50)` | `void` | Jadwalkan kompilasi ulang WASM dengan debounce `50ms` tanpa memanggil server. |
| `compileAndRenderWasm` | `()` | `Promise<void>` | Jalankan `$typst.svg()` (atau fallback `$typst.pdf()`), render halaman ke `#kanvas-wasm`, dan bangun overlay handle. |
| `parseTypstBlocks` | `(bodyTyp)` | `Array<Object>` | Ekstrak daftar objek (`#gambar`, `#tabel`, `#pm(n)`, `#kaki-naik`) dari string `body.typ`. |
| `buildInteractiveOverlay` | `(pageEl, pageNum)` | `void` | Buat `.wasm-overlay-layer` berisi `.wasm-box` (8 `.handle`) dan `.col-handle-bar` di atas halaman. |
| `mutateFigureScale` | `(nomor, skala, penuh)` | `void` | Ubah parameter `skala` dan `penuh` pada `#gambar` di `body.typ` memori dan picu compile WASM. |
| `mutateObjectPlacement` | `(jenis, nomor, kep, pm)` | `void` | Ubah `keputusan` (`tempat`/`atas`/`bawah`/`apung`) atau urutan baris objek di `body.typ` memori. |
| `mutateColumnBreak` | `(pm, toggle)` | `void` | Sisipkan/hapus `#colbreak()` sebelum `#pm(n)` di `body.typ` memori dan picu compile WASM. |
| `mutateFooterShift` | `(hal, baris)` | `void` | Ubah `#kaki-naik(hal, pt)` saat handle batas bawah kolom ditarik naik/turun. |
| `saveTypstToServer` | `()` | `Promise<void>` | Kirim `body.typ` dan `meta.json` ke `api.php?action=save_typst` untuk disimpan permanen. |
| `exportWasmPdf` | `()` | `Promise<void>` | Kompilasi `$typst.pdf()` di memori WASM dan unduh PDF vektor Typst asli seketika. |

## 7. Urutan Chunk Implementasi (Maksimal 300 Baris per Chunk)
- **CHUNK-W1 (`SPEC-WASM.md`)**: Penulisan dokumen spesifikasi teknis WASM ini.
- **CHUNK-W2 (`api.php`)**: Tambah endpoint `get_wasm_bundle` (mengirim `template_jurnal.typ`, `main.typ`, `body.typ`, `meta.json`, `config.json`, `layout_map.json`, dan seluruh gambar base64) serta `save_typst` (menyimpan `body.typ` & `meta.json` ke disk).
- **CHUNK-W3 (`index.php` & `gaya.css`)**: Bongkar total HTML/CSS multi-column lama; ganti dengan kanvas Typst WASM `#kanvas-wasm`, `.wasm-page-sheet`, `.wasm-overlay-layer`, `.wasm-box`, 8 `.handle`, `.col-handle-bar`, serta panel properti & editor kode `.typ` (hidden default).
- **CHUNK-W4 (`app.js` Bagian 1)**: State `window.EditorState`, `initTypstWasm`, `base64ToUint8Array`, `loadBundleToVfs`, `scheduleWasmCompile` (debounce 50ms), `compileAndRenderWasm`, `parseTypstBlocks`, `buildInteractiveOverlay`.
- **CHUNK-W5 (`app.js` Bagian 2)**: Mutator string `.typ` (`mutateFigureScale`, `mutateObjectPlacement`, `mutateColumnBreak`, `mutateFooterShift`), event pointer drag/resize real-time, `saveTypstToServer`, `exportWasmPdf`, dan pengikatan toolbar.
