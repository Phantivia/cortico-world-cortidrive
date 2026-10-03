/**
 * 嘴型同步：订阅 vtuber World 的演出流（GET /stream，SSE），把可缇每段语音的发声区间转给插件，
 * 游戏里妹妹的嘴在这些区间里张合。vtuber 每段语音开播时发 subtitle（cue 的 atMs 相对发出时刻，
 * 同一段播放中会以更准的时间重发，以最新一批为准），被打断时发 subtitle.cut。
 * vtuber 把 /stream 有订阅者当作在播，所以只在游戏连着时订阅。
 */
import type { Logger } from 'cortico/core/types.ts';

const RETRY_MS = 3000;

export interface MouthWindow {
  atMs: number;
  ms: number;
}

/** 演出流的一条消息对应的发声区间；与嘴型无关的消息返回 null。 */
export function mouthWindows(msg: { type?: unknown; cues?: unknown }): MouthWindow[] | null {
  if (msg.type === 'subtitle.cut') return [];
  if (msg.type !== 'subtitle' || !Array.isArray(msg.cues)) return null;
  return (msg.cues as Array<{ atMs?: number; speakMs?: number; durMs?: number }>)
    .map((c) => ({ atMs: Number(c.atMs ?? 0), ms: Number(c.speakMs ?? c.durMs ?? 0) }))
    .filter((w) => w.ms > 0);
}

export class MouthSync {
  private abort: AbortController | null = null;
  private retry: NodeJS.Timeout | null = null;
  /** 连不上只报一次，连上后复位。 */
  private warned = false;

  constructor(
    private readonly url: () => string,
    private readonly send: (windows: MouthWindow[]) => void,
    private readonly log: () => Logger | undefined,
  ) {}

  start(): void {
    if (this.abort || this.retry) return;
    void this.connect();
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
  }

  private async connect(): Promise<void> {
    const url = this.url();
    if (!url) return;
    const ac = new AbortController();
    this.abort = ac;
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.warned = false;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let end = buf.indexOf('\n\n'); end !== -1; end = buf.indexOf('\n\n')) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let windows: MouthWindow[] | null = null;
          try {
            windows = mouthWindows(JSON.parse(data) as { type?: unknown; cues?: unknown });
          } catch {
            continue;
          }
          if (windows) this.send(windows);
        }
      }
    } catch (err) {
      if (!ac.signal.aborted && !this.warned) this.log()?.warn('cortidrive.mouth', `演出流 ${url} 不可用：${String(err)}，每 ${RETRY_MS / 1000} 秒重试`);
      this.warned = true;
    }
    if (this.abort !== ac || ac.signal.aborted) return;
    this.abort = null;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, RETRY_MS);
  }
}
