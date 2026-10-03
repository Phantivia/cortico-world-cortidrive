import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { CORTIDRIVE } from '../src/definition.ts';
import { PROTOCOL } from '../src/bridge.ts';
import { FakeHost } from './helpers/fake-host.ts';

/** 游戏内插件的替身：真 TCP，帧格式按 docs/protocol.md。 */
class FakePlugin {
  server: Server;
  socket: Socket | null = null;
  received: Array<Record<string, unknown>> = [];
  /** drive 的回复；缺省为接受并开始计划 1。 */
  driveReply: Record<string, unknown> = { ok: true, planId: 1 };
  constructor() {
    this.server = createServer((socket) => {
      this.socket = socket;
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
          const frame = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          this.received.push(frame);
          if (frame.kind === 'drive') this.send({ kind: 'reply', id: frame.id, ...this.driveReply });
        }
      });
      this.send({ kind: 'hello', protocol: PROTOCOL, plugin: 'test', state: { scene: 'ParkingSceneTest', driverInput: true, paused: false, speedUnit: 'km/h' } });
    });
  }
  send(frame: Record<string, unknown>): void {
    this.socket?.write(`${JSON.stringify(frame)}\n`);
  }
  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as { port: number }).port)));
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}

let scratchDir: string;
let plugin: FakePlugin;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'cortidrive-world-'));
  plugin = new FakePlugin();
});
afterEach(() => {
  plugin.server.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

async function started() {
  const port = await plugin.listen();
  const ctx = fakeWorldContext(CORTIDRIVE, { scratchDir });
  ctx.persist({ port, attachImages: false });
  const world = CORTIDRIVE.create(ctx);
  const host = new FakeHost();
  await world.start(host);
  await until(() => host.events.some((e) => e.type === 'cortidrive.connection'));
  return { world, host, drive: world.tools().find((t) => t.name === 'cortidrive_drive')! };
}

describe('cortidrive World', () => {
  it('干装载不报失败', async () => {
    const report = await dryMountWorld(CORTIDRIVE, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('cortidrive_drive 把计划与去掉表演标记的台词交给插件，台词带上说完要的秒数', async () => {
    const { world, drive } = await started();
    const steps = [{ speed: 10, steer: 0, until: 'distance', value: 5 }, { speed: 0, until: 'stopped' }];
    const receipt = await drive.handler({ steps, line: '【握紧方向盘】<小声>知道啦，开五米就停' }, {} as ToolCallContext);
    expect(typeof receipt === 'string' ? receipt : receipt.failed).not.toBe(true);
    const sent = plugin.received.find((f) => f.kind === 'drive')!;
    expect(sent.steps).toEqual(steps);
    expect(sent.line).toBe('知道啦，开五米就停');
    expect(sent.lineSec).toBe(2);
    await world.stop();
  });

  it('游戏拒收时回执说明原因；游戏自己的台词渲染成 script 事件', async () => {
    const { world, host, drive } = await started();
    plugin.driveReply = { ok: false, error: 'inputDisabled' };
    const receipt = await drive.handler({ steps: [{ speed: 0 }] }, {} as ToolCallContext);
    expect(typeof receipt === 'string' ? undefined : receipt.failed).toBe(true);
    expect(typeof receipt === 'string' ? receipt : receipt.text).toContain('不接受驾驶指令');

    plugin.send({ kind: 'event', type: 'script', scene: 'TutorialScene', text: '知道了。现在出发！' });
    await until(() => host.events.some((e) => e.type === 'cortidrive.script'));
    expect(host.events.find((e) => e.type === 'cortidrive.script')!.text).toContain('「知道了。现在出发！」');
    await world.stop();
  });
});
