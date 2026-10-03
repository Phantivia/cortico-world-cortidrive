import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.cortidrive 段，默认禁用。 */
export interface CortiDriveConfigSection {
  enabled: boolean;
  /** 游戏内插件监听的 127.0.0.1 端口，与插件配置 BepInEx/config/ai.cortico.cortidrive.cfg 一致。 */
  port: number;
  /** 控制台「启动游戏」打开的 exe：装了本插件的那份游戏副本。 */
  gameExe: string;
  /** 截图的最大宽度，像素。 */
  captureWidth: number;
  /** 场景载入、情境区、画面提示、违规倒计时、地雷爆炸、碰撞、关卡结束七类事件是否附带当时的游戏截图。 */
  attachImages: boolean;
  /** 关卡中在游戏画面右上角显示俯视小地图，范围同 topViewSpanMeters；观众和截图都看得到。 */
  minimap: boolean;
  /** 截图时另附车顶俯视图（车头朝上）。 */
  topView: boolean;
  /** 俯视图覆盖的边长，米。 */
  topViewSpanMeters: number;
  /** 关卡中每隔多少秒缓存一份最新画面，随下一次唤醒一起送达；0 关闭。 */
  liveViewSec: number;
  /** 关卡中超过这么多秒没有驾驶操作时，实时画面改为唤醒事件；每段空闲一次，0 关闭。 */
  wakeIdleSec: number;
}

export const CORTIDRIVE_DEFAULTS: CortiDriveConfigSection = {
  enabled: false,
  port: 47632,
  gameExe: 'L:\\CorticoGames\\teach corti to drive Demo\\teach_sister_to_drive.exe',
  captureWidth: 960,
  attachImages: true,
  minimap: true,
  topView: true,
  topViewSpanMeters: 60,
  liveViewSec: 3,
  wakeIdleSec: 6,
};

export const CORTIDRIVE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:cortidrive',
  owner: 'world:cortidrive',
  schema: {
    type: 'object',
    title: '教可缇开车',
    properties: {
      'worlds.cortidrive.port': {
        type: 'integer',
        minimum: 1024,
        maximum: 65535,
        title: '插件端口',
        description: '须与游戏目录 BepInEx/config/ai.cortico.cortidrive.cfg 的 Port 一致。',
        'x-hot': false,
      },
      'worlds.cortidrive.gameExe': {
        type: 'string',
        title: '游戏程序',
        description: '控制台「启动游戏」打开的 teach_sister_to_drive.exe，指向装了本插件的那份游戏副本；Steam 客户端须在运行。',
        'x-path': { kind: 'file' },
        'x-hot': true,
      },
      'worlds.cortidrive.captureWidth': {
        type: 'integer',
        minimum: 320,
        maximum: 1920,
        title: '截图宽度',
        'x-suffix': 'px',
        'x-hot': true,
      },
      'worlds.cortidrive.attachImages': {
        type: 'boolean',
        title: '关键事件附截图',
        description: '场景载入、情境区、画面提示、违规倒计时、地雷爆炸、碰撞、关卡结束。',
        'x-hot': true,
      },
      'worlds.cortidrive.minimap': {
        type: 'boolean',
        title: '右上角小地图',
        description: '范围与俯视图相同。',
        'x-hot': true,
      },
      'worlds.cortidrive.topView': {
        type: 'boolean',
        title: '附俯视图',
        description: '车顶正上方，车头朝上。',
        'x-hot': true,
      },
      'worlds.cortidrive.topViewSpanMeters': {
        type: 'integer',
        minimum: 10,
        maximum: 300,
        title: '俯视图范围',
        'x-suffix': 'm',
        'x-hot': true,
      },
      'worlds.cortidrive.liveViewSec': {
        type: 'integer',
        minimum: 0,
        maximum: 60,
        title: '实时画面间隔',
        description: '关卡中按此间隔缓存最新画面，随下一次唤醒送达；0 关闭。',
        'x-suffix': 's',
        'x-hot': true,
      },
      'worlds.cortidrive.wakeIdleSec': {
        type: 'integer',
        minimum: 0,
        maximum: 120,
        title: '空闲唤醒',
        description: '关卡中这么久没有驾驶操作，就用实时画面唤醒一次；0 关闭。',
        'x-suffix': 's',
        'x-hot': true,
      },
    },
  },
};
