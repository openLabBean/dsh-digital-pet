/**
 * DSH Pet 确定性纯逻辑引擎 —— 公开 API 汇总。
 *
 * host 层只需 `import * as core from './src/core/index.js'`。
 * 所有函数都是纯函数：时间/时区/配置由调用方显式传入，不读 Date.now()/process.env/fs。
 *
 * 主要入口：
 *   createInitialState / settle / startAction / cancelAction / resolveNeeds /
 *   availableActions / setBoarding / pet / stageAt / lifeEndsAtMs /
 *   tokensToCoins / grantForDay / buyItem / claimRelief / grantFirstGift
 */

export * from './constants.js';
export * from './errors.js';
export * from './time.js';
export * from './growth.js';
export * from './state.js';
export * from './economy.js';
export * from './actions.js';
export * from './care.js';
