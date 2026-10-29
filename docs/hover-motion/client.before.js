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
.dsh-digital-pet-need { max-width: 190px; padding: 4px 10px; border-radius: 99px; font-size: 11px; line-height: 1.4;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  color: var(--dsw-alias-label-primary, #222); box-shadow: 0 2px 8px rgba(0,0,0,.1); text-align: center; }
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
.dsh-digital-pet-panel-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsh-digital-pet-panel-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-digital-pet-panel-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.dsh-digital-pet-bars { display: grid; grid-template-columns: 1fr; gap: 4px; }
.dsh-digital-pet-bar-row { display: grid; grid-template-columns: 30px 1fr 30px; align-items: center; gap: 6px; }
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
/* 待机微动：清醒时缓慢呼吸+轻摆，偶尔小跳一下；睡眠时只有很慢的起伏 */
/* 醒着：连续呼吸 + 轻微上下浮动（桌面悬浮层与设置页大图共用，幅度小但持续可见） */
@keyframes dsh-digital-pet-idle-awake {
  0% { transform: translateY(0) scale(1) rotate(0deg); }
  28% { transform: translateY(-3px) scale(1.012) rotate(-.6deg); }
  52% { transform: translateY(0) scale(.998) rotate(.4deg); }
  72% { transform: translateY(-2px) scale(1.008) rotate(-.3deg); }
  100% { transform: translateY(0) scale(1) rotate(0deg); }
}
/* 睡着：更慢更浅的呼吸（比醒着再收一半幅度） */
@keyframes dsh-digital-pet-idle-sleep {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.018); }
}
/* 饿了：小幅摇晃 + 略微下沉 */
@keyframes dsh-digital-pet-idle-hungry {
  0%, 100% { transform: translateY(1px) rotate(0deg) scale(1); }
  18% { transform: translateY(1px) rotate(-2.4deg) scale(.998); }
  42% { transform: translateY(2px) rotate(1.8deg) scale(1.002); }
  68% { transform: translateY(1px) rotate(0deg) scale(1); }
}
.dsh-digital-pet-sprite { transform-origin: 50% 100%; will-change: transform; }
.dsh-digital-pet-sprite[data-mood="awake"] { animation: dsh-digital-pet-idle-awake 4.8s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-mood="sleep"] { animation: dsh-digital-pet-idle-sleep 6.4s ease-in-out infinite; }
.dsh-digital-pet-sprite[data-mood="hungry"], .dsh-digital-pet-sprite[data-mood="thirsty"] {
  animation: dsh-digital-pet-idle-hungry 4.6s ease-in-out infinite; filter: saturate(.82) drop-shadow(0 6px 10px rgba(0,0,0,.18)); }
.dsh-digital-pet-sprite[data-mood="acting"] { animation: none; }
.dsh-digital-pet-sprite.dragging { animation: none; }
.dsh-digital-pet-mood-bubble { position: absolute; bottom: 82%; left: 50%; z-index: 2; font-size: 15px; line-height: 1;
  pointer-events: none; animation: dsh-digital-pet-mood-float 5.6s ease-in-out infinite; text-shadow: 0 1px 2px rgba(0,0,0,.18); }
@keyframes dsh-digital-pet-mood-float {
  0%, 55% { opacity: 0; transform: translate(-50%, 4px) scale(.85); }
  65% { opacity: 1; transform: translate(-50%, -4px) scale(1); }
  85% { opacity: 1; transform: translate(-50%, -8px) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -12px) scale(.95); }
}
.dsh-digital-pet-hero img[data-mood="awake"] { animation: dsh-digital-pet-idle-awake 4.8s ease-in-out infinite; transform-origin: 50% 100%; will-change: transform; }
.dsh-digital-pet-hero img[data-mood="sleep"] { animation: dsh-digital-pet-idle-sleep 6.4s ease-in-out infinite; transform-origin: 50% 100%; will-change: transform; }
.dsh-digital-pet-hero img[data-mood="hungry"], .dsh-digital-pet-hero img[data-mood="thirsty"] {
  animation: dsh-digital-pet-idle-hungry 4.6s ease-in-out infinite; transform-origin: 50% 100%; filter: saturate(.82); }
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
    // 展示辅助
    // ---------------------------------------------------------------------
    const STAGES = [
      { key: 'baby', label: '婴儿', endDays: 3 },
      { key: 'toddler', label: '幼儿', endDays: 14 },
      { key: 'child', label: '少儿', endDays: 45 },
      { key: 'teen', label: '青年', endDays: 90 },
      { key: 'adult', label: '壮年', endDays: 150 },
      { key: 'elder', label: '老年', endDays: Infinity },
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

    const fmtDate = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    const fmtDuration = (ms) => {
      const total = Math.max(0, Math.round((ms ?? 0) / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      if (days > 0) return `${days} 天 ${hours} 小时`
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      return `${minutes} 分 ${total % 60} 秒`
    }

    // 照顾操作（UI 入口）：按用户反馈依次移除「梳理/皮肤刷洗」「喂水」，只保留 4 项。
    // 引擎与 HTTP 接口仍支持 groom / water（老存档、外部调用与自动化不受影响），
    // 但客户端不再提供这两个按钮。
    const CARE_ACTIONS = [
      { type: 'feed', label: '喂食', slot: 'feed' },
      { type: 'walk', label: '逛街', slot: 'walk' },
      { type: 'bathe', label: '洗澡', slot: 'bathe' },
      { type: 'cleanWaste', label: '铲屎', slot: 'cleanWaste' },
    ]

    // 宿主仍可能报告「想梳理」「想喝水」诉求；客户端已没有对应按钮，不再展示这类死胡同提示。
    const HIDDEN_NEEDS = new Set(['groom', 'water'])

    function actionLabel(actionType, spec) {
      if (actionType === 'groom' && spec?.grooming !== undefined) return spec.grooming
      const hit = CARE_ACTIONS.find((item) => item.type === actionType)
      return hit?.label ?? actionType
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
          setToast(`长大啦：进入${snap.pet.stageLabel ?? stageKey}`)
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
            care(CARE_ACTIONS[digit - 1].type)
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            const target = document.activeElement
            if (target !== null && target.classList !== undefined && target.classList.contains('dsh-digital-pet-panel-btn')) {
              event.preventDefault()
              care(CARE_ACTIONS[focusIndex].type)
            }
            return
          }
          const arrows = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }
          const delta = arrows[event.key]
          if (delta === undefined) return
          event.preventDefault()
          const next = (focusIndex + delta + CARE_ACTIONS.length) % CARE_ACTIONS.length
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
          setError(err.message ?? String(err))
        } finally {
          setBusy(null)
        }
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const rect = event.currentTarget.getBoundingClientRect()
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
          setError(err.message ?? String(err))
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
        : (typeof need === 'string' ? need : (need.label ?? need.text ?? ''))
      return h('div', { className: 'dsh-digital-pet-overlay' },
        h('div', { className: 'dsh-digital-pet-sr', 'aria-live': 'polite' }, [mood === 'sleep' ? '睡觉中' : '', needText, error ?? ''].filter(Boolean).join('；')),
        h('div', { className: 'dsh-digital-pet-float', style },
          ring || activeAction !== null || needText === '' ? null
            : (NEED_ACTION[need?.key] === undefined || NEED_ACTION[need?.key] === null
              ? h('div', { className: 'dsh-digital-pet-need' }, needText)
              : h('button', {
                  type: 'button',
                  className: 'dsh-digital-pet-need dsh-digital-pet-need-btn',
                  title: '点击照顾它',
                  onClick: () => { care(NEED_ACTION[need.key]) },
                }, needText)),
          error === null ? null : h('div', { className: 'dsh-digital-pet-pill-error' }, error),
          activeAction === null ? null : h('div', { className: 'dsh-digital-pet-need' },
            `${actionLabel(activeAction.type, spec)}中 · ${countdown === null ? '' : (countdown > 0 ? Math.ceil(countdown / 1000) + 's' : '完成')}`),
          h('div', {
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
              h('img', {
                className: 'dsh-digital-pet-sprite',
              'data-mood': mood,
              'data-action': activeAction === null ? undefined : activeAction.type,
              src: spriteUrl(snap, actionSlotOf(activeAction) ?? stageOf(snap).key),
              style: { height: size, width: 'auto', maxWidth: size * 1.4 },
              alt: `${pet.nickname ?? '电子宠物'}（${stageOf(snap).label}）`,
              draggable: false,
              tabIndex: 0,
              role: 'button',
              'aria-label': `${pet.nickname ?? '宠物'}：Enter 抚摸`,
              onPointerDown,
              onPointerMove,
              onPointerUp,
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
                onError: (event) => { event.currentTarget.style.display = 'none' },
              }),
              mood === 'sleep' ? h(SleepZzz) : null,
            ),
          ),
          ring ? h('div', {
            ref: panelRef,
            className: `dsh-digital-pet-panel ${panelSide}`,
            role: 'menu',
            'aria-label': '照顾菜单',
          },
            CARE_ACTIONS.map((action, index) => h('button', {
              key: action.type,
              type: 'button',
              className: 'dsh-digital-pet-panel-btn',
              role: 'menuitem',
              'aria-label': `${index + 1}. ${actionLabel(action.type, spec)}`,
              title: actionLabel(action.type, spec),
              tabIndex: index === focusIndex ? 0 : -1,
              ref: (element) => { sectorRefs.current[index] = element },
              disabled: busy !== null,
              onFocus: () => setFocusIndex(index),
              onClick: () => care(action.type),
            }, actionLabel(action.type, spec)))) : null,
          h('button', {
            className: 'dsh-digital-pet-paw',
            title: '照顾它',
            ref: pawRef,
            'aria-label': ring ? '关闭照顾菜单' : '打开照顾菜单',
            'aria-haspopup': 'menu',
            'aria-expanded': ring,
            onClick: () => { setRing((value) => !value); setFocusIndex(0) },
          }, '🐾'),
          toast === null ? null : h('div', { className: 'dsh-digital-pet-toast', role: 'status' }, toast),
        ),
        ctxMenu === null ? null : h('div', {
          className: 'dsh-digital-pet-ctx',
          role: 'menu',
          'aria-label': '宠物菜单',
          ref: ctxMenuRef,
          style: { left: ctxMenu.x, top: ctxMenu.y },
        },
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-digital-pet-ctx-item',
            title: '把它从桌面隐藏（设置里可重新显示）',
            onClick: hidePet,
          }, `隐藏「${pet.nickname ?? '宠物'}」`),
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
        h('h2', null, '金币明细'),
        h('div', { className: 'dsh-digital-pet-chip-row', style: { marginBottom: 6 } },
          h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), `今日已获 ${granted} / ${cap} 金币`),
          capped ? h('span', { className: 'dsh-digital-pet-chip' }, '今日已封顶') : null,
        ),
        h('div', { className: 'dsh-digital-pet-muted', style: { fontSize: 12, lineHeight: 1.6 } },
          `今日有效 Token：${tokens.toLocaleString()}（${perCoinText} Token = 1 金币）`,
        ),
        h('div', { className: 'dsh-digital-pet-muted', style: { fontSize: 12, lineHeight: 1.6 } },
          capped
            ? `按 Token 折算本应 ${Math.floor(tokens / perCoin).toLocaleString()} 金币，但每日兑换上限 ${cap} 金币，超出部分不再发放，次日 0 点重置。`
            : pending > 0
              ? `按当前 Token 折算可换 ${expected} 金币，下一次模型调用后到账（今日上限 ${cap}）。`
              : `再累计 ${remainTokens.toLocaleString()} Token 可再换 1 金币。`,
        ),
        h('div', { className: 'dsh-digital-pet-hint', style: { marginTop: 4 } },
          `金币来源只有「模型调用用量」：每 ${perCoinText} 个有效 Token（输入 + 输出）换 1 金币，每日 0 点按 profile 时区重置；缓存命中不额外计算。`,
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
          title: `${item.speciesZh} · ${item.nameZh} · ${item.nameEn}${disabled ? '（v1.1 开放）' : ''}`,
        },
          h('img', { src: assetUrl(snap, `sprites/${item.id}/baby.png`), alt: item.speciesZh, draggable: false }),
          h('div', { className: 'dsh-digital-pet-species-name' }, item.speciesZh ?? item.nameZh),
          h('div', { className: 'dsh-digital-pet-species-en' }, `${item.nameZh} · ${item.nameEn}`),
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
          setError(err.message ?? String(err))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, '领养一只小宠物'),
        h('p', { className: 'dsh-digital-pet-sub', style: { marginBottom: 12 } },
          '它会陪你工作六个月：用 DSH 的 Token 换金币，买喜欢的食品，照顾它长大。',
          '每天约 1～2 次照顾，忙起来可以免费托管，不会因为漏养提前离开。'),
        h(SpeciesPicker, { snap, selected: speciesId, onSelect: setSpeciesId }),
        h('div', { className: 'dsh-digital-pet-row' },
          h('input', {
            className: 'dsh-digital-pet-input',
            'aria-label': '宠物昵称（1～12 个字符）',
            placeholder: '给它起个名字（1～12 个字符）',
            value: nickname,
            maxLength: 12,
            onChange: (event) => setNickname(event.target.value),
          }),
          h('button', { className: 'dsh-digital-pet-btn', disabled: busy || nickname.trim() === '', onClick: submit },
            busy ? '领取中…' : '领取宠物'),
        ),
        error === null ? null : h('div', { className: 'dsh-digital-pet-error', role: 'alert' }, error),
        h('div', { className: 'dsh-digital-pet-hint' }, '首次领养赠送 60 金币 + 3 份基础口粮；没有 Token 也能每天领免费救济口粮。'),
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
      const care = async (type) => {
        const entry = Array.isArray(pet?.availableActions) ? pet.availableActions.find((item) => item.type === type) : null
        if (entry !== null && entry !== undefined && entry.enabled === false) {
          setError(entry.reason ?? '现在还不能做这个动作')
          return
        }
        setBusy(type)
        setError(null)
        try {
          await postJson('/care', { action: type })
          refresh()
        } catch (err) {
          setError(err.message ?? String(err))
        } finally {
          setBusy(null)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('div', { className: 'dsh-digital-pet-dash' },
          h('div', { className: 'dsh-digital-pet-hero' },
            h('div', {
              className: 'dsh-digital-pet-act-stage dsh-digital-pet-hero-stage',
              'data-action': activeAction === null ? undefined : activeAction.type,
            },
              h(ActionFx, { actionType: activeAction === null ? null : activeAction.type }),
              h('div', { className: 'dsh-digital-pet-pet-wrap' },
                h('img', {
                  'data-mood': mood,
                  'data-action': activeAction === null ? undefined : activeAction.type,
                  src: spriteUrl(snap, actionSlotOf(activeAction) ?? stageOf(snap).key),
                  alt: pet.nickname,
                }),
                mood === 'sleep' ? h(SleepZzz) : null,
              ),
            ),
            h('div', { style: { fontWeight: 700, fontSize: 15 } }, pet.nickname),
            h('div', { className: 'dsh-digital-pet-muted' }, `${spec?.speciesZh ?? ''} · ${spec?.nameZh ?? ''}`),
            h('div', { className: 'dsh-digital-pet-chip-row' },
              h('span', { className: 'dsh-digital-pet-chip' }, stageOf(snap).label),
              h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), `${snap.wallet?.balance ?? 0}`),
            ),
          ),
          h('div', null,
            h('div', { className: 'dsh-digital-pet-bars', style: { gap: 8 } },
              h(Bar, { label: '饱食', value: pet.H, color: '#f0a05a' }),
              h(Bar, { label: '心情', value: pet.M, color: '#f08ac0' }),
              h(Bar, { label: '清洁', value: pet.C, color: '#5aa9f0' }),
            ),
            h('div', { className: 'dsh-digital-pet-row', style: { marginTop: 8 } },
              h('span', { className: 'dsh-digital-pet-chip' }, `陪伴 ${fmtDuration(pet.ageMs)}`),
              h('span', { className: 'dsh-digital-pet-chip' }, `亲密度 ${pet.affinity ?? 0}/100`),
              h('span', { className: 'dsh-digital-pet-chip' }, `主动照顾 ${pet.careCount ?? 0} 次`),
            ),
            activeAction === null || (countdown !== null && countdown <= 0) ? null : h('div', { className: 'dsh-digital-pet-hint' },
              `${actionLabel(activeAction.type, spec)}中，约 ${countdown === null ? '' : Math.ceil(countdown / 1000) + ' 秒'}后完成。`),
            h('div', { className: 'dsh-digital-pet-actions' }, CARE_ACTIONS.map((action) =>
              h('button', {
                key: action.type,
                className: 'dsh-digital-pet-action',
                disabled: busy !== null || (activeAction !== null && (countdown === null || countdown > 0)),
                onClick: () => care(action.type),
              },
                h('img', { src: spriteUrl(snap, action.slot), alt: '', draggable: false }),
                h('span', null, busy === action.type ? '处理中…' : actionLabel(action.type, spec)),
              ))),
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
          setError(err.message ?? String(err))
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
          setError(err.message ?? String(err))
        } finally {
          setBusy(null)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, '食品与背包'),
        h('div', { className: 'dsh-digital-pet-chip-row', style: { marginBottom: 8 } },
          h('span', { className: 'dsh-digital-pet-chip gold' }, CoinIcon(), `${wallet} 金币`),
          h('span', { className: 'dsh-digital-pet-chip' }, `基础口粮 ${Math.floor((inventory.basic ?? 0) / 2)} 份 + ${(inventory.basic ?? 0) % 2} 半份`),
          h('span', { className: 'dsh-digital-pet-chip' }, `喜爱主食 ${Math.floor((inventory.favorite ?? 0) / 2)} 份`),
          h('span', { className: 'dsh-digital-pet-chip' }, `零食 ${inventory.snack ?? 0} 份`),
          h('span', { className: 'dsh-digital-pet-chip' }, `救济口粮 ${Math.floor((inventory.relief ?? 0) / 2)} 份`),
        ),
        foods.map((item) => {
          const isSnack = item.halfPrice === null
          return h('div', { key: item.id, className: 'dsh-digital-pet-shop-item' },
            h('div', null,
              h('div', { className: 'dsh-digital-pet-shop-name' },
                item.nameZh,
                ' · ',
                h('span', { className: 'dsh-digital-pet-shop-price' }, CoinIcon({ size: 12 }), `${item.price}`),
                ' 金币'),
              h('div', { className: 'dsh-digital-pet-shop-desc' },
                isSnack
                  ? `饱食 +${item.hunger}、心情 +${item.mood}，每天最多 ${item.dailyLimit} 份`
                  : `饱食 +${item.hunger}${item.mood > 0 ? `、心情 +${item.mood}` : ''}；半份 ${item.halfPrice} 金币`),
            ),
            isSnack
              ? h('button', {
                  className: 'dsh-digital-pet-btn sm ghost',
                  disabled: busy !== null || wallet < item.price,
                  onClick: () => buy(item, { quantity: 1 }),
                }, busy === `${item.id}:${JSON.stringify({ quantity: 1 })}` ? '购买中…' : '买 1 份')
              : h('div', { className: 'dsh-digital-pet-chip-row' },
                  h('button', {
                    className: 'dsh-digital-pet-btn sm ghost',
                    disabled: busy !== null || wallet < item.halfPrice,
                    onClick: () => buy(item, { halfUnits: 1 }),
                  }, `半份 ${item.halfPrice}`),
                  h('button', {
                    className: 'dsh-digital-pet-btn sm',
                    disabled: busy !== null || wallet < item.price,
                    onClick: () => buy(item, { halfUnits: 2 }),
                  }, `整份 ${item.price}`),
                ),
          )
        }),
        h('div', { className: 'dsh-digital-pet-shop-item' },
          h('div', null,
            h('div', { className: 'dsh-digital-pet-shop-name' }, '救济口粮 · 免费'),
            h('div', { className: 'dsh-digital-pet-shop-desc' },
              snap.relief?.claimable === true
                ? '每 24 小时可领 1 份（饱食 +60）；没有 Token 也能养育。'
                : snap.relief?.nextClaimAtMs !== null && snap.relief?.nextClaimAtMs !== undefined
                  ? `下次可领：${fmtDate(snap.relief.nextClaimAtMs)}（库存中还有 1 份时不能再领）`
                  : '库存中还有 1 份时必须先用完。'),
          ),
          h('button', {
            className: 'dsh-digital-pet-btn sm',
            disabled: busy !== null || snap.relief?.claimable !== true,
            onClick: claimRelief,
          }, busy === 'relief' ? '领取中…' : '领取救济'),
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
        h('h2', null, '成长记录'),
        h('dl', { className: 'dsh-digital-pet-kv' },
          h('dt', null, '物种'), h('dd', null, `${spec?.speciesZh ?? ''}（${spec?.nameZh ?? ''} / ${spec?.nameEn ?? ''}）`),
          h('dt', null, '出生日期'), h('dd', null, fmtDate(pet.adoptedAtMs)),
          h('dt', null, '当前阶段'), h('dd', null, `${stage.label} · 第 ${Math.floor(ageDays) + 1} 天`),
          h('dt', null, '距离下一阶段'), h('dd', null, next === null ? '已是最后阶段' : `约 ${Math.max(0, Math.ceil(endDays - ageDays))} 天（${next.label}）`),
          h('dt', null, '亲密度'), h('dd', null, `${pet.affinity ?? 0} / 100`),
          h('dt', null, '主动照顾'), h('dd', null, `${pet.careCount ?? 0} 次`),
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
          setError(err.message ?? String(err))
        } finally {
          setBusy(false)
        }
      }
      const settings = snap.settings ?? {}
      const sizes = [72, 96, 128]
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, '偏好设置'),
        h('div', { className: 'dsh-digital-pet-row', style: { marginTop: 0 } },
          h('span', { className: 'dsh-digital-pet-muted' }, '免打扰'),
          h('button', {
            className: 'dsh-digital-pet-btn sm ghost',
            disabled: busy,
            onClick: () => update({ quiet: settings.quiet !== true }),
          }, settings.quiet === true ? '开' : '关'),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, '大小'),
          h('div', { className: 'dsh-digital-pet-chip-row' }, sizes.map((size) =>
            h('button', {
              key: size,
              className: `dsh-digital-pet-btn sm ${settings.size === size ? '' : 'ghost'}`,
              disabled: busy,
              onClick: () => update({ size }),
            }, `${size}px`))),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, '睡眠时间'),
          h('input', {
            className: 'dsh-digital-pet-input', style: { flex: '0 0 110px', minWidth: 90 }, type: 'time', value: sleepStart,
            onChange: (event) => setSleepStart(event.target.value),
          }),
          h('span', { className: 'dsh-digital-pet-muted' }, '至'),
          h('input', {
            className: 'dsh-digital-pet-input', style: { flex: '0 0 110px', minWidth: 90 }, type: 'time', value: sleepEnd,
            onChange: (event) => setSleepEnd(event.target.value),
          }),
          h('button', {
            className: 'dsh-digital-pet-btn sm ghost',
            disabled: busy,
            onClick: () => update({ sleepStart, sleepEnd }),
          }, '保存作息'),
        ),
        h('div', { className: 'dsh-digital-pet-row' },
          h('span', { className: 'dsh-digital-pet-muted' }, '免费托管'),
          h('button', {
            className: 'dsh-digital-pet-btn sm ghost',
            disabled: busy,
            onClick: () => update({ boarding: settings.boarding !== true }),
          }, settings.boarding === true ? '托管中（点击结束）' : '开始托管'),
          h('span', { className: 'dsh-digital-pet-hint', style: { margin: 0 } }, '托管期间自动维持状态，不扣金币与背包；寿命继续推进。'),
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
        h('h2', null, '纪念册'),
        list.length === 0
          ? h('p', { className: 'dsh-digital-pet-muted', style: { margin: 0 } }, '还没有离开的宠物。它会陪你走完六个月，留下这段记录。')
          : list.slice().reverse().map((item) => h('div', { key: item.petId, className: 'dsh-digital-pet-mem-item' },
              h('img', { src: assetUrl(snap, `sprites/${item.speciesId}/adult.png`), alt: item.nickname, draggable: false }),
              h('div', null,
                h('div', { style: { fontWeight: 600, fontSize: 13 } }, item.nickname),
                h('div', { className: 'dsh-digital-pet-muted' },
                  `${fmtDate(item.adoptedAtMs)} – ${fmtDate(item.deceasedAtMs)} · 陪伴 ${Math.max(1, Math.round((item.deceasedAtMs - item.adoptedAtMs) / DAY_MS))} 天 · 照顾 ${item.careCount ?? 0} 次`),
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
          setError(err.message ?? String(err))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-digital-pet-card' },
        h('h2', null, '送养'),
        h('p', { className: 'dsh-digital-pet-muted', style: { margin: '0 0 10px', lineHeight: 1.6 } },
          '把它送进宠物救助站会删除当前宠物的数据且不可恢复；金币和口粮会保留，之后可以重新领养一只（首次赠礼不会重复发放）。'),
        confirming
          ? h('div', { className: 'dsh-digital-pet-row' },
              h('span', { className: 'dsh-digital-pet-error', role: 'alert', style: { margin: 0 } },
                `确定要送走「${pet?.nickname ?? '它'}」吗？`),
              h('button', { className: 'dsh-digital-pet-btn', disabled: busy, onClick: surrender },
                busy ? '送养中…' : '确认送走'),
              h('button', { className: 'dsh-digital-pet-btn ghost', disabled: busy, onClick: () => setConfirming(false) }, '取消'),
            )
          : h('button', { className: 'dsh-digital-pet-btn ghost', onClick: () => setConfirming(true) }, '送进宠物救助站'),
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
          setActionError(err.message ?? String(err))
        } finally {
          setBusy(false)
        }
      }
      if (snap === null) {
        return h('div', { className: 'dsh-digital-pet-settings' },
          h('h1', { className: 'dsh-digital-pet-h1' }, '电子宠物'),
          h('p', { className: 'dsh-digital-pet-sub' }, error === null ? '正在读取宠物档案…' : `读取失败：${error}`))
      }
      const hasPet = snap.hasPet === true
      const visible = snap.settings?.visible !== false
      return h('div', { className: 'dsh-digital-pet-settings' },
        h('div', { className: 'dsh-digital-pet-head' },
          h('div', { className: 'dsh-digital-pet-head-main' },
            h('h1', { className: 'dsh-digital-pet-h1' }, '电子宠物'),
            h('p', { className: 'dsh-digital-pet-sub' }, hasPet
              ? '它正在 DSH 里陪你工作。桌面上可以拖动位置，点爪印打开操作盘照顾它。'
              : '还没有在养的宠物。领养后它会陪你六个月，用 DSH Token 换金币照顾它长大。'),
          ),
          hasPet
            ? h('div', { className: 'dsh-digital-pet-head-toggle' },
              h('span', { className: 'dsh-digital-pet-muted' }, '桌面显示'),
              h('button', {
                className: 'dsh-digital-pet-btn sm ghost',
                disabled: busy,
                'aria-pressed': visible,
                title: '在 DSH 桌面上显示/隐藏宠物（隐藏后仍可在设置页照护）',
                onClick: toggleVisible,
              }, visible ? '显示中（点击隐藏）' : '已隐藏（点击显示）'),
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
          label: () => '电子宠物',
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
