<?php
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => !empty($_SERVER['HTTPS']),
                           'httponly' => true, 'samesite' => 'Strict']);
session_start();
$masuk = !empty($_SESSION['masuk']);
?><!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IMRECS Layout Editor</title>
  <link rel="stylesheet" href="gaya.css?v=49">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
</head>
<body class="<?= $masuk ? 'masuk' : 'belum' ?>">

<section id="layar-masuk" <?= $masuk ? 'hidden' : '' ?>>
  <form id="form-masuk">
    <h1>IMRECS Layout Editor</h1>
    <p>Automated Journal Layout Engine</p>
    <input type="password" id="input-sandi" name="sandi" placeholder="Kata sandi editor" autocomplete="current-password" required>
    <button type="submit" class="btn-primary">Masuk</button>
    <p id="pesan-masuk" class="galat"></p>
  </form>
</section>

<div id="aplikasi" class="app-shell" <?= $masuk ? '' : 'hidden' ?>>
  <aside id="kiri">
    <div class="sidebar-header">
      <h2 class="sidebar-title">IMRECS Layout Editor</h2>
      <div class="sidebar-actions">
        <button id="btn-baru" type="button" class="btn-sm btn-primary" title="Bangun naskah baru dari Word">+ Build Word</button>
        <button id="btn-keluar" type="button" class="btn-sm btn-tautan" title="Keluar">Keluar</button>
      </div>
    </div>

    <div class="sidebar-tabs">
      <button type="button" id="tab-btn-artikel" class="tab-btn aktif">📄 Artikel</button>
      <button type="button" id="tab-btn-objek" class="tab-btn">🎯 Select Object</button>
    </div>

    <div id="panel-tab-artikel" class="sidebar-pane">
      <ul id="daftar-artikel"></ul>
    </div>

    <div id="panel-tab-objek" class="sidebar-pane" hidden>
      <div class="obj-filter-bar">
        <input type="search" id="cari-objek" placeholder="Cari blok / teks / #pm...">
        <select id="filter-jenis-objek">
          <option value="all">Semua Objek</option>
          <option value="meta">Metadata Hal. 1</option>
          <option value="figure">Gambar (Figure)</option>
          <option value="table">Tabel (Table)</option>
          <option value="heading">Heading / Judul</option>
          <option value="paragraph">Paragraf & Daftar</option>
          <option value="reference">Referensi</option>
        </select>
      </div>
      <ul id="daftar-objek"></ul>
    </div>
  </aside>

  <main id="tengah">
    <header class="top-toolbar">
      <div class="tb-group tb-left">
        <strong id="judul-artikel">Pilih Artikel</strong>
        <span id="status-draft" class="status-badge">Siap</span>
        <span id="qa-status" class="wasm-badge">QA: Siap</span>
      </div>
      <div class="tb-group tb-center">
        <button id="btn-undo" type="button" disabled title="Undo Server (Ctrl+Z)">↶ Undo</button>
        <button id="btn-redo" type="button" disabled title="Redo Server (Ctrl+Y)">↷ Redo</button>
        <button id="btn-toggle-frames" type="button" class="btn-aktif" title="Tampilkan/Sembunyikan Bingkai Interaktif">🔲 Bingkai</button>
        <button id="btn-preview-mode" type="button" title="Mode Pratinjau Bersih: sembunyikan panel & bingkai untuk melihat hasil PDF akhir (Esc untuk keluar)">👁️ Preview</button>
        <button id="btn-toggle-grid" type="button" title="Tampilkan Grid 11pt & Aktifkan Snap-to-Grid">📏 Grid</button>
        <button id="btn-freeze-layout" type="button" title="Bekukan Tata Letak: kunci seluruh halaman; klik blok 1x untuk buka kunci (🔓) lalu geser/resize/edit dengan auto-render tanpa menggeser blok terkunci">🧊 Freeze Layout</button>
        <button id="btn-cut-mode" type="button" title="Mode Potong Visual (Gunting): Klik pada blok teks di kanvas untuk memotong paragraf">✂️ Mode Potong</button>
        <label class="zoom-label">Zoom <input id="zoom" type="range" min="60" max="160" step="5" value="100"> <span id="zoom-val">100%</span></label>
      </div>
      <div class="tb-group tb-right">
        <button id="btn-metadata" type="button" title="Edit Metadata Naskah (Penulis, Abstrak, Riwayat)">📝 Metadata</button>
        <button id="btn-reset-draft" type="button" hidden title="Batalkan draft lokal yang belum disimpan">✕ Reset Draft</button>
        <button id="btn-simpan-server" type="button" class="btn-primary" title="Simpan perubahan draft lokal ke Typst & render ulang PDF">💾 Simpan Perubahan</button>
        <button id="btn-cetak-pdf" type="button" class="btn-success">🖨️ Unduh PDF</button>
        <button id="btn-toggle-prop" type="button">⚙️ Properti</button>
      </div>
    </header>

    <div class="workspace-body">
      <div class="canvas-viewport" id="viewport-utama">
        <div id="kanvas-pdf" class="show-frames">
          <div class="empty-state">Pilih naskah di panel kiri untuk memuat PDF server dan bingkai interaktif.</div>
        </div>
        <div id="server-loading-overlay" class="server-loading-overlay" hidden>
          <div class="server-loading-card">⏳ Memproses di Server...</div>
        </div>
      </div>

      <aside id="panel-properti" class="prop-panel">
        <div class="prop-header">
          <strong>Inspector Objek & Tata Letak</strong>
          <button id="btn-tutup-prop" type="button" class="btn-ikon" title="Tutup">✕</button>
        </div>

        <form id="form-properti" onsubmit="return false;">
          <div id="prop-info" class="prop-info">Klik blok di kanvas atau melalui tab <b>Select Object</b> untuk mengedit draft lokal. Klik <b>Simpan Perubahan</b> untuk merender PDF.</div>
          <input type="hidden" id="prop-id">
          <input type="hidden" id="prop-jenis">
          <input type="hidden" id="prop-nomor">
          <input type="hidden" id="prop-pm">
          <input type="hidden" id="prop-hal">

          <div id="grup-prop-teks" class="prop-group" hidden>
            <h4>Edit Teks / Konten Blok</h4>
            <label>Isi Teks (atau Caption)
              <textarea id="prop-teks" rows="5" placeholder="Teks blok..."></textarea>
            </label>
            <div class="prop-row-btns">
              <button id="btn-terapkan-teks" type="button" class="btn-primary btn-sm">✓ Simpan ke Draft</button>
              <button id="btn-hapus-blok" type="button" class="btn-danger btn-sm">🗑️ Hapus Blok</button>
            </div>
          </div>

          <div id="grup-prop-objek" class="prop-group" hidden>
            <h4>Parameter Gambar / Tabel</h4>
            <label>Skala Objek: <span id="prop-skala-val">100%</span>
              <input type="range" id="prop-skala" min="70" max="120" step="1" value="100">
            </label>
            <label>Posisi / Penempatan
              <select id="prop-keputusan">
                <option value="auto">Di Tempat (In-Flow)</option>
                <option value="top">Atas Halaman (Float Top)</option>
                <option value="bottom">Bawah Halaman (Float Bottom)</option>
                <option value="float">Apung Otomatis</option>
              </select>
            </label>
            <label class="check-label">
              <input type="checkbox" id="prop-penuh"> Rentang 2 Kolom (penuh: true)
            </label>
            <label>Pindah Urutan ke Target Blok:
              <div class="prop-inline">
                <select id="prop-move-pos" style="width:95px">
                  <option value="before">Sebelum</option>
                  <option value="after">Sesudah</option>
                </select>
                <select id="prop-target-id"></select>
              </div>
            </label>
            <button id="btn-terapkan-pindah" type="button" class="btn-outline btn-sm">↕️ Pindahkan di Draft</button>
            <button id="btn-buka-crop" type="button" class="btn-outline btn-sm" hidden>✂️ Crop Objek Ini...</button>
          </div>

          <div id="grup-prop-paragraf" class="prop-group" hidden>
            <h4>Parameter Paragraf & Kolom (Grid 11pt)</h4>
            <label>Pindah Kolom / Halaman Sebelum Blok
              <select id="prop-break-before">
                <option value="none">Mengalir Normal</option>
                <option value="column">Pindah Kolom (#colbreak)</option>
                <option value="page">Pindah Halaman (#pagebreak)</option>
              </select>
            </label>
            <label>Spasi Atas Grid (kelipatan 11pt)
              <select id="prop-spasi-atas">
                <option value="0">0 pt (Standar)</option>
                <option value="11">11 pt (+1 Baris)</option>
                <option value="22">22 pt (+2 Baris)</option>
                <option value="-11">-11 pt (-1 Baris)</option>
              </select>
            </label>
          </div>

          <div id="grup-prop-halaman" class="prop-group">
            <h4>Margin Halaman (<span id="lbl-hal-aktif">1</span>)</h4>
            <label>Margin Atas Kolom (maks &plusmn;22pt): <span id="prop-kepala-val">0 pt (0 baris)</span>
              <input type="range" id="prop-kepala-turun" min="-2" max="2" step="1" value="0">
            </label>
            <label>Margin Bawah Kolom (maks &plusmn;22pt): <span id="prop-kaki-val">0 pt (0 baris)</span>
              <input type="range" id="prop-kaki-naik" min="-2" max="2" step="1" value="0">
            </label>
          </div>
        </form>

        <div id="qa-masalah-box" class="prop-info">Status QA akan tampil di sini.</div>
      </aside>
    </div>
  </main>
</div>

<!-- MODAL 1: BUILD NASKAH BARU (.DOCX) -->
<div id="modal-baru" class="modal-backdrop" hidden>
  <div class="modal-kotak modal-lebar">
    <div class="modal-kepala">
      <strong>Bangun Naskah Baru dari Word (.docx)</strong>
      <button type="button" id="btn-batal-baru" class="btn-ikon">✕</button>
    </div>
    <form id="form-baru">
      <div class="form-grid-2">
        <label>ID Artikel (Opsional, kosongkan = nama file)
          <input type="text" id="input-id-baru" name="id" placeholder="Contoh: 591-3500-1-LE">
        </label>
        <label>Jurnal Tujuan
          <select id="input-jurnal-baru" name="jurnal" required>
            <option value="bsscd">bsscd</option>
          </select>
        </label>
      </div>
      <div class="form-grid-4">
        <label>Volume *
          <input type="number" id="input-volume-baru" name="volume" min="1" max="999" value="5" required>
        </label>
        <label>Nomor *
          <select id="input-nomor-baru" name="nomor" required>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </label>
        <label>Tahun *
          <input type="number" id="input-tahun-baru" name="tahun" min="2000" max="2100" value="2026" required>
        </label>
        <label>Halaman Awal *
          <input type="number" id="input-halaman-baru" name="halaman_awal" min="1" max="99999" value="1" required>
        </label>
      </div>
      <label>Berkas Naskah Word (.docx) *
        <input type="file" id="input-file-docx" name="docx" accept=".docx" required>
      </label>
      <pre id="log-bangun" class="build-log-box" hidden></pre>
      <div class="modal-aksi">
        <button type="submit" id="btn-submit-bangun" class="btn-primary">🚀 Bangun & Konversi Otomatis (build.py)</button>
      </div>
    </form>
  </div>
</div>

<!-- MODAL 2: METADATA NASKAH LENGKAP -->
<div id="modal-metadata" class="modal-backdrop" hidden>
  <div class="modal-kotak modal-xl">
    <div class="modal-kepala">
      <strong>📝 Edit Metadata Naskah & Riwayat Artikel</strong>
      <button type="button" id="btn-tutup-metadata" class="btn-ikon">✕</button>
    </div>
    <form id="form-metadata" class="meta-form-scroll">
      <label>Judul Artikel
        <textarea id="meta-judul" rows="2"></textarea>
      </label>
      <div class="form-grid-2">
        <label>Daftar Penulis (1 baris per penulis, mis: <code>Nama (1)*</code>)
          <textarea id="meta-penulis" rows="4"></textarea>
        </label>
        <label>Afiliasi (1 baris per nomor afiliasi)
          <textarea id="meta-afiliasi" rows="4"></textarea>
        </label>
      </div>
      <div class="form-grid-3">
        <label>Received (Diterima)
          <input type="text" id="meta-riwayat-diterima" placeholder="mis: 10 January 2026">
        </label>
        <label>Accepted (Disetujui)
          <input type="text" id="meta-riwayat-disetujui" placeholder="mis: 22 February 2026">
        </label>
        <label>Published (Terbit)
          <input type="text" id="meta-riwayat-terbit" placeholder="mis: 01 March 2026">
        </label>
      </div>
      <div class="form-grid-2">
        <label>Email Corresponding Author
          <input type="email" id="meta-email" placeholder="author@university.ac.id">
        </label>
        <label>Kata Kunci / Keywords (pisahkan dengan <code>;</code> atau baris baru)
          <input type="text" id="meta-kata-kunci" placeholder="Keyword 1; Keyword 2; Keyword 3">
        </label>
      </div>
      <label>Abstrak (Abstract)
        <textarea id="meta-abstrak" rows="6"></textarea>
      </label>
      <label>Info Terbitan & Sitasi (Volume, Nomor, Tahun, Halaman, Edisi)
        <textarea id="meta-sitasi" rows="4"></textarea>
      </label>
      <div class="modal-aksi meta-aksi-baris">
        <button type="button" id="btn-batal-metadata" class="btn-outline">Batal</button>
        <button type="submit" class="btn-primary">✓ Simpan Metadata ke Draft Lokal</button>
      </div>
    </form>
  </div>
</div>

<!-- MODAL 3: CROP GAMBAR INTERAKTIF -->
<div id="modal-crop" class="modal-backdrop" hidden>
  <div class="modal-kotak modal-xl">
    <div class="modal-kepala">
      <strong id="judul-modal-crop">✂️ Crop Gambar</strong>
      <button type="button" id="btn-tutup-crop" class="btn-ikon">✕</button>
    </div>
    <p class="crop-hint">Geser kotak atau tarik titik sudut untuk memilih area gambar atau tabel yang dipertahankan. Perubahan tersimpan di Draft Lokal dan dirender ulang otomatis.</p>
    <div class="crop-stage-wrap">
      <div id="crop-stage" class="crop-stage">
        <img id="crop-img" alt="Pratinjau Gambar">
        <div id="crop-rect" class="crop-rect">
          <div class="crop-handle" data-cdir="nw"></div>
          <div class="crop-handle" data-cdir="ne"></div>
          <div class="crop-handle" data-cdir="sw"></div>
          <div class="crop-handle" data-cdir="se"></div>
        </div>
      </div>
    </div>
    <div class="crop-coords-info" id="crop-coords-info">Area: Kiri 0% • Atas 0% • Kanan 0% • Bawah 0%</div>
    <div class="modal-aksi meta-aksi-baris">
      <button type="button" id="btn-reset-crop" class="btn-outline">↺ Reset ke Asli</button>
      <button type="button" id="btn-simpan-crop" class="btn-primary">✓ Terapkan Crop ke Draft</button>
    </div>
  </div>
</div>

<div id="toast-container"></div>
<script src="app.js?v=55"></script>
</body>
</html>
