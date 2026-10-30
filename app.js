/* ============================================================
 * Hadir Wajah - rekod kehadiran murid melalui pengecaman wajah
 * face-api.js (vladmandic) dihos tempatan. Tiada gambar disimpan.
 * ============================================================ */
import * as faceapi from './vendor/face-api.esm.js';
import { csvCell, escapeHtml, isValidBackup, uniqueNames } from './app-core.js';

const MODEL_URL = './vendor/models';
const LS = { settings: 'hw.settings', students: 'hw.students', att: 'hw.att', admin: 'hw.admin.auth' };
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 8;
const MARGIN = 0.03; // beza minima antara padanan terbaik & kedua (elak keliru)

const $ = (id) => document.getElementById(id);

/* ---------------- Keadaan ---------------- */
const defaults = {
  kelas: '',
  sesi: '',
  scriptUrl: 'https://script.google.com/macros/s/AKfycbyE0KJ2Wkp3iDpT7kJ4cztabUUc125GntD90N7u2SuPWsQJBtyue3CUdhGdlXkhx34K1g/exec',
  token: '',
  threshold: 0.5,
  hits: 3,
  consent: false
};
let settings = { ...defaults, ...load(LS.settings, {}) };
// Tetapan lama yang disimpan tanpa URL tidak boleh mengatasi URL lalai aplikasi.
if (!String(settings.scriptUrl || '').trim()) settings.scriptUrl = defaults.scriptUrl;
settings.threshold = Number(settings.threshold);
settings.hits = parseInt(settings.hits, 10);
if (!Number.isFinite(settings.threshold) || settings.threshold < 0.35 || settings.threshold > 0.60) settings.threshold = defaults.threshold;
if (!Number.isInteger(settings.hits) || settings.hits < 2 || settings.hits > 8) settings.hits = defaults.hits;
let students = load(LS.students, []); // {id, nama, kelas, d:[[128]...]}
if (!Array.isArray(students)) students = [];
students.forEach((student) => { if (!student.kelas) student.kelas = ''; });
let attendance = load(LS.att, {}); // {"tarikh|sesi": {id: {masa, kaedah}}}
if (!attendance || typeof attendance !== 'object' || Array.isArray(attendance)) attendance = {};

let modelsReady = false;
let stream = null;
let facingMode = 'user';
let loopActive = false;
let active = null; // {video, canvas, stage, mode}
let lastResults = [];
let hitCounter = {};
let enrolStudent = null;
let enrolSamples = [];
let frames = 0;
let fpsLast = performance.now();
let toastTimer = 0;
let audioCtx = null;
let isAdmin = sessionStorage.getItem('hw.admin.session') === '1';

/* ---------------- Simpanan ---------------- */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    toast('Gagal menyimpan data: storan penuh atau disekat.', 'err');
    return false;
  }
}
const saveSettings = () => save(LS.settings, settings);
const saveStudents = () => save(LS.students, students);
const saveAtt = () => save(LS.att, attendance);

let scanClassFilter = '';
let scanNameQuery = '';
let studentClassFilter = '';

function activeStudents() {
  if (!scanClassFilter) return [];
  const query = scanNameQuery.trim().toLocaleLowerCase();
  return students.filter((student) => {
    const sameClass = String(student.kelas || '').trim() === scanClassFilter;
    const sameName = !query || String(student.nama || '').toLocaleLowerCase().includes(query);
    return sameClass && sameName;
  });
}

function studentClasses() {
  return [...new Set(students.map((s) => String(s.kelas || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ms'));
}

function filteredStudents() {
  return studentClassFilter
    ? students.filter((s) => String(s.kelas || '').trim() === studentClassFilter)
    : students;
}

function refreshStudentClassFilters() {
  const classes = studentClasses();
  const scanFilter = $('scanClassFilter');
  const filter = $('studentClassFilter');
  if (scanFilter) {
    scanFilter.innerHTML = '<option value="">Pilih kelas</option>' + classes.map((kelas) =>
      `<option value="${esc(kelas)}">${esc(kelas)}</option>`).join('');
    scanFilter.value = classes.includes(scanClassFilter) ? scanClassFilter : '';
    scanClassFilter = scanFilter.value;
  }
  const add = $('addStudentClass');
  if (filter) {
    const selected = studentClassFilter;
    filter.innerHTML = '<option value="">Semua kelas</option>' + classes.map((kelas) =>
      `<option value="${esc(kelas)}">${esc(kelas)}</option>`).join('');
    filter.value = classes.includes(selected) ? selected : '';
    studentClassFilter = filter.value;
  }
  if (add) {
    const options = $('studentClassOptions');
    if (options) options.innerHTML = classes.map((kelas) => `<option value="${esc(kelas)}"></option>`).join('');
  }
}

async function hashAdminPin(pin, salt) {
  const saltBytes = Uint8Array.from(salt.match(/.{1,2}/g).map((hex) => parseInt(hex, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 210000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function legacyHashAdminPin(pin, salt) {
  const bytes = new TextEncoder().encode(salt + ':' + pin);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function initAdminLogin(open = false) {
  const overlay = $('adminLogin');
  const setup = !load(LS.admin, null);
  $('adminPinConfirmWrap').hidden = !setup;
  $('adminLoginDesc').textContent = setup
    ? 'Tetapkan PIN pentadbir buat kali pertama. Gunakan sekurang-kurangnya 4 digit.'
    : 'Masukkan PIN pentadbir untuk mengurus murid dan kehadiran manual.';
  $('adminLoginTitle').textContent = setup ? 'Tetapkan PIN pentadbir' : 'Log masuk pentadbir';
  $('adminLoginBtn').textContent = setup ? 'Simpan PIN' : 'Log masuk';
  overlay.hidden = isAdmin || !open;
  $('adminPin').value = '';
  $('adminPinConfirm').value = '';
  $('adminLoginError').hidden = true;
  if (!overlay.hidden) setTimeout(() => $('adminPin').focus(), 0);
  updateAdminMode();
}

async function loginAdmin() {
  const pin = $('adminPin').value.trim();
  const confirmPin = $('adminPinConfirm').value.trim();
  const error = $('adminLoginError');
  error.hidden = true;
  if (!/^\d{4,12}$/.test(pin)) {
    error.textContent = 'PIN mesti 4 hingga 12 digit.';
    error.hidden = false;
    return;
  }

  const stored = load(LS.admin, null);
  if (!stored) {
    if (pin !== confirmPin) {
      error.textContent = 'Sahkan PIN tidak sepadan.';
      error.hidden = false;
      return;
    }
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!save(LS.admin, { salt, hash: await hashAdminPin(pin, salt), version: 2 })) return;
  } else {
    let valid = (await hashAdminPin(pin, stored.salt)) === stored.hash;
    if (!valid && stored.version !== 2) valid = (await legacyHashAdminPin(pin, stored.salt)) === stored.hash;
    if (!valid) {
      error.textContent = 'PIN tidak betul.';
      error.hidden = false;
      $('adminPin').select();
      return;
    }
    if (stored.version !== 2) {
      save(LS.admin, { salt: stored.salt, hash: await hashAdminPin(pin, stored.salt), version: 2 });
    }
  }

  isAdmin = true;
  sessionStorage.setItem('hw.admin.session', '1');
  $('adminLogin').hidden = true;
  $('logoutBtn').hidden = false;
  $('loginAdminBtn').hidden = true;
  updateAdminMode();
  renderAttendance();
  initConsent();
  toast('Log masuk pentadbir berjaya.', 'ok');
}

function requireAdmin(action) {
  if (isAdmin) return true;
  initAdminLogin(true);
  $('adminLoginDesc').textContent = action || 'Log masuk pentadbir untuk meneruskan tindakan ini.';
  setTimeout(() => $('adminPin').focus(), 0);
  return false;
}

function updateAdminMode() {
  document.querySelectorAll('[data-admin-only]').forEach((el) => { el.hidden = !isAdmin; });
  $('loginAdminBtn').hidden = isAdmin;
  $('logoutBtn').hidden = !isAdmin;
  if (!isAdmin && document.querySelector('.tab-btn.active')?.dataset.tab !== 'scan') switchTab('scan');
  renderAttendance();
}

// Cache Float32Array untuk padanan pantas
function hydrate() {
  students.forEach((s) => {
    s._f = (s.d || []).map((a) => new Float32Array(a));
  });
}
hydrate();

/* ---------------- Utiliti ---------------- */
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function todayStr() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}
function uid() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function esc(s) {
  return escapeHtml(s);
}
function avatar(nama) {
  const words = nama.replace(/\b(bin|binti|b\.|bt\.|a\/l|a\/p)\b/gi, ' ').split(/\s+/).filter(Boolean);
  const ini = ((words[0] || '?')[0] + ((words[1] || '')[0] || '')).toUpperCase();
  let h = 0;
  for (const c of nama) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar" style="--h:${h}" aria-hidden="true">${esc(ini)}</span>`;
}
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.12);
  } catch {}
  if (navigator.vibrate) navigator.vibrate(60);
}

/* ---------------- Rekod kehadiran ---------------- */
const attKey = () => `${$('fDate').value || todayStr()}|${($('fSesi').value || '').trim() || '-'}`;
function currentAtt() {
  const k = attKey();
  if (!attendance[k]) attendance[k] = {};
  return attendance[k];
}
function markPresent(id, kaedah) {
  const rec = currentAtt();
  if (rec[id]) return false;
  rec[id] = { masa: nowTime(), kaedah };
  saveAtt();
  renderAttendance();
  return true;
}
function unmark(id) {
  const rec = currentAtt();
  delete rec[id];
  saveAtt();
  renderAttendance();
}

/* ---------------- Paparan: senarai kehadiran ---------------- */
function renderAttendance() {
  const rec = attendance[attKey()] || {};
  const list = $('attList');
  const current = activeStudents();
  const present = current.filter((s) => rec[s.id]).length;
  $('cntPresent').textContent = present;
  $('cntAbsent').textContent = current.length - present;
  $('cntTotal').textContent = current.length;
  $('attEmpty').hidden = current.length > 0;
  $('attEmpty').innerHTML = scanClassFilter
    ? (scanNameQuery ? 'Tiada murid sepadan dengan carian.' : 'Tiada murid dalam kelas dipilih.')
    : 'Pilih kelas dahulu untuk memaparkan senarai murid.';

  const pct = current.length ? present / current.length : 0;
  $('ringFg').style.strokeDashoffset = String(188.5 * (1 - pct));
  $('ringPct').textContent = `${Math.round(pct * 100)}%`;

  list.innerHTML = activeStudents()
    .map((s) => {
      const r = rec[s.id];
      return `<li class="row ${r ? 'present' : ''}">
        ${avatar(s.nama)}
        <span class="name">${esc(s.nama)}<span class="meta">${r ? `${r.masa} · ${r.kaedah}` : 'Belum hadir'}</span></span>
        <span class="tag">${r ? '✓ Hadir' : ''}</span>
        ${isAdmin ? `<span class="actions"><button class="btn btn-tiny" data-act="toggle" data-id="${s.id}">${r ? 'Batal' : 'Tanda'}</button></span>` : ''}
      </li>`;
    })
    .join('');
}

/* ---------------- Paparan: senarai murid ---------------- */
function renderStudents() {
  const list = $('stuList');
  const current = filteredStudents();
  const enrolled = current.filter((s) => s.d && s.d.length >= MIN_SAMPLES).length;
  $('enrolSummary').textContent = `${enrolled}/${current.length} berdaftar`;
  $('stuEmpty').hidden = current.length > 0;

  list.innerHTML = current
    .map((s) => {
      const n = s.d ? s.d.length : 0;
      const ok = n >= MIN_SAMPLES;
      return `<li class="row ${ok ? 'present' : ''}">
        ${avatar(s.nama)}
        <span class="name">${esc(s.nama)}<span class="meta">${esc(s.kelas || 'Kelas belum ditetapkan')} · ${ok ? n + ' sampel wajah' : 'Belum daftar wajah'}</span></span>
        <span class="actions">
          <button class="btn btn-tiny" data-act="enrol" data-id="${s.id}">${ok ? 'Daftar semula' : 'Daftar wajah'}</button>
          ${n ? `<button class="btn btn-tiny" data-act="clearface" data-id="${s.id}">Padam wajah</button>` : ''}
          <button class="btn btn-tiny btn-danger" data-act="remove" data-id="${s.id}">Buang</button>
        </span>
      </li>`;
    })
    .join('');
}

/* ---------------- Model & TensorFlow ---------------- */
async function ensureModels(setText) {
  if (modelsReady) return;
  setText('Menyediakan enjin AI...');
  let ok = false;
  try {
    ok = await faceapi.tf.setBackend('webgl');
  } catch {}
  if (!ok) await faceapi.tf.setBackend('cpu');
  await faceapi.tf.ready();

  setText('Memuatkan model wajah...');
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  modelsReady = true;
  console.log('[AI] Model dimuat. Backend:', faceapi.tf.getBackend());
}

/* ---------------- Kamera ---------------- */
async function openCamera(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Pelayar tidak menyokong kamera, atau halaman bukan HTTPS/localhost.');
  }
  closeStream();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }
  });
  video.srcObject = stream;
  video.classList.toggle('mirror', facingMode === 'user');
  await new Promise((res, reject) => {
    const timeout = setTimeout(() => reject(new Error('Kamera mengambil masa terlalu lama untuk bersedia.')), 15000);
    const ready = () => {
      if (video.readyState >= 2 && video.videoWidth) {
        clearTimeout(timeout);
        res();
      }
    };
    video.onloadedmetadata = ready;
    video.onloadeddata = ready;
    ready();
  });
  await video.play();
}
function closeStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
function cameraError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kebenaran kamera ditolak. Benarkan akses kamera dalam tetapan pelayar.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kamera tidak dijumpai pada peranti ini.';
    case 'NotReadableError':
      return 'Kamera sedang digunakan oleh aplikasi lain.';
    default:
      return 'Ralat: ' + (err && err.message ? err.message : err);
  }
}

/* ---------------- Gelung pengesanan ---------------- */
const detOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

async function loop() {
  if (!loopActive || !active) return;
  const { video, canvas } = active;
  if (video.readyState >= 2 && video.videoWidth) {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    let results = [];
    try {
      results = await faceapi.detectAllFaces(video, detOpts()).withFaceLandmarks(true).withFaceDescriptors();
    } catch (e) {
      console.warn('[AI] pengesanan gagal:', e);
    }
    if (!loopActive || !active) return;
    lastResults = results;
    if (active.mode === 'scan') handleScan(results);
    else handleEnrol(results);

    frames++;
    const now = performance.now();
    if (now - fpsLast >= 1000) {
      $('fpsTag').textContent = `${Math.round((frames * 1000) / (now - fpsLast))} FPS`;
      frames = 0;
      fpsLast = now;
    }
  }
  requestAnimationFrame(loop);
}

function stopLoop() {
  loopActive = false;
  closeStream();
  if (active) {
    const { canvas, stage, video } = active;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    stage.classList.remove('live');
    video.srcObject = null;
  }
  lastResults = [];
  hitCounter = {};
}

/* ---------------- Padanan wajah ---------------- */
function matchDescriptor(desc) {
  let best = { id: null, dist: 9 };
  let second = 9;
  for (const s of activeStudents()) {
    if (!s._f || s._f.length < MIN_SAMPLES) continue;
    let m = 9;
    for (const f of s._f) {
      const d = faceapi.euclideanDistance(desc, f);
      if (d < m) m = d;
    }
    if (m < best.dist) {
      second = best.dist;
      best = { id: s.id, dist: m };
    } else if (m < second) {
      second = m;
    }
  }
  if (best.id && best.dist <= settings.threshold && second - best.dist >= MARGIN) return best;
  return { id: null, dist: best.dist };
}

function drawBox(ctx, w, box, mirrored, label, color) {
  const x = mirrored ? w - (box.x + box.width) : box.x;
  const lw = Math.max(2, w / 400);
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.strokeRect(x, box.y, box.width, box.height);

  const fs = Math.max(14, Math.round(w / 36));
  ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  const tw = Math.min(ctx.measureText(label).width + fs, w - 8);
  const th = fs * 1.7;
  let lx = Math.max(4, Math.min(x, w - tw - 4));
  const ly = Math.max(4, box.y - th - 2);
  ctx.fillStyle = color;
  ctx.fillRect(lx, ly, tw, th);
  ctx.fillStyle = '#05070f';
  ctx.fillText(label, lx + fs / 2, ly + th / 2, tw - fs);
}

function handleScan(results) {
  const { canvas } = active;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mirrored = facingMode === 'user';
  const rec = currentAtt();
  const seen = new Set();

  results.forEach((r) => {
    const m = matchDescriptor(r.descriptor);
    if (m.id) {
      const s = students.find((x) => x.id === m.id);
      seen.add(m.id);
      hitCounter[m.id] = (hitCounter[m.id] || 0) + 1;
      if (rec[m.id]) {
        drawBox(ctx, canvas.width, r.detection.box, mirrored, `✓ ${s.nama}`, '#30d158');
      } else if (hitCounter[m.id] >= settings.hits) {
        if (markPresent(m.id, 'wajah')) {
          beep();
          toast(`Hadir: ${s.nama}`, 'ok');
        }
        drawBox(ctx, canvas.width, r.detection.box, mirrored, `✓ ${s.nama}`, '#30d158');
      } else {
        drawBox(ctx, canvas.width, r.detection.box, mirrored, `${s.nama} (${hitCounter[m.id]}/${settings.hits})`, '#0a84ff');
      }
    } else {
      drawBox(ctx, canvas.width, r.detection.box, mirrored, 'Tidak dikenali', '#ff9f0a');
    }
  });

  // Kurangkan kiraan bagi yang tidak kelihatan bingkai ini
  Object.keys(hitCounter).forEach((id) => {
    if (!seen.has(id)) hitCounter[id] = Math.max(0, hitCounter[id] - 1);
  });

  $('statusScan').textContent = results.length
    ? `${results.length} wajah dikesan.`
    : 'Mencari wajah...';
  $('statusScan').classList.remove('error');
}

function handleEnrol(results) {
  const { canvas } = active;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mirrored = facingMode === 'user';
  results.forEach((r) => {
    drawBox(ctx, canvas.width, r.detection.box, mirrored, results.length === 1 ? 'Sedia' : 'Hanya satu wajah', results.length === 1 ? '#30d158' : '#ff9f0a');
  });
  const el = $('statusEnrol');
  el.classList.remove('error');
  el.textContent =
    results.length === 0 ? 'Tiada wajah dikesan.' : results.length > 1 ? 'Lebih satu wajah. Sila pastikan seorang sahaja.' : 'Wajah dikesan. Tekan Ambil sampel.';
}

/* ---------------- Imbas ---------------- */
async function toggleScan() {
  const btn = $('btnScan');
  if (!loopActive && !scanClassFilter) {
    toast('Pilih kelas dahulu sebelum memulakan imbasan.', 'err');
    $('scanClassFilter').focus();
    return;
  }
  if (loopActive) {
    stopLoop();
    btn.textContent = 'Mula Imbas';
    btn.classList.remove('running');
    $('btnFlipScan').disabled = true;
    $('fpsTag').hidden = true;
    $('statusScan').textContent = 'Dihentikan.';
    return;
  }
  btn.disabled = true;
  const ph = $('phScan');
  ph.classList.add('loading');
  const setText = (t) => {
    $('phScanText').textContent = t;
    $('statusScan').textContent = t;
  };
  try {
    await ensureModels(setText);
    setText('Meminta kebenaran kamera...');
    await openCamera($('vidScan'));
    active = { video: $('vidScan'), canvas: $('cvScan'), stage: $('stageScan'), mode: 'scan' };
    $('stageScan').classList.add('live');
    btn.textContent = 'Henti Imbas';
    btn.classList.add('running');
    $('btnFlipScan').disabled = false;
    $('fpsTag').hidden = false;
    hitCounter = {};
    loopActive = true;
    frames = 0;
    fpsLast = performance.now();
    loop();
  } catch (err) {
    console.error(err);
    closeStream();
    const msg = cameraError(err);
    $('statusScan').textContent = msg;
    $('statusScan').classList.add('error');
    $('phScanText').innerHTML = 'Gagal memulakan. Tekan <strong>Mula Imbas</strong> untuk cuba lagi.';
  } finally {
    ph.classList.remove('loading');
    btn.disabled = false;
  }
}

async function flipCamera(video, statusEl) {
  const prev = facingMode;
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  try {
    await openCamera(video);
  } catch (e) {
    facingMode = prev;
    try {
      await openCamera(video);
    } catch {}
    statusEl.textContent = 'Tidak dapat menukar kamera pada peranti ini.';
    statusEl.classList.add('error');
  }
}

/* ---------------- Pendaftaran wajah ---------------- */
async function startEnrol(id) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  enrolStudent = s;
  enrolSamples = [];
  $('enrolTitle').textContent = `Daftar wajah: ${s.nama}`;
  updateSampleUI();
  $('listView').hidden = true;
  $('enrolView').hidden = false;
  window.scrollTo({ top: 0 });

  const ph = $('phEnrol');
  ph.classList.add('loading');
  const st = $('statusEnrol');
  st.classList.remove('error');
  try {
    await ensureModels((t) => (st.textContent = t));
    await openCamera($('vidEnrol'));
    active = { video: $('vidEnrol'), canvas: $('cvEnrol'), stage: $('stageEnrol'), mode: 'enrol' };
    $('stageEnrol').classList.add('live');
    loopActive = true;
    loop();
  } catch (err) {
    console.error(err);
    st.textContent = cameraError(err);
    st.classList.add('error');
  } finally {
    ph.classList.remove('loading');
  }
}

function updateSampleUI() {
  $('btnSample').textContent = `Ambil sampel (${enrolSamples.length})`;
  $('btnEnrolSave').disabled = enrolSamples.length < MIN_SAMPLES;
  $('btnSample').disabled = enrolSamples.length >= MAX_SAMPLES;
}

function takeSample() {
  const st = $('statusEnrol');
  if (lastResults.length !== 1) {
    st.textContent = lastResults.length === 0 ? 'Tiada wajah dikesan.' : 'Pastikan hanya seorang dalam bingkai.';
    st.classList.add('error');
    return;
  }
  const r = lastResults[0];
  const vw = active.video.videoWidth;
  if (r.detection.score < 0.6 || r.detection.box.width < vw * 0.15) {
    st.textContent = 'Wajah terlalu kecil atau kurang jelas. Dekatkan sedikit.';
    st.classList.add('error');
    return;
  }
  if (enrolSamples.some((sample) => faceapi.euclideanDistance(Array.from(r.descriptor), sample) < 0.08)) {
    st.textContent = 'Sampel terlalu serupa. Tukar sedikit pose, jarak atau ekspresi.';
    st.classList.add('error');
    return;
  }
  enrolSamples.push(Array.from(r.descriptor));
  st.classList.remove('error');
  updateSampleUI();
  beep();
  toast(`Sampel ${enrolSamples.length} diambil`, 'ok');
}

function finishEnrol() {
  stopLoop();
  active = null;
  enrolStudent = null;
  enrolSamples = [];
  $('enrolView').hidden = true;
  $('listView').hidden = false;
  renderStudents();
}

function saveEnrol() {
  if (!enrolStudent || enrolSamples.length < MIN_SAMPLES) return;
  // Semak sama ada hampir sama dengan murid lain
  const probe = enrolSamples.map((a) => new Float32Array(a));
  for (const o of students) {
    if (o.id === enrolStudent.id || !o._f) continue;
    const close = probe.some((p) => o._f.some((f) => faceapi.euclideanDistance(p, f) < 0.4));
    if (close && !confirm(`Wajah ini sangat hampir dengan "${o.nama}". Teruskan simpan?`)) return;
  }
  enrolStudent.d = enrolSamples.map((a) => a.map((v) => Math.round(v * 10000) / 10000));
  enrolStudent._f = enrolStudent.d.map((a) => new Float32Array(a));
  saveStudents();
  toast(`${enrolStudent.nama} berjaya didaftarkan`, 'ok');
  finishEnrol();
}

/* ---------------- Senarai murid ---------------- */
function addNames(text) {
  const kelas = $('addStudentClass') ? $('addStudentClass').value.trim() : '';
  const existingNames = students.filter((s) => s.kelas === kelas).map((s) => s.nama);
  const names = uniqueNames(text, existingNames);
  names.forEach((nama) => students.push({ id: uid(), nama, kelas, d: [], _f: [] }));
  const added = names.length;
  saveStudents();
  refreshStudentClassFilters();
  renderStudents();
  renderAttendance();
  return added;
}

async function loadFromSheet() {
  if (!settings.scriptUrl) return toast('Isi URL Web App dalam Tetapan dahulu.', 'err');
  const btn = $('btnLoadSheet');
  btn.disabled = true;
  btn.textContent = 'Memuat...';
  try {
    const u = new URL(settings.scriptUrl);
    u.pathname = u.pathname.replace(/\/dev$/, '/exec');

    let data;
    let errorMessage = '';
    try {
      const res = await fetch(u.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'murid', token: settings.token || '' })
      });
      const text = await res.text();
      try { data = JSON.parse(text); }
      catch { errorMessage = text.trim().slice(0, 160); }
    } catch (e) {
      errorMessage = e.message;
    }

    // Fallback untuk deployment Apps Script lama yang masih hanya menyokong GET.
    if (!data) {
      u.searchParams.set('action', 'murid');
      u.searchParams.set('token', settings.token || '');
      const res = await fetch(u.toString());
      const text = await res.text();
      try { data = JSON.parse(text); }
      catch { throw new Error(errorMessage || text.trim().slice(0, 160) || 'Pelayan tidak mengembalikan JSON.'); }
    }

    if (!data.ok) throw new Error(data.error || 'Ralat tidak diketahui');
    const rows = (Array.isArray(data.murid) ? data.murid : []).map((item) =>
      typeof item === 'string' ? { nama: item.trim(), kelas: '' } : { nama: String(item.nama || '').trim(), kelas: String(item.kelas || '').trim() }
    ).filter((item) => item.nama);
    if (!rows.length) throw new Error('Tiada nama murid dijumpai dalam tab Senarai.');
    let added = 0;
    rows.forEach((row) => {
      const key = row.nama.toLowerCase();
      const existing = students.find((s) => s.nama.toLowerCase() === key);
      if (existing) {
        existing.kelas = row.kelas || existing.kelas || '';
      } else {
        students.push({ id: uid(), nama: row.nama, kelas: row.kelas, d: [], _f: [] });
        added++;
      }
    });
    saveStudents();
    refreshStudentClassFilters();
    renderStudents();
    renderAttendance();
    toast(added ? `${added} murid baharu dimuat` : 'Semua nama dan kelas dari Sheet sudah dikemas kini.', added ? 'ok' : '');
  } catch (e) {
    toast('Gagal memuat dari Sheet: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Dari Sheet';
  }
}

/* ---------------- Eksport & Sheet ---------------- */
function buildRecords() {
  const rec = attendance[attKey()] || {};
  return activeStudents().map((s, i) => {
    const r = rec[s.id];
    return {
      id: s.id,
      bil: i + 1,
      nama: s.nama,
      kelas: s.kelas || '',
      status: r ? 'Hadir' : 'Tidak Hadir',
      masa: r ? r.masa : '',
      kaedah: r ? r.kaedah : ''
    };
  });
}

function exportCsv() {
  if (!activeStudents().length) return toast('Tiada murid untuk dieksport.', 'err');
  const tarikh = $('fDate').value || todayStr();
  const sesi = ($('fSesi').value || '').trim();
  const csvSafe = csvCell;
  const lines = [['Tarikh', 'Sesi', 'Kelas', 'Bil', 'Nama', 'Status', 'Masa', 'Kaedah'].map(csvSafe).join(',')];
  buildRecords().forEach((r) => {
    lines.push([tarikh, sesi, r.kelas, r.bil, r.nama, r.status, r.masa, r.kaedah].map(csvSafe).join(','));
  });
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kehadiran_${tarikh}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function sendToSheet() {
  if (!settings.scriptUrl) return toast('Isi URL Web App dalam Tetapan dahulu.', 'err');
  if (!activeStudents().length) return toast('Tiada murid untuk dihantar.', 'err');
  if (!navigator.onLine) return toast('Anda luar talian. Cuba lagi bila dalam talian.', 'err');
  const btn = $('btnSend');
  btn.disabled = true;
  btn.textContent = 'Menghantar...';
  const payload = {
    requestId: uid(),
    token: settings.token || '',
    kelas: '',
    tarikh: $('fDate').value || todayStr(),
    sesi: ($('fSesi').value || '').trim(),
    rekod: buildRecords()
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(settings.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Pelayan mengembalikan respons yang tidak sah.'); }

    if (!data.ok) throw new Error(data.error || 'Ditolak oleh pelayan');
    toast(`Dihantar: ${data.ditulis} baris dikemas kini`, 'ok');
  } catch (e) {
    toast('Gagal menghantar: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Hantar ke Google Sheet';
  }
}

/* ---------------- Tab ---------------- */
function switchTab(name) {
  // Lepaskan kamera apabila bertukar tab
  if (loopActive) {
    if (active && active.mode === 'enrol') finishEnrol();
    else {
      stopLoop();
      $('btnScan').textContent = 'Mula Imbas';
      $('btnScan').classList.remove('running');
      $('btnFlipScan').disabled = true;
      $('fpsTag').hidden = true;
      $('statusScan').textContent = 'Dihentikan.';
    }
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const selected = b.dataset.tab === name;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
    b.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    const selected = p.id === 'tab-' + name;
    p.classList.toggle('active', selected);
    p.setAttribute('aria-hidden', selected ? 'false' : 'true');
  });
}

/* ---------------- Pengendali acara ---------------- */
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false');
  b.addEventListener('click', () => switchTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll('.tab-btn')];
    const next = (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
});

$('btnScan').addEventListener('click', toggleScan);
$('btnFlipScan').addEventListener('click', async () => {
  $('btnFlipScan').disabled = true;
  await flipCamera($('vidScan'), $('statusScan'));
  $('btnFlipScan').disabled = false;
});
$('btnFlipEnrol').addEventListener('click', () => flipCamera($('vidEnrol'), $('statusEnrol')));

$('scanClassFilter').addEventListener('change', (e) => {
  scanClassFilter = e.target.value;
  scanNameQuery = '';
  $('scanNameSearch').value = '';
  $('scanNameSearch').disabled = !scanClassFilter;
  renderAttendance();
});
$('scanNameSearch').addEventListener('input', (e) => {
  scanNameQuery = e.target.value;
  renderAttendance();
});
$('studentClassFilter').addEventListener('change', (e) => {
  studentClassFilter = e.target.value;
  renderStudents();
});
$('fDate').addEventListener('change', renderAttendance);
$('fSesi').addEventListener('input', () => {
  settings.sesi = $('fSesi').value;
  saveSettings();
  renderAttendance();
});

$('attList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act="toggle"]');
  if (!b) return;
  if (!requireAdmin('Log masuk untuk menanda atau membatalkan kehadiran manual.')) return;
  const id = b.dataset.id;
  const rec = currentAtt();
  if (rec[id]) unmark(id);
  else markPresent(id, 'manual');
});

$('btnAddNames').addEventListener('click', () => {
  if (!requireAdmin('Log masuk untuk menambah murid.')) return;
  const t = $('namesInput').value;
  if (!t.trim()) return toast('Tampal senarai nama dahulu.', 'err');
  const n = addNames(t);
  $('namesInput').value = '';
  toast(n ? `${n} murid ditambah` : 'Tiada nama baharu (mungkin sudah ada).', n ? 'ok' : '');
});
$('btnLoadSheet').addEventListener('click', () => {
  if (requireAdmin('Log masuk untuk menarik senarai murid daripada Google Sheet.')) loadFromSheet();
});

$('stuList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const s = students.find((x) => x.id === id);
  if (!s) return;
  switch (b.dataset.act) {
    case 'enrol':
      if (requireAdmin('Log masuk untuk mendaftar atau mengemas kini wajah murid.')) startEnrol(id);
      break;
    case 'clearface':
      if (!requireAdmin('Log masuk untuk memadam data wajah murid.')) break;
      if (confirm(`Padam data wajah ${s.nama}?`)) {
        s.d = [];
        s._f = [];
        saveStudents();
        renderStudents();
      }
      break;
    case 'remove':
      if (!requireAdmin('Log masuk untuk membuang murid.')) break;
      if (confirm(`Buang ${s.nama} daripada senarai (termasuk data wajah)?`)) {
        students = students.filter((x) => x.id !== id);
        saveStudents();
        refreshStudentClassFilters();
        renderStudents();
        renderAttendance();
      }
      break;
  }
});

$('btnSample').addEventListener('click', takeSample);
$('btnEnrolSave').addEventListener('click', saveEnrol);
$('btnEnrolReset').addEventListener('click', () => {
  enrolSamples = [];
  updateSampleUI();
});
$('btnEnrolCancel').addEventListener('click', finishEnrol);

$('btnCsv').addEventListener('click', exportCsv);
$('btnSend').addEventListener('click', sendToSheet);

/* Tetapan */
function bindSetting(id, key, transform = (v) => v, after) {
  const el = $(id);
  el.addEventListener('input', () => {
    settings[key] = transform(el.value);
    saveSettings();
    if (after) after();
  });
}
bindSetting('sUrl', 'scriptUrl', (v) => v.trim());
bindSetting('sToken', 'token', (v) => v.trim());
bindSetting('sThr', 'threshold', parseFloat, () => ($('sThrVal').textContent = settings.threshold.toFixed(2)));
bindSetting('sHits', 'hits', (v) => parseInt(v, 10), () => ($('sHitsVal').textContent = settings.hits));

function exportBackup() {
  if (!requireAdmin('Log masuk untuk membuat sandaran data.')) return;
  const backup = {
    app: 'Hadir Wajah',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    students,
    attendance
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hadir-wajah-sandaran-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function restoreBackup(file) {
  if (!requireAdmin('Log masuk untuk memulihkan sandaran.')) return;
  try {
    const data = JSON.parse(await file.text());
    if (!isValidBackup(data)) {
      throw new Error('Format fail sandaran tidak sah.');
    }
    if (!confirm('Pulihkan sandaran ini? Data murid dan rekod semasa akan diganti.')) return;
    settings = { ...defaults, ...(data.settings || {}) };
    students = data.students;
    attendance = data.attendance;
    hydrate();
    $('fSesi').value = settings.sesi || '';
    $('sUrl').value = settings.scriptUrl || '';
    $('sToken').value = settings.token || '';
    $('sThr').value = settings.threshold;
    $('sThrVal').textContent = settings.threshold.toFixed(2);
    $('sHits').value = settings.hits;
    $('sHitsVal').textContent = settings.hits;
    save(LS.settings, settings);
    saveStudents();
    saveAtt();
    refreshStudentClassFilters();
    renderStudents();
    renderAttendance();
    toast('Sandaran berjaya dipulihkan.', 'ok');
  } catch (e) {
    toast('Gagal memulihkan: ' + e.message, 'err');
  } finally {
    $('restoreFile').value = '';
  }
}

$('btnBackup').addEventListener('click', exportBackup);
$('btnRestore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) restoreBackup(e.target.files[0]);
});

$('btnWipeFaces').addEventListener('click', () => {
  if (!requireAdmin('Log masuk untuk memadam data wajah.')) return;
  if (!confirm('Padam data wajah SEMUA murid? Senarai nama dan rekod hadir dikekalkan.')) return;
  students.forEach((s) => {
    s.d = [];
    s._f = [];
  });
  saveStudents();
  renderStudents();
  toast('Semua data wajah dipadam.', 'ok');
});
$('btnWipeAll').addEventListener('click', () => {
  if (!requireAdmin('Log masuk untuk memadam semua data.')) return;
  if (!confirm('Padam SEMUA data (murid, wajah, rekod kehadiran, tetapan)?')) return;
  if (loopActive) stopLoop();
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  location.reload();
});

/* Persetujuan */
function initConsent() {
  if (settings.consent) return;
  $('consent').hidden = false;
  $('consentCheck').addEventListener('change', (e) => ($('consentBtn').disabled = !e.target.checked));
  $('consentBtn').addEventListener('click', () => {
    settings.consent = true;
    saveSettings();
    $('consent').hidden = true;
  });
}

/* Pentadbir */
$('loginAdminBtn').addEventListener('click', () => initAdminLogin(true));
$('adminLoginBtn').addEventListener('click', loginAdmin);
$('adminLoginCancel').addEventListener('click', () => { $('adminLogin').hidden = true; });
$('adminPin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginAdmin();
});
$('adminPinConfirm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginAdmin();
});
$('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('hw.admin.session');
  isAdmin = false;
  $('logoutBtn').hidden = true;
  updateAdminMode();
  initAdminLogin(false);
});

/* Rangkaian & pemasangan */
function updateNet() {
  const on = navigator.onLine;
  $('netBadge').textContent = on ? 'Dalam talian' : 'Luar talian';
  $('netBadge').classList.toggle('pill-online', on);
  $('netBadge').classList.toggle('pill-offline', !on);
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => ($('installBtn').hidden = true));
window.addEventListener('swupdateavailable', () => {
  if (confirm('Versi baharu Hadir Wajah tersedia. Muat semula sekarang?')) location.reload();
});
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !(window.navigator.standalone === true)) $('iosHint').hidden = false;

document.addEventListener('visibilitychange', () => {
  if (document.hidden && loopActive && active && active.mode === 'scan') {
    // Jimat bateri & privasi: henti kamera bila app di latar belakang
    switchTab('scan');
  }
});

/* ---------------- Permulaan ---------------- */
$('fDate').value = todayStr();
$('fSesi').value = settings.sesi || '';
$('sUrl').value = settings.scriptUrl || '';
$('sToken').value = settings.token || '';
$('sThr').value = settings.threshold;
$('sThrVal').textContent = Number(settings.threshold).toFixed(2);
$('sHits').value = settings.hits;
$('sHitsVal').textContent = settings.hits;
refreshStudentClassFilters();
$('scanNameSearch').disabled = !scanClassFilter;
renderAttendance();
updateNet();
renderAttendance();
renderStudents();
updateAdminMode();
$('logoutBtn').hidden = !isAdmin;
initAdminLogin(false).then(() => {
  if (isAdmin) initConsent();
});

