// מנפיק טוקן זמני ל-Live API.
// מפתח ה-API יושב כאן בשרת בלבד ולעולם לא מגיע לטלפון.
import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';

const SYSTEM_INSTRUCTION = `אתה מדריך טיולים ישראלי שמלווה מטייל בזמן אמת.
אתה רואה מה שהמצלמה שלו רואה. ענה קצר — שתיים שלוש משפטים, כמו בשיחה.
אם הוא מכוון על תפריט, שלט או תמרור — תרגם והסבר.
אם הוא שואל לאן ללכת — תן המלצה אחת קונקרטית, לא רשימה.
דבר בעברית אלא אם פנו אליך בשפה אחרת.`;

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

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();

    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: ['AUDIO'],
            systemInstruction: SYSTEM_INSTRUCTION,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
          },
        },
      },
    });

    return res.status(200).json({ token: token.name, model: MODEL });
  } catch (err) {
    console.error('token mint failed:', err);
    return res.status(502).json({ error: 'mint_failed', detail: String(err?.message || err) });
  }
}
