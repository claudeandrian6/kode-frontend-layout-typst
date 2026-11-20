<?php
header('Content-Type: text/plain');
$sock = '/opt/typst_editor/worker.sock';
$c = @stream_socket_client('unix://' . $sock, $errno, $errstr, 5);
if ($c === false) {
    echo "GAGAL KONEK.\n";
    echo "Error Code: $errno\n";
    echo "Pesan: $errstr\n";
    echo "open_basedir: " . ini_get('open_basedir') . "\n";
} else {
    echo "SUKSES KONEK DARI WEB!\n";
}
