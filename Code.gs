/**
 * Hadir Wajah - Google Apps Script (Web App) v2
 *
 * Tab yang diurus (dicipta automatik):
 *  - Kehadiran : senarai penuh, satu baris = satu murid pada satu tarikh+sesi (sumber data).
 *  - Jadual    : jadual kehadiran (murid di baris, tarikh di lajur) dengan jumlah dan peratus.
 *                Satu tab bagi setiap kelas, cth "Jadual 5 Anjal". Dibina semula setiap kali hantar.
 *  - Log       : rekod tambah-sahaja (tidak pernah ditimpa) bagi setiap hantaran dan setiap perubahan status.
 *  - Senarai   : (pilihan) Nama di lajur A, Kelas di lajur B, untuk "Dari Sheet" dalam aplikasi.
 *
 * PENTING: skrip ini mesti dibuka dari Sheet anda (Extensions > Apps Script) supaya terikat dengan Sheet.
 * Jika skrip berdiri sendiri, tambah Script property SHEET_ID = ID Sheet (bahagian antara /d/ dan /edit dalam URL).
 *
 * Kod rahsia (pilihan): Project Settings > Script properties > TOKEN = kod anda.
 */

const SHEET_REKOD = 'Kehadiran';
const SHEET_SENARAI = 'Senarai';
const SHEET_LOG = 'Log';
const PREFIX_JADUAL = 'Jadual';

const HEADERS = ['Tarikh', 'Sesi', 'Kelas', 'Bil', 'Nama', 'Status', 'Masa', 'Kaedah', 'Dikemas kini', 'ID Murid'];
const LOG_HEADERS = ['Masa', 'Jenis', 'Tarikh', 'Sesi', 'Kelas', 'Nama', 'Sebelum', 'Selepas', 'Kaedah', 'Catatan'];
const HARI = ['Ahd', 'Isn', 'Sel', 'Rab', 'Kha', 'Jum', 'Sab'];
const HADIR = '✓';
const TIDAK = '✗';

/* ---------------- Asas ---------------- */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function semakToken_(token) {
  const wajib = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (wajib && String(token || '') !== wajib) throw new Error('Kod rahsia tidak sah');
}

function selamatSheet_(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+@-]/.test(text)) text = "'" + text;
  return text;
}

function getSS_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss) {
    const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (id) ss = SpreadsheetApp.openById(id);
  }
  if (!ss) {
    throw new Error('Skrip tidak terikat dengan Sheet. Buka Sheet > Extensions > Apps Script, atau tetapkan Script property SHEET_ID.');
  }
  return ss;
}

function ensureSheet_(name, headers) {
  const ss = getSS_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eefc');
    sh.setFrozenRows(1);
  }
  return sh;
}

function getRekodSheet_() {
  const existed = !!getSS_().getSheetByName(SHEET_REKOD);
  const sh = ensureSheet_(SHEET_REKOD, HEADERS);
  if (!existed) {
    // Tarikh, Sesi, Kelas dan Masa sebagai teks supaya tidak ditukar format oleh Sheets
    sh.getRange('A:C').setNumberFormat('@');
    sh.getRange('G:G').setNumberFormat('@');
  } else if (sh.getLastColumn() < HEADERS.length) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
}

function getLogSheet_() {
  const existed = !!getSS_().getSheetByName(SHEET_LOG);
  const sh = ensureSheet_(SHEET_LOG, LOG_HEADERS);
  if (!existed) {
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('C:C').setNumberFormat('@');
  }
  return sh;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/* ---------------- Sediakan tab (jalankan sekali) ---------------- */
function sediakan() {
  getRekodSheet_();
  getLogSheet_();
  ensureSheet_(SHEET_SENARAI, ['Nama', 'Kelas']);
  binaSemuaJadual();
  try { getSS_().toast('Tab Kehadiran, Jadual, Log dan Senarai sedia.', 'Hadir Wajah', 5); } catch (e) {}
}

function binaSemuaJadual() {
  const sh = getRekodSheet_();
  const last = sh.getLastRow();
  const kelasSet = {};
  if (last > 1) {
    sh.getRange(2, 3, last - 1, 1).getValues().forEach(function (r) { kelasSet[String(r[0])] = true; });
  }
  const senarai = Object.keys(kelasSet);
  if (!senarai.length) {
    // Belum ada data: sediakan tab Jadual kosong dengan panduan
    const ss = getSS_();
    let j = ss.getSheetByName(PREFIX_JADUAL);
    if (!j) {
      j = ss.insertSheet(PREFIX_JADUAL);
      j.getRange(1, 1).setValue('Jadual kehadiran akan muncul di sini selepas anda menghantar kehadiran pertama dari aplikasi.');
    }
    return;
  }
  senarai.forEach(binaJadual_);
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Hadir Wajah')
      .addItem('Sediakan tab', 'sediakan')
      .addItem('Bina semula Jadual', 'binaSemuaJadual')
      .addToUi();
  } catch (e) {}
}

/* ---------------- Jadual (murid x tarikh) ---------------- */
function namaJadual_(kelas) {
  const k = String(kelas || '').replace(/[\[\]\*\?:\/\\]/g, ' ').trim().slice(0, 60);
  return k ? PREFIX_JADUAL + ' ' + k : PREFIX_JADUAL;
}

function labelTarikh_(iso) {
  const p = iso.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return HARI[d.getDay()] + ' ' + p[2] + '/' + p[1];
}

function binaJadual_(kelas) {
  kelas = String(kelas || '');
  const sumber = getRekodSheet_();
  const last = sumber.getLastRow();
  if (last < 2) return;
  const data = sumber
    .getRange(2, 1, last - 1, HEADERS.length)
    .getValues()
    .filter(function (r) { return String(r[2]) === kelas && r[0] !== ''; });
  if (!data.length) return;

  const kolMap = {};
  const kols = [];
  const bil = {};
  const nama = [];
  const sel = {};

  data.forEach(function (r) {
    const t = String(r[0]);
    const s = String(r[1]);
    const k = t + '|' + s;
    if (!kolMap[k]) { kolMap[k] = true; kols.push({ t: t, s: s, k: k }); }
    const n = String(r[4]);
    const b = Number(r[3]) || 9999;
    if (!(n in bil)) { bil[n] = b; nama.push(n); } else if (b < bil[n]) { bil[n] = b; }
    sel[n + '\u0001' + k] = String(r[5]) === 'Hadir' ? HADIR : TIDAK;
  });

  kols.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : a.s < b.s ? -1 : a.s > b.s ? 1 : 0; });
  nama.sort(function (a, b) { return bil[a] - bil[b] || a.localeCompare(b); });

  const FIX = 4; // Bil, Nama, Hadir, %
  const N = nama.length;
  const lebar = FIX + kols.length;
  const awal = colLetter_(FIX + 1);

  const out = [];
  // Baris 1: tarikh, baris 2: sesi
  out.push(['Bil', 'Nama', 'Hadir', '%'].concat(kols.map(function (c) { return labelTarikh_(c.t); })));
  out.push(['', '', '', ''].concat(kols.map(function (c) { return c.s === '-' ? '' : c.s; })));

  const bg = [];
  nama.forEach(function (n, i) {
    const r = i + 3;
    const baris = [
      i + 1,
      n,
      '=COUNTIF(' + awal + r + ':' + r + ',"' + HADIR + '")',
      '=IFERROR(C' + r + '/(COUNTIF(' + awal + r + ':' + r + ',"' + HADIR + '")+COUNTIF(' + awal + r + ':' + r + ',"' + TIDAK + '")),"")'
    ];
    const warna = [];
    kols.forEach(function (c) {
      const v = sel[n + '\u0001' + c.k] || '';
      baris.push(v);
      warna.push(v === HADIR ? '#d9f2e3' : v === TIDAK ? '#fde2e2' : null);
    });
    out.push(baris);
    bg.push(warna);
  });

  const foot = ['', 'Jumlah hadir', '', ''];
  kols.forEach(function (c, i) {
    const L = colLetter_(FIX + 1 + i);
    foot.push('=COUNTIF(' + L + '3:' + L + (2 + N) + ',"' + HADIR + '")');
  });
  out.push(foot);

  const ss = getSS_();
  const nm = namaJadual_(kelas);
  let sh = ss.getSheetByName(nm);
  if (!sh) sh = ss.insertSheet(nm);
  sh.clear();

  sh.getRange(1, 1, 2, lebar).setNumberFormat('@');
  sh.getRange(1, 1, out.length, lebar).setValues(out);

  sh.getRange(1, 1, 2, lebar).setFontWeight('bold').setBackground('#e8eefc').setHorizontalAlignment('center');
  sh.getRange(1, 2, 2, 1).setHorizontalAlignment('left');
  sh.getRange(out.length, 1, 1, lebar).setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(3, 4, N, 1).setNumberFormat('0%');
  sh.getRange(3, 3, N, 2).setHorizontalAlignment('center');
  if (kols.length) {
    const dt = sh.getRange(3, FIX + 1, N, kols.length);
    dt.setHorizontalAlignment('center').setBackgrounds(bg);
    sh.getRange(out.length, FIX + 1, 1, kols.length).setHorizontalAlignment('center');
  }
  sh.setFrozenRows(2);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 240);
  sh.setColumnWidth(3, 55);
  sh.setColumnWidth(4, 55);
  if (kols.length) sh.setColumnWidths(FIX + 1, kols.length, 78);

  // Buang tab "Jadual" panduan (kosong) yang dicipta oleh sediakan() sebelum ada data
  if (nm !== PREFIX_JADUAL) {
    const ph = ss.getSheetByName(PREFIX_JADUAL);
    if (ph && ph.getLastRow() <= 1 && String(ph.getRange(1, 1).getValue()).indexOf('akan muncul') > -1) {
      ss.deleteSheet(ph);
    }
  }
}

/* ---------------- Terima kehadiran ---------------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    semakToken_(d.token);

    const requestId = String(d.requestId || '').slice(0, 80);
    if (requestId) {
      const cache = CacheService.getScriptCache();
      if (cache.get('req:' + requestId)) return jsonOut_({ ok: true, ditulis: 0, baharu: 0, dikemas: 0, perubahan: 0, duplikasi: true });
    }

    if (d.action === 'murid') {
      const sh = getSS_().getSheetByName(SHEET_SENARAI);
      if (!sh) throw new Error('Tab "' + SHEET_SENARAI + '" tidak dijumpai. Jalankan fungsi sediakan() dahulu.');
      const last = sh.getLastRow();
      const murid = last < 2 ? [] : sh.getRange(2, 1, last - 1, 2).getValues()
        .filter(function (r) { return r[0]; })
        .map(function (r) { return { nama: selamatSheet_(r[0]), kelas: selamatSheet_(r[1]) }; });
      return jsonOut_({ ok: true, murid: murid });
    }

    const tarikh = String(d.tarikh || '');
    const sesi = String(d.sesi || '');
    const rekod = d.rekod || [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tarikh)) throw new Error('Tarikh tidak sah');
    if (sesi.length > 60) throw new Error('Sesi terlalu panjang');
    if (!Array.isArray(rekod) || rekod.length > 5000) throw new Error('Senarai rekod tidak sah');

    const sh = getRekodSheet_();
    const last = sh.getLastRow();
    const data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];

    const peta = {};
    data.forEach(function (r, i) {
      const key = JSON.stringify([String(r[0]), String(r[1]), String(r[2]), String(r[9] || r[4])]);
      peta[key] = i;
    });

    const sekarang = nowStr_();
    const sesiKunci = sesi || '-';
    const baru = [];
    const logBaris = [];
    let kemas = 0;
    let hadir = 0;

    rekod.forEach(function (r) {
      if (!r || !['Hadir', 'Tidak Hadir'].includes(r.status) || typeof r.nama !== 'string' || !r.nama.trim()) throw new Error('Rekod murid tidak sah');
      if (String(r.nama).length > 200 || String(r.kelas || '').length > 60 || String(r.kaedah || '').length > 30) throw new Error('Data rekod terlalu panjang');
      const kelas = String(r.kelas || d.kelas || '').trim();
      const muridId = String(r.id || r.nama.trim()).slice(0, 80);
      if (r.status === 'Hadir') hadir++;
      const bil = Number(r.bil);
      if (!Number.isInteger(bil) || bil < 1 || bil > 5000) throw new Error('Nombor murid tidak sah');
      const baris = [tarikh, selamatSheet_(sesi), selamatSheet_(kelas), bil, selamatSheet_(r.nama.trim()), r.status, selamatSheet_(r.masa), selamatSheet_(r.kaedah), sekarang, selamatSheet_(muridId)];
      const kunci = JSON.stringify([tarikh, sesi, kelas, muridId]);
      const kunciLama = JSON.stringify([tarikh, sesi, kelas, String(r.nama.trim())]);
      if (kunci in peta || kunciLama in peta) {
        const idx = (kunci in peta) ? peta[kunci] : peta[kunciLama];
        const lama = String(data[idx][5]);
        sh.getRange(idx + 2, 1, 1, HEADERS.length).setValues([baris]);
        kemas++;
        if (lama !== r.status) {
          logBaris.push([sekarang, 'Perubahan', selamatSheet_(tarikh), selamatSheet_(sesi), selamatSheet_(kelas), selamatSheet_(r.nama.trim()), selamatSheet_(lama), r.status, selamatSheet_(r.kaedah), '']);
        }
      } else {
        baru.push(baris);
        if (r.status === 'Hadir') {
          logBaris.push([sekarang, 'Perubahan', selamatSheet_(tarikh), selamatSheet_(sesi), selamatSheet_(kelas), selamatSheet_(r.nama.trim()), '-', r.status, selamatSheet_(r.kaedah), '']);
        }
      }
    });

    if (baru.length) {
      sh.getRange(sh.getLastRow() + 1, 1, baru.length, HEADERS.length).setValues(baru);
    }

    // Ringkasan hantaran + perubahan dalam Log (tambah sahaja)
    const ringkas = [
      sekarang, 'Hantaran', tarikh, sesi, '', '', '', '', '',
      rekod.length + ' murid, ' + hadir + ' hadir, ' + logBaris.length + ' perubahan'
    ];
    const log = getLogSheet_();
    const semua = [ringkas].concat(logBaris);
    log.getRange(log.getLastRow() + 1, 1, semua.length, LOG_HEADERS.length).setValues(semua);

    const kelasSet = {};
    rekod.forEach(function (r) { if (r.kelas) kelasSet[String(r.kelas)] = true; });
    Object.keys(kelasSet).forEach(binaJadual_);

    if (requestId) CacheService.getScriptCache().put('req:' + requestId, '1', 21600);
    return jsonOut_({
      ok: true,
      ditulis: kemas + baru.length,
      baharu: baru.length,
      dikemas: kemas,
      perubahan: logBaris.length
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ---------------- Baca (semakan & senarai murid) ---------------- */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    semakToken_(p.token);

    if (p.action !== 'murid') {
      // Semakan: buka URL /exec dalam pelayar untuk sahkan sambungan ke Sheet
      const ss = getSS_();
      return jsonOut_({
        ok: true,
        mesej: 'Hadir Wajah aktif',
        sheet: ss.getName(),
        tab: ss.getSheets().map(function (s) { return s.getName(); })
      });
    }

    const sh = getSS_().getSheetByName(SHEET_SENARAI);
    if (!sh) throw new Error('Tab "' + SHEET_SENARAI + '" tidak dijumpai. Jalankan fungsi sediakan() dahulu.');
    const last = sh.getLastRow();
    if (last < 2) return jsonOut_({ ok: true, murid: [] });

    const rows = sh.getRange(2, 1, last - 1, 2).getValues();
    const murid = rows
      .filter(function (r) { return r[0]; })
      .map(function (r) { return { nama: String(r[0]).trim(), kelas: String(r[1] || '').trim() }; });
    return jsonOut_({ ok: true, murid: murid });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err.message || err) });
  }
}
