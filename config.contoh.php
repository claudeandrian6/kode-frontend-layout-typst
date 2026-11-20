<?php
/*
 * Salin menjadi config.php lalu sesuaikan.
 * Buat hash kata sandi di server:  php -r 'echo password_hash("SANDI-ANDA", PASSWORD_DEFAULT), "\n";'
 */
return [
    // folder mesin (DI LUAR public_html): build.py, qa_cepat.py, template_jurnal.typ, bin/, fonts/, jurnal/, kerja/
    'mesin' => '/home/u587972949/typst_editor',
    // Python 3 dengan pymupdf & pillow (CloudLinux alt-python)
    'python' => '/opt/alt/python311/bin/python3',
    'sandi_hash' => 'GANTI-DENGAN-HASIL-password_hash',
    'ppi' => 80,                 // resolusi gambar halaman di editor
    // variabel lingkungan untuk build.py (LibreOffice untuk chart & gambar EMF)
    'env' => [
        'HOME' => '/home/u587972949',
        'XDG_CACHE_HOME' => '/home/u587972949/.cache',
        'SOFFICE_BIN' => '/home/u587972949/domains/fkip.unila.ac.id/public_html/tools/squashfs-root/AppRun',
    ],
];
