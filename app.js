import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai@2.23.0';

const IN_RATE = 16000;
const OUT_RATE = 24000;

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body, pill: $('pill'), stateText: $('stateText'),
  feed: $('feed'), log: $('log'), hint: $('hint'), err: $('err'),
  start: $('start'), end: $('end'), mute: $('mute'),
  camera: $('camera'), flip: $('flip'), attach: $('attach'), file: $('file'),
};

const hash = new URLSearchParams(location.hash.slice(1));
// טוקן בכתובת — הזרימה הישנה, QR מ-mint_qr.py. בלעדיו הדף מנפיק לעצמו
// טוקן טרי מ-/api/token בכל לחיצה, ולכן הקישור עצמו לא פג תוקף.
const HASH_TOKEN = hash.get('t') || '';
const MODEL = hash.get('m') || 'gemini-3.8-live';
const API_VERSION = hash.get('v') || 'v1alpha';

// קוד הכניסה מגיע פעם אחת ב-#p= ונשמר, כדי שהקישור יעבוד גם אחרי
// הוספה למסך הבית ובלי להחזיק סוד בצד השרת של הדף.
const PASS_STORE = 'travel-live-pass';
let passcode = hash.get('p') || '';
if (passcode) {
  try { localStorage.setItem(PASS_STORE, passcode); } catch (_) {}
} else {
  try { passcode = localStorage.getItem(PASS_STORE) || ''; } catch (_) {}
}

let ctx = null, session = null;
let micStream = null, micNode = null;
let camStream = null, camTimer = null, facing = 'user';
let playHead = 0, speakTimer = null;
const playing = new Set();
let live = false, muted = false;
// handle להמשך שיחה אחרי עצירה. תקף שעתיים, ומחזיר את כל ההקשר.
let resumeHandle = null;

// ---------- מצב ----------

const LABEL = {
  idle: 'לא מחובר', connecting: 'מתחבר…', listening: 'מקשיב',
  thinking: 'חושב', speaking: 'מדבר', muted: 'מושתק',
};

function setState(s) {
  els.body.dataset.state = s;
  els.stateText.textContent = LABEL[s] || s;
  els.body.classList.toggle('speaking', s === 'speaking');
}

function fail(title, detail) {
  els.err.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  els.err.append(b, document.createTextNode(detail || ''));
  els.err.hidden = false;
  clearTimeout(fail.t);
  fail.t = setTimeout(() => { els.err.hidden = true; }, 9000);
  console.error(title, detail);
}

function say(who, text) {
  if (!text) return;
  els.hint?.remove();
  const last = els.log.lastElementChild;
  if (last && last.dataset.who === who) {
    last.textContent += text;
  } else {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    d.dataset.who = who;
    d.dir = 'auto';                 // עברית לימין, אנגלית לשמאל — לפי התוכן
    d.textContent = text;
    els.log.appendChild(d);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

// ---------- מד עוצמה ----------
// הנתונים מגיעים ~10 פעמים בשנייה. בלי החלקה זה נראה מקפץ.
// עלייה מהירה, ירידה איטית — כמו כל מד עוצמה.
class Level {
  constructor() { this.target = 0; this.value = 0; this.last = performance.now(); }
  push(rms) {
    if (rms < 0.004) { this.target = 0; return; }
    const db = 20 * Math.log10(rms);
    const n = (db + 50) / 38;                       // -50dB..-12dB → 0..1
    this.target = Math.min(1, Math.max(0, n)) ** 0.8;
  }
  tick(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const speed = this.target > this.value ? 22 : 6;
    this.value += (this.target - this.value) * (1 - Math.exp(-speed * dt));
    return this.value;
  }
}
const level = new Level();
let raf = 0;
function pump() {
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame(now) {
  const v = level.tick(now);
  document.documentElement.style.setProperty('--lvl', v.toFixed(3));
  raf = (Math.abs(level.target - v) > 0.002 || v > 0.002) ? requestAnimationFrame(frame) : 0;
}

// ---------- אודיו ----------

function toPcm16Base64(f32, fromRate) {
  const ratio = fromRate / IN_RATE;
  const outLen = Math.floor(f32.length / ratio);
  const bytes = new Uint8Array(outLen * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < outLen; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = from; j < to; j++) { sum += f32[j]; n++; }
    const s = Math.max(-1, Math.min(1, n ? sum / n : 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function playPcm(b64) {
  if (!ctx) return;
  const bin = atob(b64);
  const n = bin.length >> 1;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const f32 = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = dv.getInt16(i * 2, true) / 32768; f32[i] = s; sum += s * s; }

  const buf = ctx.createBuffer(1, n, OUT_RATE);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => playing.delete(src);
  playing.add(src);
  playHead = Math.max(playHead, ctx.currentTime);
  src.start(playHead);
  playHead += buf.duration;

  // אותו מד עוצמה משרת גם את הקול שלו — חיווי אחד לשני הכיוונים
  level.push(Math.sqrt(sum / n));
  pump();
  setState('speaking');
  clearTimeout(speakTimer);
  speakTimer = setTimeout(
    () => { if (live) setState(muted ? 'muted' : 'listening'); },
    Math.max(150, (playHead - ctx.currentTime) * 1000)
  );
}

function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch (_) {} }
  playing.clear();
  playHead = 0;
  clearTimeout(speakTimer);
  els.body.classList.remove('speaking');
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micStream.getAudioTracks()[0].onended = () => {
    if (live) { stop(); fail('המיקרופון נותק', 'ייתכן שאפליקציה אחרת תפסה אותו.'); }
  };

  await ctx.audioWorklet.addModule('./pcm-worklet.js');
  micNode = new AudioWorkletNode(ctx, 'p');
  micNode.port.onmessage = (e) => {
    const f32 = e.data;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);

    if (muted) { level.push(0); pump(); return; }
    if (!els.body.classList.contains('speaking')) { level.push(rms); pump(); }

    if (!live || !session) return;
    if (playHead > ctx.currentTime + 0.05 && rms < 0.006) return;  // דלף שקט מהרמקול

    try {
      session.sendRealtimeInput({
        audio: { data: toPcm16Base64(f32, ctx.sampleRate), mimeType: `audio/pcm;rate=${IN_RATE}` },
      });
    } catch (_) {}
  };

  ctx.createMediaStreamSource(micStream).connect(micNode);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  micNode.connect(sink).connect(ctx.destination);
}

// ---------- מצלמה ----------

async function openCam(which = facing) {
  const next = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: which === 'user' ? 'user' : { ideal: 'environment' }, width: { ideal: 960 } },
  });
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = next;
  facing = which;
  els.feed.srcObject = camStream;
  els.feed.hidden = false;
  els.feed.classList.toggle('front', facing === 'user');
  els.camera.setAttribute('aria-pressed', 'true');
  els.flip.hidden = false;
  await els.feed.play().catch(() => {});

  if (!camTimer) {
    const cv = document.createElement('canvas');
    camTimer = setInterval(() => {
      if (!live || !session || !els.feed.videoWidth) return;
      cv.width = 640;
      cv.height = Math.round((els.feed.videoHeight / els.feed.videoWidth) * 640);
      cv.getContext('2d').drawImage(els.feed, 0, 0, cv.width, cv.height);
      try {
        session.sendRealtimeInput({
          video: { data: cv.toDataURL('image/jpeg', 0.6).split(',')[1], mimeType: 'image/jpeg' },
        });
      } catch (_) {}
    }, 1000);
  }
}

function closeCam() {
  clearInterval(camTimer); camTimer = null;
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  els.feed.hidden = true;
  els.feed.srcObject = null;
  els.camera.setAttribute('aria-pressed', 'false');
  els.flip.hidden = true;
}

// ---------- חיבור ----------

// מנפיק טוקן חד-פעמי מהשרת. כל התצורה — קול, הנחיה, תמלול — נקבעת שם,
// כך שהטוקן שמגיע לטלפון נעול לשיחה אחת ולא שווה כלום מעבר לזה.
async function mintToken() {
  if (!passcode) {
    passcode = (window.prompt('קוד כניסה') || '').trim();
    if (!passcode) throw new Error('בלי קוד כניסה אי אפשר לפתוח שיחה.');
  }

  let res;
  try {
    res = await fetch('./api/token', { method: 'POST', headers: { 'x-passcode': passcode } });
  } catch (e) {
    throw new Error('אין חיבור לשרת. ' + (e.message || ''));
  }

  if (res.status === 401) {
    passcode = '';
    try { localStorage.removeItem(PASS_STORE); } catch (_) {}
    throw new Error('קוד הכניסה שגוי. פתח שוב את הקישור המלא.');
  }
  if (res.status === 404) {
    throw new Error('הדף הזה מוגש בלי שרת. פתח את הכתובת ב-Vercel, או סרוק QR מ-mint_qr.py.');
  }
  if (res.status === 429) throw new Error('יותר מדי ניסיונות. חכה דקה ונסה שוב.');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || body.error || ('שגיאה ' + res.status));
  }

  const body = await res.json();
  if (!body.token) throw new Error('השרת לא החזיר טוקן.');
  try { localStorage.setItem(PASS_STORE, passcode); } catch (_) {}
  return { token: body.token, model: body.model || MODEL, apiVersion: body.apiVersion || API_VERSION };
}

async function start() {
  els.err.hidden = true;
  els.start.disabled = true;
  setState('connecting');

  try {
    await startMic();
  } catch (e) {
    setState('idle'); cleanup(); els.start.disabled = false;
    return fail('אין גישה למיקרופון', e.message);
  }

  let token = HASH_TOKEN, model = MODEL, apiVersion = API_VERSION;
  if (!token) {
    try {
      ({ token, model, apiVersion } = await mintToken());
    } catch (e) {
      setState('idle'); cleanup(); els.start.disabled = false;
      return fail('הנפקת הטוקן נכשלה', e.message);
    }
  }

  try {
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion } });
    session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
      },
      callbacks: {
        onopen: () => {
          live = true;
          els.start.hidden = true; els.start.disabled = false;
          els.end.hidden = false; els.mute.hidden = false;
          els.attach.disabled = false;
          setState('listening');
        },
        onmessage: (m) => {
          const up = m.sessionResumptionUpdate;
          if (up?.resumable && up.newHandle) resumeHandle = up.newHandle;
          const sc = m.serverContent;
          if (!sc) return;
          if (sc.interrupted) { stopPlayback(); setState('listening'); }
          if (sc.generationComplete || sc.turnComplete) {
            if (!playing.size) setState(muted ? 'muted' : 'listening');
          }
          for (const p of sc.modelTurn?.parts || []) {
            if (p.inlineData?.data) playPcm(p.inlineData.data);
          }
          if (sc.inputTranscription?.text) {
            say('me', sc.inputTranscription.text);
            if (!els.body.classList.contains('speaking')) setState('thinking');
          }
          if (sc.outputTranscription?.text) say('ai', sc.outputTranscription.text);
        },
        onerror: (e) => fail('שגיאת חיבור', e?.message || String(e)),
        onclose: (e) => { if (live) { const r = e?.reason; stop(); if (r) fail('הסשן נסגר', r); } },
      },
    });
  } catch (e) {
    setState('idle'); cleanup(); els.start.disabled = false;
    return fail('החיבור נכשל', e?.message || String(e));
  }
}

function cleanup() {
  try { session?.close(); } catch (_) {}
  session = null;
  if (micNode) { micNode.port.onmessage = null; try { micNode.disconnect(); } catch (_) {} }
  micStream?.getTracks().forEach((t) => t.stop());
  micNode = micStream = null;
  stopPlayback();
  ctx?.close().catch(() => {});
  ctx = null;
  level.target = level.value = 0;
  document.documentElement.style.setProperty('--lvl', '0');
}

function stop() {
  live = false; muted = false;
  cleanup();
  els.start.hidden = false; els.start.disabled = false;
  els.end.hidden = true; els.mute.hidden = true;
  els.mute.setAttribute('aria-pressed', 'false');
  els.attach.disabled = true;
  setState('idle');
}

// ---------- פעולות ----------

els.start.onclick = () => {
  // iOS מודד "הקשה אחרונה" וסוגר את החלון אחרי 5 שניות.
  // לכן ה-context נוצר כאן, סינכרונית, לפני כל await.
  if (!ctx) {
    if ('audioSession' in navigator) navigator.audioSession.type = 'play-and-record';
    ctx = new AudioContext();
    ctx.resume();
    ctx.onstatechange = () => { if (ctx && ctx.state !== 'running') ctx.resume(); };
  }
  start();
};

els.end.onclick = stop;

els.mute.onclick = () => {
  muted = !muted;
  els.mute.setAttribute('aria-pressed', String(muted));
  els.mute.setAttribute('aria-label', muted ? 'בטל השתקה' : 'השתק מיקרופון');
  setState(muted ? 'muted' : (playing.size ? 'speaking' : 'listening'));
};

els.camera.onclick = () => {
  if (camStream) return closeCam();
  openCam('user').catch((e) => fail('אין גישה למצלמה', e.message));
};

els.flip.onclick = () => {
  openCam(facing === 'user' ? 'environment' : 'user')
    .catch((e) => fail('החלפת מצלמה נכשלה', e.message));
};

// ---------- צירוף קבצים ----------
// ה-Live API לא מקבל קובץ וידאו. הוא מקבל רק פריימים כתמונות,
// אז סרטון מפורק כאן בטלפון לכמה תמונות ונשלח כך.

function drawToJpeg(src, max = 768) {
  const w = src.videoWidth || src.width;
  const h = src.videoHeight || src.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.75).split(',')[1];
}

async function videoFrames(file, count = 6) {
  const v = document.createElement('video');
  v.src = URL.createObjectURL(file);
  v.muted = true; v.playsInline = true; v.preload = 'metadata';
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('לא הצלחתי לקרוא את הסרטון'));
    });
    const dur = Math.min(v.duration || 0, 60);
    const out = [];
    for (let i = 0; i < count; i++) {
      v.currentTime = (dur * i) / count;
      await new Promise((r) => { v.onseeked = r; });
      out.push(drawToJpeg(v));
    }
    return out;
  } finally {
    URL.revokeObjectURL(v.src);
  }
}

async function sendFile(file) {
  const isVideo = file.type.startsWith('video/');
  let frames;

  if (isVideo) {
    frames = await videoFrames(file);
  } else {
    const bmp = await createImageBitmap(file);
    frames = [drawToJpeg(bmp)];
    bmp.close?.();
  }

  for (const data of frames) {
    session.sendRealtimeInput({ video: { data, mimeType: 'image/jpeg' } });
    await new Promise((r) => setTimeout(r, 120));   // לא להציף את ה-WebSocket
  }

  // פריים לבדו לא סוגר תור. טקסט קצר מכריח אותו להתייחס עכשיו.
  session.sendRealtimeInput({
    text: isVideo
      ? `צירפתי סרטון, הנה ${frames.length} תמונות ממנו לפי הסדר. מה אתה רואה?`
      : 'צירפתי תמונה. מה אתה רואה בה?',
  });

  say('me', isVideo ? `🎬 סרטון (${frames.length} פריימים)` : '🖼 תמונה');
  setState('thinking');
}

els.attach.onclick = () => els.file.click();
els.file.onchange = async () => {
  const f = els.file.files?.[0];
  els.file.value = '';
  if (!f || !session) return;
  els.attach.disabled = true;
  try {
    await sendFile(f);
  } catch (e) {
    fail('שליחת הקובץ נכשלה', e.message);
  } finally {
    els.attach.disabled = !live;
  }
};

// חזרה מנעילת מסך משאירה את ה-context מושהה
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume();
});

