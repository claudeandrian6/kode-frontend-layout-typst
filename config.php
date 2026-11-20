<?php
return [
    // folder mesin (DI LUAR public_html)
    'mesin' => '/opt/typst_editor',
    
    // Unix socket worker.py
    'worker_socket' => '/opt/typst_editor/worker.sock',
    
    // Python 3 dengan pymupdf & pillow (Virtual Environment Oracle)
    'python' => '/opt/typst-venv/bin/python3',
    
    // Sandi hash (biarkan sama seperti sebelumnya)
    'sandi_hash' => '$2y$10$OgBPQ.7eL4au0KYvmS5HEuNbXevfTA/up5YDrE0/6Tcw6AwlP31N.', 
    
    'ppi' => 80,
    
    // variabel lingkungan untuk build.py (LibreOffice)
    'env' => [
        'HOME' => '/home/ubuntu',
        'XDG_CACHE_HOME' => '/home/ubuntu/.cache',
        'SOFFICE_BIN' => '/usr/bin/soffice',
    ],
];
