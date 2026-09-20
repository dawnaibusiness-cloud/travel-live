r"""
מנפיק טוקן זמני ומייצר QR לסריקה מהאייפון.
המפתח שלך נשאר כאן במחשב ולא נשלח לשום מקום חוץ מגוגל.

הרצה:
  $env:GEMINI_API_KEY = "המפתח_שלך"
  python mint_qr.py

הטוקן תקף 30 דקות ולסשן אחד. לשיחה נוספת — הרץ שוב.
"""
import datetime as dt
import os
import sys
import webbrowser

# בלי זה העברית יוצאת ג'יבריש בקונסול של Windows
if sys.platform == "win32":
    os.system("")  # מפעיל עיבוד ANSI ב-conhost
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

import segno
from google import genai
from google.genai import types

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    """קורא .env מקומי. המפתח נשאר בקובץ ולא נכנס להיסטוריית הפקודות."""
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


load_env()

PAGE_URL = os.environ.get("TRAVEL_LIVE_URL", "").rstrip("/")
MODEL = os.environ.get("LIVE_MODEL", "gemini-3.8-live")

SYSTEM_INSTRUCTION = """RESPOND IN HEBREW. YOU MUST RESPOND UNMISTAKABLY IN HEBREW,
unless the user speaks to you in another language — then match their language.

אתה מדריך טיולים ישראלי שמלווה מטייל בזמן אמת.
לפעמים אתה רואה מה שהמצלמה שלו רואה, ולפעמים לא — אל תמציא מה שאתה לא רואה.
ענה קצר, שניים־שלושה משפטים, כמו בשיחה אמיתית. בלי רשימות ובלי הקדמות.
אם הוא מכוון על תפריט, שלט או תמרור — תרגם והסבר מה כתוב.
אם הוא שואל לאן ללכת — תן המלצה אחת קונקרטית עם שם מקום, לא אפשרויות."""

VOICE = "Charon"   # גברי, טון של מדריך. חלופות: Orus, Iapetus

# SMART מוסיף פיסוק ומנקה גמגומים, ורמזי שפה משפרים תמלול עברית.
# השדות האלה מתועדים למודל התמלול הייעודי; אם 3.8 Live דוחה אותם,
# נופלים חזרה לתמלול רגיל במקום להיכשל.
SMART_TRANSCRIPTION = types.AudioTranscriptionConfig(
    mode=types.AudioTranscriptionConfigMode.SMART,
    language_codes=["he-IL", "en-US"],
)
PLAIN_TRANSCRIPTION = types.AudioTranscriptionConfig()

api_key = os.environ.get("GEMINI_API_KEY", "")
if not api_key or api_key == "PASTE_YOUR_KEY_HERE":
    sys.exit("פתח את הקובץ .env והדבק את המפתח אחרי GEMINI_API_KEY=")
if not PAGE_URL:
    sys.exit("חסר TRAVEL_LIVE_URL בקובץ .env")

# הטוקן מונפק ב-v1alpha, ולכן גם החיבור מהטלפון חייב להיות באותה גרסה.
API_VERSION = "v1alpha"
MINUTES = 60   # אורך חיי הטוקן
USES = 25      # כמה פעמים אפשר לפתוח שיחה עם אותו QR

client = genai.Client(api_key=api_key, http_options={"api_version": API_VERSION})
now = dt.datetime.now(tz=dt.timezone.utc)

def mint(input_transcription):
    return client.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            # מספר פתיחות סשן, לא מספר שיחות. עצירה והמשך שורפים עוד אחד.
            uses=USES,
            expire_time=now + dt.timedelta(minutes=MINUTES),
            # חלון לפתיחת הסשן — מספיק זמן לסרוק, לאשר מיקרופון וללחוץ
            new_session_expire_time=now + dt.timedelta(minutes=10),
            live_connect_constraints=types.LiveConnectConstraints(
                model=MODEL,
                config=types.LiveConnectConfig(
                    response_modalities=["AUDIO"],
                    system_instruction=SYSTEM_INSTRUCTION,
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
                        )
                    ),
                    # בלי זה סשן עם אודיו+וידאו נחתך אחרי שתי דקות.
                    context_window_compression=types.ContextWindowCompressionConfig(
                        sliding_window=types.SlidingWindow()
                    ),
                    # מאפשר לעצור ולהמשיך בלי לאבד את ההקשר
                    session_resumption=types.SessionResumptionConfig(),
                    input_audio_transcription=input_transcription,
                    output_audio_transcription=types.AudioTranscriptionConfig(),
                    # רגישות התחלה בברירת המחדל — LOW גרם לו לא לזהות דיבור.
                    # silence_duration קובע מתי התור שלך נגמר והוא מתחיל לענות.
                    realtime_input_config=types.RealtimeInputConfig(
                        automatic_activity_detection=types.AutomaticActivityDetection(
                            prefix_padding_ms=200,
                            silence_duration_ms=700,
                        )
                    ),
                ),
            ),
        )
    )


try:
    token = mint(SMART_TRANSCRIPTION)
    transcription = "SMART + he-IL"
except Exception as exc:
    print(f"[תמלול משופר נדחה, נופל לרגיל: {type(exc).__name__}]")
    token = mint(PLAIN_TRANSCRIPTION)
    transcription = "רגיל"

url = f"{PAGE_URL}/#t={token.name}&m={MODEL}&v={API_VERSION}"

qr = segno.make(url, error="m")
qr.save("qr.png", scale=8, border=3)

print()
print(f"מודל:  {MODEL}")
print(f"קול:   {VOICE} (גברי)")
print(f"תמלול: {transcription}")
print(f"תוקף:  {MINUTES} דקות, עד {USES} פתיחות שיחה")
print(f"נשמר:  qr.png")
print()
print("סרוק מהאייפון. אל תשתף את ה-QR — הוא מכיל טוקן פעיל.")

webbrowser.open(os.path.join(HERE, "qr.png"))
