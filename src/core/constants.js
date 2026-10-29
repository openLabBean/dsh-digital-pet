/**
 * DSH Pet 确定性纯逻辑引擎 —— 全部数值常量集中处。
 *
 * 约定：
 * - 本文件只导出常量 / 冻结对象，不含任何逻辑与时间读取。
 * - 所有时间单位一律毫秒；状态值为 0~100 浮点。
 * - 数值来源：docs/deepseek-pet-development-design-v1.md §4~§10。
 */

export const SCHEMA_VERSION = 1;
export const CONFIG_VERSION = 1;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** 生命周期：本地日历 6 个月。 */
export const LIFE_MONTHS = 6;

/** 四状态键（顺序固定，用于遍历/事件）。 */
export const STATUS_KEYS = Object.freeze(['H', 'M', 'E', 'C']);
export const STATUS_MIN = 0;
export const STATUS_MAX = 100;
export const INITIAL_STATUS = Object.freeze({ H: 80, M: 80, E: 100, C: 90 });

/** 四状态衰减率（单位：点/小时）。 */
export const AWAKE_RATES = Object.freeze({ H: -3, M: -1, E: -1.5, C: -0.75 });
export const SLEEP_RATES = Object.freeze({ H: -0.75, M: -0.25, E: 7.5, C: 0 });

/** 默认作息（地方时间，分钟数）：23:00 - 07:00，连续 8h。 */
export const DEFAULT_SLEEP_START_MIN = 23 * 60; // 1380
export const DEFAULT_SLEEP_END_MIN = 7 * 60; // 420

/**
 * 运行配置。cfg 由调用方每次显式传入（可部分覆盖），引擎绝不读 Date.now()。
 * - sleepStart / sleepEnd：地方时间“距零点分钟数”，可跨零点；传 null 表示不启用睡眠。
 * - offline：true 表示本次结算是“进程恢复补算”（用户离线期间），触发 §10.2 保护。
 */
export const DEFAULT_CONFIG = Object.freeze({
  sleepStart: DEFAULT_SLEEP_START_MIN,
  sleepEnd: DEFAULT_SLEEP_END_MIN,
  offline: false,
  configVersion: CONFIG_VERSION,
});

/** 成长阶段：天粒度，半开区间 [startDay, endDay)。 */
export const STAGE_DEFS = Object.freeze([
  { key: 'baby', label: '婴儿', startDay: 0, endDay: 3 },
  { key: 'toddler', label: '幼儿', startDay: 3, endDay: 14 },
  { key: 'child', label: '少儿', startDay: 14, endDay: 45 },
  { key: 'teen', label: '青年', startDay: 45, endDay: 90 },
  { key: 'adult', label: '壮年', startDay: 90, endDay: 150 },
  { key: 'elder', label: '老年', startDay: 150, endDay: null },
]);
export const STAGE_BOUNDARY_DAYS = Object.freeze([3, 14, 45, 90, 150]);

/** 精力自动休息（§5.1）：E<20 进入休息（E+10/h，替代清醒 E 衰减），E>=40 恢复清醒。 */
export const AUTO_REST_RULES = Object.freeze({
  triggerBelow: 20,
  recoverAt: 40,
  restorePerHour: 10,
});

/** 状态联动附加心情衰减（§5.1，仅清醒，合计上限 1/h）。 */
export const LINKAGE_RULES = Object.freeze({
  lowHThreshold: 25,
  lowHRecover: 35,
  lowHExtraMoodPerHour: 0.5,
  lowCThreshold: 30,
  lowCRecover: 40,
  lowCExtraMoodPerHour: 0.5,
  wasteAgeHours: 4,
  wasteExtraMoodPerHour: 0.25,
  maxExtraMoodPerHour: 1,
});

/** 喂水（§6.1）。 */
export const WATER_RULES = Object.freeze({
  needAfterHours: 18,
  highPriorityAfterHours: 24,
  penaltyAfterHours: 36,
  penaltyEveryHours: 6,
  penaltyAmount: 2,
  maxPenalty: 8,
  cooldownHours: 6,
  moodGain: 2,
  energyCost: 0,
  hungerGain: 0,
  durationMs: 4_000,
  affinity: 1,
});

/** 排泄（§6.2）。 */
export const WASTE_RULES = Object.freeze({
  /** 有效主食累计恢复 H 达到该值即安排一次（滚动窗口，实现按本地日近似）。 */
  foodRecoverThresholdH: 20,
  /** 再延迟 2h 出现。 */
  delayMs: 2 * HOUR_MS,
  /** 场上最多并存 2 份。 */
  maxCount: 2,
  /** 每新增一份 C-4（只在实际新增时扣）。 */
  appearanceCleanPenalty: 4,
  /** 铲屎清空全部 M+2。 */
  cleanMoodBonus: 2,
  cleanDurationMs: 3_000,
  affinity: 1,
});

/** 洗澡（§6.3）。 */
export const BATHE_RULES = Object.freeze({
  needAtC: 50,
  resolveAtC: 70,
  cleanGain: 60,
  moodGain: 3,
  energyCost: 5,
  minEnergy: 10,
  cooldownHours: 12,
  tooCleanAtC: 95,
  durationMs: 8_000,
  affinity: 1,
});

/** 修剪/护理（§6.4）。 */
export const GROOM_RULES = Object.freeze({
  needAfterHours: 72,
  cleanGain: 10,
  moodGain: 4,
  energyCost: 2,
  minEnergy: 5,
  cooldownHours: 24,
  durationMs: 6_000,
  affinity: 1,
});

/** 逛街（§6.5）。 */
export const WALK_RULES = Object.freeze({
  minHunger: 20,
  minEnergy: 30,
  moodGain: 20,
  energyCost: 15,
  cleanCost: 5,
  durationMs: 60_000,
  cooldownHours: 6,
  needMoodAt: 45,
  needSinceWalkHours: 20,
  affinity: 2,
});

/** 喂食（§6 / §9）。 */
export const FEED_RULES = Object.freeze({
  durationMs: 5_000,
  minHungerDeficit: 10,
  affinity: 1,
});

/** 抚摸（§7.1）。 */
export const PET_RULES = Object.freeze({
  moodGain: 2,
  cooldownMinutes: 30,
  dailyLimit: 5,
});

/** 羁绊值（§4.2）。 */
export const AFFINITY_RULES = Object.freeze({
  care: 1,
  walk: 2,
  dailyCap: 5,
  max: 100,
});

/** 托管（§10.2）。 */
export const BOARDING_RULES = Object.freeze({
  floor: 60,
  waterHours: 24,
});

/** 离线（§10.2）。 */
export const OFFLINE_RULES = Object.freeze({
  protectionHours: 24,
  /** 前 24h 衰减保护下限（已低于下限的不抬升）。 */
  floors: Object.freeze({ H: 30, M: 40, E: 30, C: 40 }),
});

/** 金币经济（§9.1）。 */
export const ECONOMY_RULES = Object.freeze({
  tokensPerCoin: 1_000,
  dailyCoinCap: 100,
  firstGiftCoins: 60,
  firstGiftBasicWholeUnits: 3,
  reliefCooldownHours: 24,
  snackDailyLimit: 2,
});

/**
 * 食品目录（§9.2）。inventory 数量一律以“半份”为单位：
 * - basic/favorite/relief 整份 = 2 半份，可拆半份；
 * - snack 整份 = 2 半份但不可拆，一次必须整份。
 * effectsPerWhole 施加后按 clamp [0,100] 结算。
 */
export const FOOD_CATALOG = Object.freeze({
  water: Object.freeze({
    id: 'water',
    name: '水',
    price: 0,
    inventory: false,
    staple: false,
    unitHalfUnits: 0,
    splittable: false,
    effectsPerWhole: Object.freeze({ H: 0, M: WATER_RULES.moodGain, E: 0, C: 0 }),
    durationMs: WATER_RULES.durationMs,
  }),
  basic: Object.freeze({
    id: 'basic',
    name: '基础口粮',
    price: 12,
    inventory: true,
    staple: true,
    unitHalfUnits: 2,
    splittable: true,
    effectsPerWhole: Object.freeze({ H: 60, M: 0, E: 0, C: 0 }),
    durationMs: FEED_RULES.durationMs,
  }),
  favorite: Object.freeze({
    id: 'favorite',
    name: '喜爱主食',
    price: 18,
    inventory: true,
    staple: true,
    unitHalfUnits: 2,
    splittable: true,
    effectsPerWhole: Object.freeze({ H: 60, M: 6, E: 0, C: 0 }),
    durationMs: FEED_RULES.durationMs,
  }),
  snack: Object.freeze({
    id: 'snack',
    name: '小零食',
    price: 5,
    inventory: true,
    staple: false,
    unitHalfUnits: 2,
    splittable: false,
    effectsPerWhole: Object.freeze({ H: 8, M: 5, E: 0, C: 0 }),
    durationMs: FEED_RULES.durationMs,
    dailyLimit: ECONOMY_RULES.snackDailyLimit,
  }),
  relief: Object.freeze({
    id: 'relief',
    name: '救济口粮',
    price: 0,
    inventory: true,
    staple: true,
    unitHalfUnits: 2,
    splittable: true,
    effectsPerWhole: Object.freeze({ H: 60, M: 0, E: 0, C: 0 }),
    durationMs: FEED_RULES.durationMs,
    claimCooldownHours: ECONOMY_RULES.reliefCooldownHours,
  }),
});

/** 操作顺序（UI/availableActions 稳定顺序）。 */
export const ACTION_ORDER = Object.freeze([
  'feed',
  'water',
  'walk',
  'groom',
  'bathe',
  'cleanWaste',
]);

export const ACTION_LABELS = Object.freeze({
  feed: '喂食',
  water: '喂水',
  walk: '逛街',
  groom: '护理',
  bathe: '洗澡',
  cleanWaste: '铲屎',
});

/** 动作时长（动作到点才结算效果；开始即串行占用）。 */
export const ACTION_DURATION_MS = Object.freeze({
  feed: FEED_RULES.durationMs,
  water: WATER_RULES.durationMs,
  walk: WALK_RULES.durationMs,
  groom: GROOM_RULES.durationMs,
  bathe: BATHE_RULES.durationMs,
  cleanWaste: WASTE_RULES.cleanDurationMs,
});

/** 诉求优先级（§8），数字越小越优先；同优先级按触发时间排序。 */
export const NEED_PRIORITIES = Object.freeze({
  rest: 1,
  hungerCritical: 2,
  waterCritical: 2,
  waste: 3,
  bathe: 4,
  hunger: 5,
  water: 5,
  walk: 6,
  groom: 7,
});

export const NEED_LABELS = Object.freeze({
  rest: '想休息',
  hunger: '想吃饭',
  water: '想喝水',
  waste: '需要铲屎',
  bathe: '想洗澡',
  walk: '想出门',
  groom: '需要护理',
});

export const NEED_KEYS = Object.freeze([
  'rest',
  'hunger',
  'water',
  'waste',
  'bathe',
  'walk',
  'groom',
]);

/** 结构化错误码（§12.2 + 引擎补充）。 */
export const ERROR_CODES = Object.freeze({
  PET_DECEASED: 'PET_DECEASED',
  BUSY: 'BUSY',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  ITEM_MISSING: 'ITEM_MISSING',
  NOT_HUNGRY: 'NOT_HUNGRY',
  LOW_ENERGY: 'LOW_ENERGY',
  TOO_CLEAN: 'TOO_CLEAN',
  ON_COOLDOWN: 'ON_COOLDOWN',
  NO_WASTE: 'NO_WASTE',
  DAILY_LIMIT: 'DAILY_LIMIT',
  INVALID_PORTION: 'INVALID_PORTION',
  NOT_ENOUGH_COINS: 'NOT_ENOUGH_COINS',
  NOT_PURCHASABLE: 'NOT_PURCHASABLE',
  RELIEF_IN_STOCK: 'RELIEF_IN_STOCK',
  RELIEF_COOLDOWN: 'RELIEF_COOLDOWN',
  GIFT_ALREADY_GRANTED: 'GIFT_ALREADY_GRANTED',
  NOT_BOARDING: 'NOT_BOARDING',
  ALREADY_BOARDING: 'ALREADY_BOARDING',
  BOARDING: 'BOARDING',
  NO_ACTIVE_ACTION: 'NO_ACTIVE_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CLOCK_REWIND: 'CLOCK_REWIND',
});
