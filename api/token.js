// מנפיק טוקן זמני ל-Live API. המפתח יושב כאן בשרת בלבד ולא מגיע לטלפון.
// הדף קורא לכאן בכל לחיצה על "התחל", ולכן הקישור עצמו לא פג תוקף.
import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const API_VERSION = 'v1alpha';
const VOICE = process.env.LIVE_VOICE || 'Charon';   // גברי. חלופות: Orus, Iapetus

const SYSTEM_INSTRUCTION = `RESPOND IN HEBREW. YOU MUST RESPOND UNMISTAKABLY IN HEBREW,
unless the user speaks to you in another language — then match their language.

אתה מדריך טיולים ישראלי שמלווה מטייל בזמן אמת.
לפעמים אתה רואה מה שהמצלמה שלו רואה, ולפעמים לא — אל תמציא מה שאתה לא רואה.
ענה קצר, שניים־שלושה משפטים, כמו בשיחה אמיתית. בלי רשימות ובלי הקדמות.
אם הוא מכוון על תפריט, שלט או תמרור — תרגם והסבר מה כתוב.
אם הוא שואל לאן ללכת — תן המלצה אחת קונקרטית עם שם מקום, לא אפשרויות.`;

// SMART מוסיף פיסוק ומנקה גמגומים, ורמזי שפה משפרים תמלול עברית.
// אם המודל דוחה את השדות האלה נופלים לתמלול רגיל במקום להיכשל.
const SMART_TRANSCRIPTION = { mode: 'SMART', languageCodes: ['he-IL', 'en-US'] };
const PLAIN_TRANSCRIPTION = {};

// הגבלת קצב בסיסית לכל instance, כדי שלא ישרפו לך קרדיטים
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60_000;
  const max = 10;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

function liveConfig(inputTranscription) {
  return {
    responseModalities: ['AUDIO'],
    systemInstruction: SYSTEM_INSTRUCTION,
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    // בלי זה סשן עם אודיו+וידאו נחתך אחרי שתי דקות.
    contextWindowCompression: { slidingWindow: {} },
    // מאפשר לעצור ולהמשיך בלי לאבד את ההקשר
    sessionResumption: {},
    inputAudioTranscription: inputTranscription,
    outputAudioTranscription: {},
    // silence_duration קובע מתי התור שלך נגמר והוא מתחיל לענות.
    realtimeInputConfig: {
      automaticActivityDetection: { prefixPaddingMs: 200, silenceDurationMs: 700 },
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const expected = process.env.APP_PASSCODE;
  const supplied = req.headers['x-passcode'];
  if (!expected || supplied !== expected) {
    return res.status(401).json({ error: 'bad_passcode' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });
  const now = Date.now();

  const mint = (inputTranscription) =>
    ai.authTokens.create({
      config: {
        // טוקן לשיחה אחת. הדף מנפיק חדש בכל לחיצה על "התחל".
        uses: 1,
        expireTime: new Date(now + 60 * 60_000).toISOString(),
        // חלון לפתיחת הסשן — מספיק זמן לאשר מיקרופון
        newSessionExpireTime: new Date(now + 5 * 60_000).toISOString(),
        liveConnectConstraints: { model: MODEL, config: liveConfig(inputTranscription) },
      },
    });

  let token;
  try {
    token = await mint(SMART_TRANSCRIPTION);
  } catch (smartErr) {
    console.warn('smart transcription rejected, falling back:', smartErr?.message || smartErr);
    try {
      token = await mint(PLAIN_TRANSCRIPTION);
    } catch (err) {
      console.error('token mint failed:', err);
      return res.status(502).json({ error: 'mint_failed', detail: String(err?.message || err) });
    }
  }

  return res.status(200).json({ token: token.name, model: MODEL, apiVersion: API_VERSION });
}
