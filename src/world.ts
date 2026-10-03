/**
 * 教可缇开车 World。bot 坐进驾驶座，顶替游戏里妹妹的模型：游戏内 BepInEx 插件把每次
 * cortidrive_drive 当作游戏的一轮语音回合，按本关原生的回复格式交给游戏自己解析（教程动作、
 * 剧情推进、台词等待照旧），速度与方向按计划在车控上执行；游戏方法调用转成事件帧，World 渲染后投递。
 * 坐副驾驶指挥的人走 asr World 的语音事件，不经过游戏。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlobInput, ToolDef, ToolOutcome, TriggerMode, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { CORTIDRIVE_CONFIG_GROUP, type CortiDriveConfigSection } from './config.ts';
import { GameBridge, PROTOCOL, type GameFrame, type GameState } from './bridge.ts';
import { MouthSync } from './mouth.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TAG = '[教可缇开车]';
// 插件在游戏主线程处理请求；游戏主线程卡顿期间请求会排队。
const REQUEST_TIMEOUT_MS = 10_000;
/** 实时画面每次唤醒都会进上下文，尺寸比事件截图小。 */
const LIVE_VIEW_SIZE = { width: 512, topWidth: 384 };
const CHAIN_MS = 3000;
const CHAIN_EVENTS = new Set(['mine', 'collision']);
/** 台词时长按每秒 4.5 个字估，游戏里等台词说完的剧情按它推进。 */
const CHARS_PER_SEC = 4.5;

/** cfg.attachImages 打开时附截图的事件。 */
const IMAGE_EVENTS = new Set(['scene', 'situation', 'guide', 'illegalAction', 'mine', 'collision', 'stageEnd']);

const EMOTION: Record<string, string> = { Smile: '平静', Angry: '生气', Anxious: '紧张' };

const TRIGGER: Record<string, TriggerMode> = {
  plan: 'debounce', script: 'flush', mission: 'flush', brief: 'flush', guide: 'flush', situation: 'flush', popup: 'flush',
  fine: 'debounce', damage: 'flush', collision: 'flush', illegalAction: 'preempt', mine: 'preempt', emotion: 'debounce', stageEnd: 'flush',
  scene: 'flush',
};

const DRIVE_REFUSAL: Record<string, string> = {
  noDriver: '当前场景没有驾驶（菜单、加载或过场）',
  inputDisabled: '游戏此刻不接受驾驶指令（剧情演出中或关卡已结束）；这次操作照常算作按过对讲键，等这个键的开场画面会继续',
  paused: '游戏处于暂停',
  actionOnlyInTutorial: 'action 只在教程关有效，其他关用 steps 控制速度和方向',
  unknownAction: '教程关只认 fasten_seatbelt、start_engine、accelerate',
};

const TUTORIAL_ACTION: Record<string, string> = { fasten_seatbelt: '系安全带', start_engine: '发动引擎', accelerate: '起步出发' };

/** 台词里的表演标记：【】动作、<>行内、[]发声；只留说出口的字。 */
export function spokenText(script: string): string {
  return script.replace(/【[^】]*】|<[^>]*>|\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

export function renderState(s: GameState | undefined): string {
  if (!s) return '';
  const parts = [`场景 ${s.scene}`];
  if (s.speed !== undefined) parts.push(`车速 ${s.speed} ${s.speedUnit}`);
  if (s.seatbelt !== undefined) parts.push(s.seatbelt ? '安全带已系' : '安全带未系');
  if (s.engine !== undefined) parts.push(s.engine ? '引擎已发动' : '引擎未发动');
  if (s.emotion) parts.push(`你的表情 ${EMOTION[s.emotion] ?? s.emotion}`);
  if (s.fine !== undefined) parts.push(`罚款累计 ${s.fine}`);
  if (s.damageCount !== undefined) parts.push(`碰撞 ${s.damageCount} 次`);
  parts.push(s.paused ? '已暂停' : s.driverInput ? '可以操作' : '此刻不接受操作');
  const ahead = s.ahead ? renderAhead(s) : '';
  const goal = s.goal ? `\n${renderGoal(s.goal)}` : '';
  return parts.join(' · ') + (ahead ? `\n${ahead}` : '') + goal;
}

const AHEAD_LABEL = { front: '正前', left: '左前 30°', right: '右前 30°' } as const;

/** 射线距离，以及按当前车速走到那里的秒数（车速取自速度表，按其单位换算成米/秒）。 */
export function renderAhead(s: GameState): string {
  const mps = s.speed === undefined ? 0 : s.speedUnit === 'mph' ? s.speed * 0.447 : s.speed / 3.6;
  const parts: string[] = [];
  for (const key of ['front', 'left', 'right'] as const) {
    const hit = s.ahead?.[key];
    if (!hit) continue;
    const eta = mps > 0.5 ? `，按当前车速约 ${(hit.distanceM / mps).toFixed(1)} 秒` : '';
    parts.push(`${AHEAD_LABEL[key]} ${hit.distanceM} 米有「${hit.object}」${eta}`);
  }
  return parts.length ? `前方障碍：${parts.join('；')}` : '前方 40 米内三个方向都没有障碍';
}

function stepText(step: string): string {
  return step
    .replace(/speed none/, '速度不变').replace(/speed (-?[\d.]+)/, (_, v) => (Number(v) === 0 ? '刹车' : Number(v) < 0 ? `倒车 ${-Number(v)} km/h` : `速度 ${v} km/h`))
    .replace(/steer none/, '方向不变').replace(/steer (-?[\d.]+)/, (_, v) => (Number(v) === 0 ? '回正' : `方向盘${Number(v) < 0 ? '左' : '右'}打 ${Math.abs(Number(v))}`))
    .replace(/until none/, '一直保持').replace(/until seconds ([\d.]+)/, '保持 $1 秒').replace(/until distance ([\d.]+)/, '开出 $1 米')
    .replace(/until turned ([\d.]+)/, '车头转过 $1°').replace(/until stopped/, '直到停稳').replace(/until goal ([\d.]+)/, '直到离目标不到 $1 米');
}

function bearingText(deg: number): string {
  const a = Math.abs(deg);
  if (a <= 10) return '正前方';
  if (a >= 170) return '正后方';
  return `${deg > 0 ? '右' : '左'}${a < 90 ? '前' : '后'}方（偏 ${a}°）`;
}

export function renderGoal(g: NonNullable<GameState['goal']>): string {
  const parts = [`目标车位在车头${bearingText(g.bearingDeg)} ${g.distanceM} 米`];
  if (g.rearIn && g.headingErrorDeg !== undefined) {
    const ok = Math.abs(g.headingErrorDeg) <= (g.allowedErrorDeg ?? 0);
    parts.push(`要求倒车入位（车尾朝里），车身与入位方向差 ${Math.abs(g.headingErrorDeg)}°，${ok ? '在允许范围内' : `允许 ${g.allowedErrorDeg}°`}`);
  }
  parts.push(g.inside ? `已完整进入车位，停稳满 ${g.requiredStaySec} 秒才算完成（已 ${g.stayedSec} 秒）` : '还没完整进入车位');
  return parts.join('；');
}

/** 判负原因：调用 ShowGameOverUI 的类与它记下的原因串，按游戏代码里的判定条件翻译。 */
const FAIL_REASON: Record<string, string> = {
  '차량이 심각한 손상을 입어 더 이상 운행할 수 없습니다.': '压雷次数到上限，车辆严重损坏',
  '차량이 갇혀서 더 이상 진행할 수 없습니다.': '车辆侧翻或卡住超过 3 秒',
};
const FAIL_CAUSE: Record<string, string> = {
  CarStuckDetector: '车辆侧翻或卡住超过 3 秒',
  PlayerCarCollider: '已经生气时又撞上车辆或行人',
  PlayerCarCollisionChecker: '发生碰撞',
  TrafficCrossChecker: '红灯时驶入路口',
  PenaltyCarCollision: '被违规后出现的惩罚车撞上',
  ParkingLotRampCarCollision: '第 4 次碰撞，车辆损毁',
  RoadTestCarCollision: '第 4 次碰撞，车辆损毁',
  CliffFallDetector: '车从边缘掉落',
};

export function failCause(cause: string, reason: string): string {
  if (reason) return FAIL_REASON[reason] ?? reason;
  return FAIL_CAUSE[cause] ?? (cause ? `判负来源 ${cause}` : '');
}

export function renderEvent(f: GameFrame): string | null {
  const str = (k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
  switch (f.type) {
    case 'plan': {
      if (f.phase === 'started') {
        const steps = Array.isArray(f.steps) ? (f.steps as string[]) : [];
        return `${TAG} 计划 ${String(f.planId)} 开始（第 ${String(f.driveId)} 次操作）：\n${steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join('\n')}`;
      }
      if (f.phase === 'step') return `${TAG} 计划 ${String(f.planId)} 第 ${String(f.index)}/${String(f.count)} 步：${stepText(str('step'))}`;
      if (f.phase === 'done') return `${TAG} 计划 ${String(f.planId)} 走完了\n${renderState(f.state)}`;
      if (f.phase === 'cancelled') return `${TAG} 计划 ${String(f.planId)} 被新的操作打断，没走完`;
      return null;
    }
    case 'script': return `${TAG} 游戏剧本里驾驶座上的妹妹（现在是你）这时说：「${str('text')}」`;
    case 'mission': return `${TAG} 任务：${str('text')}`;
    case 'brief': return `${TAG} 本关游戏写给原妹妹模型的说明（原文节选：目标与动作刻度）：\n${str('text')}`;
    case 'guide': return `${TAG} 画面提示：${str('text') || str('key')}`;
    case 'situation': return `${TAG} 进入情境区，游戏给原妹妹模型的情境描述：${str('text')}`;
    case 'popup': return `${TAG} 弹窗：${str('text')}`;
    case 'fine': return `${TAG} 罚款 +${String(f.amount)}，累计 ${String(f.total)}`;
    case 'damage': return `${TAG} 碰撞，本关累计 ${String(f.count)} 次`;
    case 'collision': return `${TAG} 车撞上了${f.hit === 'cone' ? '锥桶' : '障碍物'}「${str('object')}」，撞击力度 ${String(f.force)}\n${renderState(f.state)}`;
    case 'mine': return `${TAG} 车压到地雷，第 ${String(f.hits)} 次（满 ${String(f.maxHits)} 次判负）\n${renderState(f.state)}`;
    case 'illegalAction': return `${TAG} 违规倒计时开始：${Number(f.timeLeftSec ?? 0).toFixed(1)} 秒`;
    case 'emotion': return `${TAG} 游戏里你的表情 ${EMOTION[str('from')] ?? str('from')} → ${EMOTION[str('to')] ?? str('to')}`;
    case 'stageEnd': {
      const cause = f.result === 'clear' ? '' : failCause(str('cause'), str('reason'));
      return `${TAG} 关卡结束：${f.result === 'clear' ? '通过' : '失败'}${cause ? `，${cause}` : ''}\n${renderState(f.state)}`;
    }
    case 'scene': return `${TAG} 场景载入：${str('scene')}\n${renderState(f.state)}`;
    default: return null;
  }
}

/** 一步计划：速度 km/h（负数倒车，0 刹车）、方向盘 -1..1；省略的项保持不变。 */
export interface DriveStep {
  speed?: number;
  steer?: number;
  until?: 'seconds' | 'distance' | 'turned' | 'stopped' | 'goal' | 'none';
  value?: number;
}

/** 台词说完大约要几秒。 */
export function lineSeconds(line: string): number {
  return Math.round((line.length / CHARS_PER_SEC) * 10) / 10;
}

/** 同名进程是否在运行；装了插件的各份游戏 exe 同名，任一在跑都算。 */
function gameRunning(exe: string): Promise<boolean> {
  const name = basename(exe);
  if (!name || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${name.toLowerCase()}"`));
    });
  });
}

export interface CortiDriveWorldOptions {
  cfg: CortiDriveConfigSection;
  timezone: string;
}

export class CortiDriveWorld implements World {
  readonly id = 'cortidrive';
  private readonly bridge = new GameBridge();
  private readonly mouth = new MouthSync(
    () => this.opts.cfg.mouthSyncUrl,
    (windows) => this.bridge.notify({ kind: 'mouth', windows }),
    () => this.host?.log,
  );
  private host: WorldHost | null = null;
  private lamp: 'offline' | 'loading' | 'online' | 'error' = 'offline';
  private detail = '';
  private scene = '';
  private driverInput = false;
  private liveTimer: NodeJS.Timeout | null = null;
  private live: { blobs: BlobInput[]; state: GameState | undefined; note: string; atMs: number } | null = null;
  private liveDeliveredAtMs = 0;
  private liveQueued = false;
  private readonly lastChainAtMs = new Map<string, number>();
  /** 上一次驾驶操作被游戏收下的时刻；场景载入时重置。 */
  private lastDriveAtMs = Date.now();
  private idleWokenAtMs = 0;

  constructor(private readonly opts: CortiDriveWorldOptions) {
    this.bridge.on('hello', (f: GameFrame) => void this.onHello(f));
    this.bridge.on('event', (f: GameFrame) => void this.onGameEvent(f));
    this.bridge.on('disconnect', () => {
      this.mouth.stop();
      this.lamp = 'loading';
      this.detail = '等待游戏';
      void this.push('connection', `${TAG} 游戏连接已断开，插件可连时自动重连。`, 'flush', true);
    });
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.driveTool(), this.lookTool(), this.stageTool()];
  }

  console(): WorldConsoleDecl {
    return {
      lamps: [{ label: '游戏插件', state: this.lamp, hint: this.detail || undefined }],
      badges: [{ label: '场景', value: this.scene || '—' }],
      config: [CORTIDRIVE_CONFIG_GROUP],
      panels: [{ id: 'game', title: '游戏', description: '启动游戏，查看游戏进程与插件连接。' }],
      invoke: async (panel, method) => {
        if (panel === 'game' && method === 'status') return this.gameStatus();
        if (panel === 'game' && method === 'launch') return this.launchGame();
        throw new Error(`未知面板方法: ${panel}.${method}`);
      },
      promptDocs: [{
        key: 'worlds.cortidrive.envPrompt',
        title: '教可缇开车 · 环境提示词',
        description: '驾驶的方式、事件与工具的含义。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lamp = 'loading';
    this.detail = '等待游戏';
    this.bridge.open(this.opts.cfg.port);
    this.scheduleLive();
  }

  async stop(): Promise<void> {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.mouth.stop();
    this.bridge.close();
    this.host = null;
    this.lamp = 'offline';
  }

  // ---- 游戏进程 ---------------------------------------------------------------------

  private async gameStatus(): Promise<{ exe: string; exists: boolean; running: boolean; connected: boolean }> {
    const exe = this.opts.cfg.gameExe;
    return { exe, exists: !!exe && existsSync(exe), running: await gameRunning(exe), connected: this.bridge.connected };
  }

  /** 以 exe 所在目录为工作目录启动，游戏进程不随 bot 退出。 */
  private async launchGame(): Promise<{ ok: true }> {
    const status = await this.gameStatus();
    if (!status.exists) throw new Error(`找不到游戏程序 ${status.exe}`);
    if (status.running) throw new Error('游戏已在运行');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(status.exe, [], { cwd: dirname(status.exe), detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return { ok: true };
  }

  // ---- 游戏 → 事件 ------------------------------------------------------------------

  private async onHello(f: GameFrame): Promise<void> {
    if (f.protocol !== PROTOCOL) {
      this.lamp = 'error';
      this.detail = `插件协议 ${String(f.protocol)}，World 需要 ${PROTOCOL}`;
      this.bridge.close();
      return;
    }
    this.lamp = 'online';
    this.detail = `插件 ${String(f.plugin)}`;
    this.scene = f.state?.scene ?? '';
    this.driverInput = f.state?.driverInput ?? false;
    this.sendConfig();
    this.mouth.start();
    await this.push('connection', `${TAG} 游戏已连接。\n${renderState(f.state)}`, 'flush', true);
  }

  private async onGameEvent(f: GameFrame): Promise<void> {
    if (f.scene) this.scene = f.scene;
    if (f.state) this.driverInput = f.state.driverInput;
    if (f.type === 'scene') {
      this.live = null;
      this.lastDriveAtMs = Date.now();
    }
    const text = renderEvent(f);
    if (!text || !f.type) return;
    // 连环爆炸、连着蹭锥桶：只有第一下唤醒并附截图，其余照常记录、随下一次唤醒送达。
    let chained = false;
    if (CHAIN_EVENTS.has(f.type)) {
      const now = Date.now();
      chained = now - (this.lastChainAtMs.get(f.type) ?? 0) < CHAIN_MS;
      this.lastChainAtMs.set(f.type, now);
    }
    // 计划走完要接下一段：立即唤醒并附画面。
    const planDone = f.type === 'plan' && f.phase === 'done';
    const blobs = !chained && this.opts.cfg.attachImages && (IMAGE_EVENTS.has(f.type) || planDone) ? await this.capture() : undefined;
    await this.push(f.type, text, chained ? 'piggyback' : planDone ? 'flush' : TRIGGER[f.type] ?? 'debounce', false, blobs);
  }

  private async capture(): Promise<BlobInput[] | undefined> {
    if (!this.host?.modelFacts.accepts('image/jpeg')) return undefined;
    try {
      return (await this.shoot()).blobs;
    } catch (err) {
      this.host?.log.warn('cortidrive.capture', String(err));
      return undefined;
    }
  }

  /** 第一人称截图，cfg.topView 时另附俯视图。 */
  private async shoot(size: { width: number; topWidth: number } = { width: this.opts.cfg.captureWidth, topWidth: 512 }): Promise<{ blobs: BlobInput[]; state: GameState | undefined; text: string }> {
    const cfg = this.opts.cfg;
    const rep = await this.bridge.request({ kind: 'look', maxWidth: size.width, top: cfg.topView, topWidth: size.topWidth, topSpanM: cfg.topViewSpanMeters }, REQUEST_TIMEOUT_MS);
    if (!rep.ok || typeof rep.jpeg !== 'string') throw new Error(rep.error ?? '插件没有返回画面');
    const blobs: BlobInput[] = [{ bytes: Buffer.from(rep.jpeg, 'base64'), mime: 'image/jpeg', name: 'cortidrive.jpg', fallbackText: `游戏画面 ${String(rep.width)}×${String(rep.height)}` }];
    let text = '';
    if (typeof rep.topJpeg === 'string') {
      text = `第二张是车顶俯视图：车头朝上，本车在图中下方四分之一处，边长约 ${String(rep.topSpanM)} 米。`;
      blobs.push({ bytes: Buffer.from(rep.topJpeg, 'base64'), mime: 'image/jpeg', name: 'cortidrive-top.jpg', fallbackText: '俯视图' });
    }
    return { blobs, state: rep.state, text };
  }

  private sendConfig(): void {
    void this.bridge.request({ kind: 'config', minimap: this.opts.cfg.minimap, minimapSpanM: this.opts.cfg.topViewSpanMeters }, REQUEST_TIMEOUT_MS).catch(() => {});
  }

  /**
   * 关卡中按 liveViewSec 缓存最新画面，用 piggyback 随行事件挂在下一次唤醒上；
   * 投递时取最新的一份，比上次送达的新才出现。
   */
  private scheduleLive(): void {
    const sec = this.opts.cfg.liveViewSec;
    this.liveTimer = setTimeout(() => void this.refreshLive(), (sec > 0 ? sec : 5) * 1000);
  }

  private async refreshLive(): Promise<void> {
    try {
      if (this.opts.cfg.liveViewSec > 0 && this.bridge.connected && this.driverInput && this.host?.modelFacts.accepts('image/jpeg')) {
        const shot = await this.shoot(LIVE_VIEW_SIZE);
        this.live = { blobs: shot.blobs, state: shot.state, note: shot.text, atMs: Date.now() };
        const wakeSec = this.opts.cfg.wakeIdleSec;
        if (wakeSec > 0 && this.idleWokenAtMs !== this.lastDriveAtMs && Date.now() - this.lastDriveAtMs >= wakeSec * 1000) {
          // 每段空闲只唤醒一次；下一次驾驶操作后重新计时。
          this.idleWokenAtMs = this.lastDriveAtMs;
          this.queueLive('flush');
        } else {
          this.queueLive('piggyback');
        }
      }
    } catch (err) {
      this.host?.log.warn('cortidrive.live', String(err));
    } finally {
      if (this.host) this.scheduleLive();
    }
  }

  private queueLive(trigger: 'piggyback' | 'flush'): void {
    if (!this.host || (trigger === 'piggyback' && this.liveQueued)) return;
    if (trigger === 'piggyback') this.liveQueued = true;
    this.host.pushDeferred({
      type: 'cortidrive.view',
      senderKey: this.id,
      tags: ['snapshot'],
      render: () => {
        if (trigger === 'piggyback') this.liveQueued = false;
        const live = this.live;
        if (!live || live.atMs <= this.liveDeliveredAtMs) return null;
        this.liveDeliveredAtMs = live.atMs;
        const now = Date.now();
        const age = ((now - live.atMs) / 1000).toFixed(1);
        const idle = ((now - this.lastDriveAtMs) / 1000).toFixed(0);
        const head = `${TAG} 实时画面（${age} 秒前截取，距你上一次驾驶操作 ${idle} 秒）：${renderState(live.state)}`;
        return { text: [head, live.note].filter(Boolean).join('\n'), blobs: live.blobs };
      },
    }, { trigger });
  }

  private async push(noun: string, text: string, trigger: TriggerMode, internal = false, blobs?: BlobInput[]): Promise<void> {
    try {
      await this.host?.pushEvent({
        type: `cortidrive.${noun}`,
        source: this.id,
        senderKey: this.id,
        ts: nowIso(this.opts.timezone),
        text,
        ...(internal ? { origin: 'internal' as const } : {}),
        ...(blobs ? { blobs } : {}),
      }, { trigger });
    } catch (err) {
      this.host?.log.warn('cortidrive.event', String(err));
    }
  }

  // ---- 工具 -------------------------------------------------------------------------

  private requireGame(): ToolOutcome | null {
    if (this.bridge.connected) return null;
    return { text: '未执行：游戏未连接（游戏没开，或插件没装）。', failed: true };
  }

  private driveTool(): ToolDef {
    const step = {
      type: 'object',
      additionalProperties: false,
      properties: {
        speed: { type: 'number', description: 'Target speed in km/h: positive forward, 0 brakes to a stop, negative reverses. Omit to keep the current one.' },
        steer: { type: 'number', minimum: -1, maximum: 1, description: 'Steering wheel, -1 full left … 0 straight … 1 full right. Omit to keep the current one.' },
        until: { type: 'string', enum: ['seconds', 'distance', 'turned', 'stopped', 'goal', 'none'], description: 'When this step ends and the next starts: after `value` seconds, after `value` metres driven, after the heading turned `value` degrees, once stopped, within `value` metres of the parking goal, or none = hold until your next drive call. Default none.' },
        value: { type: 'number', description: 'Number for seconds / distance / turned / goal.' },
      },
    };
    return {
      name: 'cortidrive_drive',
      description: 'Drive the car: you are in the driver seat. Each call is one turn of yours in the game. steps run in order on the car (a new call replaces a running plan); action does a tutorial step; line is what you say with it, so the game waits for you to finish before its next scripted beat.',
      tags: ['act'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          steps: { type: 'array', items: step, description: 'Speed and steering plan. Empty or omitted leaves the car as it is.' },
          action: { type: 'string', enum: Object.keys(TUTORIAL_ACTION), description: 'Tutorial stage only: fasten_seatbelt, start_engine, or accelerate (set off).' },
          line: { type: 'string', description: 'The words you say with this turn, as spoken in vtuber_act. Optional.' },
        },
      },
      handler: async (args) => this.drive(args as { steps?: DriveStep[]; action?: string; line?: string }),
    };
  }

  private async drive(args: { steps?: DriveStep[]; action?: string; line?: string }): Promise<ToolOutcome> {
    const missing = this.requireGame();
    if (missing) return missing;
    const line = spokenText(String(args.line ?? ''));
    const steps = args.steps ?? [];
    if (!steps.length && !args.action && !line) return { text: '未执行：steps、action、line 都是空的。', failed: true };
    const rep = await this.bridge.request({ kind: 'drive', steps, action: args.action, line, lineSec: lineSeconds(line) }, REQUEST_TIMEOUT_MS);
    if (!rep.ok) return { text: `未执行：${DRIVE_REFUSAL[rep.error ?? ''] ?? rep.error}。`, failed: true };
    this.lastDriveAtMs = Date.now();
    const lines = [`已交给游戏（第 ${String(rep.id)} 次操作）。`];
    if (args.action) lines.push(`教程动作：${TUTORIAL_ACTION[args.action] ?? args.action}。`);
    if (typeof rep.planId === 'number') lines.push(`计划 ${rep.planId} 开始执行，进度见 cortidrive.plan。`);
    if (rep.planRejected) lines.push('这一关的车不接受速度和方向控制，steps 没有执行（教程关只用 action）。');
    return { text: lines.join('\n') };
  }

  private lookTool(): ToolDef {
    return {
      name: 'cortidrive_look',
      description: 'Current game screen plus scene, speed, emotion, fines, collisions, obstacles ahead, parking goal, and the situation text the game prepares for this stage.',
      tags: ['read', 'snapshot'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const missing = this.requireGame();
        if (missing) return missing;
        let shot;
        try {
          shot = await this.shoot();
        } catch (err) {
          return { text: `未取得画面：${err instanceof Error ? err.message : String(err)}`, failed: true };
        }
        const lines = [`${TAG} ${renderState(shot.state)}`];
        if (shot.text) lines.push(shot.text);
        if (shot.state?.context) lines.push(`游戏此刻的情境：${shot.state.context}`);
        return { text: lines.join('\n'), blobs: shot.blobs };
      },
    };
  }

  private stageTool(): ToolDef {
    return {
      name: 'cortidrive_stage',
      description: 'Stage flow: restart = replay the current stage; next = load the next stage; menu = back to the main menu; continue = from the main menu, resume at the saved stage.',
      tags: ['act'],
      barrierAfter: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string', enum: ['restart', 'next', 'menu', 'continue'] } },
        required: ['action'],
      },
      handler: async (args) => {
        const missing = this.requireGame();
        if (missing) return missing;
        const rep = await this.bridge.request({ kind: 'stage', action: args.action }, REQUEST_TIMEOUT_MS);
        if (!rep.ok) return { text: `未执行：${rep.error}`, failed: true };
        return `已执行 ${String(args.action)}；新场景载入后会收到 cortidrive.scene 事件。`;
      },
    };
  }
}
