import type { WorldDefinition } from 'cortico/world.ts';
import { CORTIDRIVE_DEFAULTS, type CortiDriveConfigSection } from './config.ts';
import { CortiDriveWorld } from './world.ts';

export const CORTIDRIVE: WorldDefinition<CortiDriveConfigSection> = {
  id: 'cortidrive',
  label: '教可缇开车',
  defaults: () => structuredClone(CORTIDRIVE_DEFAULTS),
  create: (ctx) => new CortiDriveWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
};
