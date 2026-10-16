import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { CORTIDRIVE_DEFAULTS, type CortiDriveConfigSection } from './config.ts';
import { CORTIDRIVE_TOOL_DECLS, CortiDriveWorld } from './world.ts';

export const CORTIDRIVE: WorldDefinition<CortiDriveConfigSection> = {
  id: 'cortidrive',
  label: '教可缇开车',
  defaults: () => structuredClone(CORTIDRIVE_DEFAULTS),
  create: (ctx) => new CortiDriveWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(CORTIDRIVE_TOOL_DECLS, {
      cortidrive_drive: {
        zh: 'bot 坐驾驶座开车：按计划控制车速和方向，教程关做系安全带、发动引擎等动作，可同时说一句台词。',
        en: 'Drives the car from the driver seat: runs a speed and steering plan, does tutorial actions such as fastening the seatbelt or starting the engine, and can say a line with it.',
      },
      cortidrive_look: {
        zh: '截一张游戏画面，附场景、车速、表情、罚款、碰撞次数、前方障碍、停车目标和本关情境。',
        en: "Takes a screenshot of the game with the scene, speed, mood, fines, collision count, obstacles ahead, the parking goal and the stage's situation text.",
      },
      cortidrive_stage: {
        zh: '重开本关、进下一关、回主菜单，或在主菜单继续存档的关卡。',
        en: 'Restarts the stage, loads the next one, goes back to the main menu, or continues the saved stage from the main menu.',
      },
    }),
    events: [
      {
        type: 'cortidrive.connection',
        description: { zh: '游戏插件连上（附当前状态）或断开。', en: 'The game plugin connected (with the current state) or disconnected.' },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.view',
        description: {
          zh: '关卡中定时截的实时画面与车况，随下一次唤醒送达；bot 太久没有驾驶操作时单独唤醒一次。',
          en: "A periodic live screenshot with the car's state during a stage, delivered with the next wake-up; it wakes the bot once when the bot has not driven for a while.",
        },
        tags: ['snapshot'],
      },
      {
        type: 'cortidrive.scene',
        description: { zh: '载入了新场景。', en: 'A new scene loaded.' },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.plan',
        description: { zh: '驾驶计划开始、走到某一步、走完或被新的操作打断。', en: 'A driving plan started, reached a step, finished or was interrupted by a new drive call.' },
      },
      {
        type: 'cortidrive.script',
        description: { zh: '游戏剧本里驾驶座上的妹妹（现在是 bot）这时说的台词。', en: "A line the game's script gives the sister in the driver seat, which is now the bot." },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.emotion',
        description: { zh: 'bot 在游戏里的表情变了。', en: "The bot's expression in the game changed." },
        trigger: 'debounce',
      },
      {
        type: 'cortidrive.mission',
        description: { zh: '游戏给出的任务。', en: 'A mission the game set.' },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.brief',
        description: { zh: '本关游戏写给原妹妹模型的说明节选：目标与动作刻度。', en: "An excerpt of this stage's instructions written for the original sister model: the goal and action scale." },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.guide',
        description: { zh: '画面上的提示。', en: 'An on-screen hint.' },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.situation',
        description: { zh: '车进入情境区，附游戏写给原妹妹模型的情境描述。', en: "The car entered a situation zone, with the game's situation text for the original sister model." },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.popup',
        description: { zh: '游戏弹窗。', en: 'A game popup.' },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.fine',
        description: { zh: '罚款增加，附累计。', en: 'A fine was added, with the running total.' },
        trigger: 'debounce',
      },
      {
        type: 'cortidrive.damage',
        description: { zh: '碰撞计数加一，附本关累计。', en: "The collision count went up, with this stage's total." },
        trigger: 'flush',
      },
      {
        type: 'cortidrive.collision',
        description: { zh: '车撞上锥桶或障碍物；3 秒内连着撞只有第一下唤醒。', en: 'The car hit a cone or an obstacle; within 3 seconds only the first hit wakes the bot.' },
      },
      {
        type: 'cortidrive.mine',
        description: { zh: '车压到地雷；3 秒内连着压只有第一下唤醒。', en: 'The car hit a mine; within 3 seconds only the first hit wakes the bot.' },
      },
      {
        type: 'cortidrive.illegalAction',
        description: { zh: '违规倒计时开始。', en: 'A violation countdown started.' },
        trigger: 'preempt',
      },
      {
        type: 'cortidrive.stageEnd',
        description: { zh: '关卡结束：通过，或失败及原因。', en: 'The stage ended: cleared, or failed with the cause.' },
        trigger: 'flush',
      },
    ],
  },
};
