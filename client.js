/* @local/dsh-digital-pet — Client half.
 *
 * 注册两个界面（Host 是唯一权威，浏览器半只渲染与发命令）：
 *   1. settings.section「电子宠物」：领养、仪表盘、商店、成长记录、偏好、纪念册。
 *   2. shell.overlay：覆盖整个 AppFrame 的透明层，承载右下角悬浮宠物 + 左侧操作盘。
 *
 * 所有数据通过同源 fetch('/dsh-digital-pet/api/…') 读写；Desktop renderer 会把同源路径
 * 转发给 Host，因此不需要生成 RPC。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-digital-pet",
  factory(require) {
    "use strict"

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-digital-pet/api'
    const DAY_MS = 24 * 60 * 60 * 1000

    // ---------------------------------------------------------------------
    // 样式
    // ---------------------------------------------------------------------
    // Approved redraw: 9 species × 6 stages × 8 frames. Same timings as review page.
    const HOVER_STAGES = ['baby', 'toddler', 'child', 'teen', 'adult', 'elder']
    const HOVER_SPECIES = Object.fromEntries(['whale', 'monkey', 'duck', 'chick', 'cat', 'dog', 'cow', 'goat', 'dinosaur'].map(id => [id, true]))
    const HOVER_REVISION = '958d707ff663bdab'
    const HOVER_SEQUENCE = [[0,1050],[1,65],[2,90],[3,65],[4,125],[5,125],[4,125],[5,125],[6,145],[7,170]]
    const HOVER_FACTORS = { baby: .8, toddler: .96, child: 1.08, teen: 1.12, adult: .92, elder: .7 }
    const HoverContext = React.createContext(false)

    const CSS = `
.dsh-digital-pet-overlay { position: fixed; inset: 0; z-index: 60; pointer-events: none; overflow: hidden; }
.dsh-digital-pet-float { position: absolute; pointer-events: auto; display: flex; flex-direction: column; align-items: center;
  gap: 4px; transition: transform .18s ease; }
.dsh-digital-pet-float.dragging { transition: none; }
.dsh-digital-pet-sprite { display: block; image-rendering: auto; cursor: grab; user-select: none;
  filter: drop-shadow(0 6px 10px rgba(0,0,0,.18)); }
.dsh-digital-pet-sprite.dragging { cursor: grabbing; }
/* 宠物右键菜单：悬停宠物后右键弹出「隐藏 <昵称>」 */
.dsh-digital-pet-ctx { position: fixed; z-index: 70; pointer-events: auto; min-width: 132px; max-width: 220px;
  padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2, rgba(32,32,34,.98));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  box-shadow: 0 10px 28px rgba(0,0,0,.22); display: flex; flex-direction: column; gap: 2px; }
.dsh-digital-pet-ctx-item { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #f5f6f7);
  font: inherit; font-size: 12px; line-height: 1.4; text-align: left; padding: 7px 10px; border-radius: 6px;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-digital-pet-ctx-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); }
.dsh-digital-pet-ctx-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: -2px; }
.dsh-digital-pet-poop { position: absolute; right: -4%; bottom: 4%; height: 40%; image-rendering: auto; pointer-events: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.15)); }
.dsh-digital-pet-paw { width: 21px; height: 21px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: 0 2px 8px rgba(0,0,0,.12); cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1; transition: transform .15s ease; }
.dsh-digital-pet-paw:hover { transform: scale(1.08); }
/* 悬浮层气泡：诉求（需要铲屎）与操作反馈（它还不饿）共用同一套样式 */
.dsh-digital-pet-need, .dsh-digital-pet-pill-error, .dsh-digital-pet-toast { max-width: 190px; padding: 4px 10px; border-radius: 99px; font-size: 11px; line-height: 1.4;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  color: var(--dsw-alias-label-primary, #222); box-shadow: 0 2px 8px rgba(0,0,0,.1); text-align: center; }
.dsh-digital-pet-need-btn { appearance: none; font-family: inherit; cursor: pointer; }
.dsh-digital-pet-need-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
/* 顶部提示绝对定位在宠物上方，不参与布局：提示出现/消失时宠物不位移 */
.dsh-digital-pet-hints { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  width: max-content; max-width: 300px;
  z-index: 3; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
.dsh-digital-pet-hints > * { pointer-events: auto; }
/* 成长播报固定在爪印下方，同样不参与布局 */
.dsh-digital-pet-toast { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 3;
  width: max-content; white-space: nowrap; pointer-events: none; }
.dsh-digital-pet-panel { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
  display: grid; grid-template-columns: repeat(2, minmax(58px, auto)); gap: 6px;
  padding: 8px; border-radius: 12px; pointer-events: auto;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  box-shadow: var(--dsw-alias-shadow-lg, 0 10px 28px rgba(0,0,0,.2)); backdrop-filter: blur(8px); }
.dsh-digital-pet-panel.left { right: calc(100% + 8px); }
.dsh-digital-pet-panel.right { left: calc(100% + 8px); }
.dsh-digital-pet-panel-btn { appearance: none; padding: 6px 12px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03));
  color: var(--dsw-alias-label-primary, #222); font-family: inherit; font-size: 12px; line-height: 1.4; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease; }
.dsh-digital-pet-panel-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-digital-pet-panel-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-digital-pet-panel-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.dsh-digital-pet-bars { display: grid; grid-template-columns: 1fr; gap: 4px; }
.dsh-digital-pet-bar-row { display: grid; grid-template-columns: 5.2em 1fr 2.6em; align-items: center; gap: 6px; }
.dsh-digital-pet-bar-row > span:first-child { white-space: nowrap; }
.dsh-digital-pet-bar { height: 6px; border-radius: 99px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.08)); overflow: hidden; }
.dsh-digital-pet-bar > i { display: block; height: 100%; border-radius: 99px; transition: width .3s ease; }
.dsh-digital-pet-hint { margin-top: 6px; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; line-height: 1.5; }
.dsh-digital-pet-settings { padding: 20px 24px 48px; max-width: 880px; color: var(--dsw-alias-label-primary, #222); }
.dsh-digital-pet-h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.dsh-digital-pet-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; column-gap: 12px; }
.dsh-digital-pet-head-main { min-width: 0; }
.dsh-digital-pet-head-toggle { display: flex; align-items: center; gap: 8px; margin-top: 2px; white-space: nowrap; }
.dsh-digital-pet-sub { color: var(--dsw-alias-label-secondary, #777); font-size: 13px; margin: 0 0 18px; line-height: 1.6; }
.dsh-digital-pet-card { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 14px; padding: 16px 18px;
  background: var(--dsw-alias-bg-layer-2, #fff); margin-bottom: 14px; }
.dsh-digital-pet-card h2 { font-size: 15px; margin: 0 0 10px; font-weight: 600; }
.dsh-digital-pet-card h3 { font-size: 13px; margin: 14px 0 8px; font-weight: 600; color: var(--dsw-alias-label-secondary, #555); }
.dsh-digital-pet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; }
.dsh-digital-pet-species { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 12px; padding: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); cursor: pointer; text-align: center; transition: all .15s ease; }
.dsh-digital-pet-species:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); transform: translateY(-1px); }
.dsh-digital-pet-species.selected { border-color: var(--dsw-alias-brand-primary, #4d6bfe); box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.16)); }
.dsh-digital-pet-species.disabled { opacity: .5; cursor: not-allowed; }
.dsh-digital-pet-species img { width: 64px; height: 64px; object-fit: contain; image-rendering: auto; }
.dsh-digital-pet-species-name { font-size: 12px; font-weight: 600; margin-top: 4px; }
.dsh-digital-pet-species-en { font-size: 10px; color: var(--dsw-alias-label-secondary, #888); }
.dsh-digital-pet-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.dsh-digital-pet-input { flex: 1 1 200px; min-width: 160px; padding: 8px 10px; border-radius: 9px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14)); background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #222); }
.dsh-digital-pet-btn { appearance: none; border: 1px solid transparent; border-radius: 9px; padding: 8px 14px; font-size: 13px;
  font-weight: 600; cursor: pointer; background: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-label-primary-foreground, #fff); transition: filter .15s ease; }
.dsh-digital-pet-btn:hover { filter: brightness(1.06); }
.dsh-digital-pet-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-digital-pet-btn.ghost { background: transparent; color: var(--dsw-alias-label-primary, #222);
  border-color: var(--dsw-alias-border-l1, rgba(0,0,0,.16)); }
.dsh-digital-pet-btn.sm { padding: 5px 10px; font-size: 12px; border-radius: 8px; }
.dsh-digital-pet-muted { color: var(--dsw-alias-label-secondary, #777); font-size: 12px; }
.dsh-digital-pet-error { color: var(--dsw-alias-state-error-primary, #d33); font-size: 12px; margin-top: 8px; }
.dsh-digital-pet-dash { display: grid; grid-template-columns: 180px 1fr; gap: 18px; }
@media (max-width: 720px) { .dsh-digital-pet-dash { grid-template-columns: 1fr; } }
.dsh-digital-pet-hero { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.dsh-digital-pet-hero img { width: 132px; height: 132px; image-rendering: auto; object-fit: contain; }
.dsh-digital-pet-stage { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.06)); }
.dsh-digital-pet-chip-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dsh-digital-pet-chip { font-size: 12px; padding: 3px 9px; border-radius: 99px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dsh-digital-pet-chip.gold { border-color: rgba(214,158,46,.4); background: rgba(250,220,140,.18); }
.dsh-digital-pet-coin { vertical-align: -2px; margin-right: 3px; flex: none; }
.dsh-digital-pet-shop-price { display: inline-flex; align-items: center; gap: 2px; }
.dsh-digital-pet-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.dsh-digital-pet-action { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02));
  font-size: 13px; color: var(--dsw-alias-label-primary, #222); }
.dsh-digital-pet-action:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dsh-digital-pet-action:disabled { opacity: .45; cursor: not-allowed; }
.dsh-digital-pet-action img { width: 30px; height: 30px; object-fit: contain; image-rendering: auto; }
.dsh-digital-pet-kv { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 13px; }
.dsh-digital-pet-kv > dt { color: var(--dsw-alias-label-secondary, #777); }
.dsh-digital-pet-kv > dd { margin: 0; }
.dsh-digital-pet-shop-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.dsh-digital-pet-shop-item:last-child { border-bottom: 0; }
.dsh-digital-pet-shop-name { font-size: 13px; font-weight: 600; }
.dsh-digital-pet-shop-desc { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); margin-top: 2px; }
.dsh-digital-pet-mem-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.dsh-digital-pet-mem-item:last-child { border-bottom: 0; }
.dsh-digital-pet-mem-item img { width: 44px; height: 44px; image-rendering: auto; object-fit: contain; filter: grayscale(.35); }
/* Rest is truly static. Hover gestures are defined per species × growth stage. */
.dsh-digital-pet-sprite { transform-origin: 50% 100%; }
.dsh-digital-pet-sprite[data-mood="hungry"], .dsh-digital-pet-sprite[data-mood="thirsty"] {
  filter: saturate(.82) drop-shadow(0 6px 10px rgba(0,0,0,.18)); }
.dsh-digital-pet-mood-bubble { position: absolute; bottom: 82%; left: 50%; z-index: 2; font-size: 15px; line-height: 1;
  pointer-events: none; animation: dsh-digital-pet-mood-float 5.6s ease-in-out infinite; text-shadow: 0 1px 2px rgba(0,0,0,.18); }
@keyframes dsh-digital-pet-mood-float {
  0%, 55% { opacity: 0; transform: translate(-50%, 4px) scale(.85); }
  65% { opacity: 1; transform: translate(-50%, -4px) scale(1); }
  85% { opacity: 1; transform: translate(-50%, -8px) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -12px) scale(.95); }
}
/* ---------------------------------------------------------------------------
 * 照护动作动效
 * 素材是单帧动作姿态图（assets/sprites/<species>/<action>.png），没有逐帧序列，
 * 所以动作反馈用「姿态变形 + 小道具 + 粒子」程序化合成，纯 CSS 驱动：
 *   .dsh-digital-pet-act-stage  动作舞台（悬浮宠物与设置页大图共用）
 *   .dsh-digital-pet-fx-under   身体后面的道具（水槽；喂食的饭碗已在动作姿态图里）
 *   .dsh-digital-pet-fx-over    身体前面的道具/粒子（泡沫、水珠、扫把、星星）
 * 舞台用 --pet-size 对齐精灵尺寸，两处渲染同比例缩放。
 * ------------------------------------------------------------------------- */
.dsh-digital-pet-act-stage { position: relative; display: flex; align-items: flex-end; justify-content: center; }
.dsh-digital-pet-hero-stage { width: 132px; height: 132px; --pet-size: 132px; }
.dsh-digital-pet-hero-stage .dsh-digital-pet-zzz { top: -14px; }
.dsh-digital-pet-hero-stage img { position: relative; z-index: 2; }
.dsh-digital-pet-sprite { position: relative; z-index: 2; }
/* 睡觉符号：头顶三个 Z（纯符号、无文字），逐个上浮淡出 */
.dsh-digital-pet-pet-wrap { position: relative; display: inline-flex; align-items: flex-end; justify-content: center; }
.dsh-digital-pet-zzz { position: absolute; top: calc(var(--pet-size, 72px) * -0.27); left: 50%; transform: translateX(-50%); z-index: 4; display: flex; align-items: flex-end; gap: 0;
  pointer-events: none; font-weight: 800; line-height: 1; user-select: none;
  color: var(--dsw-alias-label-primary, #2f3440); }
.dsh-digital-pet-zzz > span { display: block; transform-origin: 50% 100%; animation: dsh-digital-pet-zzz-float 2.6s ease-in-out infinite; }
.dsh-digital-pet-zzz > span:nth-child(1) { font-size: 10px; animation-delay: 0s; }
.dsh-digital-pet-zzz > span:nth-child(2) { font-size: 13px; animation-delay: .42s; }
.dsh-digital-pet-zzz > span:nth-child(3) { font-size: 17px; animation-delay: .84s; }
@keyframes dsh-digital-pet-zzz-float {
  0% { transform: translateY(3px) scale(.9); opacity: .35; }
  30% { transform: translateY(-2px) scale(1.04); opacity: 1; }
  100% { transform: translateY(-10px) scale(1.1); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-digital-pet-zzz > span { animation: none; opacity: .95; }
}
.dsh-digital-pet-fx { position: absolute; left: 50%; bottom: 0; z-index: 1;
  width: var(--pet-size, 72px); height: var(--pet-size, 72px); transform: translateX(-50%); pointer-events: none; }
.dsh-digital-pet-fx-over { z-index: 3; }
.dsh-digital-pet-fx > span { position: absolute; display: block; }
/* 动作进行中的姿态动画（按 data-action 区分；未知动作回落到轻微起伏） */
@keyframes dsh-digital-pet-act-bob {
  0%, 100% { transform: translate(0, 0) rotate(0deg) scale(1); }
  50% { transform: translate(0, -2.5%) rotate(1deg) scale(1.012); }
}
/* 喂食：低头一口一口咀嚼 */
@keyframes dsh-digital-pet-act-eat {
  0%, 16%, 36%, 56%, 76%, 100% { transform: translate(0, 0) rotate(0deg) scaleY(1); }
  7%, 27%, 47%, 67% { transform: translate(-2.5%, 2.5%) rotate(-2.6deg) scaleY(.955); }
}
/* 洗澡：被擦洗时左右扭动 */
@keyframes dsh-digital-pet-act-bathe {
  0%, 100% { transform: rotate(0deg) scaleX(1); }
  10% { transform: rotate(-4.5deg) scaleX(1.02); }
  22% { transform: rotate(3.8deg) scaleX(.985); }
  34% { transform: rotate(-3.4deg) scaleX(1.018); }
  46% { transform: rotate(3deg) scaleX(.99); }
  58% { transform: rotate(-2deg) scaleX(1.008); }
  70%, 100% { transform: rotate(0deg) scaleX(1); }
}
/* 逛街：左右来回走，走到边缘转身（scaleX 翻转），带脚步起伏 */
@keyframes dsh-digital-pet-act-walk {
  0% { transform: translateX(-13%) translateY(0) scaleX(1); }
  12% { transform: translateX(-9.5%) translateY(-3.2%) scaleX(1); }
  24% { transform: translateX(-2%) translateY(0) scaleX(1); }
  36% { transform: translateX(5.5%) translateY(-3.2%) scaleX(1); }
  48% { transform: translateX(12%) translateY(0) scaleX(1); }
  50% { transform: translateX(12%) translateY(0) scaleX(-1); }
  62% { transform: translateX(5.5%) translateY(-3.2%) scaleX(-1); }
  74% { transform: translateX(-2%) translateY(0) scaleX(-1); }
  86% { transform: translateX(-9.5%) translateY(-3.2%) scaleX(-1); }
  100% { transform: translateX(-13%) translateY(0) scaleX(-1); }
}
/* 喝水：两次低头 */
@keyframes dsh-digital-pet-act-drink {
  0%, 24%, 64%, 100% { transform: translate(0, 0) rotate(0deg) scaleY(1); }
  14%, 34%, 54%, 74% { transform: translate(-2%, 2%) rotate(-2.2deg) scaleY(.96); }
}
/* 铲屎：轻侧身清扫 */
@keyframes dsh-digital-pet-act-sweep {
  0%, 100% { transform: translate(1.5%, 0) rotate(-1deg); }
  50% { transform: translate(3%, 1%) rotate(1.5deg); }
}
/* 睡觉：闭眼睡觉精灵 + 轻微「蜷起呼吸」——只有睡眠态生效，其它状态一律不动 */
@keyframes dsh-digital-pet-sleep-breathe {
  0%, 100% { transform: translateY(2px) scale(0.975, 0.955); }
  50% { transform: translateY(1px) scale(0.988, 0.978); }
}
.dsh-digital-pet-sprite[data-mood="sleep"],
.dsh-digital-pet-hero img[data-mood="sleep"] {
  transform-origin: 50% 100%;
  animation: dsh-digital-pet-sleep-breathe 5.2s ease-in-out infinite;
}

.dsh-digital-pet-sprite[data-mood="acting"],
.dsh-digital-pet-hero img[data-mood="acting"] { animation: dsh-digital-pet-act-bob 1.7s ease-in-out infinite; }
/* 动作姿态以脚底为轴，吃/洗澡/铲屎的转动才不会整体漂浮 */
.dsh-digital-pet-sprite[data-action],
.dsh-digital-pet-hero img[data-action] { transform-origin: 50% 100%; }
.dsh-digital-pet-sprite[data-action="feed"],
.dsh-digital-pet-hero img[data-action="feed"] { animation: dsh-digital-pet-act-eat 1.8s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-action="water"],
.dsh-digital-pet-hero img[data-action="water"] { animation: dsh-digital-pet-act-drink 1.6s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-action="bathe"],
.dsh-digital-pet-hero img[data-action="bathe"] { animation: dsh-digital-pet-act-bathe 1.5s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-action="groom"],
.dsh-digital-pet-hero img[data-action="groom"] { animation: dsh-digital-pet-act-bathe 1.8s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-action="walk"],
.dsh-digital-pet-hero img[data-action="walk"] { animation: dsh-digital-pet-act-walk 2.8s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-action="cleanWaste"],
.dsh-digital-pet-hero img[data-action="cleanWaste"] { animation: dsh-digital-pet-act-sweep 1.1s ease-in-out infinite; }
/* 拖动时不播放姿态动画（否则位移动画会和跟随手指冲突） */
.dsh-digital-pet-sprite.dragging { animation: none !important; }
/* 喂食道具：饭碗（身后）+ 飞溅的口粮 + 星星 */
.dsh-digital-pet-fx-crumb { width: 7%; height: 7%; left: 16%; bottom: 22%; border-radius: 50%; background: #8d5a29; opacity: 0;
  animation: dsh-digital-pet-fx-crumb 1.5s ease-out infinite; }
.dsh-digital-pet-fx-crumb-2 { left: 10%; animation-delay: .45s; }
.dsh-digital-pet-fx-crumb-3 { left: 22%; animation-delay: .9s; }
@keyframes dsh-digital-pet-fx-crumb {
  0% { opacity: 0; transform: translate(0, 0) scale(.5); }
  14% { opacity: 1; }
  62% { opacity: 1; transform: translate(30%, -190%) scale(1.05); }
  100% { opacity: 0; transform: translate(58%, -95%) scale(.7); }
}
.dsh-digital-pet-fx-spark { top: 30%; left: 68%; width: 11%; height: 11%; background: #ffd76e; opacity: 0;
  clip-path: polygon(50% 0%, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0% 50%, 39% 39%);
  animation: dsh-digital-pet-fx-twinkle 1.5s ease-in-out infinite; }
@keyframes dsh-digital-pet-fx-twinkle {
  0%, 100% { opacity: 0; transform: scale(.4) rotate(0deg); }
  45% { opacity: 1; transform: scale(1.1) rotate(25deg); }
}
/* 洗澡道具：泡沫 + 泡泡 + 海绵搓洗 + 水珠 */
.dsh-digital-pet-fx-foam { left: 8%; right: 8%; top: 24%; height: 32%; border-radius: 50%; opacity: 0;
  background: radial-gradient(circle at 20% 42%, rgba(255, 255, 255, .96) 0 23%, transparent 25%),
    radial-gradient(circle at 44% 26%, rgba(255, 255, 255, .96) 0 21%, transparent 23%),
    radial-gradient(circle at 70% 40%, rgba(255, 255, 255, .94) 0 22%, transparent 24%),
    radial-gradient(circle at 56% 64%, rgba(255, 255, 255, .9) 0 20%, transparent 22%),
    radial-gradient(circle at 30% 70%, rgba(255, 255, 255, .86) 0 17%, transparent 19%);
  filter: blur(.7px); animation: dsh-digital-pet-fx-foam 1.4s ease-in-out infinite; }
@keyframes dsh-digital-pet-fx-foam {
  0%, 100% { opacity: .55; transform: scale(.97); }
  50% { opacity: .95; transform: scale(1.03); }
}
.dsh-digital-pet-fx-bubble { left: 16%; bottom: 26%; width: 8%; height: 8%; border-radius: 50%; opacity: 0;
  border: 1.5px solid rgba(255, 255, 255, .92);
  background: radial-gradient(circle at 32% 30%, rgba(255, 255, 255, .95), rgba(206, 236, 255, .42) 58%, transparent 64%);
  animation: dsh-digital-pet-fx-bubble 2.4s ease-in infinite; }
.dsh-digital-pet-fx-bubble-2 { left: 44%; animation-delay: .7s; }
.dsh-digital-pet-fx-bubble-3 { left: 70%; animation-delay: 1.3s; }
@keyframes dsh-digital-pet-fx-bubble {
  0% { opacity: 0; transform: translateY(0) scale(.5); }
  18% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-150%) scale(1.1); }
}
.dsh-digital-pet-fx-sponge { top: 46%; left: 50%; width: 26%; height: 13%; border-radius: 26%;
  background: linear-gradient(135deg, #d7ecfb 0 32%, #74b9ea 55%, #4f9bd6 100%);
  box-shadow: inset 0 -2px 2px rgba(0, 0, 0, .12), inset 0 2px 2px rgba(255, 255, 255, .5);
  animation: dsh-digital-pet-fx-scrub 1.05s ease-in-out infinite alternate; }
@keyframes dsh-digital-pet-fx-scrub {
  from { transform: translate(-96%, 4%) rotate(-16deg); }
  to { transform: translate(26%, 10%) rotate(12deg); }
}
.dsh-digital-pet-fx-drop { left: 84%; top: 28%; width: 6%; height: 10%; opacity: 0;
  border-radius: 50% 50% 50% 50% / 34% 34% 72% 72%; background: #8fd1f0;
  animation: dsh-digital-pet-fx-drop 1.3s ease-in infinite; }
.dsh-digital-pet-fx-drop-2 { left: 76%; top: 34%; animation-delay: .5s; }
@keyframes dsh-digital-pet-fx-drop {
  0% { opacity: 0; transform: translateY(0); }
  25% { opacity: .95; }
  100% { opacity: 0; transform: translateY(190%) scaleY(1.15); }
}
/* 逛街道具：脚下的尘土 */
.dsh-digital-pet-fx-dust { left: 40%; bottom: 1%; width: 15%; height: 5%; border-radius: 50%; opacity: 0;
  background: rgba(146, 128, 100, .42); filter: blur(1px);
  animation: dsh-digital-pet-fx-dust 1.35s ease-out infinite; }
.dsh-digital-pet-fx-dust-2 { left: 48%; animation-delay: .45s; }
.dsh-digital-pet-fx-dust-3 { left: 56%; animation-delay: .9s; }
@keyframes dsh-digital-pet-fx-dust {
  0% { opacity: 0; transform: scaleX(.5) translateX(0); }
  22% { opacity: .85; }
  100% { opacity: 0; transform: scaleX(1.5) translateX(-60%); }
}
/* 铲屎道具：扫把 + 便便被打扫飞走 */
.dsh-digital-pet-fx-broom { right: 0; bottom: 0; width: 32%; height: 36%; transform-origin: 80% 96%;
  animation: dsh-digital-pet-fx-sweep 1.05s ease-in-out infinite alternate; }
.dsh-digital-pet-fx-broom::before { content: ''; position: absolute; right: 2%; bottom: 0; width: 54%; height: 34%;
  border-radius: 16% 16% 28% 28%;
  background: repeating-linear-gradient(90deg, #f3cd72 0 12%, #dcae50 12% 24%); }
.dsh-digital-pet-fx-broom::after { content: ''; position: absolute; right: 26%; bottom: 30%; width: 9%; height: 74%;
  border-radius: 99px; background: linear-gradient(90deg, #b9863f, #8a5c25);
  transform: rotate(24deg); transform-origin: bottom center; }
@keyframes dsh-digital-pet-fx-sweep {
  from { transform: rotate(-22deg) translate(-8%, 2%); }
  to { transform: rotate(18deg) translate(2%, 0); }
}
.dsh-digital-pet-act-stage[data-action="cleanWaste"] .dsh-digital-pet-poop { animation: dsh-digital-pet-poop-away 3s ease-in forwards; }
@keyframes dsh-digital-pet-poop-away {
  0% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
  30% { opacity: 1; transform: translate(14%, -8%) rotate(8deg) scale(1); }
  100% { opacity: 0; transform: translate(64%, -6%) rotate(18deg) scale(.5); }
}
/* 喝水道具：水槽 + 水面波动 */
.dsh-digital-pet-fx-trough { left: 2%; bottom: 1%; width: 36%; height: 12%;
  border-radius: 4% 4% 46% 46% / 4% 4% 92% 92%;
  background: linear-gradient(180deg, #c9e9fa 0%, #67b4ee 48%, #2f7fc4 100%);
  box-shadow: inset 0 2px 2px rgba(255, 255, 255, .6), 0 2px 3px rgba(0, 0, 0, .12); }
.dsh-digital-pet-fx-trough::after { content: ''; position: absolute; left: 12%; right: 12%; top: -14%; height: 22%; border-radius: 50%;
  background: rgba(255, 255, 255, .55); animation: dsh-digital-pet-fx-water 1.6s ease-in-out infinite; }
@keyframes dsh-digital-pet-fx-water {
  0%, 100% { opacity: .45; transform: scaleX(.9); }
  50% { opacity: .7; transform: scaleX(1.05); }
}
.dsh-digital-pet-panel-btn:focus-visible, .dsh-digital-pet-paw:focus-visible, .dsh-digital-pet-species:focus-visible,
.dsh-digital-pet-action:focus-visible, .dsh-digital-pet-btn:focus-visible, .dsh-digital-pet-sprite:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 2px; }
.dsh-digital-pet-heart { position: absolute; bottom: 82%; left: 50%; z-index: 3; font-size: 18px; line-height: 1; color: #f0609a;
  pointer-events: none; animation: dsh-digital-pet-heart-up .95s ease-out forwards; text-shadow: 0 1px 2px rgba(0,0,0,.15); }
@keyframes dsh-digital-pet-heart-up {
  0% { opacity: 0; transform: translate(-50%, 4px) scale(.7); }
  25% { opacity: 1; transform: translate(-50%, -6px) scale(1.05); }
  100% { opacity: 0; transform: translate(-50%, -26px) scale(1); }
}
.dsh-digital-pet-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  .dsh-digital-pet-sprite, .dsh-digital-pet-hero img, .dsh-digital-pet-mood-bubble,
  .dsh-digital-pet-poop, .dsh-digital-pet-fx, .dsh-digital-pet-fx > span,
  .dsh-digital-pet-fx > span::before, .dsh-digital-pet-fx > span::after { animation: none !important; }
  .dsh-digital-pet-fx { display: none !important; }
  .dsh-digital-pet-panel-btn, .dsh-digital-pet-paw, .dsh-digital-pet-species, .dsh-digital-pet-bar > i { transition: none !important; }
}
.dsh-digital-pet-float .dsh-digital-pet-hover-stage { touch-action: none; }
.dsh-digital-pet-frame-pet { display: inline-block; position: relative; vertical-align: bottom; flex: none; line-height: 0; }
.dsh-digital-pet-frame-pet > img { pointer-events: none; }
.dsh-digital-pet-frame-surface { position: absolute; inset: 0; pointer-events: none; background-repeat: no-repeat; background-size: 800% 100%; }
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) *,
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) *::before,
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) *::after {
  animation: none !important; will-change: auto;
}
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-zzz > span { opacity: 1; }
/* 睡眠呼吸是唯一需要常驻的微动效（不依赖 hover）：闭眼精灵 + 轻微起伏，其它状态仍按 hover 策略。 */
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-sprite[data-mood="sleep"],
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-hero img[data-mood="sleep"] {
  animation: dsh-digital-pet-sleep-breathe 5.2s ease-in-out infinite !important;
}
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-mood-bubble,
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-heart { opacity: 0; }
.dsh-digital-pet-hover-stage:not([data-hovering="true"]) .dsh-digital-pet-fx { display: none; }
@media (prefers-reduced-motion: reduce) {
  .dsh-digital-pet-hover-stage *, .dsh-digital-pet-hover-stage *::before,
  .dsh-digital-pet-hover-stage *::after { animation: none !important; will-change: auto !important; }
}

`

    function installStyles() {
      const el = document.createElement('style')
      el.setAttribute('data-dsh-digital-pet', '')
      el.textContent = CSS
      document.head.appendChild(el)
      return () => el.remove()
    }

    // ---------------------------------------------------------------------
    // 数据
    // ---------------------------------------------------------------------
    async function fetchState() {
      const res = await fetch(`${API}/state`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function postJson(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(data.error ?? `HTTP ${res.status}`)
        err.code = data.code
        throw err
      }
      return data
    }

    /** 读快照 + 轮询（状态由 Host 权威结算，客户端只负责显示）。 */
    function useSnapshot(pollMs = 8000) {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState(null)
      const refresh = useCallback(() => {
        fetchState().then((data) => {
          setUiLocale(data?.settings?.locale)
          setSnap(data)
          setError(null)
        }).catch((err) => setError(err.message ?? String(err)))
      }, [])
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, pollMs)
        return () => clearInterval(timer)
      }, [refresh, pollMs])
      const apply = useCallback((data) => {
        const next = data?.store ?? data
        if (next !== undefined && next !== null) setSnap(next)
      }, [])
      return { snap, error, refresh, apply }
    }

    // ---------------------------------------------------------------------
    // 文案（中/英）
    // ---------------------------------------------------------------------
    // 默认中文；语言存在 Host 存档 settings.locale 里，切换后下一轮快照生效。
    // 少量 Host 下发的中文字段（阶段名、诉求名、物种名）在客户端按 key 重新取词，
    // 取不到时回退 Host 文案，保证老 Host 也能正常显示。
    let uiLocale = 'zh'
    const setUiLocale = (value) => { uiLocale = value === 'en' ? 'en' : 'zh' }
    const isEn = () => uiLocale === 'en'
    const localeTag = () => (isEn() ? 'en-US' : 'zh-CN')
    const locNum = (value) => Number(value ?? 0).toLocaleString(localeTag())

    const I18N = {
      zh: {
        app_title: '电子宠物',
        nav_label: '电子宠物',
        loading_pet: '正在读取宠物档案…',
        load_failed: '读取失败：{err}',
        subtitle_alive: '它正在 DSH 里陪你工作。鼠标悬停时它会做出成长阶段专属动作，移开即停止。桌面上可以拖动位置，点爪印打开操作盘照顾它。',
        subtitle_empty: '还没有在养的宠物。领养后它会陪你六个月，用 DSH Token 换金币照顾它长大。',
        display_label: '桌面显示',
        display_shown: '显示中（点击隐藏）',
        display_hidden: '已隐藏（点击显示）',
        display_hint: '在 DSH 桌面上显示/隐藏宠物（隐藏后仍可在设置页照护）',
        stage_up: '长大啦：进入{stage}',
        stage_baby: '婴儿', stage_toddler: '幼儿', stage_child: '少儿', stage_teen: '青年', stage_adult: '壮年', stage_elder: '老年',
        bar_hunger: '饱食', bar_mood: '心情', bar_clean: '清洁',
        chip_companion: '陪伴 {dur}', chip_affinity: '亲密度 {n}/100', chip_care: '主动照顾 {n} 次',
        act_feed: '喂食', act_walk: '逛街', act_bathe: '洗澡', act_cleanWaste: '铲屎', act_groom: '梳理',
        act_running: '{action}中 · {sec}s', act_running_zero: '{action}中 · 完成', act_done_line: '{action}中，约 {sec} 秒后完成。',
        act_processing: '处理中…',
        reason_NOT_HUNGRY: '它还不饿（饱食低于 90 才能喂）',
        reason_ITEM_MISSING: '背包里没有能喂的口粮',
        reason_TOO_CLEAN: '已经很干净了',
        reason_LOW_ENERGY: '体力不够，先让它休息',
        reason_ON_COOLDOWN: '还在冷却中',
        reason_NO_WASTE: '地面很干净',
        reason_DAILY_LIMIT: '今天的额度用完了',
        reason_BUSY: '正在照顾中',
        reason_PET_DECEASED: '宠物已经离开了',
        reason_unavailable: '暂时不可用',
        reason_cannot_now: '现在还不能做这个动作',
        token_title: '金币明细',
        token_today: '今日已获 {granted} / {cap} 金币',
        token_capped: '今日已封顶',
        token_count: '今日有效 Token：{tokens}（{perCoin} Token = 1 金币）',
        token_capped_desc: '按 Token 折算本应 {expected} 金币，但每日兑换上限 {cap} 金币，超出部分不再发放，次日 0 点重置。',
        token_expected: '按当前 Token 折算可换 {expected} 金币，下一次模型调用后到账（今日上限 {cap}）。',
        token_remaining: '再累计 {remain} Token 可再换 1 金币。',
        token_source: '金币来源只有「模型调用用量」：每 {perCoin} 个有效 Token（输入 + 输出）换 1 金币，每日 0 点按 profile 时区重置；缓存命中不额外计算。',
        adopt_title: '领养一只小宠物',
        adopt_desc1: '它会陪你工作六个月：用 DSH 的 Token 换金币，买喜欢的食品，照顾它长大。',
        adopt_desc2: '每天约 1～2 次照顾，忙起来可以免费托管，不会因为漏养提前离开。',
        adopt_name_aria: '宠物昵称（1～12 个字符）',
        adopt_name_placeholder: '给它起个名字（1～12 个字符）',
        adopt_submit: '领取宠物',
        adopt_submitting: '领取中…',
        adopt_hint: '首次领养赠送 60 金币 + 3 份基础口粮；没有 Token 也能每天领免费救济口粮。',
        adopt_disabled_note: '（即将开放）',
        shop_title: '食品与背包',
        shop_wallet: '{n} 金币',
        bag_basic: '基础口粮 {whole} 份 + {half} 半份',
        bag_favorite: '喜爱主食 {n} 份',
        bag_snack: '零食 {n} 份',
        bag_relief: '救济口粮 {n} 份',
        food_basic: '基础口粮', food_favorite: '喜爱主食', food_snack: '小零食', food_relief: '救济口粮',
        price_staple: '饱食 +{hunger}{mood}；半份 {half} 金币',
        price_snack: '饱食 +{hunger}、心情 +{mood}，每天最多 {limit} 份',
        price_mood_suffix: '、心情 +{mood}',
        price_coins: '{n} 金币',
        buy_one: '买 1 份', buying: '购买中…',
        half_price: '半份 {n}', whole_price: '整份 {n}',
        relief_free: '救济口粮 · 免费',
        relief_desc: '每 24 小时可领 1 份（饱食 +60）；没有 Token 也能养育。',
        relief_next: '下次可领：{time}（库存中还有 1 份时不能再领）',
        relief_stock: '库存中还有 1 份时必须先用完。',
        claim_relief: '领取救济', claiming: '领取中…',
        growth_title: '成长记录',
        growth_species: '物种', growth_born: '出生日期', growth_stage: '当前阶段', growth_next: '距离下一阶段',
        growth_affinity: '亲密度', growth_care: '主动照顾',
        growth_last_stage: '已是最后阶段',
        growth_stage_value: '{stage} · 第 {day} 天',
        growth_next_value: '约 {days} 天（{stage}）',
        growth_times: '{n} 次',
        pref_title: '偏好设置',
        pref_quiet: '免打扰', pref_on: '开', pref_off: '关',
        pref_size: '大小',
        pref_sleep: '睡眠时间', pref_sleep_start: '睡眠开始时间（24 小时制）', pref_sleep_end: '睡眠结束时间（24 小时制）', pref_to: '至',
        sleep_status_sleeping: '当前：睡眠中', sleep_status_awake: '当前：清醒',
        sleep_hint_invalid: '按 24 小时制填写，例如 23:00 至 12:00。{status}',
        sleep_hint_disabled: '起止时间相同：视为不启用睡眠（例如 23:00 至 12:00 表示睡到次日中午）。{status}',
        sleep_hint: '每天 {start} 至 {cross}{end}，共 {dur}；改动即保存。{status}',
        sleep_next_day: '次日 ',
        dur_dh: '{d} 天 {h} 小时', dur_h: '{h} 小时', dur_hm: '{h} 小时 {m} 分', dur_ms: '{m} 分 {s} 秒',
        pref_boarding: '免费托管', pref_boarding_on: '托管中（点击结束）', pref_boarding_off: '开始托管',
        pref_boarding_hint: '托管期间自动维持状态，不扣金币与背包；寿命继续推进。',
        lang_title: '语言', lang_hint: '界面语言；切换后立即生效，其它设置不受影响。',
        lang_zh: '中文', lang_en: 'English',
        memorial_title: '纪念册',
        memorial_empty: '还没有离开的宠物。它会陪你走完六个月，留下这段记录。',
        memorial_entry: '{birth} – {death} · 陪伴 {days} 天 · 照顾 {care} 次',
        surrender_title: '送养',
        surrender_desc: '把它送进宠物救助站会删除当前宠物的数据且不可恢复；金币和口粮会保留，之后可以重新领养一只（首次赠礼不会重复发放）。',
        surrender_confirm: '确定要送走「{name}」吗？',
        surrender_yes: '确认送走', surrender_cancel: '取消', surrender_busy: '送养中…',
        surrender_open: '送进宠物救助站',
        need_hunger: '想吃饭', need_water: '想喝水', need_waste: '需要铲屎', need_bathe: '想洗澡',
        need_walk: '想出门', need_groom: '想梳理', need_rest: '想休息',
        sleep_aria: '睡觉中',
        pet_menu_aria: '宠物菜单',
        pet_click_title: '点击照顾它',
        care_menu_aria: '照顾菜单',
        care_open_aria: '打开照顾菜单', care_close_aria: '关闭照顾菜单',
        hide_menu_title: '把它从桌面隐藏（设置里可重新显示）',
        hide_menu_item: '隐藏「{name}」',
        pet_alt: '{name}（{stage}）',
        pet_pet_aria: '{name}：Enter 抚摸',
        fallback_pet_name: '电子宠物', fallback_pet_short: '宠物',
        error_generic: '这个操作暂时不能进行',
        err_UNKNOWN_SPECIES: '未知物种',
        err_PET_EXISTS: '已经有在养的宠物了',
        err_NO_PET: '还没有在养的宠物',
        err_PET_DECEASED: '宠物已经离开了',
        err_NOT_ENOUGH_COINS: '金币不够',
        err_ITEM_MISSING: '背包里没有这个物品',
        err_ON_COOLDOWN: '还在冷却中',
        err_BUSY: '正在照顾中，等这次完成吧',
        err_INVALID_SIZE: '大小只能是 72/96/128',
        err_INVALID_SLEEP_WINDOW: '作息格式应为 HH:MM',
        err_CONFIRM_REQUIRED: '需要二次确认',
        err_DAILY_LIMIT: '今天的额度用完了',
        err_RELIEF_IN_STOCK: '背包里还有一整份救济口粮，先吃完再领',
        err_RELIEF_COOLDOWN: '今天已经领过了，明天再来',
        err_NICKNAME: '昵称需要 1～12 个字符',
        err_generic: '这个操作暂时不能进行',
      },
      en: {
        app_title: 'Digital pet',
        nav_label: 'Digital pet',
        loading_pet: 'Loading your pet…',
        load_failed: 'Failed to load: {err}',
        subtitle_alive: 'It is here with you while you work. Hover to see its stage-specific animation; moving away stops it. Drag it anywhere on the page, or click the paw to open the care panel.',
        subtitle_empty: 'No pet yet. Adopt one and it will stay with you for six months — tokens from DSH become coins to care for it.',
        display_label: 'On desktop',
        display_shown: 'Shown (click to hide)',
        display_hidden: 'Hidden (click to show)',
        display_hint: 'Show or hide the pet on the DSH desktop (you can still care for it in Settings)',
        stage_up: 'It grew up: {stage}',
        stage_baby: 'Baby', stage_toddler: 'Toddler', stage_child: 'Child', stage_teen: 'Teen', stage_adult: 'Adult', stage_elder: 'Elder',
        bar_hunger: 'Fullness', bar_mood: 'Mood', bar_clean: 'Cleanliness',
        chip_companion: 'Together {dur}', chip_affinity: 'Bond {n}/100', chip_care: 'Care actions {n}',
        act_feed: 'Feed', act_walk: 'Walk', act_bathe: 'Bathe', act_cleanWaste: 'Clean', act_groom: 'Groom',
        act_running: '{action} · {sec}s', act_running_zero: '{action} · done', act_done_line: '{action}, about {sec} seconds to finish.',
        act_processing: 'Working…',
        reason_NOT_HUNGRY: 'Not hungry yet (fullness must be below 90)',
        reason_ITEM_MISSING: 'No food for it in the bag',
        reason_TOO_CLEAN: 'Already clean',
        reason_LOW_ENERGY: 'Too tired — let it rest first',
        reason_ON_COOLDOWN: 'Still cooling down',
        reason_NO_WASTE: 'The floor is clean',
        reason_DAILY_LIMIT: 'Daily limit reached',
        reason_BUSY: 'Already caring for it',
        reason_PET_DECEASED: 'The pet has passed away',
        reason_unavailable: 'Not available yet',
        reason_cannot_now: 'That action is not possible right now',
        token_title: 'Coin details',
        token_today: 'Earned today {granted} / {cap} coins',
        token_capped: 'Daily cap reached',
        token_count: 'Tokens counted today: {tokens} ({perCoin} tokens = 1 coin)',
        token_capped_desc: 'Your tokens would be worth {expected} coins, but the daily cap is {cap}; the rest is not paid out and resets at 00:00.',
        token_expected: 'Your tokens are worth {expected} coins so far; they arrive after your next model call (daily cap {cap}).',
        token_remaining: '{remain} more tokens until the next coin.',
        token_source: 'Coins come only from model usage: every {perCoin} tokens (input + output) = 1 coin, reset daily at 00:00 in your profile time zone. Cache hits are not counted again.',
        adopt_title: 'Adopt a little pet',
        adopt_desc1: 'It will stay with you for six months: turn DSH tokens into coins, buy its favourite food, and watch it grow.',
        adopt_desc2: 'About 1–2 care actions a day. When you are busy, free boarding keeps it safe — it never leaves early because of missed care.',
        adopt_name_aria: 'Pet nickname (1–12 characters)',
        adopt_name_placeholder: 'Give it a name (1–12 characters)',
        adopt_submit: 'Adopt',
        adopt_submitting: 'Adopting…',
        adopt_hint: 'First adoption grants 60 coins + 3 basic rations. Without any tokens you can still claim free relief rations every day.',
        adopt_disabled_note: '(coming soon)',
        shop_title: 'Food & bag',
        shop_wallet: '{n} coins',
        bag_basic: '{whole} full + {half} half',
        bag_favorite: 'Favourite {n}',
        bag_snack: 'Snacks {n}',
        bag_relief: 'Relief {n}',
        food_basic: 'Basic ration', food_favorite: 'Favourite meal', food_snack: 'Snack', food_relief: 'Relief ration',
        price_staple: 'Fullness +{hunger}{mood}; half {half} coins',
        price_snack: 'Fullness +{hunger}, mood +{mood}; up to {limit} a day',
        price_mood_suffix: ', mood +{mood}',
        price_coins: '{n} coins',
        buy_one: 'Buy 1', buying: 'Buying…',
        half_price: 'Half {n}', whole_price: 'Full {n}',
        relief_free: 'free',
        relief_desc: 'One free claim every 24 hours (+60 fullness). No tokens needed to raise a pet.',
        relief_next: 'Next claim: {time} (you cannot claim while a whole ration is in the bag).',
        relief_stock: 'Finish the whole ration you already have first.',
        claim_relief: 'Claim', claiming: 'Claiming…',
        growth_title: 'Growth',
        growth_species: 'Species', growth_born: 'Born', growth_stage: 'Stage', growth_next: 'Next stage',
        growth_affinity: 'Bond', growth_care: 'Care actions',
        growth_last_stage: 'Final stage',
        growth_stage_value: '{stage} · day {day}',
        growth_next_value: 'about {days} days ({stage})',
        growth_times: '{n}',
        pref_title: 'Preferences',
        pref_quiet: 'Do not disturb', pref_on: 'On', pref_off: 'Off',
        pref_size: 'Size',
        pref_sleep: 'Sleep time', pref_sleep_start: 'Sleep starts (24-hour)', pref_sleep_end: 'Sleep ends (24-hour)', pref_to: 'to',
        sleep_status_sleeping: 'Now: sleeping', sleep_status_awake: 'Now: awake',
        sleep_hint_invalid: 'Use 24-hour time, e.g. 23:00 to 12:00. {status}',
        sleep_hint_disabled: 'Same start and end: sleep is disabled (23:00 to 12:00 means sleeping until noon). {status}',
        sleep_hint: '{start} to {cross}{end} every day, {dur} total; saved as you type. {status}',
        sleep_next_day: 'next day ',
        dur_dh: '{d}d {h}h', dur_h: '{h}h', dur_hm: '{h}h {m}m', dur_ms: '{m}m {s}s',
        pref_boarding: 'Free boarding', pref_boarding_on: 'Boarding (click to stop)', pref_boarding_off: 'Start boarding',
        pref_boarding_hint: 'Boarding keeps its stats up without spending coins or food; its lifespan keeps running.',
        lang_title: 'Language', lang_hint: 'Interface language. Takes effect right away; other settings are unchanged.',
        lang_zh: '中文', lang_en: 'English',
        memorial_title: 'Memorial',
        memorial_empty: 'No pet has left yet. It will stay with you for six months and leave this record.',
        memorial_entry: '{birth} – {death} · {days} days together · {care} care actions',
        surrender_title: 'Rehome',
        surrender_desc: 'Sending it to the pet shelter deletes this pet permanently. Coins and food are kept, and you can adopt again afterwards (the first-adoption gift is not granted twice).',
        surrender_confirm: 'Really send 「{name}」 away?',
        surrender_yes: 'Send away', surrender_cancel: 'Cancel', surrender_busy: 'Sending…',
        surrender_open: 'Send to pet shelter',
        need_hunger: 'Hungry', need_water: 'Thirsty', need_waste: 'Needs cleanup', need_bathe: 'Wants a bath',
        need_walk: 'Wants a walk', need_groom: 'Wants grooming', need_rest: 'Tired',
        sleep_aria: 'Sleeping',
        pet_menu_aria: 'Pet menu',
        pet_click_title: 'Click to care for it',
        care_menu_aria: 'Care menu',
        care_open_aria: 'Open care menu', care_close_aria: 'Close care menu',
        hide_menu_title: 'Hide it from the desktop (show it again in Settings)',
        hide_menu_item: 'Hide 「{name}」',
        pet_alt: '{name} ({stage})',
        pet_pet_aria: '{name}: press Enter to pet it',
        fallback_pet_name: 'Digital pet', fallback_pet_short: 'Pet',
        error_generic: 'That action is not possible right now',
        err_UNKNOWN_SPECIES: 'Unknown species',
        err_PET_EXISTS: 'You already have a pet',
        err_NO_PET: 'No pet yet',
        err_PET_DECEASED: 'The pet has passed away',
        err_NOT_ENOUGH_COINS: 'Not enough coins',
        err_ITEM_MISSING: 'That item is not in your bag',
        err_ON_COOLDOWN: 'Still cooling down',
        err_BUSY: 'Already caring for it — wait for this action to finish',
        err_INVALID_SIZE: 'Size must be 72 / 96 / 128',
        err_INVALID_SLEEP_WINDOW: 'Time format should be HH:MM',
        err_CONFIRM_REQUIRED: 'Confirmation required',
        err_DAILY_LIMIT: 'Daily limit reached',
        err_RELIEF_IN_STOCK: 'You still have a whole relief ration — finish it first',
        err_RELIEF_COOLDOWN: 'Already claimed today, come back tomorrow',
        err_NICKNAME: 'Nickname must be 1–12 characters',
        err_generic: 'That action is not possible right now',
      },
    }

    const fmtTemplate = (text, vars) => String(text).replace(/\{(\w+)\}/g, (hit, key) => (
      vars !== undefined && vars !== null && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : hit
    ))
    /** 取词：当前语言缺失时回退中文，再缺回退 key。 */
    const tx = (key, vars) => {
      const table = I18N[uiLocale] ?? I18N.zh
      const text = table[key] ?? I18N.zh[key] ?? key
      return fmtTemplate(text, vars)
    }
    const specLabel = (spec) => {
      if (spec === null || spec === undefined) return ''
      return isEn()
        ? `${spec.speciesEn ?? spec.speciesZh ?? ''}`
        : `${spec.speciesZh ?? ''}`
    }
    const specRoleLabel = (spec) => (spec === null || spec === undefined ? '' : (isEn() ? (spec.nameEn ?? spec.nameZh ?? '') : (spec.nameZh ?? '')))
    const foodNameOf = (item) => {
      if (item === null || item === undefined) return ''
      const key = `food_${item.id}`
      const localized = tx(key)
      return localized === key ? (item.nameZh ?? item.id ?? '') : localized
    }
    const stageLabelOf = (key) => (key === undefined || key === null ? '' : tx(`stage_${key}`))
    const needLabelOf = (need) => {
      if (need === null || need === undefined) return ''
      const key = typeof need === 'string' ? need : need.key
      const fallback = typeof need === 'string' ? null : need.label
      const localized = key === undefined || key === null ? key : I18N[uiLocale]?.[`need_${key}`]
      return localized ?? fallback ?? (key ?? '')
    }
    /** Host 错误码 → 当前语言；未知错误码回退 Host 文案（老 Host 也还能用），再回退通用句。 */
    const errorTextOf = (code, serverMessage) => {
      if (code !== undefined && code !== null) {
        const hit = I18N[uiLocale]?.[`err_${code}`]
        if (hit !== undefined) return hit
      }
      return isEn() ? tx('err_generic') : (serverMessage ?? tx('err_generic'))
    }

    // ---------------------------------------------------------------------
    // 展示辅助
    // ---------------------------------------------------------------------
    const STAGES = [
      { key: 'baby', endDays: 3 },
      { key: 'toddler', endDays: 14 },
      { key: 'child', endDays: 45 },
      { key: 'teen', endDays: 90 },
      { key: 'adult', endDays: 150 },
      { key: 'elder', endDays: Infinity },
    ]

    /** 仅用于显示的阶段回退；权威阶段以 Host 快照的 pet.stage 为准。 */
    function stageForAge(ageMs) {
      const days = (ageMs ?? 0) / DAY_MS
      for (const stage of STAGES) if (days < stage.endDays) return stage
      return STAGES[STAGES.length - 1]
    }

    function stageOf(snap) {
      const pet = snap?.pet
      if (pet?.stage !== undefined && pet.stage !== null) {
        const key = typeof pet.stage === 'string' ? pet.stage : pet.stage.key
        const hit = STAGES.find((item) => item.key === key)
        if (hit !== undefined) return hit
      }
      return stageForAge(pet?.ageMs ?? 0)
    }

    // 素材带 immutable 缓存：用快照里的 assetsVersion 做 URL 破坏，重新导出精灵后能自动刷新。
    // 兜底版本号在「Host 半尚未重启（没有 assetsVersion 字段）」时也强制破一次缓存 —— 每次重出素材可手动 +1。
    const ASSET_QUERY_FALLBACK = '2'
    const assetUrl = (snap, path) => {
      const version = snap?.assetsVersion ?? ASSET_QUERY_FALLBACK
      return `${API}/assets/${path}?v=${encodeURIComponent(version)}`
    }

    /** 素材：`assets/sprites/<species>/<slot>.png`（单帧动作姿态图，不是逐帧序列）。 */
    const spriteUrl = (snap, slot) => {
      const species = snap?.pet?.speciesId ?? 'whale'
      return assetUrl(snap, `sprites/${species}/${slot}.png`)
    }

    const specOf = (snap) => (snap?.species ?? []).find((item) => item.id === snap?.pet?.speciesId)

    /**
     * 睡觉时优先用「闭眼睡觉」精灵 `sprites/<species>/sleep-<stage>.png`；
     * 该文件还没生成/加载失败时自动回退到该阶段的普通精灵，任何素材状态下都能正常显示。
     */
    function usePetSprite(snap, mood, activeAction) {
      const species = snap?.pet?.speciesId ?? 'whale'
      const stageKey = stageOf(snap)?.key
      const actionSlot = actionSlotOf(activeAction)
      const sleepSlot = `sleep-${stageKey}`
      const preferred = actionSlot ?? (mood === 'sleep' ? sleepSlot : stageKey)
      const [failed, setFailed] = useState(false)
      useEffect(() => { setFailed(false) }, [preferred, species, snap?.assetsVersion])
      const useFallback = failed && preferred !== stageKey
      return {
        src: spriteUrl(snap, useFallback ? stageKey : preferred),
        onError: (event) => {
          if (!useFallback) { setFailed(true); return }
          event.currentTarget.style.display = 'none'
        },
      }
    }

    const fmtDate = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (isEn()) return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      const d = new Date(ms)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** 24 小时制时间输入：原生 time 控件在部分区域显示 12 小时制（12:00 AM/PM），容易把中午设成午夜。 */
    function SleepTimeInput({ value, onCommit, label }) {
      const [text, setText] = useState(value ?? '')
      useEffect(() => { setText(value ?? '') }, [value])
      const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(text)
      const commit = () => {
        if (!valid) { setText(value ?? ''); return }
        if (text !== value) onCommit(text)
      }
      return h('input', {
        className: 'dsh-digital-pet-input',
        style: { flex: '0 0 92px', minWidth: 84, textAlign: 'center' },
        type: 'text',
        inputMode: 'numeric',
        maxLength: 5,
        placeholder: '23:00',
        value: text,
        'aria-label': label,
        'aria-invalid': valid ? 'false' : 'true',
        onChange: (event) => setText(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit() }
        },
      })
    }

    /** 睡觉窗口的人类可读描述（24 小时制；跨夜自动标注「次日」，起止相同视为不启用）。 */
    function sleepWindowHint(startHHMM, endHHMM, sleeping) {
      const toMin = (text) => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? ''))
        if (match === null) return null
        const hours = Number(match[1])
        const minutes = Number(match[2])
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null
      }
      const status = sleeping ? tx('sleep_status_sleeping') : tx('sleep_status_awake')
      const start = toMin(startHHMM)
      const end = toMin(endHHMM)
      if (start === null || end === null) return tx('sleep_hint_invalid', { status })
      if (start === end) return tx('sleep_hint_disabled', { status })
      const cross = end < start
      const span = cross ? 24 * 60 - start + end : end - start
      const hours = Math.floor(span / 60)
      const minutes = span % 60
      const dur = minutes === 0 ? tx('dur_h', { h: hours }) : tx('dur_hm', { h: hours, m: minutes })
      return tx('sleep_hint', { start: startHHMM, cross: cross ? tx('sleep_next_day') : '', end: endHHMM, dur, status })
    }

    const fmtDuration = (ms) => {
      const total = Math.max(0, Math.round((ms ?? 0) / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return tx('dur_dh', { d: days, h: hours })
      if (hours > 0) return minutes === 0 ? tx('dur_h', { h: hours }) : tx('dur_hm', { h: hours, m: minutes })
      return tx('dur_ms', { m: minutes, s: total % 60 })
    }

    // 照顾操作（UI 入口）：按用户反馈依次移除「梳理/皮肤刷洗」「喂水」，只保留 4 项。
    // 引擎与 HTTP 接口仍支持 groom / water（老存档、外部调用与自动化不受影响），
    // 但客户端不再提供这两个按钮。
    const CARE_ACTIONS = [
      { type: 'feed', slot: 'feed' },
      { type: 'walk', slot: 'walk' },
      { type: 'bathe', slot: 'bathe' },
      { type: 'cleanWaste', slot: 'cleanWaste' },
    ]

    // 宿主仍可能报告「想梳理」「想喝水」诉求；客户端已没有对应按钮，不再展示这类死胡同提示。
    const HIDDEN_NEEDS = new Set(['groom', 'water'])

    /** 动作不可用原因（Host 只下发结构化 code；这里翻成用户能看懂的一句话，用于按钮 title）。 */
    const ACTION_REASON_KEYS = new Set([
      'NOT_HUNGRY', 'ITEM_MISSING', 'TOO_CLEAN', 'LOW_ENERGY', 'ON_COOLDOWN',
      'NO_WASTE', 'DAILY_LIMIT', 'BUSY', 'PET_DECEASED',
    ])
    const actionReasonText = (entry) => {
      if (entry === null || entry === undefined || entry.enabled !== false) return null
      if (ACTION_REASON_KEYS.has(entry.reason)) return tx(`reason_${entry.reason}`)
      return tx('reason_unavailable')
    }
    /** 前置校验失败时的用户可见文案：优先查文案表，未知 code 用兜底句（不直接暴露 code）。 */
    const actionReasonMessage = (entry) => (ACTION_REASON_KEYS.has(entry?.reason) ? tx(`reason_${entry.reason}`) : tx('reason_cannot_now'))

    function actionLabel(actionType, spec) {
      if (actionType === 'groom') {
        if (isEn()) return tx('act_groom')
        if (spec?.grooming !== undefined) return spec.grooming
      }
      const known = ['feed', 'walk', 'bathe', 'cleanWaste']
      if (known.includes(actionType)) return tx(`act_${actionType}`)
      return actionType
    }

    /** 金币图标：不依赖 emoji（系统字体的硬币 emoji 偏银色），用 SVG 画一枚金色硬币。 */
    function CoinIcon({ size = 13 } = {}) {
      return h('svg', {
        className: 'dsh-digital-pet-coin',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('circle', { cx: 8, cy: 8, r: 7.3, fill: '#E7A93A', stroke: '#9A6A14', strokeWidth: 1 }),
        h('circle', { cx: 8, cy: 8, r: 5.7, fill: '#F7CB61', stroke: '#C08A28', strokeWidth: 0.8 }),
        h('ellipse', { cx: 5.7, cy: 5.4, rx: 2.2, ry: 1.25, fill: '#FFF2C0', opacity: 0.85, transform: 'rotate(-28 5.7 5.4)' }),
        h('path', {
          d: 'M8 6.1v4.4M6.6 7.3h2.8M6.6 8.8h2.8',
          fill: 'none',
          stroke: '#8A5C10',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
        }),
      )
    }

    function Bar({ label, value, color }) {
      const pct = Math.max(0, Math.min(100, value ?? 0))
      return h('div', { className: 'dsh-digital-pet-bar-row' },
        h('span', { className: 'dsh-digital-pet-muted' }, label),
        h('span', { className: 'dsh-digital-pet-bar' }, h('i', { style: { width: `${pct}%`, background: color } })),
        h('span', { className: 'dsh-digital-pet-muted', style: { textAlign: 'right' } }, Math.round(pct)),
      )
    }

    function useCountdown(endsAtMs) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        if (typeof endsAtMs !== 'number') return undefined
        const timer = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(timer)
      }, [endsAtMs])
      if (typeof endsAtMs !== 'number') return null
      return Math.max(0, endsAtMs - now)
    }

    // ---------------------------------------------------------------------
    // 悬浮宠物（shell.overlay）：拖动 + 点击状态卡 + 左侧操作盘
    // ---------------------------------------------------------------------
    const NEED_ACTION = { hunger: 'feed', waste: 'cleanWaste', bathe: 'bathe', walk: 'walk', rest: null }
    const ACTION_SLOTS = { feed: 'feed', water: 'water', walk: 'walk', groom: 'groom', bathe: 'bathe', cleanWaste: 'cleanWaste' }
    function actionSlotOf(activeAction) {
      if (activeAction === null) return null
      return ACTION_SLOTS[activeAction.type] ?? null
    }

    /**
     * 待机表现：acting > sleep > hungry(H<20) > thirsty(想喝水) > awake。
     * 只驱动 CSS 动画，不改变任何数值。
     */
    function moodOf(pet, activeAction) {
      if (activeAction !== null && activeAction !== undefined) return 'acting'
      if (pet?.sleeping === true) return 'sleep'
      if (typeof pet?.H === 'number' && pet.H < 20) return 'hungry'
      if (pet?.need?.key === 'water') return 'thirsty'
      return 'awake'
    }

    // 照护动作的小道具与粒子。素材只有单帧姿态图（没有逐帧序列），所以动作由
    // CSS 姿态动画（见样式区的 data-action 规则）+ 这些道具一起合成：
    //   under 画在身体后面（饭碗、水槽）；over 盖在身体前面（泡沫、水珠、扫把、粒子）。
    // 舞台尺寸来自 --pet-size，悬浮宠物与设置页大图共用同一套样式。
    const ACTION_FX = {
      feed: { under: [], over: ['crumb', 'crumb', 'crumb', 'spark'] },
      water: { under: ['trough'], over: ['drop', 'drop', 'spark'] },
      bathe: { under: [], over: ['foam', 'bubble', 'bubble', 'bubble', 'drop', 'sponge'] },
      groom: { under: [], over: ['sponge', 'spark'] },
      walk: { under: [], over: ['dust', 'dust', 'dust'] },
      cleanWaste: { under: [], over: ['broom', 'spark'] },
    }
    const ACTION_FX_FALLBACK = { under: [], over: ['spark'] }

    /** 睡觉符号（Z Z Z）：只表达状态，不写文字；跟随 --pet-size 缩放。 */
    function SleepZzz() {
      return h('div', { className: 'dsh-digital-pet-zzz', 'aria-hidden': 'true' },
        h('span', null, 'Z'), h('span', null, 'Z'), h('span', null, 'Z'))
    }

    function ActionFx({ actionType }) {
      if (actionType === null || actionType === undefined) return null
      const spec = ACTION_FX[actionType] ?? ACTION_FX_FALLBACK
      // 同类粒子出现多次时追加 -2/-3 修饰名，让样式能分别摆位与错峰
      const layer = (name, nodes) => {
        const seen = {}
        return h('div', {
          className: `dsh-digital-pet-fx dsh-digital-pet-fx-${name}`,
          'aria-hidden': 'true',
        }, nodes.map((node) => {
          seen[node] = (seen[node] ?? 0) + 1
          return h('span', {
            key: `${node}-${seen[node]}`,
            className: `dsh-digital-pet-fx-${node} dsh-digital-pet-fx-${node}-${seen[node]}`,
          })
        }))
      }
      return h(React.Fragment, null, layer('under', spec.under), layer('over', spec.over))
    }

    function useReducedMotion() {
      const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setReduced(media.matches)
        update()
        media.addEventListener('change', update)
        return () => media.removeEventListener('change', update)
      }, [])
      return reduced
    }

    /** Real drawn poses. Keep event handlers on a fixed square, separate from frame selection. */
    function FramePet({ snap, size = 132, ...imageProps }) {
      const hovering = React.useContext(HoverContext)
      const reduced = useReducedMotion()
      const surface = useRef(null)
      const wrapper = useRef(null)
      const [loadedUrl, setLoadedUrl] = useState(null)
      const species = snap?.pet?.speciesId ?? 'whale'
      const stage = stageOf(snap).key
      const acting = !!imageProps['data-action'] || imageProps['data-mood'] === 'sleep'
      const supported = !!HOVER_SPECIES[species] && HOVER_STAGES.includes(stage)
      const atlas = `${assetUrl(snap, `hover-v1/atlases/${species}/${stage}.png`)}&hv=${HOVER_REVISION}`
      const poster = `${assetUrl(snap, `hover-v1/posters/${species}/${stage}.png`)}&hv=${HOVER_REVISION}`
      const ready = loadedUrl === atlas
      useEffect(() => {
        if (!supported || acting) return undefined
        let cancelled = false
        const image = new Image()
        image.onload = () => {
          if (!cancelled && image.naturalWidth === image.naturalHeight * 8) setLoadedUrl(atlas)
        }
        image.onerror = () => { if (!cancelled) setLoadedUrl(null) }
        image.src = atlas
        return () => { cancelled = true; image.onload = null; image.onerror = null }
      }, [atlas, supported, acting])
      useEffect(() => {
        let raf = 0
        const paint = (index) => {
          if (surface.current) surface.current.style.backgroundPosition = `${index / 7 * 100}% 0`
          if (wrapper.current) wrapper.current.dataset.frame = String(index)
        }
        paint(0)
        if (hovering && ready && !reduced && !acting) {
          const factor = HOVER_FACTORS[stage] ?? 1
          const duration = HOVER_SEQUENCE.reduce((sum, item) => sum + item[1], 0)
          // On entry show the greeting immediately, then retain the approved neutral pause in the loop.
          const started = performance.now() - HOVER_SEQUENCE[0][1] / factor
          const tick = (now) => {
            let elapsed = (now - started) * factor % duration
            for (const [index, ms] of HOVER_SEQUENCE) {
              if (elapsed < ms) { paint(index); break }
              elapsed -= ms
            }
            raf = requestAnimationFrame(tick)
          }
          raf = requestAnimationFrame(tick)
        }
        return () => { cancelAnimationFrame(raf); paint(0) }
      }, [hovering, ready, reduced, acting, atlas, stage])
      if (acting || !supported) return h('img', imageProps)
      const { src, alt, style, onError, ...events } = imageProps
      return h('span', {
        ...events, ref: wrapper,
        className: `${imageProps.className ?? ''} dsh-digital-pet-frame-pet`,
        role: imageProps.role ?? 'img', 'aria-label': imageProps['aria-label'] ?? alt,
        'data-frame': '0', 'data-atlas-ready': ready ? 'true' : 'false',
        style: { ...style, width: size, height: size },
      },
        h('img', { key: poster, src: poster, alt: '', draggable: false,
          style: { width: '100%', height: '100%', objectFit: 'contain', visibility: ready ? 'hidden' : 'visible' },
          onError: (event) => {
            if (!event.currentTarget.dataset.fallback) {
              event.currentTarget.dataset.fallback = 'true'
              event.currentTarget.src = src
            } else onError?.(event)
          },
        }),
        ready ? h('span', { ref: surface, className: 'dsh-digital-pet-frame-surface', 'aria-hidden': 'true',
          style: { backgroundImage: `url("${atlas}")`, backgroundPosition: '0% 0' },
        }) : null,
      )
    }

    /** Stable hit area: moving pixels never move the hover boundary. No background timer. */
    function HoverStage({ snap, className, style, children, ...props }) {
      const [hovering, setHovering] = useState(false)
      const stage = stageOf(snap).key
      const species = snap?.pet?.speciesId ?? 'whale'
      useEffect(() => {
        const stop = () => setHovering(false)
        window.addEventListener('blur', stop)
        document.addEventListener('visibilitychange', stop)
        return () => {
          window.removeEventListener('blur', stop)
          document.removeEventListener('visibilitychange', stop)
        }
      }, [])
      useEffect(() => setHovering(false), [species, stage])
      const enter = (event) => {
        if (event.pointerType === 'mouse' && event.buttons === 0) setHovering(true)
      }
      return h(HoverContext.Provider, { value: hovering }, h('div', {
        ...props, className: `${className} dsh-digital-pet-hover-stage`,
        style,
        'data-hovering': hovering ? 'true' : 'false', 'data-species': species, 'data-stage': stage,
        'data-hover-gesture': isEn() ? 'Frame-by-frame blinking and gestures' : '逐帧眨眼与肢体动作',
        onPointerEnter: enter, onPointerLeave: () => setHovering(false),
        onPointerDownCapture: () => setHovering(false),
        onPointerUpCapture: (event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) enter(event)
          else setHovering(false)
        },
        onPointerCancel: () => setHovering(false),
        onContextMenuCapture: () => setHovering(false),
      }, children))
    }

    function PetOverlay() {
      const { snap, refresh } = useSnapshot(8000)
      const [ring, setRing] = useState(false)
      const [pos, setPos] = useState(null)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [focusIndex, setFocusIndex] = useState(0)
      const [hearts, setHearts] = useState(0)
      const [ctxMenu, setCtxMenu] = useState(null)
      const [toast, setToast] = useState(null)
      const prevStageRef = useRef(null)
      const dragRef = useRef(null)
      const pawRef = useRef(null)
      const ctxMenuRef = useRef(null)
      const sectorRefs = useRef([])
      const panelRef = useRef(null)
      const pet = snap?.pet
      const spec = specOf(snap)
      const visible = snap?.settings?.visible !== false

      useEffect(() => {
        if (error === null) return undefined
        const timer = setTimeout(() => setError(null), 4000)
        return () => clearTimeout(timer)
      }, [error])

      useEffect(() => {
        const stageKey = snap?.pet?.stage
        if (stageKey === undefined || stageKey === null) return
        if (prevStageRef.current !== null && prevStageRef.current !== stageKey) {
          setToast(tx('stage_up', { stage: stageLabelOf(stageKey) }))
        }
        prevStageRef.current = stageKey
      }, [snap?.pet?.stage])

      useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => setToast(null), 5200)
        return () => clearTimeout(timer)
      }, [toast])
      const activeAction = pet?.activeAction ?? null
      const countdown = useCountdown(activeAction?.endsAtMs)
      const mood = moodOf(pet, activeAction)
      const petSprite = usePetSprite(snap, mood, activeAction)

      // 动作进行中：每秒刷新一次快照，动作一结束立刻隐藏倒计时并恢复按钮可点
      const refreshRef = useRef(refresh)
      refreshRef.current = refresh
      const actionRunning = activeAction !== null
      useEffect(() => {
        if (!actionRunning) return undefined
        const timer = setInterval(() => refreshRef.current(), 1000)
        return () => clearInterval(timer)
      }, [actionRunning])

      useEffect(() => {
        const saved = snap?.settings?.position
        if (saved !== undefined && saved !== null && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          setPos((prev) => prev ?? { x: saved.x, y: saved.y })
        }
      }, [snap])

      // 打开操作盘时把焦点交给第一个按钮（菜单展开才接受键盘焦点）。
      useEffect(() => {
        if (!ring) return undefined
        const timer = setTimeout(() => { sectorRefs.current[focusIndex]?.focus?.() }, 0)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ring])

      // 点击操作盘/爪印以外的区域 → 收起操作盘
      useEffect(() => {
        if (!ring) return undefined
        const onDown = (event) => {
          const target = event.target
          if (panelRef.current !== null && panelRef.current.contains?.(target)) return
          if (pawRef.current !== null && pawRef.current.contains?.(target)) return
          setRing(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [ring])

      useEffect(() => {
        if (!ring) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setRing(false)
            pawRef.current?.focus?.()
            return
          }
          if (!ring) return
          const digit = Number.parseInt(event.key, 10)
          if (Number.isInteger(digit) && digit >= 1 && digit <= CARE_ACTIONS.length) {
            event.preventDefault()
            if (!actionUnavailable(CARE_ACTIONS[digit - 1].type)) care(CARE_ACTIONS[digit - 1].type)
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            const target = document.activeElement
            if (target !== null && target.classList !== undefined && target.classList.contains('dsh-digital-pet-panel-btn')) {
              event.preventDefault()
              if (!actionUnavailable(CARE_ACTIONS[focusIndex].type)) care(CARE_ACTIONS[focusIndex].type)
            }
            return
          }
          const arrows = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }
          const delta = arrows[event.key]
          if (delta === undefined) return
          event.preventDefault()
          const enabledIndexes = CARE_ACTIONS
            .map((action, index) => (actionUnavailable(action.type) ? -1 : index))
            .filter((index) => index !== -1)
          if (enabledIndexes.length === 0) return
          const currentPos = Math.max(0, enabledIndexes.indexOf(focusIndex))
          const nextPos = (currentPos + (delta > 0 ? 1 : -1) + enabledIndexes.length) % enabledIndexes.length
          const next = enabledIndexes[nextPos]
          setFocusIndex(next)
          sectorRefs.current[next]?.focus?.()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ring, focusIndex])

      // 右键菜单：Esc 关闭、点击其它区域关闭；打开后把焦点交给菜单项（键盘可用）
      useEffect(() => {
        if (ctxMenu === null) return undefined
        const onDown = (event) => {
          if (event.target instanceof Element && event.target.closest('.dsh-digital-pet-ctx') !== null) return
          setCtxMenu(null)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setCtxMenu(null) }
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey)
        }
      }, [ctxMenu])

      useEffect(() => {
        if (ctxMenu === null) return
        requestAnimationFrame(() => ctxMenuRef.current?.querySelector('button')?.focus?.())
      }, [ctxMenu])

      if (!snap || snap.hasPet !== true || pet === null || visible === false) return null

      const size = snap.settings?.size ?? 72
      const style = pos === null
        ? { right: 28, bottom: 96 }
        : {
            left: Math.max(8, Math.min((window.innerWidth || 1280) - size - 8, pos.x)),
            top: Math.max(8, Math.min((window.innerHeight || 800) - size - 96, pos.y)),
          }

      // 操作盘默认在宠物左侧；宠物贴近屏幕左边时翻到右侧，避免出屏。
      const petLeft = pos === null ? (window.innerWidth || 1280) - 28 - size * 1.4 : pos.x
      const panelSide = petLeft < 220 ? 'right' : 'left'

      const actionEntryOf = (type) => {
        const list = Array.isArray(pet?.availableActions) ? pet.availableActions : []
        return list.find((item) => item.type === type) ?? null
      }
      const actionUnavailable = (type) => {
        const entry = actionEntryOf(type)
        return entry !== null && entry.enabled === false
      }
      const reasonOf = (type) => actionReasonText(actionEntryOf(type))
      const firstEnabledIndex = () => {
        const index = CARE_ACTIONS.findIndex((action) => !actionUnavailable(action.type))
        return index === -1 ? 0 : index
      }
      const care = async (action) => {
        setBusy(action)
        setError(null)
        try {
          const data = await postJson('/care', { action })
          setRing(false)
          pawRef.current?.focus?.()
          if (data?.store !== undefined) {
            // 通过下一轮轮询刷新，避免客户端自行计算数值
            refresh()
          }
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(null)
        }
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const rect = event.currentTarget.closest('.dsh-digital-pet-hover-stage').getBoundingClientRect()
        dragRef.current = {
          dx: event.clientX - rect.left, dy: event.clientY - rect.top,
          moved: false, startX: event.clientX, startY: event.clientY,
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (drag === null) return
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
        drag.moved = true
        setPos({ x: event.clientX - drag.dx, y: event.clientY - drag.dy })
      }
      const onPointerUp = (event) => {
        const drag = dragRef.current
        dragRef.current = null
        if (drag === null) return
        if (drag.moved && pos !== null) {
          postJson('/settings', { position: pos }).catch(() => {})
        } else {
          setRing(false)
          setHearts((value) => value + 1)
          // 轻点宠物 = 抚摸；奖励由 host 做 30 分钟冷却
          postJson('/pet', {}).then(() => refresh()).catch(() => {})
        }
      }

      /** 右键菜单动作：隐藏宠物（等价于设置页「桌面显示」关）。 */
      const hidePet = async () => {
        setCtxMenu(null)
        try {
          await postJson('/settings', { visible: false })
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        }
      }

      /** 在鼠标位置打开右键菜单：靠右/靠下时向左/上展开，保证不出屏、不盖住整个宠物。 */
      const openCtxMenu = (clientX, clientY) => {
        const menuW = 150
        const menuH = 44
        const gap = 6
        const vw = window.innerWidth || 1280
        const vh = window.innerHeight || 800
        setRing(false)
        const x = clientX + menuW + gap > vw - 8 ? clientX - menuW - gap : clientX + gap
        const y = clientY + menuH + gap > vh - 8 ? clientY - menuH - gap : clientY + gap
        setCtxMenu({
          x: Math.max(8, Math.min(vw - menuW - 8, x)),
          y: Math.max(8, Math.min(vh - menuH - 8, y)),
        })
      }

      const need = pet.need ?? null
      const needKey = typeof need === 'object' && need !== null ? need.key : null
      const needText = need === null || HIDDEN_NEEDS.has(needKey)
        ? ''
        : (typeof need === 'string' ? need : (needLabelOf(need) || need.text || ''))
      return h('div', { className: 'dsh-digital-pet-overlay' },
        h('div', { className: 'dsh-digital-pet-sr', 'aria-live': 'polite' }, [mood === 'sleep' ? tx('sleep_aria') : '', needText, error ?? ''].filter(Boolean).join('；')),
        h('div', { className: 'dsh-digital-pet-float', style },
          h('div', { className: 'dsh-digital-pet-hints' },
            ring || activeAction !== null || needText === '' ? null
              : (NEED_ACTION[need?.key] === undefined || NEED_ACTION[need?.key] === null
                ? h('div', { className: 'dsh-digital-pet-need' }, needText)
                : h('button', {
                    type: 'button',
                    className: 'dsh-digital-pet-need dsh-digital-pet-need-btn',
                    title: tx('pet_click_title'),
                    onClick: () => { care(NEED_ACTION[need.key]) },
                  }, needText)),
            error === null ? null : h('div', { className: 'dsh-digital-pet-pill-error' }, error),
            activeAction === null ? null : h('div', { className: 'dsh-digital-pet-need' },
              countdown === null || countdown > 0
                ? tx('act_running', { action: actionLabel(activeAction.type, spec), sec: countdown === null ? '' : Math.ceil(countdown / 1000) })
                : tx('act_running_zero', { action: actionLabel(activeAction.type, spec) })),
          ),
          h(HoverStage, {
            snap,
            className: 'dsh-digital-pet-act-stage',
            'data-action': activeAction === null ? undefined : activeAction.type,
            style: { width: size * 1.4, height: size, '--pet-size': `${size}px` },
          },
            hearts > 0 ? h('div', { key: `heart-${hearts}`, className: 'dsh-digital-pet-heart', 'aria-hidden': 'true' }, '❤') : null,
            mood === 'hungry' || mood === 'thirsty'
              ? h('div', { className: 'dsh-digital-pet-mood-bubble', 'aria-hidden': 'true' }, mood === 'hungry' ? '🍖' : '💧')
              : null,
            (pet.pendingWaste ?? 0) > 0
              ? h('img', { className: 'dsh-digital-pet-poop', src: spriteUrl(snap, 'poop'), alt: '', draggable: false, onError: (event) => { event.currentTarget.style.display = 'none' } })
              : null,
            h(ActionFx, { actionType: activeAction === null ? null : activeAction.type }),
            h('div', { className: 'dsh-digital-pet-pet-wrap' },
              h(FramePet, {
                snap, size,
                className: 'dsh-digital-pet-sprite',
              'data-mood': mood,
              'data-action': activeAction === null ? undefined : activeAction.type,
              src: petSprite.src,
              style: { height: size, width: 'auto', maxWidth: size * 1.4 },
              alt: tx('pet_alt', { name: pet.nickname ?? tx('fallback_pet_name'), stage: stageLabelOf(stageOf(snap).key) }),
              draggable: false,
              tabIndex: 0,
              role: 'button',
              'aria-label': tx('pet_pet_aria', { name: pet.nickname ?? tx('fallback_pet_short') }),
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: () => { dragRef.current = null },
              onContextMenu: (event) => {
                event.preventDefault()
                event.stopPropagation()
                openCtxMenu(event.clientX, event.clientY)
              },
              onDragStart: (event) => { event.preventDefault() },
              onKeyDown: (event) => {
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  openCtxMenu(rect.right - 12, rect.top + 12)
                  return
                }
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setRing(false)
                setHearts((value) => value + 1)
                postJson('/pet', {}).then(() => refresh()).catch(() => {})
              },
                onError: petSprite.onError,
              }),
              mood === 'sleep' ? h(SleepZzz) : null,
            ),
          ),
          ring ? h('div', {
            ref: panelRef,
            className: `dsh-digital-pet-panel ${panelSide}`,
            role: 'menu',
            'aria-label': tx('care_menu_aria'),
          },
            CARE_ACTIONS.map((action, index) => h('button', {
              key: action.type,
              type: 'button',
              className: 'dsh-digital-pet-panel-btn',
              role: 'menuitem',
              'aria-label': `${index + 1}. ${actionLabel(action.type, spec)}${reasonOf(action.type) === null ? '' : `（${reasonOf(action.type)}）`}`,
              title: reasonOf(action.type) === null ? actionLabel(action.type, spec) : `${actionLabel(action.type, spec)} · ${reasonOf(action.type)}`,
              tabIndex: index === focusIndex ? 0 : -1,
              ref: (element) => { sectorRefs.current[index] = element },
              disabled: busy !== null || actionUnavailable(action.type),
              'aria-disabled': busy !== null || actionUnavailable(action.type),
              onFocus: () => setFocusIndex(index),
              onClick: () => care(action.type),
            }, actionLabel(action.type, spec)))) : null,
          h('button', {
            className: 'dsh-digital-pet-paw',
            title: tx('pet_click_title'),
            ref: pawRef,
            'aria-label': ring ? tx('care_close_aria') : tx('care_open_aria'),
            'aria-haspopup': 'menu',
            'aria-expanded': ring,
            onClick: () => { setRing((value) => !value); setFocusIndex(firstEnabledIndex()) },
          }, '🐾'),
          toast === null ? null : h('div', { className: 'dsh-digital-pet-toast', role: 'status' }, toast),
        ),
        ctxMenu === null ? null : h('div', {
          className: 'dsh-digital-pet-ctx',
          role: 'menu',
          'aria-label': tx('pet_menu_aria'),
          ref: ctxMenuRef,
          style: { left: ctxMenu.x, top: ctxMenu.y },
        },
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-digital-pet-ctx-item',
            title: tx('hide_menu_title'),
            onClick: hidePet,
          }, tx('hide_menu_item', { name: pet.nickname ?? tx('fallback_pet_short') })),
        ),
      )
    }

    /** 今日 Token → 金币 兑换进度（比例与封顶都来自 /state 的 economy，不在客户端写死）。 */
    function TokenExchangeCard({ snap }) {
      const eco = snap?.economy ?? {}
      const perCoin = eco.tokensPerCoin ?? 1000000
      const perCoinText = Number(perCoin).toLocaleString()
      const cap = eco.dailyCap ?? 100
      const tokens = eco.eligibleTokens ?? 0
      const granted = eco.grantedCoins ?? 0
      const expected = Math.min(cap, Math.floor(tokens / perCoin))
      const pending = Math.max(0, expected - granted)
      const capped = granted >= cap
      const remainTokens = capped ? 0 : Math.max(0, (granted + 1) * perCoin - tokens)
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('token_title')),
        h('div', { className: 'dsh-digital-pet-chip-row', style: { marginBottom: 6 } },
          h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), tx('token_today', { granted, cap })),
          capped ? h('span', { className: 'dsh-digital-pet-chip' }, tx('token_capped')) : null,
        ),
        h('div', { className: 'dsh-digital-pet-muted', style: { fontSize: 12, lineHeight: 1.6 } },
          tx('token_count', { tokens: locNum(tokens), perCoin: perCoinText }),
        ),
        h('div', { className: 'dsh-digital-pet-muted', style: { fontSize: 12, lineHeight: 1.6 } },
          capped
            ? tx('token_capped_desc', { expected: locNum(Math.floor(tokens / perCoin)), cap })
            : pending > 0
              ? tx('token_expected', { expected, cap })
              : tx('token_remaining', { remain: locNum(remainTokens) }),
        ),
        h('div', { className: 'dsh-digital-pet-hint', style: { marginTop: 4 } },
          tx('token_source', { perCoin: perCoinText }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：领养
    // ---------------------------------------------------------------------
    function SpeciesPicker({ snap, selected, onSelect }) {
      const list = snap?.species ?? []
      return h('div', { className: 'dsh-digital-pet-grid' }, list.map((item) => {
        const disabled = item.extension === true
        const cls = ['dsh-digital-pet-species']
        if (selected === item.id) cls.push('selected')
        if (disabled) cls.push('disabled')
        return h('div', {
          key: item.id,
          className: cls.join(' '),
          onClick: () => { if (!disabled) onSelect(item.id) },
          onKeyDown: (event) => {
            if (disabled) return
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(item.id) }
          },
          role: 'button',
          tabIndex: disabled ? -1 : 0,
          'aria-disabled': disabled,
          'aria-pressed': selected === item.id,
          title: `${isEn() ? `${item.speciesEn} · ${item.nameEn}` : `${item.speciesZh} · ${item.nameZh}`}${disabled ? tx('adopt_disabled_note') : ''}`,
        },
          h('img', { src: assetUrl(snap, `sprites/${item.id}/baby.png`), alt: isEn() ? (item.speciesEn ?? item.nameEn) : item.speciesZh, draggable: false }),
          h('div', { className: 'dsh-digital-pet-species-name' }, isEn() ? (item.speciesEn ?? item.nameEn) : (item.speciesZh ?? item.nameZh)),
          h('div', { className: 'dsh-digital-pet-species-en' }, isEn() ? item.nameEn : `${item.nameZh} · ${item.nameEn}`),
        )
      }))
    }

    function AdoptCard({ snap, onDone }) {
      const [speciesId, setSpeciesId] = useState('whale')
      const [nickname, setNickname] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          await postJson('/adopt', { speciesId, nickname: nickname.trim() })
          onDone()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('adopt_title')),
        h('p', { className: 'dsh-digital-pet-sub', style: { marginBottom: 12 } },
          tx('adopt_desc1'),
          tx('adopt_desc2')),
        h(SpeciesPicker, { snap, selected: speciesId, onSelect: setSpeciesId }),
        h('div', { className: 'dsh-digital-pet-row' },
          h('input', {
            className: 'dsh-digital-pet-input',
            'aria-label': tx('adopt_name_aria'),
            placeholder: tx('adopt_name_placeholder'),
            value: nickname,
            maxLength: 12,
            onChange: (event) => setNickname(event.target.value),
          }),
          h('button', { className: 'dsh-digital-pet-btn', disabled: busy || nickname.trim() === '', onClick: submit },
            busy ? tx('adopt_submitting') : tx('adopt_submit')),
        ),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
        h('div', { className: 'dsh-digital-pet-hint' }, tx('adopt_hint')),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：仪表盘
    // ---------------------------------------------------------------------
    function DashboardCard({ snap, refresh }) {
      const pet = snap.pet
      const spec = specOf(snap)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const activeAction = pet.activeAction ?? null
      const countdown = useCountdown(activeAction?.endsAtMs)
      const mood = moodOf(pet, activeAction)
      const actionRunning = activeAction !== null
      const refreshRef = useRef(refresh)
      refreshRef.current = refresh
      // 动作进行中每秒刷新：结束时立刻隐藏倒计时文案、恢复按钮可点
      useEffect(() => {
        if (!actionRunning) return undefined
        const timer = setInterval(() => refreshRef.current(), 1000)
        return () => clearInterval(timer)
      }, [actionRunning])
      const heroSprite = usePetSprite(snap, mood, activeAction)
      const care = async (type) => {
        const entry = Array.isArray(pet?.availableActions) ? pet.availableActions.find((item) => item.type === type) : null
        if (entry !== null && entry !== undefined && entry.enabled === false) {
          setError(actionReasonMessage(entry))
          return
        }
        setBusy(type)
        setError(null)
        try {
          await postJson('/care', { action: type })
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(null)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('div', { className: 'dsh-digital-pet-dash' },
          h('div', { className: 'dsh-digital-pet-hero' },
            h(HoverStage, {
              snap,
              className: 'dsh-digital-pet-act-stage dsh-digital-pet-hero-stage',
              'data-action': activeAction === null ? undefined : activeAction.type,
            },
              h(ActionFx, { actionType: activeAction === null ? null : activeAction.type }),
              h('div', { className: 'dsh-digital-pet-pet-wrap' },
                h(FramePet, {
                  snap, size: 132,
                  'data-mood': mood,
                  'data-action': activeAction === null ? undefined : activeAction.type,
                  src: heroSprite.src,
                  onError: heroSprite.onError,
                  alt: pet.nickname,
                }),
                mood === 'sleep' ? h(SleepZzz) : null,
              ),
            ),
            h('div', { style: { fontWeight: 700, fontSize: 15 } }, pet.nickname),
            h('div', { className: 'dsh-digital-pet-muted' }, spec === undefined ? '' : `${specLabel(spec)} · ${specRoleLabel(spec)}`),
            h('div', { className: 'dsh-digital-pet-chip-row' },
              h('span', { className: 'dsh-digital-pet-chip' }, stageLabelOf(stageOf(snap).key)),
              h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), `${snap.wallet?.balance ?? 0}`),
            ),
          ),
          h('div', null,
            h('div', { className: 'dsh-digital-pet-bars', style: { gap: 8 } },
              h(Bar, { label: tx('bar_hunger'), value: pet.H, color: '#f0a05a' }),
              h(Bar, { label: tx('bar_mood'), value: pet.M, color: '#f08ac0' }),
              h(Bar, { label: tx('bar_clean'), value: pet.C, color: '#5aa9f0' }),
            ),
            h('div', { className: 'dsh-digital-pet-row', style: { marginTop: 8 } },
              h('span', { className: 'dsh-digital-pet-chip' }, tx('chip_companion', { dur: fmtDuration(pet.ageMs) })),
              h('span', { className: 'dsh-digital-pet-chip' }, tx('chip_affinity', { n: pet.affinity ?? 0 })),
              h('span', { className: 'dsh-digital-pet-chip' }, tx('chip_care', { n: pet.careCount ?? 0 })),
            ),
            activeAction === null || (countdown !== null && countdown <= 0) ? null : h('div', { className: 'dsh-digital-pet-hint' },
              tx('act_done_line', { action: actionLabel(activeAction.type, spec), sec: countdown === null ? '' : Math.ceil(countdown / 1000) })),
            h('div', { className: 'dsh-digital-pet-actions' }, CARE_ACTIONS.map((action) => {
              const entry = Array.isArray(pet?.availableActions) ? pet.availableActions.find((item) => item.type === action.type) : null
              const reason = actionReasonText(entry)
              return h('button', {
                key: action.type,
                className: 'dsh-digital-pet-action',
                disabled: busy !== null || (activeAction !== null && (countdown === null || countdown > 0)),
                title: reason === null ? actionLabel(action.type, spec) : `${actionLabel(action.type, spec)} · ${reason}`,
                onClick: () => care(action.type),
              },
                h('img', { src: spriteUrl(snap, action.slot), alt: '', draggable: false }),
                h('span', null, busy === action.type ? tx('act_processing') : actionLabel(action.type, spec)),
              )
            })),
            error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：商店与救济
    // ---------------------------------------------------------------------
    function ShopCard({ snap, refresh }) {
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const wallet = snap.wallet?.balance ?? 0
      const inventory = snap.inventory ?? {}
      const foods = (snap.foods ?? []).filter((item) => item.free !== true)
      const buy = async (item, payload) => {
        setBusy(`${item.id}:${JSON.stringify(payload)}`)
        setError(null)
        try {
          await postJson('/buy', { itemId: item.id, ...payload })
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(null)
        }
      }
      const claimRelief = async () => {
        setBusy('relief')
        setError(null)
        try {
          await postJson('/claim-relief', {})
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(null)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('shop_title')),
        h('div', { className: 'dsh-digital-pet-chip-row', style: { marginBottom: 8 } },
          h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), tx('shop_wallet', { n: locNum(wallet) })),
          h('span', { className: 'dsh-digital-pet-chip' }, tx('bag_basic', { whole: Math.floor((inventory.basic ?? 0) / 2), half: (inventory.basic ?? 0) % 2 })),
          h('span', { className: 'dsh-digital-pet-chip' }, tx('bag_favorite', { n: Math.floor((inventory.favorite ?? 0) / 2) })),
          h('span', { className: 'dsh-digital-pet-chip' }, tx('bag_snack', { n: inventory.snack ?? 0 })),
          h('span', { className: 'dsh-digital-pet-chip' }, tx('bag_relief', { n: Math.floor((inventory.relief ?? 0) / 2) })),
        ),
        foods.map((item) => {
          const isSnack = item.halfPrice === null
          return h('div', { key: item.id, className: 'dsh-digital-pet-shop-item' },
            h('div', null,
              h('div', { className: 'dsh-digital-pet-shop-name' },
                foodNameOf(item),
                ' · ',
                h('span', { className: 'dsh-digital-pet-shop-price' }, CoinIcon({ size: 12 }), tx('price_coins', { n: item.price }))),
              h('div', { className: 'dsh-digital-pet-shop-desc' },
                isSnack
                  ? tx('price_snack', { hunger: item.hunger, mood: item.mood, limit: item.dailyLimit })
                  : tx('price_staple', { hunger: item.hunger, mood: item.mood > 0 ? tx('price_mood_suffix', { mood: item.mood }) : '', half: item.halfPrice })),
            ),
            isSnack
              ? h('button', {
                  className: 'dsh-digital-pet-btn sm ghost',
                  disabled: busy !== null || wallet < item.price,
                  onClick: () => buy(item, { quantity: 1 }),
                }, busy === `${item.id}:${JSON.stringify({ quantity: 1 })}` ? tx('buying') : tx('buy_one'))
              : h('div', { className: 'dsh-digital-pet-chip-row' },
                  h('button', {
                    className: 'dsh-digital-pet-btn sm ghost',
                    disabled: busy !== null || wallet < item.halfPrice,
                    onClick: () => buy(item, { halfUnits: 1 }),
                  }, tx('half_price', { n: item.halfPrice })),
                  h('button', {
                    className: 'dsh-digital-pet-btn sm',
                    disabled: busy !== null || wallet < item.price,
                    onClick: () => buy(item, { halfUnits: 2 }),
                  }, tx('whole_price', { n: item.price })),
                ),
          )
        }),
        h('div', { className: 'dsh-digital-pet-shop-item' },
          h('div', null,
            h('div', { className: 'dsh-digital-pet-shop-name' }, `${tx('food_relief')} · ${tx('relief_free')}`),
            h('div', { className: 'dsh-digital-pet-shop-desc' },
              snap.relief?.claimable === true
                ? tx('relief_desc')
                : snap.relief?.nextClaimAtMs !== null && snap.relief?.nextClaimAtMs !== undefined
                  ? tx('relief_next', { time: fmtDate(snap.relief.nextClaimAtMs) })
                  : tx('relief_stock')),
          ),
          h('button', {
            className: 'dsh-digital-pet-btn sm',
            disabled: busy !== null || snap.relief?.claimable !== true,
            onClick: claimRelief,
          }, busy === 'relief' ? tx('claiming') : tx('claim_relief')),
        ),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：成长记录
    // ---------------------------------------------------------------------
    function GrowthCard({ snap }) {
      const pet = snap.pet
      const spec = specOf(snap)
      const stage = stageOf(snap)
      const index = STAGES.findIndex((item) => item.key === stage.key)
      const next = STAGES[index + 1] ?? null
      const ageDays = (pet.ageMs ?? 0) / DAY_MS
      const endDays = stage.endDays
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('growth_title')),
        h('dl', { className: 'dsh-digital-pet-kv' },
          h('dt', null, tx('growth_species')), h('dd', null, spec === undefined ? '' : (isEn() ? `${spec.nameEn} (${spec.speciesEn} / ${spec.speciesZh})` : `${spec.speciesZh}（${spec.nameZh} / ${spec.nameEn}）`)),
          h('dt', null, tx('growth_born')), h('dd', null, fmtDate(pet.adoptedAtMs)),
          h('dt', null, tx('growth_stage')), h('dd', null, tx('growth_stage_value', { stage: stageLabelOf(stage.key), day: Math.floor(ageDays) + 1 })),
          h('dt', null, tx('growth_next')), h('dd', null, next === null ? tx('growth_last_stage') : tx('growth_next_value', { days: Math.max(0, Math.ceil(endDays - ageDays)), stage: stageLabelOf(next.key) })),
          h('dt', null, tx('growth_affinity')), h('dd', null, `${pet.affinity ?? 0} / 100`),
          h('dt', null, tx('growth_care')), h('dd', null, tx('growth_times', { n: pet.careCount ?? 0 })),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：偏好
    // ---------------------------------------------------------------------
    function PreferencesCard({ snap, refresh }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [sleepStart, setSleepStart] = useState(snap.settings?.sleepStart ?? '23:00')
      const [sleepEnd, setSleepEnd] = useState(snap.settings?.sleepEnd ?? '07:00')
      const update = async (payload) => {
        setBusy(true)
        setError(null)
        try {
          await postJson('/settings', payload)
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(false)
        }
      }
      const settings = snap.settings ?? {}
      const sizes = [72, 96, 128]
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('pref_title')),
        h('div', { className: 'dsh-digital-pet-row', style: { marginTop: 0 } },
          h('span', { className: 'dsh-digital-pet-muted' }, tx('pref_quiet')),
          h('button', {
            className: 'dsh-digital-pet-btn sm ghost',
            disabled: busy,
            onClick: () => update({ quiet: settings.quiet !== true }),
          }, settings.quiet === true ? tx('pref_on') : tx('pref_off')),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, tx('pref_size')),
          h('div', { className: 'dsh-digital-pet-chip-row' }, sizes.map((size) =>
            h('button', {
              key: size,
              className: `dsh-digital-pet-btn sm ${settings.size === size ? '' : 'ghost'}`,
              disabled: busy,
              onClick: () => update({ size }),
            }, `${size}px`))),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, tx('pref_sleep')),
          h(SleepTimeInput, {
            value: sleepStart,
            label: tx('pref_sleep_start'),
            onCommit: (value) => { setSleepStart(value); update({ sleepStart: value, sleepEnd }) },
          }),
          h('span', { className: 'dsh-digital-pet-muted' }, tx('pref_to')),
          h(SleepTimeInput, {
            value: sleepEnd,
            label: tx('pref_sleep_end'),
            onCommit: (value) => { setSleepEnd(value); update({ sleepStart, sleepEnd: value }) },
          }),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-hint', style: { margin: 0 } },
            sleepWindowHint(sleepStart, sleepEnd, snap.pet?.sleeping === true)),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, tx('pref_boarding')),
          h('button', {
            className: 'dsh-digital-pet-btn sm ghost',
            disabled: busy,
            onClick: () => update({ boarding: settings.boarding !== true }),
          }, settings.boarding === true ? tx('pref_boarding_on') : tx('pref_boarding_off')),
          h('span', { className: 'dsh-digital-pet-hint', style: { margin: 0 } }, tx('pref_boarding_hint')),
        ),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：纪念册
    // ---------------------------------------------------------------------
    function MemorialCard({ snap }) {
      const list = snap.memorial ?? []
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('memorial_title')),
        list.length === 0
          ? h('p', { className: 'dsh-digital-pet-muted', style: { margin: 0 } }, tx('memorial_empty'))
          : list.slice().reverse().map((item) => h('div', { key: item.petId, className: 'dsh-digital-pet-mem-item' },
              h('img', { src: assetUrl(snap, `sprites/${item.speciesId}/adult.png`), alt: item.nickname, draggable: false }),
              h('div', null,
                h('div', { style: { fontWeight: 600, fontSize: 13 } }, item.nickname),
                h('div', { className: 'dsh-digital-pet-muted' },
                  tx('memorial_entry', { birth: fmtDate(item.adoptedAtMs), death: fmtDate(item.deceasedAtMs), days: Math.max(1, Math.round((item.deceasedAtMs - item.adoptedAtMs) / DAY_MS)), care: item.careCount ?? 0 })),
              ),
            )),
      )
    }

    /** 送养：两步确认，成功后清空宠物数据并回到领养页（金币与口粮保留）。 */
    function SurrenderCard({ snap, refresh }) {
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const pet = snap.pet
      const surrender = async () => {
        setBusy(true)
        setError(null)
        try {
          await postJson('/surrender', { confirm: true })
          setConfirming(false)
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('surrender_title')),
        h('p', { className: 'dsh-digital-pet-muted', style: { margin: '0 0 10px', lineHeight: 1.6 } },
          tx('surrender_desc')),
        confirming
          ? h('div', { className: 'dsh-digital-pet-row' },
              h('span', { className: 'dsh-digital-pet-error', role: 'alert', style: { margin: 0 } },
                tx('surrender_confirm', { name: pet?.nickname ?? tx('fallback_pet_short') })),
              h('button', { className: 'dsh-digital-pet-btn', disabled: busy, onClick: surrender },
                busy ? tx('surrender_busy') : tx('surrender_yes')),
              h('button', { className: 'dsh-digital-pet-btn ghost', disabled: busy, onClick: () => setConfirming(false) }, tx('surrender_cancel')),
            )
          : h('button', { className: 'dsh-digital-pet-btn ghost', onClick: () => setConfirming(true) }, tx('surrender_open')),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
      )
    }

    /** 界面语言：默认中文；切换写入 Host 设置，快照回来后立即生效。 */
    function LanguageCard({ snap, refresh }) {
      const current = snap?.settings?.locale === 'en' ? 'en' : 'zh'
      const [error, setError] = useState(null)
      const choose = async (locale) => {
        if (locale === current) return
        setError(null)
        try {
          await postJson('/settings', { locale })
          refresh()
        } catch (err) {
          setError(errorTextOf(err?.code, err?.message))
        }
      }
      const cls = (locale) => (current === locale ? 'dsh-digital-pet-btn sm' : 'dsh-digital-pet-btn sm ghost')
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, tx('lang_title')),
        h('p', { className: 'dsh-digital-pet-sub', style: { marginBottom: 10 } }, tx('lang_hint')),
        h('div', { className: 'dsh-digital-pet-chip-row' },
          h('button', { className: cls('zh'), 'aria-pressed': current === 'zh', onClick: () => choose('zh') }, tx('lang_zh')),
          h('button', { className: cls('en'), 'aria-pressed': current === 'en', onClick: () => choose('en') }, tx('lang_en')),
        ),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
      )
    }

    function PetSettings() {
      const { snap, error, refresh } = useSnapshot(6000)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const toggleVisible = async () => {
        if (snap === null) return
        setBusy(true)
        setActionError(null)
        try {
          await postJson('/settings', { visible: snap.settings?.visible === false })
          refresh()
        } catch (err) {
          setActionError(errorTextOf(err?.code, err?.message))
        } finally {
          setBusy(false)
        }
      }
      if (snap === null) {
        return h('div', { className: 'dsh-digital-pet-settings' },
          h('h1', { className: 'dsh-digital-pet-h1' }, tx('app_title')),
          h('p', { className: 'dsh-digital-pet-sub' }, error === null ? tx('loading_pet') : tx('load_failed', { err: error })))
      }
      const hasPet = snap.hasPet === true
      const visible = snap.settings?.visible !== false
      return h('div', { className: 'dsh-digital-pet-settings' },
        h('div', { className: 'dsh-digital-pet-head' },
          h('div', { className: 'dsh-digital-pet-head-main' },
            h('h1', { className: 'dsh-digital-pet-h1' }, tx('app_title')),
            h('p', { className: 'dsh-digital-pet-sub' }, hasPet ? tx('subtitle_alive') : tx('subtitle_empty')),
          ),
          hasPet
            ? h('div', { className: 'dsh-digital-pet-head-toggle' },
              h('span', { className: 'dsh-digital-pet-muted' }, tx('display_label')),
              h('button', {
                className: 'dsh-digital-pet-btn sm ghost',
                disabled: busy,
                'aria-pressed': visible,
                title: tx('display_hint'),
                onClick: toggleVisible,
              }, visible ? tx('display_shown') : tx('display_hidden')),
            )
            : null,
        ),
        actionError === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, actionError),
        hasPet ? h(DashboardCard, { snap, refresh }) : h(AdoptCard, { snap, onDone: refresh }),
        hasPet ? h(ShopCard, { snap, refresh }) : null,
        hasPet ? h(TokenExchangeCard, { snap }) : null,
        hasPet ? h(GrowthCard, { snap }) : null,
        hasPet ? h(PreferencesCard, { snap, refresh }) : null,
        h(MemorialCard, { snap }),
        hasPet ? h(SurrenderCard, { snap, refresh }) : null,
        h(LanguageCard, { snap, refresh }),
      )
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------
    const inject = ['slots', 'locale', 'layout']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-digital-pet: styles')

      ctx.effect(() => {
        const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-digital-pet',
          order: 70,
          label: () => tx('nav_label'),
        }, () => h(PetSettings, null)))
        return () => dispose()
      }, 'dsh-digital-pet: settings section')

      ctx.effect(() => {
        const dispose = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-digital-pet.overlay',
          order: 900,
        }, () => h(PetOverlay, null)))
        return () => dispose()
      }, 'dsh-digital-pet: floating pet overlay')
    }

    return { inject, apply }
  },
})
