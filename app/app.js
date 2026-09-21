/* ============================================================
   SplitFace — app logic (100% client-side, no backend)
   - Photo upload (picker + drag & drop) with validation
   - Face detection via vendored MediaPipe BlazeFace (wasm,
     single-threaded fallback — no COOP/COEP headers needed)
   - Eye-based auto-alignment, draggable split line, flip sides
   - PNG export (384x480 free watermarked / 2160x2700 HD + 3240x4050 4K pro)
   ============================================================ */

'use strict';

/* MediaPipe's TFLite runtime prints a single informational line
   ("Created TensorFlow Lite XNNPACK delegate for CPU") via
   console.error when the model first loads. Filter that one known-
   benign message so the console stays clean on the happy path. */
(() => {
  const rawError = console.error.bind(console);
  console.error = (...args) => {
    if (args.length > 0 && typeof args[0] === 'string' &&
        args[0].indexOf('XNNPACK delegate for CPU') !== -1) return;
    rawError(...args);
  };
})();

/* ---------------- Config / state ---------------- */
const PAYMENT_URL =
  (window.SPLITFACE_CONFIG && window.SPLITFACE_CONFIG.PAYMENT_URL) || '';

const S = {
  photos: { A: null, B: null }, // {canvas,w,h,name,thumb,faceStatus,eyes,centerCrop,noFaceDismissed}
  split: 0.5,
  flipped: false,
  seam: 'soft', // 'soft' (feathered blend) | 'hard' (crisp classic split)
  variant: 'soft', // 'classic' | 'soft' | 'flipped' — the Style segmented control
  pro: false, // set at boot from license key — see isPro(). Never trust a cached flag at export time.
  detector: null,
  faceEngine: 'loading', // 'loading' | 'ready' | 'failed'
  enginePromise: null,
  renderQueued: false,
  exportURL: null,
};

const MAX_DIM = 2048;               // downscale very large images to this max side
const LARGE_FILE_BYTES = 12 * 1024 * 1024; // warn toast above this size
const EYE_DIST_FRAC = 0.30;         // canonical inter-eye distance (fraction of canvas width)
const EYE_Y_FRAC = 0.40;            // canonical eye-line height (fraction of canvas height)

/* ---------------- Pro license keys ----------------
   Pro is unlocked with a license key (SF-XXXX-XXXX-XXXX) issued
   after purchase — validated locally on EVERY export, never via a
   URL flag. Generate keys with:  node tools/gen-key.mjs
   NOTE: this is client-side gating. It stops casual sharing, URL
   tricks and Inspect-Element games, but a determined user with
   devtools can bypass any client-side check. Bulletproof
   enforcement would need server-side key validation at export. */
const KEY_SALT = 'splitface-pro-v1';
const KEY_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function keyChecksum(body) {
  let h = 0;
  const s = body + KEY_SALT;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  let code = '', x = h;
  for (let i = 0; i < 4; i++) { code += KEY_ALPHA[x % KEY_ALPHA.length]; x = Math.floor(x / KEY_ALPHA.length); }
  return code;
}
function validateKey(key) {
  if (!key) return false;
  let clean = String(key).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith('SF')) clean = clean.slice(2); // drop the "SF-" display prefix
  if (clean.length !== 12) return false;
  return clean.slice(8) === keyChecksum(clean.slice(0, 8));
}
function isPro() {
  try { return validateKey(localStorage.getItem('splitface_key') || ''); }
  catch (e) { return false; }
}

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const el = {
  views: { upload: $('view-upload'), editor: $('view-editor'), export: $('view-export') },
  slots: { A: $('slot-a'), B: $('slot-b') },
  fileA: $('file-a'), fileB: $('file-b'),
  btnSample: $('btn-sample'), btnSample2: $('btn-sample2'),
  continueRow: $('continue-row'), btnContinue: $('btn-continue'),
  toasts: $('toasts'),
  // editor
  srcImg: { A: $('src-img-a'), B: $('src-img-b') },
  pills: { A: $('pill-a'), B: $('pill-b') },
  srcRole: { A: $('src-role-a'), B: $('src-role-b') },
  flipThumbA: $('flip-thumb-a'), flipThumbB: $('flip-thumb-b'),
  canvasWrap: $('canvas-wrap'), mergeCanvas: $('merge-canvas'),
  splitLine: $('split-line'), splitHandle: $('split-handle'), dragHint: $('drag-hint'),
  tagLeft: $('tag-left'), tagRight: $('tag-right'),
  statSplit: $('stat-split'), statEyes: $('stat-eyes'), statScale: $('stat-scale'),
  alignDesc: $('align-desc'),
  btnFlip: $('btn-flip'), btnExport: $('btn-export'),
  mBtnFlip: $('m-btn-flip'), mBtnExport: $('m-btn-export'),
  btnBackUpload: $('btn-back-upload'), btnBackEditor: $('btn-back-editor'),
  proNudge: $('pro-nudge'),
  // export
  exportImg: $('export-img'), exportChip: $('export-chip'),
  exportHdChip: $('export-hdchip'),
  exportTitle: $('export-title'), exportSub: $('export-sub'),
  exportSide: $('export-side'), unlockedSlot: $('unlocked-slot'),
  btnDownload: $('btn-download'),
};

/* ---------------- Small helpers ---------------- */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(type, html, ms = 7000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.setAttribute('role', 'alert');
  const icon = type === 'error' ? '✕' : type === 'warn' ? '!' : '✓';
  t.innerHTML =
    '<div class="t-icon" aria-hidden="true">' + icon + '</div>' +
    '<div style="flex:1">' + html + '</div>' +
    '<button type="button" class="t-close" aria-label="Dismiss notification">✕</button>';
  const kill = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 280); };
  t.querySelector('.t-close').addEventListener('click', kill);
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  const timer = setTimeout(kill, ms);
}

function showView(name) {
  for (const k of Object.keys(el.views)) el.views[k].hidden = k !== name;
  window.scrollTo(0, 0);
}

const fmtMB = (bytes) => (bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1) + ' MB';

/* ---------------- Face engine (MediaPipe BlazeFace, vendored) ---------------- */
async function ensureFaceEngine() {
  if (S.faceEngine === 'ready') return true;
  if (S.faceEngine === 'failed') return false;
  if (!S.enginePromise) {
    S.enginePromise = (async () => {
      try {
        const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
        const resolver = await vision.FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
        S.detector = await vision.FaceDetector.createFromOptions(resolver, {
          baseOptions: {
            modelAssetPath: './vendor/mediapipe/blaze_face_short_range.tflite',
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.5,
        });
        S.faceEngine = 'ready';
        return true;
      } catch (err) {
        // Graceful degradation: center-crop alignment still works.
        console.warn('[SplitFace] face engine unavailable, using center-crop fallback.', err);
        S.faceEngine = 'failed';
        return false;
      }
    })();
  }
  return S.enginePromise;
}

function boxArea(d) {
  const b = d.boundingBox;
  return b ? b.width * b.height : 0;
}

async function detectFace(slot, photo) {
  const ok = await ensureFaceEngine();
  if (S.photos[slot] !== photo) return; // photo was replaced meanwhile
  if (!ok || !S.detector) {
    photo.faceStatus = 'unavailable';
    updatePhotoUI();
    return;
  }
  try {
    const res = S.detector.detect(photo.canvas);
    const dets = (res.detections || []).filter((d) => d.keypoints && d.keypoints.length >= 2);
    if (!dets.length) {
      photo.faceStatus = 'none';
    } else {
      dets.sort((a, b) => boxArea(b) - boxArea(a));
      const kp = dets[0].keypoints;
      photo.eyes = {
        l: { x: kp[0].x * photo.w, y: kp[0].y * photo.h },
        r: { x: kp[1].x * photo.w, y: kp[1].y * photo.h },
      };
      photo.faceStatus = 'found';
    }
  } catch (err) {
    console.warn('[SplitFace] detection failed for a photo, using center-crop fallback.', err);
    photo.faceStatus = 'unavailable';
  }
  if (S.photos[slot] === photo) updatePhotoUI();
}

/* ---------------- Photo loading ---------------- */
const isImageFile = (file) =>
  (file.type && file.type.startsWith('image/')) ||
  /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || '');

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

function downscaleImage(img) {
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h); // EXIF orientation is applied automatically
  return { canvas: c, w, h };
}

async function ingestPhoto(slot, blob, name, opts = {}) {
  try {
    const url = URL.createObjectURL(blob);
    let img;
    try {
      img = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const art = downscaleImage(img);
    S.photos[slot] = {
      canvas: art.canvas, w: art.w, h: art.h, name,
      thumb: art.canvas.toDataURL('image/jpeg', 0.82),
      faceStatus: 'pending', eyes: null, centerCrop: false, noFaceDismissed: false,
    };
    updatePhotoUI();
    detectFace(slot, S.photos[slot]);
  } catch (err) {
    toast('error',
      '<b>We couldn\'t read that image.</b> ' + esc(name) +
      ' might be corrupted — please try a different JPG, PNG or WebP photo.');
  }
}

async function handleFile(slot, file) {
  if (!file) return;
  if (!isImageFile(file)) {
    toast('error',
      '<b>That file isn\'t a photo.</b> &ldquo;' + esc(file.name) + '&rdquo; can\'t be used — ' +
      'please choose a JPG, PNG or WebP image.');
    return;
  }
  if (file.size > LARGE_FILE_BYTES) {
    toast('warn',
      '<b>Heads up: this photo is very large (' + fmtMB(file.size) + ').</b> ' +
      'We\'ll shrink it down automatically so everything stays fast — quality won\'t suffer.');
  }
  await ingestPhoto(slot, file, file.name);
}

function openPicker(slot) {
  (slot === 'A' ? el.fileA : el.fileB).click();
}

async function loadSamplePhotos(pair) {
  const btn = pair === 'duo' ? el.btnSample2 : el.btnSample;
  const files = pair === 'duo'
    ? ['assets/sample-man.jpg', 'assets/sample-boy.jpg', 'sample-man.jpg', 'sample-boy.jpg']
    : ['assets/sample-parent.jpg', 'assets/sample-child.jpg', 'sample-parent.jpg', 'sample-child.jpg'];
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Loading samples…';
  try {
    const [a, b] = await Promise.all([
      fetch(files[0]).then((r) => { if (!r.ok) throw new Error('sample A'); return r.blob(); }),
      fetch(files[1]).then((r) => { if (!r.ok) throw new Error('sample B'); return r.blob(); }),
    ]);
    await ingestPhoto('A', a, files[2]);
    await ingestPhoto('B', b, files[3]);
  } catch (err) {
    toast('error', '<b>Couldn\'t load the sample photos.</b> Please check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

/* ---------------- Upload-slot UI ---------------- */
function pillHTML(status) {
  if (status === 'found') return '<span class="align-pill">✓ Face found</span>';
  if (status === 'crop') return '<span class="align-pill crop">◐ Center crop</span>';
  if (status === 'none' || status === 'unavailable')
    return '<span class="align-pill none">⚠ No face</span>';
  return '<span class="align-pill pending"><span class="spin" aria-hidden="true"></span> Detecting…</span>';
}

function noFaceNoteHTML(slot, status) {
  const msg = status === 'unavailable'
    ? '<b>Face detection isn\'t available right now.</b> We\'ll use a plain center crop for this photo — or pick a different one.'
    : '<b>We couldn\'t find a face in this photo.</b> Try a clearer, front-facing shot with both eyes visible — or continue with a plain center crop.';
  return (
    '<div class="slot-error-note">' +
      '<p>' + msg + '</p>' +
      '<div style="display:flex; gap:10px; flex-wrap:wrap;">' +
        '<button type="button" class="btn btn-warn btn-sm" data-use-crop="' + slot + '">Use center crop anyway</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-replace="' + slot + '">Replace photo</button>' +
      '</div>' +
    '</div>'
  );
}

function emptySlotHTML(slot) {
  const tag = slot === 'A'
    ? '<span class="slot-tag">A · LEFT</span>'
    : '<span class="slot-tag b">B · RIGHT</span>';
  const icon = slot === 'A' ? '⤓' : '🖼';
  const title = slot === 'A' ? 'Drop Photo A here' : 'Photo B';
  const sub = slot === 'A' ? 'This becomes the left half of the merge' : 'This becomes the right half of the merge';
  const btnCls = slot === 'A' ? 'btn btn-primary' : 'btn btn-ghost';
  return (
    tag +
    '<div class="slot-icon" aria-hidden="true">' + icon + '</div>' +
    '<h3>' + title + '</h3>' +
    '<p class="slot-sub">' + sub + '</p>' +
    '<button type="button" class="' + btnCls + '" data-choose="' + slot + '">Choose photo</button>' +
    '<span class="or">or drag &amp; drop a JPG / PNG</span>'
  );
}

function filledSlotHTML(slot, photo) {
  const tag = slot === 'A'
    ? '<span class="slot-tag" style="position:static;">A · LEFT</span>'
    : '<span class="slot-tag b" style="position:static;">B · RIGHT</span>';
  const showNote = (photo.faceStatus === 'none' || photo.faceStatus === 'unavailable') && !photo.noFaceDismissed;
  return (
    '<img class="thumb" src="' + photo.thumb + '" alt="Photo ' + slot + ' — uploaded photo">' +
    '<div class="slot-foot">' + tag +
      '<span class="name" title="' + esc(photo.name) + '">' + esc(photo.name) + '</span>' +
      '<span class="pill-slot">' + pillHTML(photo.centerCrop ? 'crop' : photo.faceStatus) + '</span>' +
    '</div>' +
    (showNote ? noFaceNoteHTML(slot, photo.faceStatus) : '')
  );
}

function renderSlot(slot) {
  const node = el.slots[slot];
  const photo = S.photos[slot];
  node.classList.toggle('slot-filled', !!photo);
  node.innerHTML = photo ? filledSlotHTML(slot, photo) : emptySlotHTML(slot);
}

function updateContinue() {
  el.continueRow.hidden = !(S.photos.A && S.photos.B);
}

function acceptCenterCrop(slot) {
  const photo = S.photos[slot];
  if (!photo) return;
  photo.centerCrop = true;
  photo.noFaceDismissed = true;
  updatePhotoUI();
  if (!el.views.editor.hidden) queueRender();
}

/* ---------------- Editor ---------------- */
function updateEditorPills() {
  for (const slot of ['A', 'B']) {
    const photo = S.photos[slot];
    if (!photo) continue;
    el.srcImg[slot].src = photo.thumb;
    el.pills[slot].outerHTML = pillHTML(photo.centerCrop ? 'crop' : photo.faceStatus)
      .replace('class="align-pill', 'id="pill-' + slot.toLowerCase() + '" class="align-pill');
    // re-cache after outerHTML swap
    el.pills[slot] = $('pill-' + slot.toLowerCase());
  }
  const thumbs = S.flipped ? [S.photos.B.thumb, S.photos.A.thumb] : [S.photos.A.thumb, S.photos.B.thumb];
  el.flipThumbA.src = thumbs[0];
  el.flipThumbB.src = thumbs[1];
}

function updateAlignStats() {
  const a = S.photos.A, b = S.photos.B;
  if (!a || !b) return;
  const bothFound = a.faceStatus === 'found' && b.faceStatus === 'found' && !a.centerCrop && !b.centerCrop;
  el.statEyes.textContent = bothFound ? '✓' : '–';
  el.statScale.textContent = bothFound ? '✓' : '–';
  el.statEyes.className = 'v' + (bothFound ? ' ok' : '');
  el.statScale.className = 'v' + (bothFound ? ' ok' : '');
  el.alignDesc.textContent = bothFound
    ? 'Both faces were auto-detected and normalized.'
    : 'Using a center crop for one photo — the merge still works, alignment may be slightly off.';
}

function updatePhotoUI() {
  renderSlot('A');
  renderSlot('B');
  updateContinue();
  if (!el.views.editor.hidden) {
    updateEditorPills();
    updateAlignStats();
    queueRender();
  }
}

function updateTags() {
  el.tagLeft.textContent = S.flipped ? 'B · LEFT' : 'A · LEFT';
  el.tagRight.textContent = S.flipped ? 'A · RIGHT' : 'B · RIGHT';
  el.srcRole.A.textContent = S.flipped ? 'Right half' : 'Left half';
  el.srcRole.B.textContent = S.flipped ? 'Left half' : 'Right half';
}

function flipSides() {
  S.flipped = !S.flipped;
  S.variant = S.flipped ? 'flipped' : (S.seam === 'hard' ? 'classic' : 'soft');
  updateTags();
  syncVariantUI();
  const t = el.flipThumbA.src;
  el.flipThumbA.src = el.flipThumbB.src;
  el.flipThumbB.src = t;
  queueRender();
}

/* Merge styles: Classic split (crisp seam), Soft seam (feathered blend),
   Sides flipped (photos swapped). Mirrors the three landing-page variants. */
function setVariant(v) {
  S.variant = v;
  if (v === 'classic') { S.flipped = false; S.seam = 'hard'; }
  else if (v === 'soft') { S.flipped = false; S.seam = 'soft'; }
  else { S.flipped = true; S.seam = 'soft'; }
  updateTags();
  syncVariantUI();
  // keep the flip-side thumbnails in sync
  const thumbs = S.flipped ? [S.photos.B.thumb, S.photos.A.thumb] : [S.photos.A.thumb, S.photos.B.thumb];
  if (thumbs[0]) el.flipThumbA.src = thumbs[0];
  if (thumbs[1]) el.flipThumbB.src = thumbs[1];
  queueRender();
}

function syncVariantUI() {
  document.querySelectorAll('.variant-btn').forEach((b) => {
    const on = b.dataset.variant === S.variant;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/* ---------------- Alignment + merge rendering ---------------- */
function faceTransform(photo, W, H) {
  let exL, exR;
  if (photo.eyes && !photo.centerCrop) {
    exL = photo.eyes.l; exR = photo.eyes.r;
  } else {
    // Center-crop fallback: pretend the face is centered
    exL = { x: photo.w * 0.40, y: photo.h * 0.40 };
    exR = { x: photo.w * 0.60, y: photo.h * 0.40 };
  }
  const dx = exR.x - exL.x, dy = exR.y - exL.y;
  const dist = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx);
  const s = (EYE_DIST_FRAC * W) / dist;
  const mx = (exL.x + exR.x) / 2, my = (exL.y + exR.y) / 2;
  const Tx = W / 2, Ty = EYE_Y_FRAC * H;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    a: s * cos, b: -s * sin, c: s * sin, d: s * cos,
    e: Tx - s * (cos * mx + sin * my),
    f: Ty - s * (-sin * mx + cos * my),
  };
}

function drawAligned(ctx, photo, W, H) {
  const t = faceTransform(photo, W, H);
  ctx.save();
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.canvas, 0, 0);
  ctx.restore();
}

let seamCanvas = null, seamCtx = null;

function renderMerge(ctx, W, H) {
  const left = S.flipped ? S.photos.B : S.photos.A;
  const right = S.flipped ? S.photos.A : S.photos.B;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#06130e';
  ctx.fillRect(0, 0, W, H);
  drawAligned(ctx, left, W, H);

  if (!seamCanvas) {
    seamCanvas = document.createElement('canvas');
    seamCtx = seamCanvas.getContext('2d');
  }
  if (seamCanvas.width !== W || seamCanvas.height !== H) {
    seamCanvas.width = W; seamCanvas.height = H;
  }
  seamCtx.save();
  seamCtx.setTransform(1, 0, 0, 1, 0, 0);
  seamCtx.clearRect(0, 0, W, H);
  drawAligned(seamCtx, right, W, H);
  seamCtx.globalCompositeOperation = 'destination-in';
  const x = S.split * W;
  // Classic split = crisp seam; Soft seam / Sides flipped = feathered blend.
  const feather = S.seam === 'hard' ? Math.max(2, W * 0.004) : Math.max(6, W * 0.025);
  const g = seamCtx.createLinearGradient(x - feather, 0, x + feather, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  seamCtx.fillStyle = g;
  seamCtx.fillRect(0, 0, W, H);
  seamCtx.restore();

  ctx.drawImage(seamCanvas, 0, 0);
  ctx.restore();
}

/* ---------------- Preview canvas ---------------- */
function sizePreviewCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.mergeCanvas.width = Math.round(540 * dpr);
  el.mergeCanvas.height = Math.round(675 * dpr);
  queueRender();
}

function queueRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => {
    S.renderQueued = false;
    if (!S.photos.A || !S.photos.B) return;
    const ctx = el.mergeCanvas.getContext('2d');
    renderMerge(ctx, el.mergeCanvas.width, el.mergeCanvas.height);
    // Free tier: the live preview itself carries the watermark (baked into
    // pixels), so a screenshot of the editor can't produce a clean image.
    if (!isPro()) {
      drawTiledWatermark(ctx, el.mergeCanvas.width, el.mergeCanvas.height);
      drawCenterWatermark(ctx, el.mergeCanvas.width, el.mergeCanvas.height);
      drawWatermark(ctx, el.mergeCanvas.width, el.mergeCanvas.height);
    }
  });
}

/* ---------------- Split line interaction ---------------- */
function setSplit(frac) {
  S.split = Math.min(0.95, Math.max(0.05, frac));
  const pct = Math.round(S.split * 100);
  el.splitLine.style.left = (S.split * 100) + '%';
  el.splitHandle.setAttribute('aria-valuenow', String(pct));
  el.statSplit.textContent = pct + '%';
  el.dragHint.classList.add('hidden');
  queueRender();
}

function moveSplitTo(clientX) {
  const r = el.mergeCanvas.getBoundingClientRect();
  if (r.width <= 0) return;
  setSplit((clientX - r.left) / r.width);
}

function bindSplit() {
  let dragging = false;
  el.canvasWrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    try { el.canvasWrap.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    moveSplitTo(e.clientX);
  });
  el.canvasWrap.addEventListener('pointermove', (e) => {
    if (dragging) moveSplitTo(e.clientX);
  });
  const stop = () => { dragging = false; };
  el.canvasWrap.addEventListener('pointerup', stop);
  el.canvasWrap.addEventListener('pointercancel', stop);

  el.splitHandle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setSplit(S.split - step); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setSplit(S.split + step); e.preventDefault(); }
    else if (e.key === 'Home') { setSplit(0.05); e.preventDefault(); }
    else if (e.key === 'End') { setSplit(0.95); e.preventDefault(); }
  });
}

/* ---------------- Export ---------------- */
function exportSize(kind) {
  if (isPro()) return kind === '4k' ? { w: 3240, h: 4050 } : { w: 2160, h: 2700 };
  return { w: 384, h: 480 }; // free tier: 480p, watermark baked into the pixels
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWatermark(ctx, W, H) {
  const fs = Math.max(20, Math.round(W * 0.026));
  ctx.save();
  ctx.font = "700 " + fs + "px 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
  const text = 'Made with SplitFace';
  const tw = ctx.measureText(text).width;
  const dotR = fs * 0.17, gap = fs * 0.5, padX = fs * 0.95, padY = fs * 0.62;
  const pillW = padX * 2 + dotR * 2 + gap + tw;
  const pillH = fs + padY * 2;
  const x = W - pillW - W * 0.035;
  const y = H - pillH - H * 0.028;
  ctx.fillStyle = 'rgba(6,19,14,.66)';
  roundRectPath(ctx, x, y, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#BEF264';
  ctx.beginPath();
  ctx.arc(x + padX + dotR, y + pillH / 2, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX + dotR * 2 + gap, y + pillH / 2 + 1);
  ctx.restore();
}

/* Two light diagonal "SplitFace" marks (free tier) — one upper, one lower —
   so no clean crop is left, without flooding the image. Baked into the
   export pixels — can't be removed via Inspect Element since it's in the
   PNG itself. */
function drawTiledWatermark(ctx, W, H) {
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 0.15;
  const fs = Math.max(16, Math.round(W * 0.075));
  ctx.font = "800 " + fs + "px 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const spots = [
    { x: W * 0.30, y: H * 0.24 },
    { x: W * 0.72, y: H * 0.72 }
  ];
  for (const s of spots) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-Math.PI / 8);
    ctx.fillText('SplitFace \u2726', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/* Center watermark in very light color (free tier): a soft white
   "SplitFace" across the middle of the face with a small "Go Pro to
   remove" line beneath. Baked into the PNG pixels — screenshots and
   downloads carry it, and it can't be deleted via Inspect Element. */
function drawCenterWatermark(ctx, W, H) {
  ctx.save();
  const fs = Math.max(24, Math.round(W * 0.10));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // soft glow so it reads over dark and light faces alike
  ctx.shadowColor = 'rgba(255,255,255,0.5)';
  ctx.shadowBlur = fs * 0.22;
  ctx.font = "800 " + fs + "px 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fillText('SplitFace', W / 2, H * 0.44);
  ctx.shadowBlur = 0;
  const fs2 = Math.max(12, Math.round(W * 0.034));
  ctx.font = "700 " + fs2 + "px 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.fillText('Go Pro to remove', W / 2, H * 0.44 + fs * 0.82);
  ctx.restore();
}

function renderExportCanvas(kind) {
  S.pro = isPro(); // re-validate on every export — never trust a cached flag
  const { w: W, h: H } = exportSize(kind);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  renderMerge(ctx, W, H);
  if (!S.pro) {
    drawTiledWatermark(ctx, W, H);
    drawCenterWatermark(ctx, W, H);
    drawWatermark(ctx, W, H);
  }
  return c;
}

function buildExport() {
  const canvas = renderExportCanvas('hd');
  canvas.toBlob((blob) => {
    if (S.exportURL) URL.revokeObjectURL(S.exportURL);
    S.exportURL = URL.createObjectURL(blob);
    el.exportImg.src = S.exportURL;
  }, 'image/png');

  const { w, h } = exportSize('hd');
  if (S.pro) {
    el.exportChip.textContent = 'PNG · ' + w + ' × ' + h + ' · HD';
    el.exportChip.classList.add('hd');
    el.exportHdChip.hidden = false;
    el.exportTitle.textContent = 'Your HD export is ready';
    el.exportSub.textContent = 'No watermark, maximum quality. Post it everywhere.';
    el.btnDownload.innerHTML = '⬇ Download HD';
    el.unlockedSlot.innerHTML =
      '<div class="unlocked-banner">' +
        '<div class="big-tick" aria-hidden="true">✓</div>' +
        '<div><h3>Pro unlocked — enjoy!</h3>' +
        '<p>Watermark-free, full-HD exports on every merge from now on.</p></div>' +
      '</div>';
    el.exportSide.innerHTML =
      '<div class="control-card mb-16">' +
        '<h4>📤 Ready to post?</h4>' +
        '<p class="desc">Save the PNG, then upload it to TikTok or Instagram as a photo post or carousel.</p>' +
        '<div class="stat-row"><span class="k">Format</span><span class="v">PNG</span></div>' +
        '<div class="stat-row"><span class="k">Size</span><span class="v">' + w + ' × ' + h + ' · HD</span></div>' +
        '<div class="stat-row"><span class="k">Watermark</span><span class="v ok">None ✓</span></div>' +
      '</div>' +
      '<button type="button" class="btn btn-outline btn-block mb-16" id="btn-dl-4k">⬇ Download 4K (3240 × 4050)</button>' +
      '<button type="button" class="btn btn-dark btn-block" id="btn-another">✨ Make another merge</button>';
    $('btn-another').addEventListener('click', resetApp);
    $('btn-dl-4k').addEventListener('click', () => downloadExport('4k'));
  } else {
    el.exportChip.textContent = 'PNG · ' + w + ' × ' + h + ' · Free';
    el.exportChip.classList.remove('hd');
    el.exportHdChip.hidden = true;
    el.exportTitle.textContent = 'Looking good — ready to post?';
    el.exportSub.textContent = 'Your free download is 480p with the SplitFace watermark baked in. Go Pro once — watermark gone, HD + 4K, yours forever.';
    el.btnDownload.innerHTML = '⬇ Download free';
    el.unlockedSlot.innerHTML = '';
    el.exportSide.innerHTML =
      '<div class="upgrade-card">' +
        '<span class="flag">✦ SplitFace Pro</span>' +
        '<h3>Clean, HD, watermark-free.</h3>' +
        '<div class="price-row"><span class="price">$4.99</span><span class="per">one-time · yours forever</span></div>' +
        '<p class="blurb">One payment. No subscription. Every future merge included.</p>' +
        '<ul class="upgrade-list">' +
          '<li><span class="tick" aria-hidden="true">✓</span>No watermark on any export</li>' +
          '<li><span class="tick" aria-hidden="true">✓</span>HD 2160 × 2700 + 4K 3240 × 4050 downloads</li>' +
          '<li><span class="tick" aria-hidden="true">✓</span>Priority face-detection engine</li>' +
          '<li><span class="tick" aria-hidden="true">✓</span>Unlimited merges, forever</li>' +
        '</ul>' +
        '<button type="button" class="btn btn-upgrade" data-gopro>Remove watermark + HD</button>' +
        '<div class="secure">🔒 Secure checkout · 30-day money-back guarantee</div>' +
      '</div>' +
      '<details class="key-details">' +
        '<summary>Have a license key?</summary>' +
        '<div class="key-row"><input id="key-input" class="key-input" placeholder="SF-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" aria-label="License key"><button id="key-apply" class="btn btn-dark btn-sm" type="button">Unlock</button></div>' +
        '<p class="key-hint">Keys are emailed with your receipt right after purchase.</p>' +
      '</details>' +
      '<div class="free-card">' +
        '<p><b>Happy with the free version?</b> Free downloads carry a visible SplitFace watermark across the image — Go Pro once and it\'s gone forever.</p>' +
        '<button type="button" class="btn btn-ghost btn-block" id="btn-download-free2">Download free version</button>' +
      '</div>';
    $('btn-download-free2').addEventListener('click', () => el.btnDownload.click());
  }
}

function downloadExport(kind) {
  const canvas = renderExportCanvas(kind || 'hd'); // re-validates the license key inside
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = S.pro ? (kind === '4k' ? 'splitface-merge-4k.png' : 'splitface-merge-hd.png') : 'splitface-merge.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}

/* ---------------- Go Pro ---------------- */
function goPro() {
  if (isPro()) return;
  if (!PAYMENT_URL || PAYMENT_URL.indexOf('example.com') !== -1) {
    toast('warn',
      '<b>Payment link not set yet.</b> Paste your Gumroad / Lemon Squeezy checkout URL as ' +
      '<b>PAYMENT_URL</b> in <b>app/config.js</b>. After purchase, buyers unlock Pro with the ' +
      'license key from their receipt — generate keys with <b>node tools/gen-key.mjs</b>.',
      9000);
    return;
  }
  window.open(PAYMENT_URL, '_blank', 'noopener');
}

function applyProUI() {
  document.querySelectorAll('[data-gopro] .btn-pro-label').forEach((n) => { n.textContent = 'Pro active'; });
  document.querySelectorAll('.btn-pro').forEach((b) => b.classList.add('pro-on'));
  if (el.proNudge) el.proNudge.style.display = 'none';
}

/* ---------------- Editor entry / reset ---------------- */
function enterEditor() {
  if (!S.photos.A || !S.photos.B) return;
  S.split = 0.5;
  S.flipped = false;
  S.seam = 'soft';
  S.variant = 'soft';
  setSplit(0.5);
  updateEditorPills();
  updateAlignStats();
  updateTags();
  syncVariantUI();
  el.dragHint.classList.remove('hidden');
  showView('editor');
  sizePreviewCanvas();
  queueRender();
}

function resetApp() {
  S.photos.A = null; S.photos.B = null;
  S.split = 0.5; S.flipped = false; S.seam = 'soft'; S.variant = 'soft';
  if (S.exportURL) { URL.revokeObjectURL(S.exportURL); S.exportURL = null; }
  renderSlot('A'); renderSlot('B');
  updateContinue();
  showView('upload');
}

/* ---------------- Events ---------------- */
function bindUpload() {
  el.fileA.addEventListener('change', (e) => { handleFile('A', e.target.files[0]); e.target.value = ''; });
  el.fileB.addEventListener('change', (e) => { handleFile('B', e.target.files[0]); e.target.value = ''; });

  for (const slot of ['A', 'B']) {
    const node = el.slots[slot];
    node.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      if (!S.photos[slot]) openPicker(slot);
    });
    node.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !S.photos[slot]) { e.preventDefault(); openPicker(slot); }
    });
    for (const ev of ['dragenter', 'dragover']) {
      node.addEventListener(ev, (e) => { e.preventDefault(); node.classList.add('dragover'); });
    }
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('dragover');
    });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(slot, f);
    });
  }

  el.btnSample.addEventListener('click', () => loadSamplePhotos('family'));
  el.btnSample2.addEventListener('click', () => loadSamplePhotos('duo'));
  el.btnContinue.addEventListener('click', enterEditor);

  // Delegated clicks for dynamically-rendered buttons
  document.addEventListener('click', (e) => {
    const choose = e.target.closest('[data-choose]');
    if (choose) { openPicker(choose.getAttribute('data-choose')); return; }
    const replace = e.target.closest('[data-replace]');
    if (replace) { openPicker(replace.getAttribute('data-replace')); return; }
    const crop = e.target.closest('[data-use-crop]');
    if (crop) { acceptCenterCrop(crop.getAttribute('data-use-crop')); return; }
    const gopro = e.target.closest('[data-gopro]');
    if (gopro) { goPro(); }
  });
}

function bindEditor() {
  el.btnFlip.addEventListener('click', flipSides);
  el.mBtnFlip.addEventListener('click', flipSides);
  document.querySelectorAll('.variant-btn').forEach((b) => {
    b.addEventListener('click', () => setVariant(b.dataset.variant));
  });
  syncVariantUI();
  const toExport = () => { buildExport(); showView('export'); };
  el.btnExport.addEventListener('click', toExport);
  el.mBtnExport.addEventListener('click', toExport);
  el.btnBackUpload.addEventListener('click', () => showView('upload'));
  bindSplit();
}

function bindExport() {
  el.btnBackEditor.addEventListener('click', () => { showView('editor'); queueRender(); });
  el.btnDownload.addEventListener('click', () => downloadExport());
  // License-key unlock (the key form is injected dynamically in buildExport)
  document.addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'key-apply') return;
    const input = $('key-input');
    const k = input ? input.value : '';
    if (validateKey(k)) {
      try { localStorage.setItem('splitface_key', String(k).trim().toUpperCase()); } catch (err) {}
      S.pro = true;
      applyProUI();
      buildExport();
      toast('ok', '<b>Pro unlocked.</b> Watermark-free HD + 4K exports on every merge from now on.');
    } else {
      toast('warn', '<b>Invalid key.</b> Check the key from your receipt email and try again.');
    }
  });
}

/* ---------------- Init ---------------- */
function init() {
  renderSlot('A');
  renderSlot('B');
  updateContinue();
  bindUpload();
  bindEditor();
  bindExport();
  S.pro = isPro(); // unlock from stored license key (re-validated on every export)
  if (S.pro) applyProUI();
  // Offline support: cache the app shell so the page keeps
  // working offline after the first load (no CDN deps at runtime).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Warm up the face engine shortly after first paint (non-blocking)
  const warm = () => ensureFaceEngine();
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* QA hook: expose internals for automated verification.
   Harmless — everything here is already client-side and readable. */
window.__splitface = { S, renderMerge, setVariant, isPro };
