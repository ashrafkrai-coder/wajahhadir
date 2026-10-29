# Hadir Wajah

PWA untuk merekod kehadiran murid melalui pengecaman wajah. Semua pemprosesan AI berlaku pada peranti guru
(pustaka dan model dihos dalam folder `vendor/`, jadi tiada CDN diperlukan dan ia berfungsi luar talian).

## Jalankan sebagai PWA

```
python3 -m http.server 8000
```
Buka `http://localhost:8000`. Kamera hanya dibenarkan pada `localhost` atau HTTPS (cth. GitHub Pages).

## Bina fail Android APK

Fail PWA asal dikekalkan dan juga disalin ke folder `www/` untuk pembungkusan Android dengan Capacitor.

```
npm.cmd run android:debug
```

APK berjaya dibina boleh ditemui di `dist/Hadir-Wajah.apk` dan `android/app/build/outputs/apk/debug/app-debug.apk`.
Untuk bina semula projek native selepas menukar fail PWA, jalankan `npm.cmd run android:sync`.

## Cara guna

1. **Murid** > tampal senarai nama > Tambah.
2. Tekan **Daftar wajah** pada setiap murid, ambil 3-8 sampel (depan, kiri, kanan, senyum).
3. **Imbas** > Mula Imbas. Murid melihat ke kamera; nama ditanda Hadir secara automatik.
   Guru boleh tanda/batal secara manual pada senarai.
4. **Eksport CSV** atau **Hantar ke Google Sheet**.

## Sambung Google Sheet (pilihan)

1. Buka Google Sheet anda > Extensions > Apps Script.
2. Tampal kandungan `Code.gs` > Save.
3. (Pilihan) Project Settings > Script properties > tambah `TOKEN` = kod rahsia anda.
4. Deploy > New deployment > jenis **Web app** > Execute as: **Me** > Who has access: **Anyone** > Deploy.
5. Salin URL `/exec` ke Tetapan aplikasi (dan kod rahsia jika ada).
6. Untuk muat nama murid dari Sheet: buat tab `Senarai` dengan Nama di lajur A (dan Kelas di lajur B, pilihan).
   Klik **Murid > Dari Sheet** dalam aplikasi. Data senarai boleh mengandungi Nama di lajur A dan Kelas di lajur B. Dalam borang tambah murid, taip terus nama kelas baharu atau pilih daripada cadangan kelas sedia ada.
   Rekod hadir ditulis ke tab `Kehadiran` (dicipta automatik). ID murid kekal digunakan untuk mengemas kini tanpa bergantung kepada nama semata-mata, dan penghantaran berulang dengan ID permintaan yang sama tidak akan ditulis semula.

Selepas mengubah `Code.gs`, buat **New version** pada deployment yang sama
(Deploy > Manage deployments > pensil > Version: New version > Deploy). URL `/exec` kekal sama.

### Tab dalam Sheet

| Tab | Isi |
|---|---|
| `Kehadiran` | Senarai penuh: satu baris = satu murid pada satu tarikh dan sesi. Sumber data. |
| `Jadual` / `Jadual <kelas>` | Murid di baris, tarikh di lajur (✓ hadir, ✗ tidak hadir), jumlah hadir, peratus, dan jumlah hadir setiap hari. Dibina semula setiap kali hantar. |
| `Log` | Tambah sahaja, tidak pernah ditimpa: satu baris "Hantaran" bagi setiap hantaran dan satu baris "Perubahan" bagi setiap murid yang berubah status (sebelum, selepas, kaedah). |
| `Senarai` | (pilihan) Nama di lajur A, Kelas di lajur B. |

Jalankan fungsi `sediakan` sekali (pilih dalam editor Apps Script > Run, atau menu **Hadir Wajah > Sediakan tab**
selepas muat semula Sheet) supaya tab dicipta serta-merta, tidak perlu tunggu hantaran pertama.

### Jika Sheet masih kosong

1. Buka URL `/exec` dalam pelayar. Mesti keluar `{"ok":true,"mesej":"Hadir Wajah aktif","sheet":"..."}`.
   Jika keluar ralat "tidak terikat dengan Sheet", buka skrip dari **Sheet** (Extensions > Apps Script),
   atau tambah Script property `SHEET_ID`.
2. Pastikan deployment: Execute as **Me**, Who has access **Anyone**, dan sudah **New version** selepas tampal kod terkini.
3. Dalam aplikasi, URL mesti URL `/exec` (bukan `/dev`) dan mesti tekan **Hantar ke Google Sheet** (rekod tidak dihantar automatik).
4. Jika guna kod rahsia, ia mesti sama dalam Script property `TOKEN` dan Tetapan aplikasi. Selepas mengubah `Code.gs`, buat deployment baharu untuk menyokong butang **Dari Sheet** melalui POST: Deploy > Manage deployments > pensel > Version: New version > Deploy. URL mesti berakhir `/exec`, bukan `/dev`.
5. Mesej ralat dari pelayan dipaparkan sebagai banner merah dalam aplikasi selepas tekan hantar.

## Privasi (PDPA 2010)

- Gambar tidak disimpan. Hanya 128 nombor bagi setiap sampel wajah disimpan dalam `localStorage` peranti.
- Dapatkan kebenaran sekolah dan penjaga sebelum mendaftarkan wajah murid.
- Butang **Padam semua data wajah** ada dalam Tetapan.
- **Sandaran data** dan **Pulihkan sandaran** tersedia dalam Tetapan untuk membuat dan memulihkan fail JSON data tempatan.
- Tiada pengesanan liveness automatik yang pasti: foto atau rakaman boleh mengelirukan sistem. Pendaftar dan guru perlu memerhati secara manual semasa sampel dan kehadiran dibuat; arahan variasi pose juga digunakan semasa pendaftaran.
- Kunci peranti guru dengan kata laluan kerana data wajah (walaupun bukan gambar) masih data biometrik.

## Penalaan

- **Kekuatan padanan** (Tetapan): lebih kecil = lebih ketat (kurang salah kenal, lebih banyak tidak dikenali). Mula pada 0.50.
- **Bingkai pengesahan**: bilangan bingkai berturut-turut sebelum ditanda hadir. Naikkan jika ada salah kenal.
- Daftar wajah dalam cahaya yang sama seperti di kelas untuk hasil terbaik.

## Kemas kini versi

Jika anda mengubah mana-mana fail, tukar `VERSION` dalam `sw.js` supaya cache baharu dimuat.

Pustaka: [@vladmandic/face-api](https://github.com/vladmandic/face-api) (MIT).
