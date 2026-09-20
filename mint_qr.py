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

SYSTEM_INSTRUCTION = """אתה מדריך טיולים ישראלי שמלווה מטייל בזמן אמת.
אתה רואה מה שהמצלמה שלו רואה. ענה קצר — שניים־שלושה משפטים, כמו בשיחה.
אם הוא מכוון על תפריט, שלט או תמרור — תרגם והסבר.
אם הוא שואל לאן ללכת — תן המלצה אחת קונקרטית, לא רשימה.
דבר בעברית אלא אם פנו אליך בשפה אחרת."""

api_key = os.environ.get("GEMINI_API_KEY", "")
if not api_key or api_key == "PASTE_YOUR_KEY_HERE":
    sys.exit("פתח את הקובץ .env והדבק את המפתח אחרי GEMINI_API_KEY=")
if not PAGE_URL:
    sys.exit("חסר TRAVEL_LIVE_URL בקובץ .env")

# הטוקן מונפק ב-v1alpha, ולכן גם החיבור מהטלפון חייב להיות באותה גרסה.
API_VERSION = "v1alpha"

client = genai.Client(api_key=api_key, http_options={"api_version": API_VERSION})
now = dt.datetime.now(tz=dt.timezone.utc)

token = client.auth_tokens.create(
    config=types.CreateAuthTokenConfig(
        uses=1,
        expire_time=now + dt.timedelta(minutes=30),
        new_session_expire_time=now + dt.timedelta(minutes=2),
        live_connect_constraints=types.LiveConnectConstraints(
            model=MODEL,
            config=types.LiveConnectConfig(
                response_modalities=["AUDIO"],
                system_instruction=SYSTEM_INSTRUCTION,
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                # הטלפון מחזיק רמקול ומיקרופון באותו מכשיר. בלי הנמכת הרגישות,
                # הדלף מהרמקול נקרא כאילו המשתמש התחיל לדבר והמדריך נקטע לעצמו.
                realtime_input_config=types.RealtimeInputConfig(
                    automatic_activity_detection=types.AutomaticActivityDetection(
                        start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                        prefix_padding_ms=300,
                    )
                ),
            ),
        ),
    )
)

url = f"{PAGE_URL}/#t={token.name}&m={MODEL}&v={API_VERSION}"

qr = segno.make(url, error="m")
qr.save("qr.png", scale=8, border=3)
qr.terminal(compact=True)

print()
print(f"מודל:  {MODEL}")
print(f"תוקף:  30 דקות, סשן אחד")
print(f"נשמר:  qr.png")
print()
print("סרוק מהאייפון. אל תשתף את ה-QR — הוא מכיל טוקן פעיל.")

webbrowser.open("qr.png")
