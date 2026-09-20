// חייב להיות קובץ אמיתי באותו origin.
// iOS Safari חוסם טעינת worklet מ-blob: URL, ואז המיקרופון פשוט לא עולה.
class P extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.n += ch.length;
      // אוגר ~100ms לפני שליחה. בלי זה יוצאים ~375 מסרים בשנייה וזה חונק את הטלפון.
      if (this.n >= sampleRate / 10) {
        const out = new Float32Array(this.n);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = [];
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('p', P);
