// Record the 3D replay as a WebM video for slides: the 3D view, the attitude inset and a readout
// are drawn onto one canvas each frame and captured with MediaRecorder. Plays at the chosen speed.
export interface RecordFrame {
  main: HTMLCanvasElement;
  inset: HTMLCanvasElement | null;
  lines: string[]; // readout, top-left
  title: string; // bottom-left
  phase: string;
  time: string;
}

export function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

export class Recorder {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  readonly done: Promise<Blob>;

  constructor(width: number, height: number, mime: string) {
    // even dimensions, at most 1280 wide, so every encoder accepts it
    const k = Math.min(1, 1280 / width);
    this.canvas.width = Math.round((width * k) / 2) * 2;
    this.canvas.height = Math.round((height * k) / 2) * 2;
    const stream = this.canvas.captureStream(30);
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.done = new Promise((res) => { this.rec.onstop = () => res(new Blob(this.chunks, { type: mime.split(";")[0] })); });
    this.rec.start(250);
  }

  draw(f: RecordFrame) {
    const { ctx, canvas: c } = this;
    const W = c.width, H = c.height, s = W / 1280;
    ctx.fillStyle = "#0d1524";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(f.main, 0, 0, W, H);
    if (f.inset) {
      const iw = 260 * s, ih = iw * (f.inset.height / Math.max(1, f.inset.width));
      ctx.fillStyle = "rgba(13,21,36,0.75)";
      ctx.fillRect(W - iw - 24 * s, H - ih - 24 * s, iw, ih);
      ctx.drawImage(f.inset, W - iw - 24 * s, H - ih - 24 * s, iw, ih);
    }
    // readout
    const pad = 16 * s, lh = 30 * s;
    ctx.fillStyle = "rgba(13,21,36,0.78)";
    ctx.fillRect(pad, pad, 300 * s, (f.lines.length + 1) * lh + 22 * s);
    ctx.fillStyle = "#ff7a1a";
    ctx.font = `600 ${22 * s}px Barlow, system-ui, sans-serif`;
    ctx.fillText(`${f.phase}  ${f.time}`, pad + 14 * s, pad + 34 * s);
    ctx.fillStyle = "#e9eef7";
    ctx.font = `500 ${20 * s}px Barlow, system-ui, sans-serif`;
    f.lines.forEach((l, i) => ctx.fillText(l, pad + 14 * s, pad + 34 * s + (i + 1) * lh));
    ctx.fillStyle = "rgba(233,238,247,0.85)";
    ctx.font = `500 ${18 * s}px Barlow, system-ui, sans-serif`;
    ctx.fillText(f.title, pad, H - pad);
  }

  stop() { if (this.rec.state !== "inactive") this.rec.stop(); }
}
