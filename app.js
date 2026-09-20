import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai@2.23.0';

const IN_RATE = 16000;   // הקצב שגוגל דורשת בקלט
const OUT_RATE = 24000;  // הקצב שגוגל מחזירה בפלט

const $ = (id) => document.getElementById(id);
const els = {
  pill: $('status'), statusText: $('statusText'),
  talk: $('talk'), cam: $('cam'), level: $('level'),
  video: $('video'), camWrap: $('camWrap'),
  log: $('log'), hint: $('hint'), err: $('err'),
};

// context אחד בלבד. שניים בקצבים שונים מתנגשים על iOS כשהמיקרופון נדלק.
let ctx = null;
let session = null;
let micStream = null, micNode = null;
let camStream = null, camTimer = null;
let playHead = 0, speakTimer = null;
const playing = new Set();
let live = false;

// הטוקן מגיע ב-QR בתוך ה-hash. hash לא נשלח לשרת ולא נכנס ללוגים.
const hash = new URLSearchParams(location.hash.slice(1));
const EPHEMERAL_TOKEN = hash.get('t') || '';
const MODEL = hash.get('m') || 'gemini-3.8-live';
const API_VERSION = hash.get('v') || 'v1alpha';  // חייב להתאים לגרסה שבה הונפק הטוקן

function setStatus(text, cls) {
  els.statusText.textContent = text;
  els.pill.className = 'pill ' + (cls || '');
}

function fail(title, detail) {
  els.err.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  els.err.append(b, document.createTextNode(detail || ''));
  els.err.hidden = false;
  console.error(title, detail);
}

function say(who, text) {
  if (!text) return;
  els.hint?.remove();
  const last = els.log.lastElementChild;
  if (last && last.dataset.who === who) {
    last.querySelector('.txt').textContent += text;
  } else {
    const row = document.createElement('div');
    row.className = 'row ' + who;
    row.dataset.who = who;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who === 'me' ? 'אתה' : 'מדריך';
    const t = document.createElement('span');
    t.className = 'txt';
    t.textContent = text;
    row.append(w, t);
    els.log.appendChild(row);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

// ---------- אודיו ----------

// Float32 בקצב החומרה → PCM 16-bit ב-16kHz → base64.
// ממוצע על החלון ולא דגימה בודדת, אחרת 48k→16k יוצר aliasing.
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
  for (let i = 0; i < n; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;

  // buffer ב-24k בתוך context בקצב החומרה — WebAudio ממיר לבד.
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

  document.body.classList.add('speaking');
  clearTimeout(speakTimer);
  speakTimer = setTimeout(
    () => document.body.classList.remove('speaking'),
    Math.max(120, (playHead - ctx.currentTime) * 1000)
  );
}

// כשהמשתמש נכנס לדברי המודל — חייבים לעצור גם מה שכבר תוזמן, לא רק את הבא.
function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch (_) {} }
  playing.clear();
  playHead = 0;
  document.body.classList.remove('speaking');
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micStream.getAudioTracks()[0].onended = () => {
    if (live) { disconnect(); fail('המיקרופון נותק', 'ייתכן שאפליקציה אחרת תפסה אותו.'); }
  };

  await ctx.audioWorklet.addModule('./pcm-worklet.js');
  micNode = new AudioWorkletNode(ctx, 'p');

  micNode.port.onmessage = (e) => {
    const f32 = e.data;

    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    els.level.style.width = Math.min(100, rms * 320) + '%';

    if (!live || !session) return;

    // בזמן שהמדריך מדבר, הרמקול דולף למיקרופון. מסננים רק רעש חלש —
    // לא משתיקים לגמרי, אחרת אי אפשר להיכנס לו לדברים.
    if (playHead > ctx.currentTime + 0.05 && rms < 0.02) return;

    try {
      session.sendRealtimeInput({
        audio: { data: toPcm16Base64(f32, ctx.sampleRate), mimeType: `audio/pcm;rate=${IN_RATE}` },
      });
    } catch (_) { /* הסשן נסגר */ }
  };

  ctx.createMediaStreamSource(micStream).connect(micNode);
  const sink = ctx.createGain();   // צומת אילם, רק כדי שה-worklet ימשיך לרוץ
  sink.gain.value = 0;
  micNode.connect(sink).connect(ctx.destination);
}

// ---------- מצלמה ----------

async function toggleCam() {
  if (camStream) {
    clearInterval(camTimer);
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    els.camWrap.hidden = true;
    els.cam.classList.remove('on');
    return;
  }

  // exact ולא ideal — עדיף שייכשל בקול מאשר שיפתח בשקט את מצלמת הסלפי
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { exact: 'environment' }, width: { ideal: 960 } },
  });
  els.video.srcObject = camStream;
  els.camWrap.hidden = false;
  els.cam.classList.add('on');
  await els.video.play().catch(() => {});

  const cv = document.createElement('canvas');
  camTimer = setInterval(() => {
    if (!live || !session || !els.video.videoWidth) return;
    cv.width = 640;
    cv.height = Math.round((els.video.videoHeight / els.video.videoWidth) * 640);
    cv.getContext('2d').drawImage(els.video, 0, 0, cv.width, cv.height);
    try {
      session.sendRealtimeInput({
        video: { data: cv.toDataURL('image/jpeg', 0.6).split(',')[1], mimeType: 'image/jpeg' },
      });
    } catch (_) {}
  }, 1000);
}

// ---------- חיבור ----------

async function connect() {
  els.err.hidden = true;
  els.talk.disabled = true;

  try {
    setStatus('מבקש מיקרופון…', 'busy');
    await startMic();
  } catch (e) {
    setStatus('לא מחובר', 'bad');
    cleanup();
    els.talk.disabled = false;
    return fail('אין גישה למיקרופון', e.message);
  }

  try {
    setStatus('מתחבר…', 'busy');
    const ai = new GoogleGenAI({
      apiKey: EPHEMERAL_TOKEN,
      httpOptions: { apiVersion: API_VERSION },
    });

    session = await ai.live.connect({
      model: MODEL,
      // ההגדרות המלאות ננעלו בטוקן בצד המחשב
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen: () => {
          live = true;
          els.talk.disabled = false;
          setStatus('מקשיב', 'on');
          els.talk.firstChild.textContent = 'נתק';
          els.talk.classList.add('on');
          if (ctx.state !== 'running') {
            setStatus('הקש להפעלת שמע', 'bad');
          }
        },
        onmessage: (m) => {
          const sc = m.serverContent;
          if (!sc) return;
          if (sc.interrupted) stopPlayback();
          for (const p of sc.modelTurn?.parts || []) {
            if (p.inlineData?.data) playPcm(p.inlineData.data);
          }
          if (sc.inputTranscription?.text) say('me', sc.inputTranscription.text);
          if (sc.outputTranscription?.text) say('ai', sc.outputTranscription.text);
        },
        onerror: (e) => fail('שגיאת חיבור', e?.message || String(e)),
        onclose: (e) => {
          if (live) {
            const reason = e?.reason;
            disconnect();
            if (reason) fail('הסשן נסגר', reason);
          }
        },
      },
    });
  } catch (e) {
    setStatus('לא מחובר', 'bad');
    cleanup();
    els.talk.disabled = false;
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
  els.level.style.width = '0%';
}

function disconnect() {
  live = false;
  cleanup();
  els.talk.disabled = false;
  els.talk.firstChild.textContent = 'התחל שיחה';
  els.talk.classList.remove('on');
  setStatus('לא מחובר', '');
}

// ---------- הפעלה ----------

els.talk.onclick = () => {
  if (live) return disconnect();

  if (!EPHEMERAL_TOKEN) {
    return fail('חסר טוקן בכתובת', 'הרץ mint_qr.py במחשב וסרוק את ה-QR מהאייפון.');
  }

  // iOS: המדיניות מודדת "הקשה אחרונה" ומוותרת אחרי 5 שניות.
  // לכן ה-context נוצר כאן, סינכרונית, ו-resume בלי await.
  if (!ctx) {
    if ('audioSession' in navigator) navigator.audioSession.type = 'play-and-record';
    ctx = new AudioContext();
    ctx.resume();
    ctx.onstatechange = () => { if (ctx && ctx.state !== 'running') ctx.resume(); };
  }

  connect();
};

els.cam.onclick = () => toggleCam().catch((e) => fail('אין גישה למצלמה', e.message));

// חזרה מנעילת מסך / שיחה נכנסת משאירה את ה-context במצב interrupted
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume();
});

if (!EPHEMERAL_TOKEN) {
  fail('חסר טוקן בכתובת', 'הרץ mint_qr.py במחשב וסרוק את ה-QR מהאייפון.');
  els.talk.disabled = true;
}
