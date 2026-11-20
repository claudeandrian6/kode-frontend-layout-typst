<?php
/*
 * api.php — Layout Editor (PHP 7.4+).
 * Semua aksi memerlukan login (sesi). Mesin (build.py, qa_cepat.py, typst, data artikel)
 * berada di luar public_html: $CFG['mesin'].
 *
 * FIX-WORKER: API ini TIDAK menjalankan perintah shell sendiri. Semua eksekusi
 * (build.py, qa_cepat.py, impor.py, typst --version, pandoc --version) dikirim ke
 * worker.py lewat Unix socket worker.sock. Dengan begitu api.php tidak memuat
 * fungsi eksekusi proses yang memicu karantina malware hosting.
 */
declare(strict_types=1);
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
      || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $https,
                           'httponly' => true, 'samesite' => 'Strict']);
ini_set('session.use_strict_mode', '1');
session_start();
$CFG = require __DIR__ . '/config.php';
header('X-Content-Type-Options: nosniff');

function jawab($data, int $kode = 200): void {
    http_response_code($kode);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function gagal(string $pesan, int $kode = 400): void {
    jawab(['ok' => false, 'galat' => $pesan], $kode);
}

$aksi = $_GET['aksi'] ?? $_POST['aksi'] ?? $_GET['action'] ?? $_POST['action'] ?? '';

/** Tolak permintaan lintas-asal untuk aksi yang mengubah keadaan (lapisan tambahan SameSite). */
function asal_sah(): bool {
    $o = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($o === '') {
        return true;                       // klien non-browser / same-origin tanpa Origin
    }
    $h = parse_url($o, PHP_URL_HOST);
    $host = preg_replace('/:\d+$/', '', (string)($_SERVER['HTTP_HOST'] ?? ''));
    return is_string($h) && $h !== '' && $host !== '' && strcasecmp($h, $host) === 0;
}
if (in_array($aksi, ['masuk', 'keluar', 'ubah', 'batal', 'bangun', 'impor',
                     'preview_workspace', 'save_workspace', 'insert_block', 'split', 'split_block',
                     'update_page', 'delete_article', 'auto_fix_page', 'undo', 'redo', 'save_layout',
                     'patch_layout'], true) && !asal_sah()) {
    gagal('Asal permintaan tidak sah', 403);
}

/** Berkas .docx / .zip harus diawali tanda tangan ZIP (PK\\x03\\x04). */
function zip_sah(string $path): bool {
    $h = @fopen($path, 'rb');
    if (!$h) {
        return false;
    }
    $sig = fread($h, 4);
    fclose($h);
    return $sig === "PK\x03\x04";
}

// ---------- login ----------
if ($aksi === 'masuk') {
    $sandi = (string)($_POST['sandi'] ?? '');
    if (!password_verify($sandi, $CFG['sandi_hash'])) {
        sleep(1);
        gagal('Kata sandi salah', 403);
    }
    session_regenerate_id(true);
    $_SESSION['masuk'] = true;
    jawab(['ok' => true]);
}
if ($aksi === 'keluar') {
    $_SESSION = [];
    session_destroy();
    jawab(['ok' => true]);
}
if (empty($_SESSION['masuk'])) {
    gagal('Belum masuk', 401);
}

// Aksi pengubah keadaan hanya boleh lewat POST.
$post_wajib = ['preview_workspace', 'save_workspace', 'insert_block', 'split', 'split_block',
               'update_page', 'delete_article', 'auto_fix_page', 'undo', 'redo', 'save_layout',
               'patch_layout'];
if (in_array($aksi, $post_wajib, true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    gagal('Metode tidak sah', 405);
}

$MESIN = rtrim($CFG['mesin'], '/');
$KERJA = $MESIN . '/kerja';

function nama_aman(string $s): string {
    if (!preg_match('/^[A-Za-z0-9_\-]{1,120}$/', $s)) {
        gagal('Nama artikel tidak sah');
    }
    return $s;
}

function folder_artikel(string $nama): string {
    global $KERJA;
    $d = $KERJA . '/' . nama_aman($nama);
    if (!is_file($d . '/main.typ') || !is_file($d . '/body.typ')) {
        gagal('Artikel tidak ditemukan', 404);
    }
    return $d;
}

/** Kirim satu permintaan JSON ke worker.py lewat Unix socket. Hasil [kode, stdout, stderr]. */
function worker(array $permintaan, int $batas = 600): array {
    global $CFG, $MESIN;
    $sock = (string)($CFG['worker_socket'] ?? ($MESIN . '/worker.sock'));
    $errno = 0;
    $errstr = '';
    $c = @stream_socket_client('unix://' . $sock, $errno, $errstr, 5);
    if (!$c) {
        return [503, '', 'Worker Layout Editor tidak berjalan (' . $errstr . '). '
                       . 'Jalankan sudo systemctl start typst-worker lewat SSH.'];
    }
    stream_set_timeout($c, max(1, $batas + 30));
    $permintaan['timeout'] = $batas;
    if (@fwrite($c, json_encode($permintaan, JSON_UNESCAPED_UNICODE) . "\n") === false) {
        fclose($c);
        return [502, '', 'Gagal mengirim permintaan ke worker'];
    }
    $out = '';
    while (!feof($c)) {
        $bagian = fread($c, 65536);
        if ($bagian === false) {
            break;
        }
        $out .= $bagian;
        if (strpos($out, "\n") !== false || strlen($out) > 16 * 1024 * 1024) {
            break;
        }
    }
    fclose($c);
    $j = json_decode(trim($out), true);
    if (!is_array($j)) {
        return [502, '', 'Balasan worker tidak sah'];
    }
    return [(int)($j['kode'] ?? 500), (string)($j['out'] ?? ''), (string)($j['err'] ?? '')];
}

/** Jalankan perintah yang diizinkan worker secara sinkron. Hasil [kode, stdout, stderr]. */
function jalankan(array $argv, string $cwd, int $batas = 600): array {
    return worker(['aksi' => 'jalan', 'argv' => array_values($argv), 'cwd' => $cwd,
                   'timeout' => $batas], $batas + 15);
}

/** Jalankan job build di latar belakang lewat worker. Hasil: 'worker' atau ''. */
function luncurkan(string $job): string {
    global $CFG, $MESIN;
    [$kode] = worker(['aksi' => 'latar',
                      'argv' => [$CFG['python'], $MESIN . '/jalankan_build.py', $job],
                      'cwd' => $MESIN, 'timeout' => 30], 35);
    return $kode === 0 ? 'worker' : '';
}

/** Jalankan satu aksi editor_blok.py lewat worker; job JSON ditulis di folder artikel. */
function editor_aksi(string $aksi, string $folder, $data = null, int $batas = 600): array {
    global $CFG, $MESIN;
    $argv = [$CFG['python'], $MESIN . '/editor_blok.py', $aksi, $folder];
    $job = null;
    if ($data !== null) {
        $job = $folder . '/.job-' . bin2hex(random_bytes(6)) . '.json';
        $isi = json_encode($data, JSON_UNESCAPED_UNICODE);
        if ($isi === false || file_put_contents($job, $isi) === false) {
            gagal('Gagal menyiapkan job editor', 500);
        }
        $argv[] = '--json';
        $argv[] = $job;
    }
    [$kode, $out, $err] = jalankan($argv, $MESIN, $batas);
    if ($job !== null) {
        @unlink($job);
    }
    $j = json_decode($out, true);
    if (!is_array($j)) {
        gagal("Editor gagal (kode $kode):\n" . substr($err . $out, -2500), 500);
    }
    return $j;
}

/** edits/moves/deletes dari app.js berupa string JSON. */
function daftar_post(string $k): array {
    $v = $_POST[$k] ?? [];
    if (is_string($v)) {
        $j = json_decode($v, true);
        return is_array($j) ? $j : [];
    }
    return is_array($v) ? $v : [];
}

/** Kunci per artikel agar dua perubahan tidak berjalan bersamaan. */
function kunci(string $folder) {
    $h = fopen($folder . '/.kunci', 'c');
    if (!$h || !flock($h, LOCK_EX)) {
        gagal('Artikel sedang diproses, coba lagi', 409);
    }
    return $h;
}

/** Jalankan qa_cepat.py -> keadaan artikel (JSON). */
function keadaan(string $folder, bool $gambar = true): array {
    global $CFG, $MESIN;
    $argv = [$CFG['python'], $MESIN . '/qa_cepat.py', $folder, '--ppi', (string)($CFG['ppi'] ?? 80)];
    if (!$gambar) {
        $argv[] = '--tanpa-gambar';
    }
    [$kode, $out, $err] = jalankan($argv, $MESIN, 300);
    $data = json_decode($out, true);
    if (!is_array($data)) {
        gagal("Mesin gagal (kode $kode):\n" . substr($err . $out, -2500), 500);
    }
    $data['versi'] = (string)@filemtime($folder . '/hasil.pdf');
    $data['riwayat'] = count(glob($folder . '/_riwayat/*.typ') ?: []);
    return $data;
}

function simpan_riwayat(string $folder, string $body): void {
    $d = $folder . '/_riwayat';
    if (!is_dir($d)) {
        mkdir($d, 0700, true);
    }
    file_put_contents($d . '/' . sprintf('%.6f', microtime(true)) . '.typ', $body);
    $semua = glob($d . '/*.typ') ?: [];
    sort($semua);
    while (count($semua) > 60) {            // simpan maks. 60 langkah batal
        @unlink(array_shift($semua));
    }
}

// ---------- operasi pada body.typ ----------
/** Pola baris yang diawali penanda paragraf #pm(n) (narasi, judul, referensi, lanjutan). */
function pola_pm(int $n): string {
    return '/^(?:=+ |#referensi(?:\([^)]*\))?\[|#butir\([^)]*\)\[|#wawancara\[|#label-gantung\([^)]*\)\[)?#pm\(' . $n . '\);/m';
}

function ubah_body(string $body, string $op, array $a): string {
    switch ($op) {
        case 'skala': {                       // ukuran gambar (0.50 - 1.30)
            $n = (int)($a['nomor'] ?? 0);
            $v = (float)($a['nilai'] ?? 1);
            if ($v < 0.5 || $v > 1.3) gagal('Skala harus 0,50 - 1,30');
            $pola = '/^(#gambar\([^\n]*?nomor: ' . $n . ',[^\n]*)$/m';
            if (!preg_match($pola, $body, $m)) gagal('Gambar tidak ditemukan (tabel tidak dapat diubah ukurannya)');
            $baris = $m[1];
            $baris = preg_replace('/, skala: [\d.]+/', '', $baris);
            if (abs($v - 1.0) > 0.0005) {
                $baris = preg_replace('/(keputusan: "\w+")/', '$1, skala: ' . sprintf('%.3f', $v), $baris, 1);
            }
            return str_replace($m[1], $baris, $body);
        }
        case 'posisi': {                      // tempat | atas | bawah | apung
            $n = (int)($a['nomor'] ?? 0);
            $k = (string)($a['nilai'] ?? '');
            if (!in_array($k, ['tempat', 'atas', 'bawah', 'apung'], true)) gagal('Posisi tidak sah');
            $pola = '/^(#(?:gambar|tabel)\([^\n]*?keputusan: ")\w+("[^\n]*?nomor: ' . $n . ',)/m';
            if (!preg_match($pola, $body)) gagal('Objek tidak ditemukan');
            return preg_replace($pola, '${1}' . $k . '${2}', $body, 1);
        }
        case 'pindah_kolom': {                // sisip / hapus #colbreak() sebelum paragraf n
            $n = (int)($a['pm'] ?? 0);
            if (!preg_match(pola_pm($n), $body, $m, PREG_OFFSET_CAPTURE)) gagal('Paragraf tidak ditemukan');
            $i = $m[0][1];
            $sebelum = substr($body, 0, $i);
            if (substr($sebelum, -13) === "#colbreak()\n\n") {
                return substr($sebelum, 0, -13) . substr($body, $i);
            }
            return $sebelum . "#colbreak()\n\n" . substr($body, $i);
        }
        case 'kaki': {                        // footer naik pada halaman fisik h (0 = normal)
            $h = (int)($a['hal'] ?? 0);
            $naik = max(0, min(5, (int)($a['baris'] ?? 0))) * 11;
            $body = preg_replace('/^#kaki-naik\(' . $h . ', [\d.]+pt\)\n/m', '', $body);
            if ($naik > 0) {
                $kepala = "#import \"/template_jurnal.typ\": *\n";
                if (strpos($body, $kepala) !== 0) gagal('Kepala body.typ tidak dikenal');
                $body = $kepala . "#kaki-naik($h, {$naik}.0pt)\n" . substr($body, strlen($kepala));
            }
            return $body;
        }
        case 'teks': {                        // ganti isi baris sumber paragraf n
            $n = (int)($a['pm'] ?? 0);
            $baru = str_replace(["\r\n", "\r"], "\n", (string)($a['isi'] ?? ''));
            if (strpos($baru, "\n") !== false) gagal('Isi paragraf harus satu baris');
            if (preg_match('/#(?:read|include|import|plugin|sys|eval)\s*[\(\[]/i', $baru)) {
                gagal('Teks tidak boleh memuat perintah Typst #read/#include/#import');
            }
            if (strpos($baru, "#pm($n);") === false) gagal("Penanda #pm($n); tidak boleh dihapus");
            if (!preg_match(pola_pm($n), $body, $m, PREG_OFFSET_CAPTURE)) gagal('Paragraf tidak ditemukan');
            $i = $m[0][1];
            $j = strpos($body, "\n", $i);
            if ($j === false) $j = strlen($body);
            return substr($body, 0, $i) . $baru . substr($body, $j);
        }
    }
    gagal('Operasi tidak dikenal');
    return $body;
}

/** Proses dengan PID ini masih berjalan? */
function proses_hidup(string $pid): bool {
    if (!ctype_digit($pid)) return false;
    if (function_exists('posix_kill')) return @posix_kill((int)$pid, 0);
    return is_dir('/proc/' . $pid);
}

/** Pesan yang jelas untuk unggahan yang gagal (batas ukuran PHP, dll.). */
function galat_unggah(string $kunci): string {
    $e = $_FILES[$kunci]['error'] ?? UPLOAD_ERR_NO_FILE;
    if ($e === UPLOAD_ERR_INI_SIZE || $e === UPLOAD_ERR_FORM_SIZE || (empty($_FILES) && !empty($_SERVER['CONTENT_LENGTH']))) {
        return 'Berkas terlalu besar (batas server upload_max_filesize = ' . ini_get('upload_max_filesize')
             . ', post_max_size = ' . ini_get('post_max_size') . ')';
    }
    return 'Berkas tidak diterima (kode ' . $e . ')';
}

// ---------- aksi ----------
switch ($aksi) {
    case 'cek': {                             // diagnostik pemasangan
        [$kode_w, $out_w, $err_w] = worker(['aksi' => 'versi'], 90);
        $versi = json_decode($out_w, true);
        if (!is_array($versi)) {
            $versi = [];
        }
        $hasil = ['worker' => $kode_w === 0,
                  'worker_galat' => $kode_w === 0 ? '' : ($err_w ?: 'worker tidak menjawab'),
                  'php' => PHP_VERSION, 'mesin_ada' => is_dir($MESIN),
                  'upload_max_filesize' => ini_get('upload_max_filesize'),
                  'post_max_size' => ini_get('post_max_size'),
                  'max_execution_time' => ini_get('max_execution_time')];
        $hasil['python'] = $versi['python'] ?? '';
        $hasil['typst'] = $versi['typst'] ?? '';
        $hasil['pandoc'] = strtok((string)($versi['pandoc'] ?? ''), "\n");
        $hasil['berkas'] = [];
        foreach (['build.py', 'qa_cepat.py', 'impor.py', 'template_jurnal.typ', 'fonts', 'jurnal', 'kerja'] as $b) {
            $hasil['berkas'][$b] = file_exists($MESIN . '/' . $b);
        }
        jawab(['ok' => true, 'cek' => $hasil]);
    }
    case 'daftar': {
        $hasil = [];
        foreach (glob($KERJA . '/*/main.typ') ?: [] as $f) {
            $d = dirname($f);
            $nama = basename($d);
            $qa = glob($d . '/*.qa.json');
            $status = '';
            if ($qa) {
                $j = json_decode((string)file_get_contents($qa[0]), true);
                $status = $j['status'] ?? '';
            }
            $hasil[] = ['nama' => $nama, 'diubah' => filemtime($d . '/body.typ'), 'status' => $status,
                        'membangun' => is_file($MESIN . '/unggah/' . $nama . '.membangun')];
        }
        usort($hasil, function ($a, $b) { return $b['diubah'] <=> $a['diubah']; });
        $jurnal = array_map('basename', glob($MESIN . '/jurnal/*', GLOB_ONLYDIR) ?: []);
        jawab(['ok' => true, 'artikel' => $hasil, 'jurnal' => $jurnal]);
    }
    case 'muat': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $h = kunci($d);
        $k = keadaan($d);
        flock($h, LOCK_UN);
        jawab($k);
    }
    case 'halaman': {                         // gambar PNG satu halaman
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $p = (int)($_GET['p'] ?? 1);
        $f = $d . '/_pratinjau/hal-' . $p . '.png';
        if (!is_file($f)) gagal('Halaman tidak ada', 404);
        header('Content-Type: image/png');
        header('Cache-Control: private, max-age=86400');
        readfile($f);
        exit;
    }
    case 'sumber': {                          // baris sumber satu paragraf (untuk edit teks)
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $n = (int)($_GET['pm'] ?? 0);
        $body = (string)file_get_contents($d . '/body.typ');
        if (!preg_match(pola_pm($n), $body, $m, PREG_OFFSET_CAPTURE)) gagal('Paragraf tidak ditemukan');
        $i = $m[0][1];
        $j = strpos($body, "\n", $i);
        jawab(['ok' => true, 'isi' => substr($body, $i, ($j === false ? strlen($body) : $j) - $i)]);
    }
    case 'ubah': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $h = kunci($d);
        $body = (string)file_get_contents($d . '/body.typ');
        $baru = ubah_body($body, (string)($_POST['op'] ?? ''), $_POST);
        if ($baru === $body) {
            flock($h, LOCK_UN);
            jawab(keadaan($d));
        }
        simpan_riwayat($d, $body);
        file_put_contents($d . '/body.typ', $baru);
        $k = keadaan($d);
        if (empty($k['ok'])) {                // kompilasi gagal -> kembalikan
            file_put_contents($d . '/body.typ', $body);
            $f = glob($d . '/_riwayat/*.typ') ?: [];
            sort($f);
            @unlink((string)end($f));
            flock($h, LOCK_UN);
            gagal("Perubahan ditolak Typst:\n" . ($k['galat'] ?? ''), 422);
        }
        flock($h, LOCK_UN);
        jawab($k);
    }
    case 'batal': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $h = kunci($d);
        $f = glob($d . '/_riwayat/*.typ') ?: [];
        sort($f);
        if (!$f) {
            flock($h, LOCK_UN);
            gagal('Tidak ada langkah untuk dibatalkan');
        }
        $akhir = (string)end($f);
        copy($akhir, $d . '/body.typ');
        unlink($akhir);
        $k = keadaan($d);
        flock($h, LOCK_UN);
        jawab($k);
    }
    case 'pdf': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $f = $d . '/hasil.pdf';
        if (!is_file($f)) gagal('PDF belum ada', 404);
        header('Content-Type: application/pdf');
        header('Content-Disposition: attachment; filename="' . basename($d) . '.pdf"');
        readfile($f);
        exit;
    }
    case 'get_workspace': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $h = kunci($d);
        $j = editor_aksi('workspace', $d, null, 600);
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'preview_workspace': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $data = ['edits' => daftar_post('edits'), 'moves' => daftar_post('moves'),
                 'deletes' => daftar_post('deletes')];
        $h = kunci($d);
        $j = editor_aksi('preview', $d, $data, 600);
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'save_workspace': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $data = ['edits' => daftar_post('edits'), 'moves' => daftar_post('moves'),
                 'deletes' => daftar_post('deletes'), 'crops' => daftar_post('crops'),
                 'splits' => daftar_post('splits')];
        $kaki_map = daftar_post('kaki_naik');
        if (!empty($kaki_map) && is_array($kaki_map)) {
            $data['kaki_naik'] = $kaki_map;
        }
        $header_map = daftar_post('header_naik');
        if (!empty($header_map) && is_array($header_map)) {
            $data['header_naik'] = $header_map;
        }
        if (isset($_POST['header_shift']) && $_POST['header_shift'] !== '') {
            $data['header_shift'] = (int)$_POST['header_shift'];
        }
        if (isset($_POST['footer_shift']) && $_POST['footer_shift'] !== '') {
            $data['footer_shift'] = (int)$_POST['footer_shift'];
        }
        $h = kunci($d);
        $j = editor_aksi('save', $d, $data, 600);
        if (!empty($j['ok'])) {
            $qa_res = keadaan($d, false);
            $j['qa'] = [
                'status' => $qa_res['status'] ?? (($qa_res['masalah'] ?? []) ? 'DITAHAN' : 'LULUS'),
                'masalah' => $qa_res['masalah'] ?? [],
                'catatan' => $qa_res['catatan'] ?? [],
                'kolom' => $qa_res['kolom'] ?? [],
                'kaki_naik' => $qa_res['kaki_naik'] ?? [],
            ];
            $j['versi'] = (string)@filemtime($d . '/hasil.pdf') . '-' . time();
            if (!isset($j['kaki_naik']) || !is_array($j['kaki_naik'])) { $j['kaki_naik'] = $qa_res['kaki_naik'] ?? []; }
        }
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'split':
    case 'split_block':
    case 'insert_block': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $h = kunci($d);
        $insert_data = [
            'block_id' => (string)($_POST['block_id'] ?? $_POST['after_id'] ?? ''),
            'after_id' => (string)($_POST['after_id'] ?? $_POST['block_id'] ?? ''),
            'text' => (string)($_POST['text'] ?? ''),
            'text_before' => (string)($_POST['text_before'] ?? ''),
            'text_after' => (string)($_POST['text_after'] ?? ''),
            'colbreak' => filter_var($_POST['colbreak'] ?? false, FILTER_VALIDATE_BOOLEAN),
        ];
        if (isset($_POST['split_ratio']) && $_POST['split_ratio'] !== '') {
            $insert_data['split_ratio'] = (float)$_POST['split_ratio'];
        }
        if (isset($_POST['split_offset']) && $_POST['split_offset'] !== '') {
            $insert_data['split_offset'] = (int)$_POST['split_offset'];
        }
        if (isset($_POST['frozen']) && $_POST['frozen'] !== '') {
            $insert_data['frozen'] = filter_var($_POST['frozen'], FILTER_VALIDATE_BOOLEAN);
        }
        $j = editor_aksi('insert', $d, $insert_data);
        if (!empty($j['ok'])) {
            $qa_res = keadaan($d, false);
            $j['qa'] = [
                'status' => $qa_res['status'] ?? (($qa_res['masalah'] ?? []) ? 'DITAHAN' : 'LULUS'),
                'masalah' => $qa_res['masalah'] ?? [],
                'catatan' => $qa_res['catatan'] ?? [],
                'kolom' => $qa_res['kolom'] ?? [],
                'kaki_naik' => $qa_res['kaki_naik'] ?? [],
            ];
            $j['versi'] = (string)@filemtime($d . '/hasil.pdf') . '-' . time();
            if (!isset($j['kaki_naik']) || !is_array($j['kaki_naik'])) { $j['kaki_naik'] = $qa_res['kaki_naik'] ?? []; }
        }
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'update_page': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $h = kunci($d);
        $page_data = [
            'hal' => (int)($_POST['hal'] ?? 0),
            'baris' => (isset($_POST['baris']) && $_POST['baris'] !== '') ? (int)$_POST['baris'] : null,
            'header_baris' => (isset($_POST['header_baris']) && $_POST['header_baris'] !== '') ? (int)$_POST['header_baris'] : null,
        ];
        if (isset($_POST['header_shift']) && $_POST['header_shift'] !== '') {
            $page_data['header_shift'] = (int)$_POST['header_shift'];
        }
        if (isset($_POST['footer_shift']) && $_POST['footer_shift'] !== '') {
            $page_data['footer_shift'] = (int)$_POST['footer_shift'];
        }
        $j = editor_aksi('page', $d, $page_data);
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'get_qa': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        jawab(editor_aksi('qa', $d, ['paksa' => !empty($_GET['paksa'])]));
    }
    case 'auto_fix_page': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $kol = isset($_POST['kol']) && (string)$_POST['kol'] !== '' ? (int)$_POST['kol'] : null;
        $h = kunci($d);
        $j = editor_aksi('auto_fix', $d, ['hal' => (int)($_POST['hal'] ?? 0), 'kol' => $kol], 600);
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'undo':
    case 'redo': {
        $d = folder_artikel((string)($_POST['artikel'] ?? ''));
        $h = kunci($d);
        $j = editor_aksi($aksi, $d);
        if (!empty($j['ok'])) {
            $qa_res = keadaan($d, false);
            $j['qa'] = [
                'status' => $qa_res['status'] ?? (($qa_res['masalah'] ?? []) ? 'DITAHAN' : 'LULUS'),
                'masalah' => $qa_res['masalah'] ?? [],
                'catatan' => $qa_res['catatan'] ?? [],
                'kolom' => $qa_res['kolom'] ?? [],
                'kaki_naik' => $qa_res['kaki_naik'] ?? [],
            ];
            $j['versi'] = (string)@filemtime($d . '/hasil.pdf') . '-' . time();
            if (!isset($j['kaki_naik']) || !is_array($j['kaki_naik'])) { $j['kaki_naik'] = $qa_res['kaki_naik'] ?? []; }
        }
        flock($h, LOCK_UN);
        jawab($j);
    }
    case 'media_gambar': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $nomor = (int)($_GET['nomor'] ?? 0);
        $body = (string)@file_get_contents($d . '/body.typ');
        if (!preg_match('/^#gambar\("([^"]+)"[^\n]*?\bnomor:\s*' . $nomor . '\b/m', $body, $m)) {
            gagal('Gambar tidak ditemukan', 404);
        }
        $rel = ltrim($m[1], '/');
        $full = realpath($MESIN . '/' . $rel);
        $akar = realpath($d);
        if ($full === false || $akar === false || strpos($full, $akar . DIRECTORY_SEPARATOR) !== 0 || !is_file($full)) {
            gagal('Berkas gambar tidak sah', 404);
        }
        $asli_kandidat = $full . '.asli';
        if (is_file($asli_kandidat) && !empty($_GET['asli'])) {
            $full = $asli_kandidat;
        }
        $ext = strtolower(pathinfo($m[1], PATHINFO_EXTENSION));
        $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp'][$ext] ?? 'application/octet-stream';
        header('Content-Type: ' . $mime);
        header('Cache-Control: no-store');
        readfile($full);
        exit;
    }
    case 'delete_article': {
        $nama = nama_aman((string)($_POST['article_id'] ?? ''));
        $d = $KERJA . '/' . $nama;
        if (!is_dir($d)) gagal('Artikel tidak ditemukan', 404);
        if (is_file($MESIN . '/unggah/' . $nama . '.membangun')) {
            gagal('Artikel sedang dibangun', 409);
        }
        $terhapus = $KERJA . '/_terhapus';
        if (!is_dir($terhapus)) mkdir($terhapus, 0700, true);
        $tujuan = $terhapus . '/' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '-' . $nama;
        if (!rename($d, $tujuan)) gagal('Gagal menghapus artikel', 500);
        jawab(['ok' => true, 'message' => 'Artikel ' . $nama . ' dihapus']);
    }
    case 'svg':
    case 'svg_preview': {
        $d = folder_artikel((string)($_GET['artikel'] ?? ''));
        $p = (int)($_GET['p'] ?? 0);
        if ($p < 1 || $p > 10000) gagal('Halaman tidak sah', 400);
        $sub = $aksi === 'svg' ? '_svg' : '_pratinjau_editor';
        $f = $d . '/' . $sub . '/hal-' . $p . '.svg';
        if (!is_file($f)) gagal('Halaman tidak ada', 404);
        header('Content-Type: image/svg+xml; charset=utf-8');
        header('Cache-Control: private, max-age=86400');
        readfile($f);
        exit;
    }
    case 'bangun': {                          // unggah .docx -> build.py di latar belakang
        if (empty($_FILES['docx']) || $_FILES['docx']['error'] !== UPLOAD_ERR_OK) gagal(galat_unggah('docx'));
        $asli = (string)$_FILES['docx']['name'];
        if (!preg_match('/\.docx$/i', $asli)) gagal('Harus berkas .docx');
        $id_kustom = trim((string)($_POST['id'] ?? ''));
        $dasar_nama = $id_kustom !== '' ? $id_kustom : pathinfo($asli, PATHINFO_FILENAME);
        $nama = trim((string)preg_replace('/[^A-Za-z0-9_\-]+/', '_', $dasar_nama), '_');
        if ($nama === '') $nama = 'artikel_' . date('His');
        $jurnal = (string)($_POST['jurnal'] ?? '');
        if (!preg_match('/^[A-Za-z0-9_\-]+$/', $jurnal) || !is_dir($MESIN . '/jurnal/' . $jurnal)) gagal('Jurnal tidak dikenal');
        $angka = [];
        foreach (['volume', 'nomor', 'tahun', 'halaman_awal'] as $k) {
            $v = (string)($_POST[$k] ?? '');
            if (!ctype_digit($v)) gagal("Isian $k harus angka");
            $angka[$k] = $v;
        }
        $unggah = $MESIN . '/unggah';
        if (!is_dir($unggah)) mkdir($unggah, 0700, true);
        $tanda = $unggah . '/' . $nama . '.membangun';
        if (is_file($tanda) && proses_hidup((string)file_get_contents($tanda))) gagal('Artikel ini sedang dibangun', 409);
        $docx = $unggah . '/' . $nama . '.docx';
        move_uploaded_file($_FILES['docx']['tmp_name'], $docx);
        if (!is_file($docx) || filesize($docx) < 4 || filesize($docx) > 64 * 1024 * 1024
                || !zip_sah($docx)) {
            @unlink($docx);
            gagal('Berkas .docx tidak sah');
        }
        if (class_exists('ZipArchive')) {
            $z = new ZipArchive();
            if ($z->open($docx) !== true) {
                @unlink($docx);
                gagal('Berkas .docx tidak dapat dibuka');
            }
            if ($z->locateName('word/document.xml') === false) {
                $z->close();
                @unlink($docx);
                gagal('Berkas .docx tidak berisi word/document.xml');
            }
            $z->close();
        }
        $log = $unggah . '/' . $nama . '.log';
        $job = $unggah . '/' . $nama . '.job.json';
        // Normalisasi struktur naskah (normalisasi.php) langsung di PHP web; naskah asli disimpan
        // sebagai <nama>.asli.docx. Bila gagal, build.py mencoba sendiri lewat PHP CLI.
        $catatan = '';
        $tanpa_norm = [];
        $norm = $MESIN . '/normalisasi.php';
        if (is_file($norm)) {
            require_once $norm;
            $asli_docx = $unggah . '/' . $nama . '.asli.docx';
            copy($docx, $asli_docx);
            $lap = normalisasi_docx($asli_docx, $docx);
            if (!empty($lap['ok'])) {
                $tanpa_norm = ['--tanpa-normalisasi'];
                $catatan = 'Normalisasi naskah: ' . ($lap['perubahan'] ? count($lap['perubahan']) . ' perubahan' : 'naskah sudah rapi') . "\n";
                foreach ($lap['perubahan'] as $ub) $catatan .= '   - ' . $ub['jenis'] . ($ub['teks'] !== '' ? ': ' . $ub['teks'] : '') . "\n";
                foreach ($lap['peringatan'] as $ub) $catatan .= '   ! ' . $ub . "\n";
                if (!empty($lap['rapor'])) {
                    $catatan .= "Rapor kesesuaian dengan profil naskah ideal:\n";
                    foreach ($lap['rapor'] as $ub) {
                        $catatan .= '   [' . strtoupper($ub['status']) . '] ' . $ub['bagian'] . ($ub['catatan'] !== '' ? ': ' . $ub['catatan'] : '') . "\n";
                    }
                }
            } else {
                copy($asli_docx, $docx);
                $catatan = 'Normalisasi di PHP web gagal (' . ($lap['galat'] ?? '?') . "), dicoba oleh build.py\n";
            }
        }
        $argv = array_merge([$CFG['python'], '-u', $MESIN . '/build.py', $docx, '--jurnal', $jurnal, '--volume', $angka['volume'],
                 '--nomor', $angka['nomor'], '--tahun', $angka['tahun'], '--halaman-awal', $angka['halaman_awal'],
                 '--verbose'], $tanpa_norm);
        $env = array_merge(['TYPST_BIN' => 'typst', 'PANDOC_BIN' => 'pandoc',
                            'PYTHONUNBUFFERED' => '1', 'LANG' => 'C.UTF-8'], $CFG['env'] ?? []);
        $pekerjaan = ['argv' => $argv, 'cwd' => $MESIN, 'env' => $env, 'tanda' => $tanda, 'log' => $log];
        $isi_job = json_encode($pekerjaan, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($isi_job === false || file_put_contents($job, $isi_job) === false) {
            @unlink($tanda);
            gagal('Gagal menyiapkan job build');
        }
        if (file_put_contents($log, '[' . date('H:i:s') . '] Naskah diterima: ' . $asli . ' ('
                . round(filesize($docx) / 1048576, 1) . " MB)\n" . $catatan
                . "Menjalankan build.py di latar belakang…\n") === false) {
            @unlink($tanda);
            gagal('Gagal menulis log build');
        }
        if (file_put_contents($tanda, 'mulai') === false) {
            gagal('Gagal menandai build');
        }
        $cara = luncurkan($job);
        if ($cara === '') {
            @unlink($tanda);
            file_put_contents($log, "!! Worker Layout Editor tidak berjalan.\n"
                . "Jalankan lewat SSH:\n  sudo systemctl start typst-worker\n"
                . "atau jalankan build manual:\n  " . $CFG['python'] . ' -u ' . $MESIN
                . '/jalankan_build.py ' . $job . "\n", FILE_APPEND);
        }
        jawab(['ok' => true, 'nama' => $nama, 'cara' => $cara]);
    }
    case 'log': {                             // kemajuan build.py
        $nama = nama_aman((string)($_GET['nama'] ?? ''));
        $log = $MESIN . '/unggah/' . $nama . '.log';
        $tanda = $MESIN . '/unggah/' . $nama . '.membangun';
        $isi = is_file($log) ? (string)file_get_contents($log) : '';
        $berjalan = false;
        $gagal = false;
        if (is_file($tanda)) {
            $pid = trim((string)file_get_contents($tanda));
            if ($pid === 'mulai') {           // launcher belum menulis PID
                $berjalan = time() - (int)filemtime($tanda) < 30;
                if (!$berjalan) {
                    $isi .= "\n!! build.py tidak mulai dalam 30 detik — worker Layout Editor belum berjalan.\n"
                          . "Jalankan lewat SSH:\n  sudo systemctl start typst-worker\n";
                }
            } elseif (proses_hidup($pid)) {
                $berjalan = true;
            } else {
                $isi .= "\n!! Proses build.py (PID $pid) berhenti sebelum selesai — kemungkinan dihentikan batas"
                      . " CPU/waktu server.\nJalankan ulang setelah memastikan worker aktif:\n"
                      . "  sudo systemctl start typst-worker\n"
                      . "atau bangun di komputer lokal lalu impor zip folder kerja\\$nama.\n";
            }
            $gagal = !$berjalan;
        } elseif (!preg_match('/== SELESAI \(kode [02]\)/', $isi)) {   // 2 = selesai, QA DITAHAN
            $gagal = $isi !== '';
            if (preg_match('/== SELESAI \(kode (137|143|152)\)/', $isi)) {
                $isi .= "\n!! build.py dihentikan server (batas CPU/memori/waktu). Jalankan lewat SSH:\n"
                      . "  sudo systemctl start typst-worker\n"
                      . "atau bangun di komputer lokal lalu impor zip folder kerja\\$nama.\n";
            }
        }
        $baris = array_slice(explode("\n", rtrim($isi)), -200);
        jawab(['ok' => true, 'selesai' => !$berjalan, 'gagal' => $gagal,
               'artikel_ada' => is_file($KERJA . '/' . $nama . '/main.typ'), 'log' => implode("\n", $baris)]);
    }
    case 'impor': {                           // zip folder kerja/<nama> hasil build.py di komputer lokal
        if (empty($_FILES['zip']) || $_FILES['zip']['error'] !== UPLOAD_ERR_OK) gagal(galat_unggah('zip'));
        if (!preg_match('/\.zip$/i', (string)$_FILES['zip']['name'])) gagal('Harus berkas .zip');
        $unggah = $MESIN . '/unggah';
        if (!is_dir($unggah)) mkdir($unggah, 0700, true);
        $zip = $unggah . '/impor-' . bin2hex(random_bytes(6)) . '.zip';
        move_uploaded_file($_FILES['zip']['tmp_name'], $zip);
        if (!is_file($zip) || filesize($zip) < 4 || filesize($zip) > 64 * 1024 * 1024
                || !zip_sah($zip)) {
            @unlink($zip);
            gagal('Berkas zip tidak sah');
        }
        $argv = [$CFG['python'], $MESIN . '/impor.py', $zip];
        if (!empty($_POST['timpa'])) $argv[] = '--timpa';
        [$kode, $out, $err] = jalankan($argv, $MESIN, 120);
        @unlink($zip);
        $j = json_decode($out, true);
        if (!is_array($j)) gagal("Impor gagal (kode $kode):\n" . substr($err . $out, -2000), 500);
        if (empty($j['ok'])) jawab($j + ['ok' => false], !empty($j['ada']) ? 409 : 400);
        jawab($j);
    }
    case 'get_content': {
        $id = (string)($_GET['id'] ?? $_GET['artikel'] ?? '');
        $d = folder_artikel($id);
        if (is_file($d . '/content.json')) {
            jawab(json_decode((string)file_get_contents($d . '/content.json'), true));
        }

        if (!is_file($d . '/dokumen.json')) {
            $h = kunci($d);
            editor_aksi('workspace', $d, null, 120);
            flock($h, LOCK_UN);
        }

        $mainTyp = is_file($d . '/main.typ') ? (string)file_get_contents($d . '/main.typ') : '';
        $jurnalId = 'bsscd';
        if (preg_match('#/jurnal/([^/]+)/config\.json#', $mainTyp, $mJ)) {
            $jurnalId = $mJ[1];
        }
        $jurnalCfgPath = $MESIN . '/jurnal/' . $jurnalId . '/config.json';
        $jurnalCfg = is_file($jurnalCfgPath) ? json_decode((string)file_get_contents($jurnalCfgPath), true) : [];
        $journal = [
            'id' => $jurnalCfg['id'] ?? $jurnalId,
            'name' => $jurnalCfg['nama_lengkap'] ?? $jurnalCfg['name'] ?? '',
            'shortHeader' => $jurnalCfg['singkatan_header'] ?? $jurnalCfg['shortHeader'] ?? '',
            'issn' => $jurnalCfg['issn'] ?? '',
            'doiPrefix' => $jurnalCfg['doi_prefix'] ?? $jurnalCfg['doiPrefix'] ?? '',
        ];

        $metaRaw = is_file($d . '/meta.json') ? json_decode((string)file_get_contents($d . '/meta.json'), true) : [];
        $authors = [];
        if (isset($metaRaw['penulis']) && is_array($metaRaw['penulis'])) {
            foreach ($metaRaw['penulis'] as $pen) {
                $n = trim((string)($pen['nama'] ?? ''));
                $af = trim((string)($pen['afiliasi'] ?? ''));
                $kor = !empty($pen['korespondensi']);
                $part = $n;
                if ($af !== '') $part .= ' (' . $af . ')';
                if ($kor) $part .= '*';
                if ($part !== '') $authors[] = $part;
            }
        }
        $affils = [];
        if (isset($metaRaw['afiliasi']) && is_array($metaRaw['afiliasi'])) {
            $affils = array_values(array_filter(array_map('trim', $metaRaw['afiliasi'])));
        }
        $keywords = [];
        if (isset($metaRaw['kata_kunci']) && is_array($metaRaw['kata_kunci'])) {
            $keywords = array_values(array_filter(array_map('trim', $metaRaw['kata_kunci'])));
        }

        $riwayat = $metaRaw['riwayat'] ?? [];
        $terbitan = $metaRaw['terbitan'] ?? [];

        $meta = [
            'title' => (string)($metaRaw['judul'] ?? $metaRaw['title'] ?? ''),
            'authors' => $authors ? implode(', ', $authors) : (string)($metaRaw['penulis'] ?? ''),
            'affiliations' => $affils ? implode("\n", $affils) : (string)($metaRaw['afiliasi'] ?? ''),
            'abstract' => (string)($metaRaw['abstrak'] ?? $metaRaw['abstract'] ?? ''),
            'keywords' => $keywords ? implode('; ', $keywords) : (string)($metaRaw['kata_kunci'] ?? ''),
            'received' => (string)($riwayat['diterima'] ?? $metaRaw['received'] ?? ''),
            'accepted' => (string)($riwayat['disetujui'] ?? $metaRaw['accepted'] ?? ''),
            'published' => (string)($riwayat['terbit'] ?? $metaRaw['published'] ?? ''),
            'email' => (string)($metaRaw['email'] ?? ''),
            'volume' => (string)($terbitan['volume'] ?? $metaRaw['volume'] ?? '1'),
            'issue' => (string)($terbitan['nomor'] ?? $metaRaw['issue'] ?? '1'),
            'year' => (string)($terbitan['tahun'] ?? $metaRaw['year'] ?? date('Y')),
            'startPage' => (int)($terbitan['halaman_awal'] ?? $metaRaw['startPage'] ?? 1),
        ];

        $totalPages = 2;
        if (is_file($d . '/layout_map.json')) {
            $lm = json_decode((string)file_get_contents($d . '/layout_map.json'), true);
            if (isset($lm['halaman']) && is_numeric($lm['halaman'])) {
                $totalPages = (int)$lm['halaman'];
            }
        }
        $pageList = [];
        for ($p = 1; $p <= max(1, $totalPages); $p++) {
            $pageList[] = [
                'pageNumber' => $p,
                'columnHeightMm' => ($p === 1 ? 135.0 : 225.0),
            ];
        }

        $layout = [
            'pageWidthMm' => 210,
            'pageHeightMm' => 297,
            'marginTopMm' => 36.1,
            'marginBottomMm' => 27.9,
            'marginLeftMm' => 27.0,
            'marginRightMm' => 27.0,
            'columnCount' => 2,
            'columnGapMm' => 6.35,
            'fontFamily' => '"Times New Roman", Times, serif',
            'fontSizePt' => 11,
            'lineHeight' => 1.15,
            'pages' => $pageList,
        ];

        $dokData = is_file($d . '/dokumen.json') ? json_decode((string)file_get_contents($d . '/dokumen.json'), true) : [];
        $blocks = $dokData['blocks'] ?? [];

        $lmBlocks = [];
        if (is_file($d . '/layout_map.json')) {
            $lmData = json_decode((string)file_get_contents($d . '/layout_map.json'), true);
            foreach (($lmData['blocks'] ?? []) as $lb) {
                if (!empty($lb['id']) && !isset($lmBlocks[$lb['id']])) {
                    $lmBlocks[$lb['id']] = $lb;
                }
            }
        }

        $elements = [];
        foreach ($blocks as $b) {
            $bid = (string)($b['id'] ?? '');
            $jenis = (string)($b['jenis'] ?? $b['tipe'] ?? '');
            if ($jenis === 'meta' || strpos($bid, 'm-') === 0) {
                continue;
            }

            $lb = $lmBlocks[$bid] ?? null;
            $pageIndex = $lb ? max(0, ((int)$lb['page']) - 1) : 0;
            $rawText = (string)($b['text'] ?? $b['content'] ?? '');
            $cleanText = trim(preg_replace('/#p[me]\(\d+\);?/', '', $rawText));

            if ($jenis === 'heading') {
                $elements[] = [
                    'id' => $bid,
                    'type' => 'heading',
                    'level' => (int)($b['level'] ?? 1),
                    'pageIndex' => $pageIndex,
                    'text' => $cleanText,
                    'style' => [
                        'fontSizePt' => 11,
                        'fontWeight' => 'bold',
                        'marginTopMm' => 3.5,
                        'marginBottomMm' => 1.5,
                        'columnSpan' => 'none',
                        'floatMode' => 'flow',
                        'xMm' => 0,
                        'yMm' => 0,
                        'widthMm' => null,
                        'heightMm' => null,
                    ],
                ];
            } elseif ($jenis === 'figure' || $jenis === 'image') {
                $imgPath = (string)($b['src']['path'] ?? $b['panggil']['path'] ?? $b['path'] ?? '');
                $imgPath = trim($imgPath, "\"'\t\n\r");
                $fullImg = '';
                $candidates = [
                    $MESIN . '/' . ltrim($imgPath, '/'),
                    $d . '/' . ltrim($imgPath, '/'),
                    $d . '/media/' . basename($imgPath),
                    $d . '/media/media/' . basename($imgPath),
                ];
                foreach ($candidates as $cand) {
                    if (is_file($cand)) {
                        $fullImg = $cand;
                        break;
                    }
                }
                $srcUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
                if ($fullImg !== '') {
                    $ext = strtolower(pathinfo($fullImg, PATHINFO_EXTENSION));
                    $mime = ($ext === 'jpg' || $ext === 'jpeg') ? 'image/jpeg' : (($ext === 'svg') ? 'image/svg+xml' : 'image/png');
                    $srcUri = 'data:' . $mime . ';base64,' . base64_encode((string)file_get_contents($fullImg));
                }
                $caption = trim((string)($b['caption_raw'] ?? $b['text'] ?? ''));
                $label = trim((string)($b['label_raw'] ?? ''));
                if ($label !== '' && strpos($caption, $label) !== 0) {
                    $caption = trim($label . ' ' . $caption);
                }
                $elements[] = [
                    'id' => $bid,
                    'type' => 'image',
                    'pageIndex' => $pageIndex,
                    'src' => $srcUri,
                    'caption' => $caption,
                    'style' => [
                        'widthMm' => !empty($b['penuh']) ? 156.0 : 75.0,
                        'heightMm' => 48.0,
                        'aspectRatio' => 1.5625,
                        'columnSpan' => !empty($b['penuh']) ? 'all' : 'none',
                        'floatMode' => 'flow',
                        'xMm' => 0,
                        'yMm' => 0,
                        'marginTopMm' => 2.5,
                        'marginBottomMm' => 2.5,
                    ],
                ];
            } elseif ($jenis === 'table') {
                $caption = trim((string)($b['caption_raw'] ?? $b['text'] ?? ''));
                $label = trim((string)($b['label_raw'] ?? ''));
                if ($label !== '' && strpos($caption, $label) !== 0) {
                    $caption = trim($label . ' ' . $caption);
                }
                $headers = [];
                $rows = [];
                $grid = [];
                foreach ($b['cells'] ?? [] as $cell) {
                    $r = (int)($cell['r'] ?? 0);
                    $c = (int)($cell['c'] ?? 0);
                    $txt = trim(preg_replace('/^\*+|\*+$/', '', (string)($cell['text'] ?? '')));
                    $grid[$r][$c] = $txt;
                }
                ksort($grid);
                foreach ($grid as $rIdx => $cols) {
                    ksort($cols);
                    $rowVals = array_values($cols);
                    if ($rIdx === 0) {
                        $headers = $rowVals;
                    } else {
                        $rows[] = $rowVals;
                    }
                }
                $elements[] = [
                    'id' => $bid,
                    'type' => 'table',
                    'pageIndex' => $pageIndex,
                    'caption' => $caption,
                    'headers' => $headers,
                    'rows' => $rows,
                    'style' => [
                        'fontSizePt' => 9.5,
                        'widthMm' => 156.0,
                        'heightMm' => null,
                        'columnSpan' => 'all',
                        'floatMode' => 'flow',
                        'xMm' => 0,
                        'yMm' => 0,
                        'marginTopMm' => 2.5,
                        'marginBottomMm' => 2.5,
                    ],
                ];
            } else {
                $elements[] = [
                    'id' => $bid,
                    'type' => 'paragraph',
                    'pageIndex' => $pageIndex,
                    'text' => $cleanText,
                    'style' => [
                        'fontSizePt' => 11,
                        'textAlign' => 'justify',
                        'textIndentMm' => ($jenis === 'reference' ? 0.0 : 5.0),
                        'marginTopMm' => 0,
                        'marginBottomMm' => 1.2,
                        'columnSpan' => 'none',
                        'floatMode' => 'flow',
                        'xMm' => 0,
                        'yMm' => 0,
                        'widthMm' => null,
                        'heightMm' => null,
                    ],
                ];
            }
        }

        $contentJson = [
            'ok' => true,
            'version' => 1,
            'articleId' => $id,
            'journal' => $journal,
            'meta' => $meta,
            'layout' => $layout,
            'elements' => $elements,
        ];

        file_put_contents($d . '/content.json', json_encode($contentJson, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
        jawab($contentJson);
    }
    case 'save_layout': {
        $raw = (string)file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload) && !empty($_POST['payload'])) {
            $payload = is_string($_POST['payload']) ? json_decode($_POST['payload'], true) : $_POST['payload'];
        }
        if (!is_array($payload)) {
            $payload = $_POST;
        }

        $id = (string)($payload['articleId'] ?? $_POST['id'] ?? $_GET['id'] ?? '');
        if ($id === '') {
            gagal('ID artikel wajib diisi', 400);
        }
        $d = folder_artikel($id);

        $content = is_array($payload['content'] ?? null) ? $payload['content'] : $payload;
        if (isset($payload['layout']) && is_array($payload['layout']) && is_array($content)) {
            $content['layout'] = $payload['layout'];
        }
        if (is_array($content)) {
            if (empty($content['ok'])) {
                $content['ok'] = true;
            }
            if (empty($content['articleId'])) {
                $content['articleId'] = $id;
            }
        }

        $jsonStr = json_encode($content, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        file_put_contents($d . '/content.json', $jsonStr);
        file_put_contents($d . '/layout_saved.json', $jsonStr);

        jawab(['ok' => true, 'articleId' => $id, 'savedAt' => date('c')]);
    }
    case 'get_state': {
        $id = (string)($_GET['id'] ?? $_GET['artikel'] ?? '');
        $d = folder_artikel($id);
        $h = kunci($d);
        $k = keadaan($d, false);
        flock($h, LOCK_UN);
        $k['articleId'] = $id;
        $k['redo'] = count(glob($d . '/_redo/*.typ') ?: []);
        jawab($k);
    }
    case 'get_preview': {
        $id = (string)($_GET['id'] ?? $_GET['artikel'] ?? '');
        $d = folder_artikel($id);
        $f = $d . '/hasil.pdf';
        if (!is_file($f)) {
            keadaan($d, false);
        }
        if (!is_file($f)) {
            gagal('PDF belum tersedia', 404);
        }
        header('Content-Type: application/pdf');
        header('Cache-Control: no-store');
        $disp = !empty($_GET['download']) ? 'attachment' : 'inline';
        header('Content-Disposition: ' . $disp . '; filename="' . basename($d) . '.pdf"');
        readfile($f);
        exit;
    }
    case 'patch_layout': {
        $raw = (string)file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload) && !empty($_POST['payload'])) {
            $payload = is_string($_POST['payload']) ? json_decode($_POST['payload'], true) : $_POST['payload'];
        }
        if (!is_array($payload)) {
            $payload = $_POST;
        }

        $id = (string)($payload['articleId'] ?? $payload['artikel'] ?? $_GET['id'] ?? '');
        $d = folder_artikel($id);
        $op = (string)($payload['op'] ?? '');

        $h = kunci($d);

        if ($op === 'undo') {
            $f = glob($d . '/_riwayat/*.typ') ?: [];
            sort($f);
            if (empty($f)) {
                flock($h, LOCK_UN);
                gagal('Tidak ada langkah untuk dibatalkan');
            }
            $redoDir = $d . '/_redo';
            if (!is_dir($redoDir)) {
                mkdir($redoDir, 0700, true);
            }
            file_put_contents($redoDir . '/' . sprintf('%.6f', microtime(true)) . '.typ', (string)file_get_contents($d . '/body.typ'));
            $fileUndo = end($f);
            copy($fileUndo, $d . '/body.typ');
            @unlink($fileUndo);
            $k = keadaan($d, false);
            flock($h, LOCK_UN);
            $k['articleId'] = $id;
            $k['redo'] = count(glob($d . '/_redo/*.typ') ?: []);
            jawab($k);
        }

        if ($op === 'redo') {
            $f = glob($d . '/_redo/*.typ') ?: [];
            sort($f);
            if (empty($f)) {
                flock($h, LOCK_UN);
                gagal('Tidak ada langkah untuk diulangi');
            }
            simpan_riwayat($d, (string)file_get_contents($d . '/body.typ'));
            $fileRedo = end($f);
            copy($fileRedo, $d . '/body.typ');
            @unlink($fileRedo);
            $k = keadaan($d, false);
            flock($h, LOCK_UN);
            $k['articleId'] = $id;
            $k['redo'] = count(glob($d . '/_redo/*.typ') ?: []);
            jawab($k);
        }

        $bodyAsli = (string)file_get_contents($d . '/body.typ');
        $baru = $bodyAsli;

        switch ($op) {
            case 'skala': {
                $nomor = (int)($payload['nomor'] ?? 0);
                $nilai = isset($payload['skala']) ? (float)$payload['skala'] : (float)($payload['nilai'] ?? 1.0);
                $baru = ubah_body($baru, 'skala', ['nomor' => $nomor, 'nilai' => $nilai]);
                if (isset($payload['penuh'])) {
                    $penuhStr = (!empty($payload['penuh']) && $payload['penuh'] !== 'false') ? 'true' : 'false';
                    $polaGbr = '/^(#gambar\([^\n]*?\bnomor:\s*' . $nomor . '\b[^\n]*)$/m';
                    if (preg_match($polaGbr, $baru, $mGbr)) {
                        $baris = $mGbr[1];
                        if (preg_match('/penuh:\s*(?:true|false)/', $baris)) {
                            $baris = preg_replace('/penuh:\s*(?:true|false)/', 'penuh: ' . $penuhStr, $baris);
                        } else {
                            $baris = preg_replace('/(\bnomor:\s*' . $nomor . ')/', '$1, penuh: ' . $penuhStr, $baris, 1);
                        }
                        $baru = str_replace($mGbr[1], $baris, $baru);
                    }
                }
                break;
            }
            case 'posisi': {
                $nomor = (int)($payload['nomor'] ?? 0);
                $keputusan = (string)($payload['keputusan'] ?? $payload['nilai'] ?? '');
                if ($keputusan !== '') {
                    $baru = ubah_body($baru, 'posisi', ['nomor' => $nomor, 'nilai' => $keputusan]);
                }
                $targetPm = (int)($payload['targetPm'] ?? 0);
                if ($targetPm > 0) {
                    $polaGbr = '/^#gambar\([^\n]*?\bnomor:\s*' . $nomor . '\b[^\n]*/m';
                    if (preg_match($polaGbr, $baru, $mGbr, PREG_OFFSET_CAPTURE)) {
                        $barisGbr = trim($mGbr[0][0]);
                        $offsetGbr = $mGbr[0][1];
                        $lenGbr = strlen($mGbr[0][0]);
                        if (substr($baru, $offsetGbr + $lenGbr, 2) === "\r\n") {
                            $lenGbr += 2;
                        } elseif (substr($baru, $offsetGbr + $lenGbr, 1) === "\n") {
                            $lenGbr += 1;
                        }
                        $baru = substr($baru, 0, $offsetGbr) . substr($baru, $offsetGbr + $lenGbr);

                        $polaPm = pola_pm($targetPm);
                        if (!preg_match($polaPm, $baru, $mPm, PREG_OFFSET_CAPTURE)) {
                            flock($h, LOCK_UN);
                            gagal('Target paragraf tidak ditemukan');
                        }
                        $posTarget = $mPm[0][1];
                        $baru = substr($baru, 0, $posTarget) . $barisGbr . "\n\n" . substr($baru, $posTarget);
                    }
                }
                break;
            }
            case 'pindah_kolom': {
                $pm = (int)($payload['pm'] ?? 0);
                if (!preg_match(pola_pm($pm), $baru, $m, PREG_OFFSET_CAPTURE)) {
                    flock($h, LOCK_UN);
                    gagal('Paragraf tidak ditemukan');
                }
                $i = $m[0][1];
                $sebelum = substr($baru, 0, $i);

                $adaColbreak = false;
                $lenColbreak = 0;
                if (preg_match('/#colbreak\(\)\r?\n(?:\r?\n)?$/', $sebelum, $mCb)) {
                    $adaColbreak = true;
                    $lenColbreak = strlen($mCb[0]);
                }

                $tambah = isset($payload['toggle']) ? (!empty($payload['toggle']) && $payload['toggle'] !== 'false') : !$adaColbreak;
                if ($tambah) {
                    if (!$adaColbreak) {
                        $baru = $sebelum . "#colbreak()\n\n" . substr($baru, $i);
                    }
                } else {
                    if ($adaColbreak) {
                        $baru = substr($sebelum, 0, -$lenColbreak) . substr($baru, $i);
                    }
                }
                break;
            }
            case 'spasi_paragraf': {
                $pm = (int)($payload['pm'] ?? 0);
                $spasi = round((float)($payload['spasi'] ?? 0), 1);
                $polaSpasi = '/^#v\([^\n]*?\/\/\s*ed:pm-' . $pm . '\r?\n/m';
                $baru = preg_replace($polaSpasi, '', $baru);
                if (abs($spasi) >= 0.5) {
                    if (!preg_match(pola_pm($pm), $baru, $m, PREG_OFFSET_CAPTURE)) {
                        flock($h, LOCK_UN);
                        gagal('Paragraf tidak ditemukan');
                    }
                    $idx = $m[0][1];
                    $spasiTeks = (string)$spasi;
                    $sisip = "#v(" . $spasiTeks . "pt, weak: true) // ed:pm-" . $pm . "\n";
                    $baru = substr($baru, 0, $idx) . $sisip . substr($baru, $idx);
                }
                break;
            }
            case 'kaki': {
                $hal = (int)($payload['hal'] ?? 0);
                $baris = isset($payload['baris']) ? (int)$payload['baris'] : (isset($payload['pt']) ? (int)round((float)$payload['pt'] / 11) : 0);
                $baru = ubah_body($baru, 'kaki', ['hal' => $hal, 'baris' => $baris]);
                break;
            }
            case 'teks': {
                $baru = ubah_body($baru, 'teks', $payload);
                break;
            }
            default: {
                flock($h, LOCK_UN);
                gagal('Operasi tidak dikenal: ' . $op);
            }
        }

        simpan_riwayat($d, $bodyAsli);

        foreach (glob($d . '/_redo/*.typ') ?: [] as $fRedo) {
            @unlink($fRedo);
        }

        file_put_contents($d . '/body.typ', $baru);

        $k = keadaan($d, false);

        if (empty($k['ok'])) {
            file_put_contents($d . '/body.typ', $bodyAsli);
            $fRiwayat = glob($d . '/_riwayat/*.typ') ?: [];
            sort($fRiwayat);
            if (!empty($fRiwayat)) {
                @unlink(end($fRiwayat));
            }
            flock($h, LOCK_UN);
            gagal("Perubahan ditolak Typst:\n" . ($k['galat'] ?? ''), 422);
        }

        flock($h, LOCK_UN);
        $k['articleId'] = $id;
        $k['redo'] = 0;
        jawab($k);
    }
}
gagal('Aksi tidak dikenal');
